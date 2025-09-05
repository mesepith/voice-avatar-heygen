import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import textToSpeech from "@google-cloud/text-to-speech";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { WebSocketServer } from "ws";
import http from "http";
import mysql from "mysql2/promise";

dotenv.config();

const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'https://demo2.zahiralam.com'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));

const port = process.env.PORT || 8787;
const server = http.createServer(app);

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

db.getConnection()
  .then(connection => {
    console.log("✓ Successfully connected to MySQL database.");
    connection.release();
  })
  .catch(err => {
    console.error("!!! CRITICAL: Failed to connect to MySQL database:", err.message);
  });


// ---- Clients ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);


if (!process.env.OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); }
if (!process.env.DEEPGRAM_API_KEY) { console.error("!!! CRITICAL: Missing DEEPGRAM_API_KEY"); }
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`✓ GOOGLE_APPLICATION_CREDENTIALS is set to: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else {
    console.error("!!! CRITICAL: GOOGLE_APPLICATION_CREDENTIALS environment variable is not set!");
}

// --- WebSocket Server for STT (NEW with Deepgram) ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected for STT streaming with Deepgram');
  
  const deepgramConnection = deepgramClient.listen.live({
    model: 'nova-3',
    language: 'multi',
    punctuate: true,
    interim_results: true,
    smart_format: true,
    endpointing: 100, // Recommended for code-switching
    encoding: 'linear16',
    sample_rate: 16000,
  });

  let keepAlive;

  deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('✓ Deepgram connection opened.');

    // Keep the connection alive
    keepAlive = setInterval(() => {
        if (deepgramConnection.getReadyState() === 1) { // 1 = OPEN
            deepgramConnection.keepAlive();
        }
    }, 10 * 1000);

    deepgramConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript && ws.readyState === ws.OPEN) {
        // Re-format the response to match the client's expected structure
        const response = {
          results: [{
            alternatives: [{ transcript }],
            isFinal: data.is_final,
          }],
        };
        ws.send(JSON.stringify(response));
      }
    });

    deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('!!! DEEPGRAM STT STREAM ERROR:', err);
    });

    deepgramConnection.on(LiveTranscriptionEvents.Close, () => {
      console.log('Deepgram connection closed.');
      clearInterval(keepAlive);
    });
  });

  ws.on('message', (message) => {
    // Forward audio data to Deepgram
    if (deepgramConnection.getReadyState() === 1) { // 1 = OPEN
      deepgramConnection.send(message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from WebSocket.');
    if (deepgramConnection.getReadyState() === 1) {
      deepgramConnection.finish();
    }
    clearInterval(keepAlive);
  });

  ws.on('error', (err) => {
    console.error('!!! WebSocket server error:', err.message);
    if (deepgramConnection.getReadyState() === 1) {
      deepgramConnection.finish();
    }
    clearInterval(keepAlive);
  });
});

// Normalize OpenAI (and fetch) errors to a consistent shape
function normalizeOpenAIError(err) {
  return {
    http_status_code: err?.status ?? 500,
    error_code: err?.code ?? err?.error?.code ?? null,
    error_type: err?.type ?? err?.error?.type ?? null,
    error_param: err?.param ?? err?.error?.param ?? null,
    error_message: err?.error?.message ?? err?.message ?? 'Unknown error',
    request_id: err?.requestID ?? null,
    response_payload: err?.response ?? null,
    stack_trace: err?.stack ?? null
  };
}

// Log any third-party API error (OpenAI, HeyGen, Deepgram, etc.)
async function logThirdPartyError({
  service_by,             // 'open_ai' | 'heygen' | 'deepgram' | ...
  provider_endpoint,      // e.g. 'chat.completions'
  chat_session_id = null,
  http_status_code = null,
  error_code = null,
  error_type = null,
  error_param = null,
  error_message = null,
  request_id = null,
  request_payload = null,   // object -> stored as JSON
  response_payload = null,  // object -> stored as JSON
  stack_trace = null
}) {
  try {
    await db.execute(
      `INSERT INTO \`third_party_api_error_log\`
       (service_by, provider_endpoint, chat_session_id, http_status_code, error_code, error_type, error_param, error_message, request_id, request_payload, response_payload, stack_trace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, NOW())`,
      [
        service_by,
        provider_endpoint,
        chat_session_id,
        http_status_code,
        error_code,
        error_type,
        error_param,
        error_message,
        request_id,
        JSON.stringify(request_payload ?? {}),
        JSON.stringify(response_payload ?? {}),
        stack_trace
      ]
    );
  } catch (dbErr) {
    console.error("!!! FAILED to log third-party error:", dbErr?.message);
  }
}


