import { useEffect, useRef, useState, useCallback } from "react";
import { Room, RoomEvent } from "livekit-client";

// --- Environment-aware API URLs ---
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787';
const WS_URL = API_BASE_URL.replace(/^http/, 'ws');

// --- Helper Function (Unchanged) ---
const createAudioStreamer = (onAudio) => {
  let audioContext;
  let processor;
  let source;
  let stream;

  const start = async (mediaStream) => {
    try {
      stream = mediaStream;
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
        console.error("Error setting up audio processing:", error);
    }
  };

  const stop = () => {
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
  const [isSessionActive, setIsSessionActive] = useState(false); // -- NEW -- State for session status

  const userVideoRef = useRef(null);
  const videoRef = useRef(null);
  
  // -- NEW -- Convert key variables to refs to access them in the stop function
  const sessionDataRef = useRef(null);
  const userStreamRef = useRef(null);
  const roomRef = useRef(null);
  const wsRef = useRef(null);
  const audioStreamerRef = useRef(null);


  // -- NEW -- Central function to stop all connections and services
  const handleStopSession = useCallback(async () => {
    // Prevent function from running if session is already stopped
    if (!sessionDataRef.current?.session_id) return;
    
    console.log("Stopping Heygen session...");
    setStatus("Session ended.");
    setIsSessionActive(false);

    // 1. Close WebSocket connection
    if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
    }
    // 2. Stop the audio streamer
    if (audioStreamerRef.current) {
        audioStreamerRef.current.stop();
        audioStreamerRef.current = null;
    }
    // 3. Disconnect from LiveKit room
    if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
    }
    // 4. Stop camera/mic tracks
    if (userStreamRef.current) {
        userStreamRef.current.getTracks().forEach(track => track.stop());
        userStreamRef.current = null;
    }
    // 5. Call backend to terminate Heygen session
    try {
        await fetch(`${API_BASE_URL}/api/heygen/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionDataRef.current.session_id }),
        });
        console.log("Successfully sent stop signal to backend.");
        sessionDataRef.current = null; // Clear session data
    } catch (error) {
        console.error("Failed to send stop signal to backend:", error);
    }
  }, []); // Empty dependency array as it uses refs, which don't trigger re-renders


  useEffect(() => {
    const setup = async () => {
      try {
        setStatus("Waiting for camera/mic permission...");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
          video: true
        });
        userStreamRef.current = stream;

        if (userVideoRef.current) {
          userVideoRef.current.srcObject = stream;
        }

        setStatus("Creating HeyGen session...");
        const sessionRes = await fetch(`${API_BASE_URL}/api/heygen/session`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avatar_id: "Marianne_CasualLook_public" }),
        });
        if (!sessionRes.ok) throw new Error("Failed to create HeyGen session");
        sessionDataRef.current = await sessionRes.json();

        const room = new Room();
        roomRef.current = room; // Store room in ref
        await room.connect(sessionDataRef.current.url, sessionDataRef.current.access_token);
        room.on(RoomEvent.TrackSubscribed, (track) => {
          const el = track.attach();
          videoRef.current?.appendChild(el);
        });
        
        setStatus("Connecting to backend...");
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws; // Store WebSocket in ref
        let accumulatedFinalTranscript = "";

        ws.onopen = () => {
          const audioStreamer = createAudioStreamer((audioChunk) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(audioChunk);
            }
          });
          audioStreamerRef.current = audioStreamer; // Store streamer in ref

          if (userStreamRef.current) {
            audioStreamer.start(userStreamRef.current);
            setStatus("Listening...");
            setIsSessionActive(true); // -- NEW -- Session is now active
          } else {
            throw new Error("User media stream not available.");
          }
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.results && data.results.length > 0) {
            const result = data.results[0];
            const transcript = result.alternatives[0].transcript;
            
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
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
             alert("Could not access the microphone and camera. Please grant permission and refresh.");
             setStatus("Permission denied. Please refresh and allow access.");
        } else {
            setStatus(`Error: ${error.message}`);
        }
        setIsSessionActive(false); // Ensure session is marked as inactive on error
      }
    };

    setup();

    // -- MODIFIED -- Cleanup now calls the central stop function
    return () => {
      console.log("Running cleanup on component unmount...");
      handleStopSession();
    };
  }, [handleStopSession]); // Add handleStopSession to dependency array
  
  async function sendToLLM(text) {
    if (!text || !sessionDataRef.current?.session_id || !isSessionActive) return;
    
    fetch(`${API_BASE_URL}/api/heygen/interrupt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionDataRef.current.session_id })
    });
    
    try {
      const r = await fetch(`${API_BASE_URL}/api/talk`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userText: text, session_id: sessionDataRef.current.session_id })
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
  
  const videoContainerStyle = { position: 'relative', width: "100%", borderRadius: 12, overflow: 'hidden', backgroundColor: '#000', aspectRatio: '16 / 9' };
  const userVideoStyle = { position: 'absolute', bottom: '20px', right: '20px', width: '25%', maxWidth: '280px', borderRadius: '8px', border: '2px solid rgba(255, 255, 255, 0.5)', boxShadow: '0 4px 15px rgba(0,0,0,0.3)', transform: 'scaleX(-1)', zIndex: 10, };

  return (
    <div style={{ display:"grid", gap:12, padding:16, maxWidth:900, margin:"0 auto", fontFamily:'sans-serif' }}>
      <h2>HeyGen + AI (Google Meet Style)</h2>

      <div style={videoContainerStyle}>
        <div ref={videoRef} style={{ width: "100%", height: "100%" }} />
        <video ref={userVideoRef} style={userVideoStyle} autoPlay muted playsInline />
      </div>

      <div style={{ display:"flex", gap:12, alignItems: "center" }}>
        <div style={{ width: 20, height: 20, backgroundColor: isListening ? '#2ecc71' : '#f39c12', borderRadius: '50%', transition: 'all 0.3s ease', boxShadow: isListening ? '0 0 10px #2ecc71' : 'none' }} title={status} />
        <p style={{ flex: 1, margin: 0, padding: '8px', border: '1px solid #ccc', borderRadius: '4px', minHeight: '24px', backgroundColor: '#f9f9f9' }}>
          {finalTranscript} <em style={{opacity: 0.6}}>{interimTranscript}</em>
        </p>
      </div>

      {/* -- NEW -- Stop Button and Status Display -- */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <strong>Status:</strong> {status}
        </div>
        <button
          onClick={handleStopSession}
          disabled={!isSessionActive}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            cursor: isSessionActive ? 'pointer' : 'not-allowed',
            backgroundColor: isSessionActive ? '#e74c3c' : '#bdc3c7',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            transition: 'background-color 0.3s ease'
          }}
        >
          Stop Heygen
        </button>
      </div>
      {/* -- END NEW -- */}

      <div>
        <strong>AI Response:</strong>
        <p style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{aiText || "—"}</p>
      </div>
    </div>
  );
}