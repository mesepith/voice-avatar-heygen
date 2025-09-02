import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import textToSpeech from "@google-cloud/text-to-speech";
import { SpeechClient } from "@google-cloud/speech";
import { WebSocketServer } from "ws";
import http from "http";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const port = process.env.PORT || 8787;
const server = http.createServer(app);

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
// It asks OpenAI for a real response and structures it as JSON.
async function planReply(userText) {
  console.log(`>>> Asking OpenAI for a reply to: "${userText}"`);
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      // Enforce JSON output for reliability
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are Wayne, a friendly and helpful AI assistant. Respond concisely. You must always output a JSON object with a "speech_text" key containing your spoken response.`
        },
        { role: "user", content: userText }
      ],
      temperature: 0.7,
    });

    const replyJson = JSON.parse(response.choices[0].message.content);
    console.log(`<<< Received from OpenAI:`, replyJson);

    // Ensure the response has the required key
    if (replyJson.speech_text) {
      return {
        speech_text: replyJson.speech_text,
        // We are keeping ui_action simple for now, but you can expand this later
        ui_action: { action: "NONE", payload: {} }
      };
    }
  } catch (e) {
    console.error("!!! OpenAI or JSON parsing error:", e);
  }

  // Fallback response if OpenAI fails
  return {
    speech_text: "I'm sorry, I had a little trouble thinking of a response.",
    ui_action: { action: "NONE", payload: {} }
  };
}


// ---- THIS IS THE UPDATED /api/talk ENDPOINT ----
// It now calls planReply() and uses the real AI response.
app.post("/api/talk", async (req, res) => {
  try {
    const { userText, session_id } = req.body;
    if (!userText || !session_id) {
      return res.status(400).json({ error: "userText and session_id required" });
    }

    // 1. Get the intelligent response from our AI "brain"
    const { speech_text, ui_action } = await planReply(userText);

    // 2. Send the AI's response text to HeyGen to be spoken
    try {
      const r = await fetch("https://api.heygen.com/v1/streaming.task", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.HEYGEN_API_KEY}` },
        body: JSON.stringify({
          session_id,
          task_type: "repeat",
          text: speech_text // <-- Using the text from OpenAI, not the user's text
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
    
    // 3. Return the response to the frontend
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