// -- NEW -- Helper function to log all HeyGen API calls to the database
async function logHeygenApiCall({ chat_session_id, heygen_api_endpoint, http_status_code, request_payload, response_payload, notes = '' }) {
  if (!chat_session_id || !heygen_api_endpoint) {
    console.error("!!! logHeygenApiCall: Missing required fields (chat_session_id, heygen_api_endpoint)");
    return;
  }
  try {
    await db.execute(
      'INSERT INTO `heygen_api_log` (chat_session_id, heygen_api_endpoint, http_status_code, request_payload, response_payload, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [
        chat_session_id,
        heygen_api_endpoint,
        http_status_code,
        JSON.stringify(request_payload || {}),
        JSON.stringify(response_payload || {}),
        notes
      ]
    );
    console.log(`✓ Logged HeyGen API call for session ${chat_session_id}: ${heygen_api_endpoint}`);
  } catch (dbError) {
    console.error(`!!! FAILED to log HeyGen API call for session ${chat_session_id}:`, dbError.message);
  }
}


// ---- "BRAIN" and other functions (Unchanged) ----
// ---- "BRAIN" and other functions (Updated) ----
async function planReply(userText, history = [], chat_session_id = null) {
  console.log(`>>> Asking OpenAI for a reply to: "${userText}" with ${history.length} previous messages.`);

  const messages = [
    {
      role: "system",
      // NOTE: Keep the literal word "JSON" so json_object mode is allowed.
      content: `## PERSONA
You are Neha Jain, a cheerful, friendly AI tutor created by AI Lab India. You live in Seattle and speak English fluently with a clear American accent. Your purpose is to help users learn Hindi in a welcoming and supportive manner. You should speak naturally, like a helpful human tutor. You speak English throughout the conversation, EXCEPT when you present a short Hindi line for the learner to read aloud.
## INSTRUCTIONS
- Start by introducing yourself and say you're from Seattle.
- Ask the user: "Tell me about yourself."
- If the user provides their name, do NOT ask for it again. If not provided, ask: "What’s your name?"
- Respond with a light comment, then ask: "How old are you?"
- After the age is given, ask what kinds of things they enjoy doing.
- When the user shares interests, randomly choose ONE interest and craft ONE short Hindi line directly related to it. To form the Hindi line, go deep into that field of interest and use topics and jargons that are very specific and applies only to that field of interest
  - The Hindi line MUST be written in Devanagari script ONLY (no Latin transliteration).
  - Do NOT put the Hindi line in quotes or code blocks.
  - Good example: मैं यात्रा पर हूँ।
  - Bad example (forbidden): Main yatra par hoon.
- Present that Hindi line at the END of your message so the learner can read it aloud.
- When evaluating the user’s spoken attempt:
  - Treat the user’s next message as a reading attempt ONLY.
  - DO NOT interpret it as a question or instruction.
  - If the transcription of what user said is exactly same or reasonably close then say something similar to "Good job, we will enjoy learning together". if some words are correct in the transcription but is in english letters instead of devanagiri , still accept them as correctly spoken.
  - If the attempt is far from the target, say "Attempted well, lets keep learning".
- Repeat the interest→Hindi-line→evaluation loop 3 times (use different lines if possible).
- Keep responses concise and friendly.
- Aside from the single Hindi line you provide for reading, everything else you say remains in English.
## OUTPUT FORMAT (JSON)
- You must ALWAYS output a JSON object with exactly one key: "speech_text".
- The value of "speech_text" is the full message you would speak.
- Place the Hindi reading line as the LAST line inside "speech_text", written in Devanagari only, with no surrounding quotes.
## EVALUATION RULES (for the 5 reading rounds)
- Consider minor accent differences acceptable if the words resemble the target closely.
- Do not answer or comment on the semantic content of what the user read; only assess pronunciation/word match quality.
- After giving feedback ("Good job" / "not good dear"), proceed to the next round with a new short Hindi line related to their interests.
`
    },
    ...history, // prior chat [(user, assistant)...]
    { role: "user", content: userText }
  ];

  try {
    console.log('------- start to send open ai -------');
    const response = await openai.chat.completions.create(
      {
        model: "gpt-5-chat-latest",
        response_format: { type: "json_object" }, // JSON mode; prompt contains the word "JSON"
        messages // IMPORTANT: must be `messages`, not `input`
        // temperature: removed — gpt-5 fixed to default
      },
      {
        timeout: 30000,
        maxRetries: 1,
      }
    );
    console.log('------- end to send open ai -------');

    // Parse JSON-mode output safely
    const rawContent = response?.choices?.[0]?.message?.content ?? "{}";
    let replyJson;
    try {
      replyJson = JSON.parse(rawContent);
    } catch (parseErr) {
      // If for any reason parsing fails, log and fallback
      await logThirdPartyError({
        service_by: 'open_ai',
        provider_endpoint: 'chat.completions',
        chat_session_id,
        http_status_code: response?.status ?? null,
        error_code: 'invalid_json',
        error_type: 'client_parse_error',
        error_param: null,
        error_message: `Failed to parse assistant JSON: ${parseErr?.message}`,
        request_id: response?.requestID ?? null,
        request_payload: { model: "gpt-5", response_format: { type: "json_object" }, messages },
        response_payload: { content: rawContent },
        stack_trace: parseErr?.stack ?? null
      });
      replyJson = { speech_text: "I'm sorry, I had trouble reading my own answer." };
    }

    // Token usage
    const usage = response?.usage || {};
    const tokens = {
      prompt_tokens: usage.prompt_tokens ?? null,
      completion_tokens: usage.completion_tokens ?? null,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
    };

    return {
      speech_text: replyJson?.speech_text ?? "I'm sorry, I had a little trouble thinking of a response.",
      ui_action: { action: "NONE", payload: {} },
      tokens,
      model: response?.model || "gpt-5"
    };

  } catch (err) {
    console.error("!!! OpenAI error in planReply:", err);

    // Normalize and persist error
    const normalized = normalizeOpenAIError(err);
    await logThirdPartyError({
      service_by: 'open_ai',
      provider_endpoint: 'chat.completions',
      chat_session_id,
      http_status_code: normalized.http_status_code,
      error_code: normalized.error_code,
      error_type: normalized.error_type,
      error_param: normalized.error_param,
      error_message: normalized.error_message,
      request_id: normalized.request_id,
      request_payload: { model: "gpt-5", response_format: { type: "json_object" }, messages },
      response_payload: normalized.response_payload,
      stack_trace: normalized.stack_trace
    });

    // Bubble up a graceful fallback
    return {
      speech_text: "I'm sorry, I had a little trouble thinking of a response.",
      ui_action: { action: "NONE", payload: {} },
      tokens: { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, total_tokens: null },
      model: "gpt-5"
    };
  }
}


