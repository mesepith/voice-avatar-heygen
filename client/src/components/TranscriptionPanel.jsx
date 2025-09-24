import { useEffect, useRef } from "react";
import { CloseIcon } from "./icons";

export default function TranscriptionPanel({
  isOpen,
  onClose,
  conversation,
  interimTranscript,
}) {
  const transcriptionContainerRef = useRef(null);
  useEffect(() => {
    transcriptionContainerRef.current?.scrollTo({
      top: transcriptionContainerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [conversation, interimTranscript]);
  return (
    <div className={`transcription-panel ${isOpen ? "open" : ""}`}>
      <div className="transcription-header">
        <span>Transcription</span>
        <button className="icon-button transcription-close-button" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="transcription-content" ref={transcriptionContainerRef}>
        {conversation.map((msg, index) => (
          <div key={index} className="transcription-message">
            <strong>{msg.speaker}</strong>
            {msg.text}
          </div>
        ))}
        {interimTranscript && (
          <div className="transcription-message" style={{ opacity: 0.7 }}>
            <strong>User</strong>
            {interimTranscript}
          </div>
        )}
      </div>
    </div>
  );
}