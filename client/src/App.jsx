import { useState } from "react";
import useSession from "./hooks/useSession";
import Controls from "./components/Controls";
import VideoDisplay from "./components/VideoDisplay";
import Overlays from "./components/Overlays";
import TranscriptionPanel from "./components/TranscriptionPanel";
import StartScreen from "./components/StartScreen";
import "./App.css";

/*
@author: Zahir
@description: Main application component that manages the video call session, controls, and transcription features
*/
export default function App() {
  const [showTranscription, setShowTranscription] = useState(false);
  const {
    status,
    isSessionActive,
    userVideoRef,
    videoRef,
    isMicOn,
    isVideoOn,
    conversation,
    interimTranscript,
    hindiLine,
    textOptions,
    isLayoutShifted, // Get the new state from the hook
    endSession,
    handleToggleMic,
    handleToggleVideo,
  } = useSession();

  if (!isSessionActive) {
    return <StartScreen />;
  }

  return (
    <div className={`app-container ${isLayoutShifted ? "layout-shifted" : ""}`}>
      {showTranscription && (
        <div
          className="backdrop open"
          onClick={() => setShowTranscription(false)}
        />
      )}
      <TranscriptionPanel
        isOpen={showTranscription}
        onClose={() => setShowTranscription(false)}
        conversation={conversation}
        interimTranscript={interimTranscript}
      />
      <div className="main-content">
        <VideoDisplay
          userVideoRef={userVideoRef}
          videoRef={videoRef}
          isVideoOn={isVideoOn}
        />
        <Overlays hindiLine={hindiLine} textOptions={textOptions} />
        <Controls
          status={status}
          isMicOn={isMicOn}
          onToggleMic={handleToggleMic}
          onToggleVideo={handleToggleVideo}
          onEndSession={() => endSession(true)}
          onShowTranscription={() => setShowTranscription(true)}
        />
      </div>
    </div>
  );
}