// -- NEW -- Function to generate a title for the chat session
async function generateChatTitle(firstUserMessage) {
  console.log(`>>> Asking OpenAI for a chat title...`);
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-chat-latest",
      messages: [
        {
          role: "system",
          content:
            "You are a title generator. Create a concise, 3-5 word title for a conversation that begins with the following user message. Do not add quotes or any other formatting. Just output the title text."
        },
        { role: "user", content: firstUserMessage }
      ]
      // no temperature for gpt-5
    });
    const title = response.choices[0].message.content.trim();
    console.log(`<<< Generated Title: "${title}"`);
    return title;
  } catch (e) {
    console.error("!!! OpenAI title generation error:", e);
    return "New Conversation";
  }
}

// ---- UPDATED /api/talk ENDPOINT with Logging ----
app.post("/api/talk", async (req, res) => {
  try {
    const { userText, session_id: chat_session_id } = req.body;
    if (!userText || !chat_session_id) {
      return res.status(400).json({ error: "userText and session_id required" });
    }

    const guest_id = chat_session_id;
    const [rows] = await db.execute(
        'SELECT user_message, ai_response FROM `chats` WHERE `chat_session_id` = ? ORDER BY `created_at` ASC',
        [chat_session_id]
    );
    const history = rows.flatMap(row => [
        { role: 'user', content: row.user_message },
        { role: 'assistant', content: row.ai_response }
    ]).filter(msg => msg.content);
    const isFirstMessage = history.length === 0;

    // >>> call planReply with chat_session_id so we can log errors against session
    const { speech_text, ui_action, tokens, model } = await planReply(userText, history, chat_session_id);

    // >>> include tokens + service_by + model in INSERT
    const [insertResult] = await db.execute(
      `INSERT INTO \`chats\`
       (guest_id, chat_session_id, user_message, ai_response, has_image, ai_model, service_by,
        prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        guest_id,
        chat_session_id,
        userText,
        speech_text,
        0,                   // has_image
        model || 'gpt-5',    // ai_model
        'open_ai',           // service_by
        tokens?.prompt_tokens,
        tokens?.completion_tokens,
        tokens?.reasoning_tokens,
        tokens?.total_tokens
      ]
    );
    const newChatId = insertResult.insertId;

    if (isFirstMessage && newChatId) {
      const title = await generateChatTitle(userText);
      if (title) {
        await db.execute(
          'INSERT INTO `chats_title` (chat_id, chat_session_id, title, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
          [newChatId, chat_session_id, title]
        );
        console.log(`Saved new chat title for session ${chat_session_id}`);
      }
    }

    // Send the AI's response text to HeyGen to be spoken
    try {
      // -- LOGGING -- Prepare the request body to be logged
      const requestBody = {
          session_id: chat_session_id,
          task_type: "repeat",
          text: speech_text
      };

      const r = await fetch("https://api.heygen.com/v1/streaming.task", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.HEYGEN_API_KEY}` },
        body: JSON.stringify(requestBody)
      });
      
      const responseText = await r.text(); // Get response text once

      // -- LOGGING -- Log the 'streaming.task' API call
      await logHeygenApiCall({
        chat_session_id,
        heygen_api_endpoint: 'streaming.task',
        http_status_code: r.status,
        request_payload: requestBody,
        response_payload: { data: responseText },
        notes: r.ok ? 'Successfully sent text to HeyGen.' : 'Failed to send text to HeyGen.'
      });

      if (!r.ok) {
        console.error("HeyGen task error:", r.status, responseText);
      } else {
        console.log("Successfully sent text to HeyGen for speaking.");
      }
    } catch (e) {
      console.error("HeyGen call failed:", e);
    }
    
    res.json({ spoke: speech_text, ui: ui_action });

  } catch (e) {
    console.error("Talk endpoint failed:", e);
    res.status(500).json({ error: "talk failed" });
  }
});


