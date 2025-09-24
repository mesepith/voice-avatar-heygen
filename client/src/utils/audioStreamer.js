export const createAudioStreamer = (onAudio) => {
  let audioContext, processor, source;

  const start = async (mediaStream) => {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });
      source = audioContext.createMediaStreamSource(mediaStream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) =>
        onAudio(
          new Int16Array(
            e.inputBuffer.getChannelData(0).map((n) => n * 32767)
          ).buffer
        );
      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (error) {
      console.error("Error setting up audio processing:", error);
    }
  };

  const stop = () => {
    source?.disconnect();
    processor?.disconnect();
    audioContext?.state !== "closed" && audioContext?.close();
  };

  return { start, stop };
};