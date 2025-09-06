//
// server/services/webSocketService.js
//
import { WebSocketServer } from "ws";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { deepgramClient } from "../config/clients.js";
import { logDeepgramApiCall, logThirdPartyError } from '../utils/logging.js';
import { nowIso } from '../utils/helpers.js';

export function initializeWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('Client connected for STT streaming with Deepgram');

    const connectStarted = Date.now();
    let lastAudioChunkSentAt = null;
    let sessionId = null;

    const dg = deepgramClient.listen.live({
      model: 'nova-3', language: 'multi', punctuate: true, interim_results: true,
      smart_format: true, endpointing: 100, encoding: 'linear16', sample_rate: 16000,
    });

    let keepAlive;

    dg.on(LiveTranscriptionEvents.Open, async () => {
      const opened = Date.now();
      console.log('✓ Deepgram connection opened.');
      keepAlive = setInterval(() => { if (dg.getReadyState() === 1) dg.keepAlive(); }, 10_000);

      await logDeepgramApiCall({
        chat_session_id: sessionId, deepgram_api_endpoint: 'listen.live.open',
        elapsed_ms: opened - connectStarted, started_at: nowIso(connectStarted), finished_at: nowIso(opened),
        notes: 'WebSocket handshake open'
      });

      dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
        const transcript = data.channel.alternatives?.[0]?.transcript || "";
        if (transcript && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            results: [{
              alternatives: [{ transcript }],
              isFinal: data.is_final,
              speechFinal: data.speech_final
            }]
          }));
        }

        const finished = Date.now();
        const elapsed = lastAudioChunkSentAt ? (finished - lastAudioChunkSentAt) : null;

        await logDeepgramApiCall({
          chat_session_id: sessionId, deepgram_api_endpoint: 'listen.live.transcript',
          elapsed_ms: elapsed, started_at: lastAudioChunkSentAt ? nowIso(lastAudioChunkSentAt) : null,
          finished_at: nowIso(finished), response_payload: { is_final: data.is_final, transcript_len: transcript.length },
          notes: data.is_final ? 'final' : 'interim'
        });
      });

      dg.on(LiveTranscriptionEvents.Error, async (err) => {
        console.error('!!! DEEPGRAM STT STREAM ERROR:', err);
        const e = {
          service_by: 'deepgram', provider_endpoint: 'listen.live', chat_session_id: sessionId,
          error_code: err?.code || null, error_type: 'websocket_error', error_message: err?.message || String(err),
          response_payload: err, stack_trace: err?.stack || null
        };
        await logThirdPartyError(e);
      });

      dg.on(LiveTranscriptionEvents.Close, async () => {
        console.log('Deepgram connection closed.');
        clearInterval(keepAlive);
        await logDeepgramApiCall({
          chat_session_id: sessionId, deepgram_api_endpoint: 'listen.live.close', notes: 'WebSocket closed by server/client'
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
}