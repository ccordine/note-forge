import type { ButtonHTMLAttributes } from "react";
import type { SustainedNoteControl } from "@/audio/use-sustained-note";
import { Icon } from "./Icon";

export interface NotePlaybackToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-pressed" | "children" | "onClick"
> {
  readonly label: string;
  readonly playback: Readonly<SustainedNoteControl>;
}

/** The only canonical control for one user-owned isolated note. */
export function NotePlaybackToggle({
  label,
  playback,
  className = "",
  title,
  type = "button",
  ...props
}: NotePlaybackToggleProps) {
  const action = playback.playing ? "Stop" : "Play";
  return (
    <button
      {...props}
      type={type}
      className={`action-button play-button note-playback-toggle ${playback.playing ? "active" : ""} ${className}`.trim()}
      aria-pressed={playback.playing}
      data-note-playback-toggle="true"
      data-playback-status={playback.status}
      title={title ?? (playback.error || undefined)}
      onClick={playback.toggle}
    >
      <span className="play-icon"><Icon name={playback.playing ? "pause" : "play"} size={16} /></span>
      {action} {label}
    </button>
  );
}
