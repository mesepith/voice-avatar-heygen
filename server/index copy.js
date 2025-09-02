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
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("!!! CRITICAL: GOOGLE_APPLICATION_CREDENTIALS environment variable is not set!");
} else {
    console.log(`✓ GOOGLE_APPLICATION_CREDENTIALS is set to: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
}

// --- WebSocket Server for STT ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected for STT streaming');
  let recognizeStream = null;

  try {
    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
      },
      interimResults: true,
    };
    
    console.log('>>> Creating new Google Speech-to-Text stream...');
    recognizeStream = speechClient
      .streamingRecognize(request)
      .on('error', (err) => {
        // This is a critical log. If you see this, there's a problem with the stream itself.
        console.error('!!! GOOGLE STT STREAM ERROR !!!:', err);
      })
      .on('data', (data) => {
        // This log confirms we are getting a response from Google.
        console.log('<<< Received transcript from Google:', JSON.stringify(data));
        // Forward the transcript back to the client
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(data));
        }
      });
  } catch(e) {
      console.error("!!! FAILED TO CREATE GOOGLE STT STREAM !!!", e);
  }


  ws.on('message', (message) => {
    // console.log(`Received audio chunk of size: ${message.length}`); // This can be noisy, let's disable for now
    if (recognizeStream) {
      recognizeStream.write(message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected, closing Google stream.');
    if (recognizeStream) {
      recognizeStream.end();
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
    if (recognizeStream) {
      recognizeStream.end();
    }
  });
});


// ---- Helper: ask OpenAI ----
async function planReply(userText) { /* ... Unchanged ... */ return { speech_text: "Placeholder", ui_action: { action: "NONE" } } }
// ---- HeyGen and Talk Endpoints (UNCHANGED) ----
app.post("/api/heygen/session", async (req, res) => { try { const { avatar_id, voice_id } = req.body; const rNew = await fetch("https://api.heygen.com/v1/streaming.new", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ version: "v2", avatar_id, ...(voice_id ? { voice_id } : {}) }) }); const newJson = await rNew.json(); const d = newJson?.data; if (!d?.url || !d?.access_token || !d?.session_id) { console.error("Unexpected HeyGen response", newJson); return res.status(500).json({ error: "HeyGen session: missing url/token/session_id" }); } await fetch("https://api.heygen.com/v1/streaming.start", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ session_id: d.session_id }) }); res.json({ session_id: d.session_id, url: d.url, access_token: d.access_token }); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to create/start HeyGen session" }); } });
app.post("/api/heygen/interrupt", async (req, res) => { try { const { session_id } = req.body; const r = await fetch("https://api.heygen.com/v1/streaming.interrupt", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ session_id }) }); const data = await r.json().catch(() => ({})); res.status(r.ok ? 200 : 500).json(data); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to interrupt" }); } });
app.post("/api/heygen/stop", async (req, res) => { try { const { session_id } = req.body; const r = await fetch("https://api.heygen.stop", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ session_id }) }); const data = await r.json().catch(() => ({})); res.status(r.ok ? 200 : 500).json(data); } catch (e) { console.error(e); res.status(500).json({ error: "Failed to stop session" }); } });
app.post("/api/talk", async (req, res) => { try { const { userText, session_id } = req.body; if (!userText || !session_id) { return res.status(400).json({ error: "userText and session_id required" }); } let speech_text="I heard you say " + userText, ui_action={action:"NONE"}; try { const r = await fetch("https://api.heygen.com/v1/streaming.task", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.HEYGEN_API_KEY}` }, body: JSON.stringify({ session_id, task_type: "repeat", text: speech_text }) }); if (!r.ok) { console.error("HeyGen task error:", r.status, await r.text()); } } catch (e) { console.error("HeyGen call failed:", e); } let ttsAudio = null; try { const [audio] = await ttsClient.synthesizeSpeech({ input: { text: speech_text }, voice: { languageCode: "en-US", name: "en-US-Neural2-C" }, audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 } }); ttsAudio = `data:audio/mpeg;base64,${Buffer.from(audio.audioContent).toString("base64")}`; } catch (e) { console.error("TTS synth failed:", e); } res.json({ spoke: speech_text, ui: ui_action, ttsAudio }); } catch (e) { console.error("talk failed:", e); res.status(500).json({ error: "talk failed" }); } });


server.listen(port, () => {
  console.log(`Server with WebSocket listening on http://localhost:${port}`);
});