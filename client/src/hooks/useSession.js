import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { startHeygenSession, stopHeygenSession } from "../services/api";
import useTranscription from "./useTranscription";

export default function useSession() {
  const [status, setStatus] = useState("Initializing...");
  const [isSessionActive, setIsSessionActive] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [conversation, setConversation] = useState([]);
  const [hindiLine, setHindiLine] = useState("");
  const [textOptions, setTextOptions] = useState(null);

  const userVideoRef = useRef(null);
  const userStreamRef = useRef(null);
  const videoRef = useRef(null);
  const sessionDataRef = useRef(null);
  const roomRef = useRef(null);

  const handleAIResponse = (aiData) => {
    if (!aiData) return;
    setConversation((prev) => [...prev, { speaker: "AI", text: aiData.spoke }]);
    if (aiData.hindi_line) setHindiLine(aiData.hindi_line);
    if (aiData.ui && aiData.ui.action === "DISPLAY_TEXT_OPTIONS") {
      setTextOptions(aiData.ui.payload.options);
    }
  };

  const { interimTranscript, startTranscription, stopTranscription } =
    useTranscription({
      onTranscriptFinalized: (fullUtterance) => {
        setHindiLine("");
        setTextOptions(null);
        setConversation((prev) => [
          ...prev,
          { speaker: "User", text: fullUtterance },
        ]);
      },
    });

  useEffect(() => {
    if (isSessionActive) {
      startSession();
    }
    return () => {
      endSession(false);
    };
  }, [isSessionActive]);

  const startSession = async () => {
    try {
      setStatus("Permissions...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      userStreamRef.current = stream;
      if (userVideoRef.current) userVideoRef.current.srcObject = stream;
      setIsVideoOn(true);
      setIsMicOn(true);

      setStatus("Connecting...");
      sessionDataRef.current = await startHeygenSession();

      roomRef.current = new Room();
      await roomRef.current.connect(
        sessionDataRef.current.url,
        sessionDataRef.current.access_token
      );
      roomRef.current.on(RoomEvent.TrackSubscribed, (track) =>
        videoRef.current?.appendChild(track.attach())
      );

      startTranscription(
        userStreamRef.current,
        sessionDataRef.current.session_id,
        handleAIResponse
      );

      setStatus("Listening...");
    } catch (error) {
      console.error("Session setup failed:", error);
      setStatus(
        error.name === "NotAllowedError" ? "Permission Denied" : "Setup Failed"
      );
      setIsSessionActive(false);
    }
  };

  const endSession = async (notifyBackend = true) => {
    if (notifyBackend && sessionDataRef.current?.session_id) {
      await stopHeygenSession(sessionDataRef.current.session_id);
    }
    stopTranscription();
    roomRef.current?.disconnect();
    userStreamRef.current?.getTracks().forEach((track) => track.stop());
    setConversation([]);
    if (videoRef.current) videoRef.current.innerHTML = "";
    if (notifyBackend) {
      setIsSessionActive(false);
      setStatus("Session Ended");
    }
  };

  const handleToggleMic = () => {
    if (!userStreamRef.current) return;
    const audioTracks = userStreamRef.current.getAudioTracks();
    if (audioTracks.length > 0) {
      const newMicState = !isMicOn;
      audioTracks[0].enabled = newMicState;
      setIsMicOn(newMicState);
    }
  };

  const handleToggleVideo = () => {
    if (!userStreamRef.current) return;
    const videoTracks = userStreamRef.current.getVideoTracks();
    if (videoTracks.length > 0) {
      const newVideoState = !isVideoOn;
      videoTracks[0].enabled = newVideoState;
      setIsVideoOn(newVideoState);
    }
  };

  return {
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
    endSession,
    handleToggleMic,
    handleToggleVideo,
  };
}