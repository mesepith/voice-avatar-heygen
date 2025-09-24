import {
  TranscriptionIcon,
  MicOnIcon,
  MicOffIcon,
  HangUpIcon,
} from "./icons";

export default function Controls({
  status,
  isMicOn,
  onToggleMic,
  onEndSession,
  onShowTranscription,
}) {
  return (
    <div className="bottom-bar">
      <div className="controls-container">
        <button className="icon-button" onClick={onShowTranscription}>
          <TranscriptionIcon />
        </button>
        <div className="status-text">
          <div
            className={`status-dot ${
              isMicOn && status === "Listening..." ? "listening" : ""
            }`}
          ></div>
          <span>
            {isMicOn
              ? status === "Listening..."
                ? "Listening"
                : status
              : "Muted"}
          </span>
        </div>
        <button className="icon-button large-icon-button" onClick={onToggleMic}>
          {isMicOn ? (
            <MicOnIcon size={28} />
          ) : (
            <MicOffIcon size={28} />
          )}
        </button>
        <button
          className="icon-button hangup-button large-icon-button"
          onClick={onEndSession}
        >
          <HangUpIcon size={32} />
        </button>
      </div>
    </div>
  );
}