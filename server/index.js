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

  const connectStarted = Date.now();
  let lastAudioChunkSentAt = null;
  let sessionId = null; // reuse your chat_session_id if you pass it from client

  const dg = deepgramClient.listen.live({
    model: 'nova-3',
    language: 'multi',
    punctuate: true,
    interim_results: true,
    smart_format: true,
    endpointing: 100,
    encoding: 'linear16',
    sample_rate: 16000,
  });

  let keepAlive;

  dg.on(LiveTranscriptionEvents.Open, async () => {
    const opened = Date.now();
    console.log('✓ Deepgram connection opened.');
    keepAlive = setInterval(() => { if (dg.getReadyState() === 1) dg.keepAlive(); }, 10_000);

    // Log handshake timing
    await logDeepgramApiCall({
      chat_session_id: sessionId,
      deepgram_api_endpoint: 'listen.live.open',
      elapsed_ms: opened - connectStarted,
      started_at: nowIso(connectStarted),
      finished_at: nowIso(opened),
      notes: 'WebSocket handshake open'
    });

    dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript = data.channel.alternatives?.[0]?.transcript || "";
      if (transcript && ws.readyState === ws.OPEN) {
        const response = {
          results: [{
            alternatives: [{ transcript }],
            isFinal: data.is_final,
          }],
        };
        ws.send(JSON.stringify(response));
      }

      // Approximate latency: time since last audio chunk was sent
      const finished = Date.now();
      const elapsed = lastAudioChunkSentAt ? (finished - lastAudioChunkSentAt) : null;

      await logDeepgramApiCall({
        chat_session_id: sessionId,
        deepgram_api_endpoint: 'listen.live.transcript',
        elapsed_ms: elapsed,
        started_at: lastAudioChunkSentAt ? nowIso(lastAudioChunkSentAt) : null,
        finished_at: nowIso(finished),
        response_payload: { is_final: data.is_final, transcript_len: transcript.length },
        notes: data.is_final ? 'final' : 'interim'
      });
    });

    dg.on(LiveTranscriptionEvents.Error, async (err) => {
      console.error('!!! DEEPGRAM STT STREAM ERROR:', err);

      const e = {
        service_by: 'deepgram',
        provider_endpoint: 'listen.live',
        chat_session_id: sessionId,
        http_status_code: null,
        error_code: err?.code || null,
        error_type: 'websocket_error',
        error_param: null,
        error_message: err?.message || String(err),
        request_id: null,
        request_payload: {},
        response_payload: err,
        stack_trace: err?.stack || null
      };
      await logThirdPartyError(e); // stored in third_party_api_error_log
    });

    dg.on(LiveTranscriptionEvents.Close, async () => {
      console.log('Deepgram connection closed.');
      clearInterval(keepAlive);
      await logDeepgramApiCall({
        chat_session_id: sessionId,
        deepgram_api_endpoint: 'listen.live.close',
        notes: 'WebSocket closed by server/client'
      });
    });
  });

  ws.on('message', (message) => {
    if (dg.getReadyState() === 1) {
      lastAudioChunkSentAt = Date.now();
      dg.send(message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from WebSocket.');
    if (dg.getReadyState() === 1) dg.finish();
    clearInterval(keepAlive);
  });

  ws.on('error', (err) => {
    console.error('!!! WebSocket server error:', err.message);
    if (dg.getReadyState() === 1) dg.finish();
    clearInterval(keepAlive);
  });
});


