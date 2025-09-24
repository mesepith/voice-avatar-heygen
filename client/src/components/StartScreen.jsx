import { ReplayIcon } from "./icons";

export default function StartScreen() {
  return (
    <div className="start-again-container">
      <button
        className="icon-button start-again-button"
        onClick={() => window.location.reload()}
      >
        <ReplayIcon size={32} />
      </button>
      <span>Start Again</span>
    </div>
  );
}