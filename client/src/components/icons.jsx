const Icon = ({ path, size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d={path} />
  </svg>
);
export const TranscriptionIcon = ({ size }) => (
  <Icon
    path="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"
    size={size}
  />
);
export const MicOnIcon = ({ size }) => (
  <Icon
    path="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"
    size={size}
  />
);
export const MicOffIcon = ({ size }) => (
  <Icon
    path="M19 11h-1.7c0 .74-.29 1.43-.78 1.98l1.46 1.46C18.68 13.3 19 12.19 19 11zm-8-6c1.66 0 3 1.34 3 3v1.58l-3-3V5zm-4 0v.58l13.42 13.42-1.41 1.41L2.01 3.41 3.42 2l3.16 3.16C6.71 5.23 6.88 5.11 7.06 5H7c0-1.66 1.34-3 3-3 .23 0 .44.03.65.08L12 2.72V2h-2v.72C7.28.2 5 2.82 5 5.5V11c0 .35.04.69.12 1.02l-1.7 1.7C3.16 12.28 3 11.66 3 11v-1c0-3.41 2.72-6.23 6-6.72V1h2v2.28c.47.07.92.22 1.34.4L12 6.42V6c0-1.66-1.34-3-3-3z"
    size={size}
  />
);
export const HangUpIcon = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    style={{ transform: "rotate(135deg)" }}
  >
    <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-2.2 2.2c-2.83-1.44-5.15-3.75-6.59-6.59l2.2-2.21c.28-.26.36-.65.25-1C8.7 6.42 8.5 5.21 8.5 4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.5c0-.55-.45-1-1-1z" />
  </svg>
);
export const CloseIcon = ({ size }) => (
  <Icon
    path="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"
    size={size}
  />
);
export const ReplayIcon = ({ size }) => (
  <Icon
    path="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
    size={size}
  />
);