function nowIso(dt) {
  // Convert ms epoch to MySQL DATETIME (UTC)
  const d = new Date(dt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function timeIt(asyncFn) {
  const started = Date.now();
  try {
    const result = await asyncFn();
    const finished = Date.now();
    return { ok: true, result, elapsed_ms: finished - started, started_at: nowIso(started), finished_at: nowIso(finished) };
  } catch (error) {
    const finished = Date.now();
    error._timing = { elapsed_ms: finished - started, started_at: nowIso(started), finished_at: nowIso(finished) };
    throw error;
  }
}

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

//buildOpenAIRequestMeta and buildOpenAIResponseMeta function Improve what we store in request_payload / response_payload 
function buildOpenAIRequestMeta(messages, extra = {}) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  return {
    ...extra,
    message_count: messages.length,
    last_user_preview: lastUser.slice(0, 160)
  };
}

function buildOpenAIResponseMeta(response) {
  const choice = response?.choices?.[0];
  const txt = choice?.message?.content || '';
  return {
    id: response?.id,
    model: response?.model,
    finish_reason: choice?.finish_reason || null,
    content_preview: txt.slice(0, 160)
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
  stack_trace = null,
  elapsed_ms = null,
  started_at = null,
  finished_at = null
}) {
  try {
    await db.execute(
      `INSERT INTO \`third_party_api_error_log\`
       (service_by, provider_endpoint, chat_session_id, http_status_code, error_code, error_type, error_param, error_message, request_id,
        request_payload, response_payload, stack_trace, elapsed_ms, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?, NOW())`,
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
        stack_trace,
        elapsed_ms,
        started_at,
        finished_at
      ]
    );
  } catch (dbErr) {
    console.error("!!! FAILED to log third-party error:", dbErr?.message);
  }
}



// -- NEW -- Helper function to log all HeyGen API calls to the database
async function logHeygenApiCall({
  chat_session_id,
  heygen_api_endpoint,
  http_status_code,
  request_payload,
  response_payload,
  notes = '',
  elapsed_ms = null,
  started_at = null,
  finished_at = null
}) {
  if (!chat_session_id || !heygen_api_endpoint) {
    console.error("!!! logHeygenApiCall: Missing required fields (chat_session_id, heygen_api_endpoint)");
    return;
  }
  try {
    await db.execute(
      `INSERT INTO \`heygen_api_log\`
       (chat_session_id, heygen_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at, request_payload, response_payload, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        chat_session_id,
        heygen_api_endpoint,
        http_status_code,
        elapsed_ms,
        started_at,
        finished_at,
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

//Deepgram logger + use it in the WS flow
async function logDeepgramApiCall({
  chat_session_id,
  deepgram_api_endpoint,
  http_status_code = null,
  elapsed_ms = null,
  started_at = null,
  finished_at = null,
  request_payload = null,
  response_payload = null,
  notes = ''
}) {
  try {
    await db.execute(
      `INSERT INTO \`deepgram_api_log\`
       (chat_session_id, deepgram_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at, request_payload, response_payload, notes)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?)`,
      [
        chat_session_id,
        deepgram_api_endpoint,
        http_status_code,
        elapsed_ms,
        started_at,
        finished_at,
        JSON.stringify(request_payload || {}),
        JSON.stringify(response_payload || {}),
        notes
      ]
    );
  } catch (e) {
    console.error("!!! FAILED to log Deepgram event:", e.message);
  }
}

//  Helper function to log all OpenAI API calls to the database
async function logOpenaiApiCall({
  chat_session_id,
  openai_api_endpoint = 'chat.completions',
  http_status_code = 200,
  elapsed_ms = null,
  started_at = null,
  finished_at = null,
  model = null,
  usage = {},
  request_payload = null,
  response_payload = null,
  notes = '',
  table_name = null,     // <-- NEW (optional)
  table_id = null        // <-- NEW (optional)
}) {
  try {
    const [res] = await db.execute(
      `INSERT INTO \`openai_api_log\`
       (chat_session_id, openai_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at, model,
        prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, request_payload, response_payload, notes, table_name, table_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?)`,
      [
        chat_session_id,
        openai_api_endpoint,
        http_status_code,
        elapsed_ms,
        started_at,
        finished_at,
        model,
        usage?.prompt_tokens ?? null,
        usage?.completion_tokens ?? null,
        usage?.completion_tokens_details?.reasoning_tokens ?? null,
        usage?.total_tokens ?? null,
        JSON.stringify(request_payload || {}),
        JSON.stringify(response_payload || {}),
        notes,
        table_name,
        table_id
      ]
    );
    return res.insertId; // <-- return log id
  } catch (e) {
    console.error('!!! FAILED to log OpenAI call:', e.message);
    return null;
  }
}

