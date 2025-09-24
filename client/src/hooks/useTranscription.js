import { useRef, useState } from "react";
import { createAudioStreamer } from "../utils/audioStreamer";
import { sendToLLM } from "../services/api";

const WS_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8787"
).replace(/^http/, "ws");

export default function useTranscription({ onTranscriptFinalized }) {
  const [interimTranscript, setInterimTranscript] = useState("");
  const wsRef = useRef(null);
  const audioStreamerRef = useRef(null);

  const startTranscription = (stream, sessionId, onAIResponse) => {
    wsRef.current = new WebSocket(WS_URL);
    let accumulatedTranscript = "";

    wsRef.current.onopen = () => {
      audioStreamerRef.current = createAudioStreamer(
        (audioChunk) =>
          wsRef.current?.readyState === WebSocket.OPEN &&
          wsRef.current.send(audioChunk)
      );
      audioStreamerRef.current.start(stream);
      // Send initial message
      sendToLLM("Hello", sessionId).then(onAIResponse);
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const transcript = data.results?.[0]?.alternatives?.[0]?.transcript;
      const isFinal = data.results?.[0]?.isFinal;
      const speechFinal = data.results?.[0]?.speechFinal;

      if (!transcript) return;

      if (isFinal) {
        accumulatedTranscript += transcript + " ";
      }

      setInterimTranscript(accumulatedTranscript + (isFinal ? "" : transcript));

      if (speechFinal && accumulatedTranscript.trim()) {
        const fullUtterance = accumulatedTranscript.trim();
        onTranscriptFinalized(fullUtterance); // Update UI with user's final words
        sendToLLM(fullUtterance, sessionId).then(onAIResponse); // Get AI response
        accumulatedTranscript = "";
        setInterimTranscript("");
      }
    };
  };

  const stopTranscription = () => {
    wsRef.current?.close();
    audioStreamerRef.current?.stop();
  };

  return { interimTranscript, startTranscription, stopTranscription };
}