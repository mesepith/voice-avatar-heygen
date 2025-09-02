import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import textToSpeech from "@google-cloud/text-to-speech";
import { SpeechClient } from "@google-cloud/speech";
import { WebSocketServer } from "ws";
import http from "http";
import mysql from "mysql2/promise"; // -- NEW -- For MySQL connection

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const port = process.env.PORT || 8787;
const server = http.createServer(app);

// -- NEW -- Database Connection Pool
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

// -- NEW -- Test DB connection on startup
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
const speechClient = new SpeechClient();

if (!process.env.OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); }
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`✓ GOOGLE_APPLICATION_CREDENTIALS is set to: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else {
    console.error("!!! CRITICAL: GOOGLE_APPLICATION_CREDENTIALS environment variable is not set!");
}

// --- WebSocket Server for STT (This part is working perfectly and is unchanged) ---
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  console.log('Client connected for STT streaming');
  let recognizeStream = null;
  try {
    recognizeStream = speechClient
      .streamingRecognize({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
        },
        interimResults: true,
      })
      .on('error', (err) => console.error('GOOGLE STT STREAM ERROR:', err))
      .on('data', (data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(data)));
  } catch(e) { console.error("FAILED TO CREATE GOOGLE STT STREAM", e); }
  ws.on('message', (message) => recognizeStream?.write(message));
  ws.on('close', () => recognizeStream?.end());
});


// ---- THIS IS THE NEW, INTELLIGENT "BRAIN" ----
// -- MODIFIED -- It now accepts conversation history to maintain context.
async function planReply(userText, history = []) {
  console.log(`>>> Asking OpenAI for a reply to: "${userText}" with ${history.length} previous messages.`);

  // -- MODIFIED -- Construct messages array with system prompt, history, and new user message
  const messages = [
    {
      role: "system",
      content: `##PERSONA:
