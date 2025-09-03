import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import textToSpeech from "@google-cloud/text-to-speech";
import { SpeechClient } from "@google-cloud/speech";
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
const speechClient = new SpeechClient();

if (!process.env.OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); }
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`✓ GOOGLE_APPLICATION_CREDENTIALS is set to: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else {
    console.error("!!! CRITICAL: GOOGLE_APPLICATION_CREDENTIALS environment variable is not set!");
}

// --- WebSocket Server for STT (Unchanged) ---
const wss = new WebSocketServer({ server });
// ... (WebSocket server code remains the same)
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
          alternativeLanguageCodes: ['hi-IN'], 
          enableAutomaticPunctuation: true,
          model: 'telephony',
          useEnhanced: true,
        },
        interimResults: true,
      })
      .on('error', (err) => console.error('GOOGLE STT STREAM ERROR:', err))
      .on('data', (data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(data)));
  } catch(e) { console.error("FAILED TO CREATE GOOGLE STT STREAM", e); }
  ws.on('message', (message) => recognizeStream?.write(message));
  ws.on('close', () => recognizeStream?.end());
});


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
async function planReply(userText, history = []) { /* ... function is unchanged ... */ }
async function generateChatTitle(firstUserMessage) { /* ... function is unchanged ... */ }
// ... (The full code for planReply and generateChatTitle is omitted for brevity but should be kept)


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

    const { speech_text, ui_action } = await planReply(userText, history);

    const [insertResult] = await db.execute(
      'INSERT INTO `chats` (guest_id, chat_session_id, user_message, ai_response, ai_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
      [guest_id, chat_session_id, userText, speech_text, 'gpt-4o-mini']
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