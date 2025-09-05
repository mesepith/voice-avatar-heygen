import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";

// --- Environment-aware API URLs ---
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787';
const WS_URL = API_BASE_URL.replace(/^http/, 'ws');

// --- SVG Icon Components ---
const Icon = ({ path }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d={path} />
  </svg>
);
const TranscriptionIcon = () => <Icon path="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />;
const VolumeUpIcon = () => <Icon path="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />;
const FlipCameraIcon = () => <Icon path="M20 4h-3.17L15 2H9L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 11.5V13H9v2.5L5.5 12 9 8.5V11h6V8.5l3.5 3.5-3.5 3.5z" />;
const VideoOnIcon = () => <Icon path="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />;
const MicOnIcon = () => <Icon path="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z" />;
const MoreIcon = () => <Icon path="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />;
const HangUpIcon = () => <Icon path="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.1-2.66 1.82-.08.08-.18.11-.28.11s-.2-.03-.28-.11l-1.4-1.4a.42.42 0 0 1 0-.6c1.02-1.09 2.2-1.99 3.48-2.66.33-.17.54-.51.54-.88V7.07C5.86 8.52 4.05 10.68 4.05 12c0 1.32.84 2.87 2.02 4.02l1.41 1.41c.08.08.18.11.28.11s.2-.03.28-.11C9.12 16.44 10.68 15 12 15c.67 0 1.29-.14 1.86-.39.2-.09.28-.33.18-.53l-1.02-1.9c-.11-.22-.38-.28-.58-.17-1.15.59-2.48.9-3.44.9-1.2 0-2.68-.61-3.62-1.55.93-.93 2.42-1.55 3.62-1.55 1.05 0 2.28.35 3.53 1.03.17.09.38.03.48-.13l1.04-1.68c.13-.21.07-.49-.13-.62C14.77 9.39 13.43 9 12 9z" />;
const CloseIcon = () => <Icon path="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />;