// ---- UPDATED HeyGen Endpoints with Logging ----
app.post("/api/heygen/session", async (req, res) => { 
  let sessionIdForLogging = 'UNKNOWN'; // Fallback session ID for logging
  try { 
    const { avatar_id, voice_id } = req.body; 
    
    // -- LOGGING -- Prepare request body for the 'new' call
    const requestBodyNew = { 
      version: "v2", 
      avatar_id, 
      ...(voice_id ? { voice_id } : {}) 
    };

    const rNew = await fetch("https://api.heygen.com/v1/streaming.new", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify(requestBodyNew) 
    });

    const newJson = await rNew.json();
    const d = newJson?.data;
    sessionIdForLogging = d?.session_id || 'UNKNOWN'; // Update session ID once we have it

    // -- LOGGING -- Log the 'streaming.new' call
    await logHeygenApiCall({
      chat_session_id: sessionIdForLogging,
      heygen_api_endpoint: 'streaming.new',
      http_status_code: rNew.status,
      request_payload: requestBodyNew,
      response_payload: newJson,
      notes: rNew.ok ? 'Session created.' : 'Failed to create session.'
    });

    if (!d?.url || !d?.access_token || !d?.session_id) { 
      console.error("Unexpected HeyGen response", newJson); 
      return res.status(500).json({ error: "HeyGen session: missing url/token/session_id" }); 
    } 

    // -- LOGGING -- Prepare request body for the 'start' call
    const requestBodyStart = { session_id: d.session_id };
    
    const rStart = await fetch("https://api.heygen.com/v1/streaming.start", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify(requestBodyStart) 
    });

    // -- LOGGING -- Log the 'streaming.start' call
    await logHeygenApiCall({
      chat_session_id: d.session_id,
      heygen_api_endpoint: 'streaming.start',
      http_status_code: rStart.status,
      request_payload: requestBodyStart,
      response_payload: {}, // No meaningful response body for this call
      notes: rStart.ok ? 'Session start command sent.' : 'Failed to send start command.'
    });

    res.json({ session_id: d.session_id, url: d.url, access_token: d.access_token }); 
  } catch (e) { 
    console.error(e); 
    // -- LOGGING -- Log failure if an exception occurs before we can log normally
    await logHeygenApiCall({
        chat_session_id: sessionIdForLogging,
        heygen_api_endpoint: 'streaming.session',
        http_status_code: 500,
        request_payload: req.body,
        response_payload: { error: e.message },
        notes: 'Endpoint failed due to an exception.'
    });
    res.status(500).json({ error: "Failed to create/start HeyGen session" }); 
  } 
});