//Add a helper to update back-links on the log row
async function updateOpenaiLogLink(log_id, table_name, table_id) {
  if (!log_id || !table_name || !table_id) return;
  try {
    await db.execute(
      'UPDATE `openai_api_log` SET `table_name` = ?, `table_id` = ? WHERE `log_id` = ?',
      [table_name, table_id, log_id]
    );
  } catch (e) {
    console.error('!!! FAILED to update openai_api_log link:', e.message);
  }
}


// ---- "BRAIN" and other functions (Unchanged) ----
// ---- "BRAIN" and other functions (Updated) ----
async function planReply(userText, history = [], chat_session_id = null) {
  console.log(`>>> Asking OpenAI for a reply to: "${userText}" with ${history.length} previous messages.`);

  const messages = [
    { role: "system", 
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
  - DO NOT interpret it as a question or instruction unless the user asks to repeat the Hindi line
  - If the transcription of what user said is exactly same or reasonably close then say something similar to "Good job, we will enjoy learning together". if some words are correct in the transcription but is in english letters instead of devanagiri , still accept them as correctly spoken.
  - If the attempt is far from the target, say "Attempted well, lets keep learning".
- Repeat the interest→Hindi-line→evaluation loop 5 times (use different lines if possible).
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
    ...history,
    { role: "user", content: userText }
  ];

  try {
    console.log('------- start to send open ai -------');

    const timed = await timeIt(() =>
      openai.chat.completions.create(
        {
          model: "gpt-5-chat-latest",
          response_format: { type: "json_object" },
          messages
        },
        { timeout: 30000, maxRetries: 1 }
      )
    );
    const response = timed.result;
    console.log('------- end to send open ai -------');

    // 👇 hoist before inner try
    let openai_log_id = null;

    // Parse JSON-mode output safely
    const rawContent = response?.choices?.[0]?.message?.content ?? "{}";
    let replyJson;
    try {
      replyJson = JSON.parse(rawContent);

      const usage = response?.usage || {};
      const modelName = response?.model || "gpt-5-chat-latest";

      // write OpenAI perf/usage log and keep the insert id
      openai_log_id = await logOpenaiApiCall({
        chat_session_id,
        openai_api_endpoint: 'chat.completions',
        http_status_code: 200,
        elapsed_ms: timed.elapsed_ms,
        started_at: timed.started_at,
        finished_at: timed.finished_at,
        model: modelName,
        usage,
        request_payload: buildOpenAIRequestMeta(messages, { response_format: { type: "json_object" } }),
        response_payload: buildOpenAIResponseMeta(response),
        notes: 'success'
      });

    } catch (parseErr) {
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
        request_payload: { model: "gpt-5-chat-latest", response_format: { type: "json_object" }, messages },
        response_payload: { content: rawContent },
        stack_trace: parseErr?.stack ?? null
      });
      replyJson = { speech_text: "I'm sorry, I had trouble reading my own answer." };
    }

    // Token usage for saving into `chats`
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
      model: response?.model || "gpt-5-chat-latest",
      openai_log_id, // ✅ now defined
    };

  } catch (err) {
    console.error("!!! OpenAI error in planReply:", err);
    const normalized = normalizeOpenAIError(err);
    const t = err?._timing || {};
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
      request_payload: { response_format: { type: "json_object" } },
      response_payload: normalized.response_payload,
      stack_trace: normalized.stack_trace,
      elapsed_ms: t.elapsed_ms ?? null,
      started_at: t.started_at ?? null,
      finished_at: t.finished_at ?? null
    });

    return {
      speech_text: "I'm sorry, I had a little trouble thinking of a response.",
      ui_action: { action: "NONE", payload: {} },
      tokens: { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, total_tokens: null },
      model: "gpt-5-chat-latest"
    };
  }
}


