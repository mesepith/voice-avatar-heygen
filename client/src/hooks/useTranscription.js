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
  const speechTimeoutRef = useRef(null); // To hold the timeout ID for the fallback

  const startTranscription = (stream, sessionId, onAIResponse) => {
    wsRef.current = new WebSocket(WS_URL);
    let accumulatedTranscript = "";

    const sendFinalUtterance = () => {
      // It's possible for interimTranscript to hold the last few words
      const fullUtterance = (accumulatedTranscript + interimTranscript).trim();

      if (fullUtterance) {
        onTranscriptFinalized(fullUtterance); // Update UI with user's final words
        sendToLLM(fullUtterance, sessionId).then(onAIResponse); // Get AI response
        accumulatedTranscript = "";
        setInterimTranscript("");
      }
    };

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

      // Always clear the previous fallback timer when new data arrives
      if (speechTimeoutRef.current) {
        clearTimeout(speechTimeoutRef.current);
      }

      if (isFinal) {
        accumulatedTranscript += transcript + " ";
        setInterimTranscript(""); // This part is final, clear the interim display
      } else {
        setInterimTranscript(transcript); // Update interim display with the latest part
      }

      // PRIMARY MECHANISM: If speechFinal is true, send immediately.
      if (speechFinal) {
        console.log("`speechFinal` received. Sending to backend.");
        sendFinalUtterance();
        return; // The utterance is sent, no need to set a fallback timer.
      }

      // FALLBACK MECHANISM: If speechFinal is not received, set a timer.
      // It will fire if no new words come in after 500 milliseconds.
      const currentUtterance = (accumulatedTranscript + transcript).trim();
      if (currentUtterance) {
        speechTimeoutRef.current = setTimeout(() => {
          console.warn("500 millisecond fallback timer triggered. Sending to backend.");
          sendFinalUtterance();
        }, 500); // 500-millisecond delay
      }
    };
  };

  const stopTranscription = () => {
    // Clear any pending timeout when stopping.
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
    }
    wsRef.current?.close();
    audioStreamerRef.current?.stop();
  };

  return { interimTranscript, startTranscription, stopTranscription };
}