app.post("/api/heygen/interrupt", async (req, res) => { 
  const { session_id } = req.body;
  try { 
    const r = await fetch("https://api.heygen.com/v1/streaming.interrupt", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify({ session_id }) 
    });
    const data = await r.json().catch(() => ({})); 
    
    // -- LOGGING --
    await logHeygenApiCall({
        chat_session_id: session_id,
        heygen_api_endpoint: 'streaming.interrupt',
        http_status_code: r.status,
        request_payload: { session_id },
        response_payload: data,
        notes: r.ok ? 'Interrupt successful.' : 'Interrupt failed.'
    });

    res.status(r.ok ? 200 : 500).json(data); 
  } catch (e) { 
    console.error(e); 
    // -- LOGGING --
     await logHeygenApiCall({
        chat_session_id: session_id,
        heygen_api_endpoint: 'streaming.interrupt',
        http_status_code: 500,
        request_payload: { session_id },
        response_payload: { error: e.message },
        notes: 'Endpoint failed due to an exception.'
    });
    res.status(500).json({ error: "Failed to interrupt" }); 
  } 
});

app.post("/api/heygen/stop", async (req, res) => { 
  const { session_id } = req.body;
  try { 
    const r = await fetch("https://api.heygen.com/v1/streaming.stop", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify({ session_id }) 
    });
    const data = await r.json().catch(() => ({})); 
    
    // -- LOGGING --
    await logHeygenApiCall({
        chat_session_id: session_id,
        heygen_api_endpoint: 'streaming.stop',
        http_status_code: r.status,
        request_payload: { session_id },
        response_payload: data,
        notes: r.ok ? 'Session stopped successfully.' : 'Session stop failed.'
    });

    res.status(r.ok ? 200 : 500).json(data); 
  } catch (e) { 
    console.error(e); 
    // -- LOGGING --
    await logHeygenApiCall({
        chat_session_id: session_id,
        heygen_api_endpoint: 'streaming.stop',
        http_status_code: 500,
        request_payload: { session_id },
        response_payload: { error: e.message },
        notes: 'Endpoint failed due to an exception.'
    });
    res.status(500).json({ error: "Failed to stop session" }); 
  } 
});


server.listen(port, () => {
  console.log(`Server with WebSocket listening on http://localhost:${port}`);
});