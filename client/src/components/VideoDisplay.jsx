export default function VideoDisplay({ userVideoRef, videoRef, isVideoOn }) {
  return (
    <div className="ai-video-container">
      <div className="ai-video-wrapper">
        <div ref={videoRef} style={{ width: "100%", height: "100%" }} />
      </div>
      <div
        className="user-video-pip"
        style={{ display: isVideoOn ? "block" : "none" }}
      >
        <video ref={userVideoRef} autoPlay muted playsInline />
      </div>
    </div>
  );
}