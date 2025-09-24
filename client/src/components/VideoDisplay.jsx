export default function VideoDisplay({ userVideoRef, videoRef, isVideoOn }) {
  return (
    <div className="ai-video-container">
      <div ref={videoRef} style={{ width: "100%", height: "100%" }} />
      <div
        className="user-video-pip"
        style={{ display: isVideoOn ? "block" : "none" }}
      >
        <video ref={userVideoRef} autoPlay muted playsInline />
      </div>
    </div>
  );
}