// --- Audio Streamer Helper ---
const createAudioStreamer = (onAudio) => {
  let audioContext, processor, source;
  const start = async (mediaStream) => {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      source = audioContext.createMediaStreamSource(mediaStream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => onAudio(new Int16Array(e.inputBuffer.getChannelData(0).map(n => n * 32767)).buffer);
      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (error) { console.error("Error setting up audio processing:", error); }
  };
  const stop = () => {
    source?.disconnect();
    processor?.disconnect();
    audioContext?.state !== 'closed' && audioContext?.close();
  };
  return { start, stop };
};

// --- Main App Component ---
export default function App() {
  const [interimTranscript, setInterimTranscript] = useState("");
  const [conversation, setConversation] = useState([]);
  const [status, setStatus] = useState("Initializing...");
  const [showTranscription, setShowTranscription] = useState(false);
  
  const userVideoRef = useRef(null);
  const userStreamRef = useRef(null);
  const videoRef = useRef(null);
  const sessionDataRef = useRef(null);
  const transcriptionContainerRef = useRef(null);

  useEffect(() => {
    let ws, audioStreamer, room;
    let finalTranscriptTimeout;
    let accumulatedFinalTranscript = "";

    const setup = async () => {
      try {
        setStatus("Waiting for camera/mic permission...");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
          video: true
        });
        userStreamRef.current = stream;
        if (userVideoRef.current) userVideoRef.current.srcObject = stream;

        setStatus("Creating HeyGen session...");
        const res = await fetch(`${API_BASE_URL}/api/heygen/session`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avatar_id: "Marianne_CasualLook_public" }),
        });
        if (!res.ok) throw new Error(`Failed to create HeyGen session: ${res.statusText}`);
        sessionDataRef.current = await res.json();

        room = new Room();
        await room.connect(sessionDataRef.current.url, sessionDataRef.current.access_token);
        room.on(RoomEvent.TrackSubscribed, (track) => videoRef.current?.appendChild(track.attach()));
        
        setStatus("Connecting to backend...");
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
          audioStreamer = createAudioStreamer((audioChunk) => ws?.readyState === WebSocket.OPEN && ws.send(audioChunk));
          audioStreamer.start(userStreamRef.current);
          setStatus("Listening...");
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          const transcript = data.results?.[0]?.alternatives?.[0]?.transcript;
          if (!transcript) return;

          if (data.results[0].isFinal) {
              accumulatedFinalTranscript += transcript + " ";
              setInterimTranscript(""); 

              clearTimeout(finalTranscriptTimeout);
              finalTranscriptTimeout = setTimeout(() => {
                  if (accumulatedFinalTranscript.trim()) {
                      const fullUtterance = accumulatedFinalTranscript.trim();
                      setConversation(prev => [...prev, { speaker: 'User', text: fullUtterance }]);
                      sendToLLM(fullUtterance);
                      accumulatedFinalTranscript = ""; 
                  }
              }, 800); 
          } else {
              setInterimTranscript(accumulatedFinalTranscript + transcript);
          }
        };
        ws.onclose = () => setStatus("Disconnected.");
        ws.onerror = () => setStatus("Connection error.");
      } catch (error) {
        console.error("Setup failed:", error);
        setStatus(error.name === 'NotAllowedError' ? "Permission denied. Please refresh and allow access." : `Error: ${error.message}`);
      }
    };
    setup();
    return () => {
      userStreamRef.current?.getTracks().forEach(track => track.stop());
      ws?.close();
      audioStreamer?.stop();
      room?.disconnect();
      clearTimeout(finalTranscriptTimeout);
      if (sessionDataRef.current?.session_id) {
        navigator.sendBeacon(`${API_BASE_URL}/api/heygen/stop`, JSON.stringify({ session_id: sessionDataRef.current.session_id }));
      }
    };
  }, []);

  useEffect(() => {
    transcriptionContainerRef.current?.scrollTo({ top: transcriptionContainerRef.current.scrollHeight, behavior: 'smooth' });
  }, [conversation, interimTranscript]);

  async function sendToLLM(text) {
    if (!text || !sessionDataRef.current?.session_id) return;
    try {
      fetch(`${API_BASE_URL}/api/heygen/interrupt`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionDataRef.current.session_id })
      });
      const res = await fetch(`${API_BASE_URL}/api/talk`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userText: text, session_id: sessionDataRef.current.session_id })
      });
      const data = await res.json();
      if (data.spoke) {
        setConversation(prev => [...prev, { speaker: 'AI', text: data.spoke }]);
      }
    } catch (e) { console.error("sendToLLM fetch error:", e); }
  }

  return (
    <>
      <style>{`
        :root { --control-bar-height: 80px; --pip-bottom-margin: calc(var(--control-bar-height) + 16px); }
        body { margin: 0; font-family: 'Google Sans', sans-serif; background-color: #202124; color: #fff; overflow: hidden; }
        .app-container { position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; }
        .ai-video-container { flex-grow: 1; height: 100%; display: flex; align-items: center; justify-content: center; position: relative; }
        .ai-video-container video { width: 100%; height: 100%; object-fit: contain; }
        .ui-overlays { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
        .top-bar, .bottom-bar { position: absolute; left: 16px; right: 16px; display: flex; align-items: center; pointer-events: auto; }
        .top-bar { top: 16px; justify-content: space-between; }
        .bottom-bar { bottom: 16px; justify-content: center; }
        .top-left, .top-right { display: flex; align-items: center; gap: 8px; }
        .icon-button { background: rgba(60, 64, 67, 0.8); border: none; border-radius: 50%; width: 48px; height: 48px; display: flex; justify-content: center; align-items: center; color: white; cursor: pointer; backdrop-filter: blur(4px); }
        .icon-button:hover { background: rgba(80, 84, 87, 0.9); }
        .controls-container { background: rgba(32, 33, 36, 0.9); border-radius: 30px; padding: 8px; display: flex; gap: 8px; backdrop-filter: blur(8px); }
        .hangup-button { background-color: #ea4335; }
        .hangup-button:hover { background-color: #f06a5e; }
        .user-video-pip { position: absolute; right: 16px; bottom: var(--pip-bottom-margin); width: clamp(150px, 22vw, 280px); border-radius: 12px; border: 2px solid rgba(255, 255, 255, 0.2); box-shadow: 0 4px 15px rgba(0,0,0,0.3); z-index: 10; overflow: hidden; pointer-events: auto; }
        .user-video-pip video { width: 100%; height: 100%; transform: scaleX(-1); display: block; }
        .transcription-panel { background: #202124; width: min(400px, 90vw); height: 100%; display: flex; flex-direction: column; transform: translateX(-100%); transition: transform 0.3s ease-in-out; border-right: 1px solid #3c4043; position: absolute; z-index: 20; left: 0; top: 0; }
        .transcription-panel.open { transform: translateX(0); }
        .transcription-header { flex-shrink: 0; padding: 16px; font-size: 1.25rem; border-bottom: 1px solid #3c4043; display: flex; justify-content: space-between; align-items: center; }
        .transcription-close-button { background: rgba(60, 64, 67, 0.8); color: #ffffff; } /* Corrected style */
        .transcription-close-button:hover { background: rgba(80, 84, 87, 0.9); } /* Corrected style */
        .transcription-content { flex-grow: 1; overflow-y: auto; padding: 16px; }
        .transcription-message { margin-bottom: 16px; line-height: 1.5; }
        .transcription-message strong { color: #8ab4f8; display: block; margin-bottom: 4px; font-weight: 500; }
        .status-text { display: flex; align-items: center; gap: 8px; background: rgba(32, 33, 36, 0.9); padding: 4px 16px 4px 12px; border-radius: 16px; font-size: 0.9rem; pointer-events: none; z-index: 5; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background-color: #e84135; }
        .status-dot.listening { animation: pulse 1.5s infinite; background-color: #34a853; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(52, 168, 83, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(52, 168, 83, 0); } 100% { box-shadow: 0 0 0 0 rgba(52, 168, 83, 0); } }
        .backdrop { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 19; opacity: 0; transition: opacity 0.3s ease-in-out; pointer-events: none; }
        .backdrop.open { opacity: 1; pointer-events: auto; }

        @media (min-width: 769px) { .backdrop { display: none; } }
        @media (max-width: 768px) {
          .main-content.panel-open .ai-video-container { margin-left: 0; }
          .transcription-panel { width: 85vw; max-width: 400px; }
          .user-video-pip { right: 8px; bottom: calc(var(--control-bar-height) + 8px); }
          .bottom-bar { left: 8px; right: 8px; bottom: 8px; }
        }
      `}</style>
      <div className="app-container">
        {showTranscription && <div className="backdrop open" onClick={() => setShowTranscription(false)} />}
        <div className={`transcription-panel ${showTranscription ? 'open' : ''}`}>
            <div className="transcription-header">
              <span>Transcription</span>
              <button className="icon-button transcription-close-button" onClick={() => setShowTranscription(false)}><CloseIcon/></button>
            </div>
            <div className="transcription-content" ref={transcriptionContainerRef}>
              {conversation.map((msg, index) => (
                <div key={index} className="transcription-message">
                  <strong>{msg.speaker}</strong>
                  {msg.text}
                </div>
              ))}
              {interimTranscript && <div className="transcription-message" style={{ opacity: 0.7 }}><strong>User</strong>{interimTranscript}</div>}
            </div>
        </div>

        <div className="ai-video-container">
          <div ref={videoRef} style={{width: "100%", height: "100%"}} />
          <div className="ui-overlays">
            <div className="top-bar">
              <div className="top-left">
                <button className="icon-button" onClick={() => setShowTranscription(true)}><TranscriptionIcon /></button>
              </div>
              <div className="top-right">
                <button className="icon-button"><VolumeUpIcon /></button>
                <button className="icon-button"><FlipCameraIcon /></button>
              </div>
            </div>
            
            <div className="user-video-pip">
              <video ref={userVideoRef} autoPlay muted playsInline />
            </div>

            <div className="bottom-bar">
              <div className="controls-container">
                <div className="status-text">
                  <div className={`status-dot ${status === 'Listening...' ? 'listening' : ''}`}></div>
                  <span>{status === 'Listening...' ? 'Listening' : status}</span>
                </div>
                <button className="icon-button"><VideoOnIcon /></button>
                <button className="icon-button"><MicOnIcon /></button>
                <button className="icon-button"><MoreIcon /></button>
                <button className="icon-button hangup-button"><HangUpIcon /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}