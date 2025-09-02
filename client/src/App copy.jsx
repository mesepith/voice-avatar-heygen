import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";

// Helper to manage microphone audio processing (Unchanged)
const createAudioStreamer = (onAudio) => {
  let audioContext;
  let processor;
  let source;
  let stream;

  const start = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const output = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          output[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
        }
        onAudio(output.buffer);
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (error) {
        console.error("Error getting microphone audio:", error);
        alert("Could not access the microphone. Please grant permission and refresh.");
    }
  };
  const stop = () => {
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (source) source.disconnect();
    if (processor) processor.disconnect();
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
  };
  return { start, stop };
};

export default function App() {
  const [interimTranscript, setInterimTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [aiText, setAiText] = useState("");
  const [status, setStatus] = useState("Initializing...");
  
  const videoRef = useRef(null);
  const sessionDataRef = useRef(null);

  useEffect(() => {
    let ws;
    let audioStreamer;
    let room;

    const setup = async () => {
      try {
        setStatus("Creating HeyGen session...");
        const sessionRes = await fetch("http://localhost:8787/api/heygen/session", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avatar_id: "Wayne_20240711" }),
        });
        if (!sessionRes.ok) throw new Error("Failed to create HeyGen session");
        const sessionData = await sessionRes.json();
        sessionDataRef.current = sessionData;

        room = new Room();
        await room.connect(sessionData.url, sessionData.access_token);
        room.on(RoomEvent.TrackSubscribed, (track) => {
          const el = track.attach();
          videoRef.current?.appendChild(el);
        });
        
        setStatus("Connecting to microphone...");
        ws = new WebSocket(`ws://localhost:8787`);
        let accumulatedFinalTranscript = "";

        ws.onopen = () => {
          audioStreamer = createAudioStreamer((audioChunk) => {
            if (ws?.readyState === WebSocket.OPEN) ws.send(audioChunk);
          });
          audioStreamer.start();
          setStatus("Listening...");
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.results && data.results.length > 0) {
            const result = data.results[0];
            const transcript = result.alternatives[0].transcript;

            // --- THE ONLY CHANGE IS HERE ---
            // It's `result.isFinal` (camelCase), not `result.is_final`
            console.log(`Received transcript: "${transcript}", isFinal: ${result.isFinal}`);

            if (result.isFinal) {
              accumulatedFinalTranscript += " " + transcript;
              setFinalTranscript(accumulatedFinalTranscript.trim());
              setInterimTranscript("");
              sendToLLM(transcript.trim());
            } else {
              setInterimTranscript(transcript);
            }
          }
        };

        ws.onclose = () => setStatus("Disconnected.");
        ws.onerror = (error) => {
          console.error("WebSocket error:", error);
          setStatus("Connection error.");
        };

      } catch (error) {
        console.error("Setup failed:", error);
        setStatus(`Error: ${error.message}`);
      }
    };

    setup();

    return () => {
      console.log("Running cleanup...");
      if (ws) ws.close();
      if (audioStreamer) audioStreamer.stop();
      if (room) room.disconnect();
      if (sessionDataRef.current?.session_id) {
        const payload = JSON.stringify({ session_id: sessionDataRef.current.session_id });
        navigator.sendBeacon("http://localhost:8787/api/heygen/stop", payload);
      }
    };
  }, []);
  
  async function sendToLLM(text) {
    const currentSession = sessionDataRef.current;
    if (!text || !currentSession?.session_id) return;
    
    fetch("http://localhost:8787/api/heygen/interrupt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: currentSession.session_id })
    });
    
    try {
      const r = await fetch("http://localhost:8787/api/talk", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userText: text, session_id: currentSession.session_id })
      });
      const data = await r.json();
      if (data.spoke) {
        setAiText(prev => (prev + " " + data.spoke).trim());
      }
    } catch (e) {
      console.error("sendToLLM fetch error:", e);
    }
  }

  const isListening = status === "Listening...";
  return (
    <div style={{ display:"grid", gap:12, padding:16, maxWidth:900, margin:"0 auto", fontFamily:'sans-serif' }}>
      <h2>HeyGen + AI (Google Streaming STT Backend)</h2>
      <div ref={videoRef} style={{ width:"100%", borderRadius:12, overflow:'hidden', backgroundColor:'#000', minHeight: '506px' }} />
      <div style={{ display:"flex", gap:12, alignItems: "center" }}>
        <div style={{
            width: 20, height: 20,
            backgroundColor: isListening ? '#2ecc71' : '#f39c12',
            borderRadius: '50%', transition: 'all 0.3s ease',
            boxShadow: isListening ? '0 0 10px #2ecc71' : 'none'
          }}
          title={status}
        />
        <p style={{ flex: 1, margin: 0, padding: '8px', border: '1px solid #ccc', borderRadius: '4px', minHeight: '24px', backgroundColor: '#f9f9f9' }}>
          {finalTranscript} <em style={{opacity: 0.6}}>{interimTranscript}</em>
        </p>
      </div>
      <div>
        <strong>Status:</strong> {status}
      </div>
      <div>
        <strong>AI Response:</strong>
        <p style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{aiText || "—"}</p>
      </div>
    </div>
  );
}