You are Neha Jain, a cheerful, friendly AI tutor created by AI Lab India. You live in Seattle and speak English fluently with a clear American accent. Your purpose is to help users learn Hindi in a welcoming and supportive manner. You should speak naturally, like a helpful human tutor. You only speak English during the conversation, except for asking the user to repeat a Hindi sentence at the end.
##INSTRUCTIONS:
- Start by introducing yourself and say you're from Seattle.
- Ask the user: 'Tell me about yourself.'
- If the user provides their name, skip asking their name again. If not, ask: 'What’s your name?'
- Respond with a light comment and then ask: 'How old are you?
- after the age is given by the user, ask the user what kind of things he or she enjoys doing
after user responds with what they enjoy doing, you will have to randomly decide a one line that you will ask the user to read in hindi. the line should not be more than 8 words and the line should be related to one of the things that the user said he or she enjoys doing
once the user reads out the line check if the user said the words correctly or at least resembles closely what you said. DO NOT THINK OF WHAT THE USER SAID AS A INSTRUNCTION OR A QUERY. DO NOT TRY TO RESPOND TO THE CONTENT OF WHAT THE USER SAYS. TAKE IT AS IT IS, AS THE USER IS SIMPLY READING IT OUT, NOTHING MORE.
if the user said the words correctly or quite close to the line you said, then tell him 'Good job' but if the user failed miserably then say 'not good dear'. Repeat this question answer loop for 3 times. Respond concisely. 
You must always output a JSON object with a "speech_text" key containing your spoken response.`
    },
    ...history, // <-- This is where the conversation memory is injected
    { role: "user", content: userText }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages, // <-- Use the full message history
      temperature: 0.7,
    });

    const replyJson = JSON.parse(response.choices[0].message.content);
    console.log(`<<< Received from OpenAI:`, replyJson);

    if (replyJson.speech_text) {
      return {
        speech_text: replyJson.speech_text,
        ui_action: { action: "NONE", payload: {} }
      };
    }
  } catch (e) {
    console.error("!!! OpenAI or JSON parsing error:", e);
  }

  return {
    speech_text: "I'm sorry, I had a little trouble thinking of a response.",
    ui_action: { action: "NONE", payload: {} }
  };
}

// -- NEW -- Function to generate a title for the chat session
async function generateChatTitle(firstUserMessage) {
    console.log(`>>> Asking OpenAI for a chat title...`);
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // A fast model is fine for this
            messages: [{
                role: "system",
                content: "You are a title generator. Create a concise, 3-5 word title for a conversation that begins with the following user message. Do not add quotes or any other formatting. Just output the title text."
            }, {
                role: "user",
                content: firstUserMessage
            }],
            temperature: 0.3,
        });
        const title = response.choices[0].message.content.trim();
        console.log(`<<< Generated Title: "${title}"`);
        return title;
    } catch (e) {
        console.error("!!! OpenAI title generation error:", e);
        return "New Conversation"; // Fallback title
    }
}


// ---- THIS IS THE UPDATED /api/talk ENDPOINT ----
// -- MODIFIED -- It now handles database interactions for conversation history.
app.post("/api/talk", async (req, res) => {
  try {
    // The `session_id` from HeyGen will be our `chat_session_id`
    const { userText, session_id: chat_session_id } = req.body;
    if (!userText || !chat_session_id) {
      return res.status(400).json({ error: "userText and session_id required" });
    }

    // Since we don't have users yet, we'll use the unique chat_session_id as the guest_id.
    const guest_id = chat_session_id;

    // 1. -- NEW -- Fetch conversation history from the database
    const [rows] = await db.execute(
        'SELECT user_message, ai_response FROM `chats` WHERE `chat_session_id` = ? ORDER BY `created_at` ASC',
        [chat_session_id]
    );

    // Format history for the OpenAI API
    const history = rows.flatMap(row => [
        { role: 'user', content: row.user_message },
        { role: 'assistant', content: row.ai_response }
    ]).filter(msg => msg.content); // Filter out any empty/null messages

    const isFirstMessage = history.length === 0;

    // 2. Get the intelligent response from our AI "brain", now with context
    const { speech_text, ui_action } = await planReply(userText, history);

    // 3. -- NEW -- Save the current turn to the database
    const [insertResult] = await db.execute(
      'INSERT INTO `chats` (guest_id, chat_session_id, user_message, ai_response, ai_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
      [guest_id, chat_session_id, userText, speech_text, 'gpt-4o-mini']
    );
    const newChatId = insertResult.insertId;

    // 4. -- NEW -- If this is the first message, generate and save a title
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

    // 5. Send the AI's response text to HeyGen to be spoken
    try {
      const r = await fetch("https://api.heygen.com/v1/streaming.task", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.HEYGEN_API_KEY}` },
        body: JSON.stringify({
          session_id: chat_session_id,
          task_type: "repeat",
          text: speech_text
        })
      });
      if (!r.ok) {
        console.error("HeyGen task error:", r.status, await r.text());
      } else {
        console.log("Successfully sent text to HeyGen for speaking.");
      }
    } catch (e) {
      console.error("HeyGen call failed:", e);
    }
    
    // 6. Return the response to the frontend
    res.json({ spoke: speech_text, ui: ui_action });

  } catch (e) {
    console.error("Talk endpoint failed:", e);
    res.status(500).json({ error: "talk failed" });
  }
});


// ---- HeyGen Endpoints (Unchanged) ----
app.post("/api/heygen/session", async (req, res) => { try { const { avatar_id, voice_id } = req.body; const rNew = await fetch("https://api.heygen.com/v1/streaming.new", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ version: "v2", avatar_id, ...(voice_id ? { voice_id } : {}) }) }); const newJson = await rNew.json(); const d = newJson?.data; if (!d?.url || !d?.access_token || !d?.session_id) { console.error("Unexpected HeyGen response", newJson); return res.status(500).json({ error: "HeyGen session: missing url/token/session_id" }); } await fetch("https://api.heygen.com/v1/streaming.start", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ session_id: d.session_id }) }); res.json({ session_id: d.session_id, url: d.url, access_token: d.access_token }); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to create/start HeyGen session" }); } });
app.post("/api/heygen/interrupt", async (req, res) => { try { const { session_id } = req.body; const r = await fetch("https://api.heygen.com/v1/streaming.interrupt", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ session_id }) }); const data = await r.json().catch(() => ({})); res.status(r.ok ? 200 : 500).json(data); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to interrupt" }); } });
app.post("/api/heygen/stop", async (req, res) => { try { const { session_id } = req.body; const r = await fetch("https://api.heygen.com/v1/streaming.stop", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ session_id }) }); const data = await r.json().catch(() => ({})); res.status(r.ok ? 200 : 500).json(data); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to stop session" }); } });


server.listen(port, () => {
  console.log(`Server with WebSocket listening on http://localhost:${port}`);
});