import type { SVGProps } from "react";

type IconName = "forge" | "sound" | "mirror" | "hum" | "control" | "ear" | "interval" | "harmony" | "melody" | "song" | "skills" | "play" | "pause" | "mic" | "chevron" | "spark" | "settings" | "headphones" | "arrow" | "eye" | "eyeOff" | "record" | "loop";

const paths: Record<IconName, string> = {
  forge: "M5 18V6l14 12V6M5 6h4m10 12h-4",
  sound: "M4 14.5v-5m4 8v-11m4 14v-17m4 14v-11m4 8v-5",
  mirror: "M4 20V4h16v16H4Zm4-4c1.2-2.5 2.5-3.8 4-3.8s2.8 1.3 4 3.8M9 9h.01M15 9h.01",
  hum: "M3 12h2m2-3v6m4-8v10m4-8v6m2-3h2M5 19c2 1.4 4.3 2 7 2s5-.6 7-2",
  control: "M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6",
  ear: "M12 20c-2 0-3-1.2-3-3.2 0-1.7 1.5-2.4 2.4-3.5.7-.9.5-2.3-.5-2.8-1.5-.8-3 .3-3 2 0 .8.3 1.5.9 2M6.2 7.4A7 7 0 1 1 17 16",
  interval: "M4 18h16M5 15V7m14 8V4M8 7H3m19-3h-6",
  harmony: "M7 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm10-4a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  melody: "M9 18V5l10-2v13M9 8l10-2M5 21a4 3 0 1 0 0-6 4 3 0 0 0 0 6Zm10-2a4 3 0 1 0 0-6 4 3 0 0 0 0 6Z",
  song: "M4 5h16v14H4zM8 9h8m-8 4h5",
  skills: "M12 3v5m0 8v5M3 12h5m8 0h5M5.6 5.6l3.5 3.5m5.8 5.8 3.5 3.5M18.4 5.6l-3.5 3.5m-5.8 5.8-3.5 3.5",
  play: "m8 5 11 7-11 7V5Z",
  pause: "M8 5v14m8-14v14",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3m-4 0h8",
  chevron: "m9 18 6-6-6-6",
  spark: "m12 2 1.4 6.6L20 10l-6.6 1.4L12 18l-1.4-6.6L4 10l6.6-1.4L12 2Z",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19 13.5l2 1.5-2 3.5-2.4-1a8 8 0 0 1-3 1.7L13.2 22H9l-.4-2.8a8 8 0 0 1-3-1.7l-2.5 1L1 15l2.2-1.6a8 8 0 0 1 0-3L1 9l2.1-3.5 2.5 1a8 8 0 0 1 3-1.7L9 2h4.2l.4 2.8a8 8 0 0 1 3 1.7l2.4-1L21 9l-2 1.5a8 8 0 0 1 0 3Z",
  headphones: "M4 14v-2a8 8 0 0 1 16 0v2M4 14h4v7H6a2 2 0 0 1-2-2v-5Zm16 0h-4v7h2a2 2 0 0 0 2-2v-5Z",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff: "m3 3 18 18M10.6 6.2A11 11 0 0 1 12 6c6.5 0 10 6 10 6a12 12 0 0 1-3 3.7M6.5 6.5A13 13 0 0 0 2 12s3.5 6 10 6a11 11 0 0 0 3-.4M9.8 9.8a3 3 0 0 0 4.4 4.4",
  record: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  loop: "M17 2l3 3-3 3M3 11V9a4 4 0 0 1 4-4h13M7 22l-3-3 3-3m14-3v2a4 4 0 0 1-4 4H4"
};

export function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={paths[name]} />
    </svg>
  );
}