// -- NEW -- Function to generate a title for the chat session
async function generateChatTitle(firstUserMessage, chat_session_id) {
  console.log(`>>> Asking OpenAI for a chat title...`);
  try {
    const timed = await timeIt(() => openai.chat.completions.create({
      model: "gpt-5-chat-latest",
      messages: [
        { role: "system", content: "You are a title generator. Create a concise, 3-5 word title for a conversation that begins with the following user message. Do not add quotes or any other formatting. Just output the title text." },
        { role: "user", content: firstUserMessage }
      ]
    }));

    const response = timed.result;
    const title = response.choices[0].message.content.trim();

    // ✅ chat_session_id is now in scope
    const openai_log_id = await logOpenaiApiCall({
      chat_session_id,
      openai_api_endpoint: 'chat.completions',
      http_status_code: 200,
      elapsed_ms: timed.elapsed_ms,
      started_at: timed.started_at,
      finished_at: timed.finished_at,
      model: response?.model || 'gpt-5-chat-latest',
      usage: response?.usage || {},
      request_payload: buildOpenAIRequestMeta([
        { role: "system", content: "title generator..." },
        { role: "user", content: firstUserMessage }
      ]),
      response_payload: buildOpenAIResponseMeta(response),
      notes: 'title generation'
    });

    console.log(`<<< Generated Title: "${title}" in ${timed.elapsed_ms} ms`);
    return { title, openai_log_id };

  } catch (e) {
    console.error("!!! OpenAI title generation error:", e);
    return { title: "New Conversation", openai_log_id: null };
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
    const { speech_text, ui_action, tokens, model, openai_log_id } = await planReply(userText, history, chat_session_id);

    // >>> include tokens + service_by + model in INSERT
    const [insertResult] = await db.execute(
      `INSERT INTO \`chats\`
      (guest_id, chat_session_id, user_message, ai_response, has_image, ai_model, service_by,
        prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, openai_api_log_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        guest_id,
        chat_session_id,
        userText,
        speech_text,
        0,
        model || 'gpt-5-chat-latest',
        'open_ai',
        tokens?.prompt_tokens,
        tokens?.completion_tokens,
        tokens?.reasoning_tokens,
        tokens?.total_tokens,
        openai_log_id || null
      ]
    );
    const newChatId = insertResult.insertId;

    // Update the openai log row with table link (reverse link)
    if (openai_log_id && newChatId) {
      await updateOpenaiLogLink(openai_log_id, 'chats', newChatId);
    }

    if (isFirstMessage && newChatId) {
      const { title, openai_log_id: title_log_id } = await generateChatTitle(userText, chat_session_id);
      if (title) {
        const [r] = await db.execute(
          'INSERT INTO `chats_title` (chat_id, chat_session_id, title, openai_api_log_id, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
          [newChatId, chat_session_id, title, title_log_id || null]
        );
        const newTitleId = r.insertId;

        // back-link the OpenAI log row to chats_title
        if (title_log_id && newTitleId) {
          await updateOpenaiLogLink(title_log_id, 'chats_title', newTitleId);
        }

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

      const timedTask = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.task", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.HEYGEN_API_KEY}` },
        body: JSON.stringify(requestBody)
      }));
      
      const r = timedTask.result;
      const responseText = await r.text();

      // -- LOGGING -- Log the 'streaming.task' API call
      await logHeygenApiCall({
        chat_session_id,
        heygen_api_endpoint: 'streaming.task',
        http_status_code: r.status,
        request_payload: requestBody,
        response_payload: { data: responseText },
        notes: r.ok ? 'Successfully sent text to HeyGen.' : 'Failed to send text to HeyGen.',
        elapsed_ms: timedTask.elapsed_ms,
        started_at: timedTask.started_at,
        finished_at: timedTask.finished_at
      });

      if (!r.ok) {
        console.error("HeyGen task error:", r.status, responseText);
        await logThirdPartyError({
          service_by: 'heygen',
          provider_endpoint: 'streaming.task',
          chat_session_id,
          http_status_code: r.status,
          error_message: responseText || 'Non-200 from streaming.task',
          request_payload: requestBody,
          response_payload: { data: responseText },
          elapsed_ms: timedTask.elapsed_ms,
          started_at: timedTask.started_at,
          finished_at: timedTask.finished_at
        });
      } else {
        console.log("Successfully sent text to HeyGen for speaking.");
      }
    } catch (e) {
      console.error("HeyGen call failed:", e);
    }
    
    res.json({ spoke: speech_text, ui: ui_action });

  } catch (e) {
    console.error("Talk endpoint failed:", e);

    const t = e?._timing || {};
    await logThirdPartyError({
      service_by: 'heygen',
      provider_endpoint: 'streaming.task',
      chat_session_id,
      http_status_code: 500,
      error_message: e?.message || 'Exception in streaming.task',
      request_payload: { session_id: chat_session_id, task_type: "repeat" },
      response_payload: {},
      elapsed_ms: t.elapsed_ms ?? null,
      started_at: t.started_at ?? null,
      finished_at: t.finished_at ?? null
    });

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

    const timedNew = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.new", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` },
      body: JSON.stringify(requestBodyNew)
    }));

    const rNew = timedNew.result;
    const newJson = await rNew.json();
    const d = newJson?.data;
    sessionIdForLogging = d?.session_id || 'UNKNOWN';

    // -- LOGGING -- Log the 'streaming.new' call
    await logHeygenApiCall({
      chat_session_id: sessionIdForLogging,
      heygen_api_endpoint: 'streaming.new',
      http_status_code: rNew.status,
      request_payload: requestBodyNew,
      response_payload: newJson,
      notes: rNew.ok ? 'Session created.' : 'Failed to create session.',
      elapsed_ms: timedNew.elapsed_ms,
      started_at: timedNew.started_at,
      finished_at: timedNew.finished_at
    });

    if (!rNew.ok) {
      await logThirdPartyError({
        service_by: 'heygen',
        provider_endpoint: 'streaming.new',
        chat_session_id: sessionIdForLogging,
        http_status_code: rNew.status,
        error_message: (newJson && newJson.error) ? JSON.stringify(newJson.error) : 'Non-200 response',
        request_payload: requestBodyNew,
        response_payload: newJson,
        elapsed_ms: timedNew.elapsed_ms,
        started_at: timedNew.started_at,
        finished_at: timedNew.finished_at
      });
    }

    if (!d?.url || !d?.access_token || !d?.session_id) { 
      console.error("Unexpected HeyGen response", newJson); 
      return res.status(500).json({ error: "HeyGen session: missing url/token/session_id" }); 
    } 

    // -- LOGGING -- Prepare request body for the 'start' call
    const requestBodyStart = { session_id: d.session_id };

    const timedStart = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` },
      body: JSON.stringify(requestBodyStart)
    }));

    const rStart = timedStart.result;

    // -- LOGGING -- Log the 'streaming.start' call
    // Log start with timing
    await logHeygenApiCall({
      chat_session_id: d.session_id,
      heygen_api_endpoint: 'streaming.start',
      http_status_code: rStart.status,
      request_payload: requestBodyStart,
      response_payload: {}, // no meaningful body
      notes: rStart.ok ? 'Session start command sent.' : 'Failed to send start command.',
      elapsed_ms: timedStart.elapsed_ms,
      started_at: timedStart.started_at,
      finished_at: timedStart.finished_at
    });

    // Error path: also log to third_party_api_error_log
    if (!rStart.ok) {
      await logThirdPartyError({
        service_by: 'heygen',
        provider_endpoint: 'streaming.start',
        chat_session_id: d.session_id,
        http_status_code: rStart.status,
        error_message: 'Non-200 from streaming.start',
        request_payload: requestBodyStart,
        response_payload: {},
        elapsed_ms: timedStart.elapsed_ms,
        started_at: timedStart.started_at,
        finished_at: timedStart.finished_at
      });
    }

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

    const timed = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.interrupt", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify({ session_id }) 
    }));

    const r = timed.result;
    const data = await r.json().catch(() => ({})); 
    
    // -- LOGGING --
    await logHeygenApiCall({
      chat_session_id: session_id,
      heygen_api_endpoint: 'streaming.interrupt',
      http_status_code: r.status,
      request_payload: { session_id },
      response_payload: data,
      notes: r.ok ? 'Interrupt successful.' : 'Interrupt failed.',
      elapsed_ms: timed.elapsed_ms,
      started_at: timed.started_at,
      finished_at: timed.finished_at
    });

    if (!r.ok) {
      await logThirdPartyError({
        service_by: 'heygen',
        provider_endpoint: 'streaming.interrupt',
        chat_session_id: session_id,
        http_status_code: r.status,
        error_message: JSON.stringify(data),
        request_payload: { session_id },
        response_payload: data,
        elapsed_ms: timed.elapsed_ms,
        started_at: timed.started_at,
        finished_at: timed.finished_at
      });
    }

    res.status(r.ok ? 200 : 500).json(data); 
  } catch (e) { 
    console.error(e); 
    // -- LOGGING --
     const t = e?._timing || {};
      await logThirdPartyError({
        service_by: 'heygen',
        provider_endpoint: 'streaming.interrupt',
        chat_session_id: session_id,
        http_status_code: 500,
        error_message: e?.message || 'Exception in streaming.interrupt',
        request_payload: { session_id },
        response_payload: {},
        elapsed_ms: t.elapsed_ms ?? null,
        started_at: t.started_at ?? null,
        finished_at: t.finished_at ?? null
      });
    res.status(500).json({ error: "Failed to interrupt" }); 
  } 
});

app.post("/api/heygen/stop", async (req, res) => { 
  const { session_id } = req.body;
  try { 

    const timed = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.stop", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify({ session_id }) 
    }));

    const r = timed.result;
    const data = await r.json().catch(() => ({})); 
    
    // -- LOGGING --
    await logHeygenApiCall({
      chat_session_id: session_id,
      heygen_api_endpoint: 'streaming.stop',
      http_status_code: r.status,
      request_payload: { session_id },
      response_payload: data,
      notes: r.ok ? 'Session stopped successfully.' : 'Session stop failed.',
      elapsed_ms: timed.elapsed_ms,
      started_at: timed.started_at,
      finished_at: timed.finished_at
    });

    if (!r.ok) {
      await logThirdPartyError({
        service_by: 'heygen',
        provider_endpoint: 'streaming.stop',
        chat_session_id: session_id,
        http_status_code: r.status,
        error_message: JSON.stringify(data),
        request_payload: { session_id },
        response_payload: data,
        elapsed_ms: timed.elapsed_ms,
        started_at: timed.started_at,
        finished_at: timed.finished_at
      });
    }

    res.status(r.ok ? 200 : 500).json(data); 
  } catch (e) { 
    console.error(e); 
    // -- LOGGING --
    const t = e?._timing || {};
    await logThirdPartyError({
      service_by: 'heygen',
      provider_endpoint: 'streaming.stop',
      chat_session_id: session_id,
      http_status_code: 500,
      error_message: e?.message || 'Exception in streaming.stop',
      request_payload: { session_id },
      response_payload: {},
      elapsed_ms: t.elapsed_ms ?? null,
      started_at: t.started_at ?? null,
      finished_at: t.finished_at ?? null
    });
    
    res.status(500).json({ error: "Failed to stop session" }); 
  } 
});


server.listen(port, () => {
  console.log(`Server with WebSocket listening on http://localhost:${port}`);
});