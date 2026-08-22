import type { CSSProperties } from "react";
import "./PianoKeyboard.css";

export type PianoKeyMarkerRole = "anchor" | "guess" | "target" | "wrong";

export interface PianoKeyMarker {
  midi: number;
  role: PianoKeyMarkerRole;
  /** Optional accessible description, such as "your answer" or "reference tone". */
  label?: string;
}

export interface PianoKeyboardProps {
  /** Inclusive lower MIDI bound. */
  startMidi: number;
  /** Inclusive upper MIDI bound. */
  endMidi: number;
  showLabels?: boolean;
  markers?: readonly PianoKeyMarker[];
  onKeyPress?: (midi: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

interface KeyLayout {
  midi: number;
  kind: "white" | "black";
  leftPercent?: number;
}

const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);
const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"] as const;
const MARKER_GLYPHS: Record<PianoKeyMarkerRole, string> = {
  anchor: "S",
  guess: "●",
  target: "◎",
  wrong: "×"
};

function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

function noteLabel(midi: number): string {
  return `${NOTE_NAMES[pitchClass(midi)]}${Math.floor(midi / 12) - 1}`;
}

function isWhiteKey(midi: number): boolean {
  return WHITE_PITCH_CLASSES.has(pitchClass(midi));
}

/**
 * Builds keyboard geometry without assuming a particular octave or fixed key count.
 * Black keys sit on the boundary between their neighboring visible white keys.
 */
export function buildPianoKeyLayout(startMidi: number, endMidi: number): KeyLayout[] {
  if (!Number.isInteger(startMidi) || !Number.isInteger(endMidi)) {
    throw new TypeError("Piano keyboard MIDI bounds must be integers.");
  }
  if (endMidi < startMidi) {
    throw new RangeError("Piano keyboard endMidi must be greater than or equal to startMidi.");
  }

  const midiNotes = Array.from({ length: endMidi - startMidi + 1 }, (_, index) => startMidi + index);
  const whiteNotes = midiNotes.filter(isWhiteKey);
  if (whiteNotes.length === 0) {
    throw new RangeError("Piano keyboard range must contain at least one white key.");
  }

  return midiNotes.map((midi) => {
    if (isWhiteKey(midi)) return { midi, kind: "white" };
    const precedingWhiteCount = whiteNotes.filter((whiteMidi) => whiteMidi < midi).length;
    return {
      midi,
      kind: "black",
      leftPercent: (precedingWhiteCount / whiteNotes.length) * 100
    };
  });
}

function markerDescription(markers: readonly PianoKeyMarker[]): string {
  if (markers.length === 0) return "";
  return markers.map((marker) => marker.label ?? marker.role).join(", ");
}

function KeyMarkers({ markers }: { markers: readonly PianoKeyMarker[] }) {
  if (markers.length === 0) return null;
  return (
    <span className="piano-keyboard__markers" aria-hidden="true">
      {markers.map((marker, index) => (
        <span
          key={`${marker.role}-${index}`}
          className={`piano-keyboard__marker piano-keyboard__marker--${marker.role}`}
          data-marker-role={marker.role}
        >
          {MARKER_GLYPHS[marker.role]}
        </span>
      ))}
    </span>
  );
}

export function PianoKeyboard({
  startMidi,
  endMidi,
  showLabels = false,
  markers = [],
  onKeyPress,
  disabled = false,
  ariaLabel,
  className = ""
}: PianoKeyboardProps) {
  const layout = buildPianoKeyLayout(startMidi, endMidi);
  const whiteKeys = layout.filter((key) => key.kind === "white");
  const blackKeys = layout.filter((key) => key.kind === "black");
  const markerMap = new Map<number, PianoKeyMarker[]>();

  for (const marker of markers) {
    if (!Number.isInteger(marker.midi) || marker.midi < startMidi || marker.midi > endMidi) continue;
    const keyMarkers = markerMap.get(marker.midi) ?? [];
    keyMarkers.push(marker);
    markerMap.set(marker.midi, keyMarkers);
  }

  const keyboardStyle = {
    "--piano-white-key-count": whiteKeys.length,
    "--piano-black-key-width": `${(0.64 / whiteKeys.length) * 100}%`
  } as CSSProperties;
  const keyboardLabel = ariaLabel ?? `Piano keyboard from ${noteLabel(startMidi)} to ${noteLabel(endMidi)}`;
  const keyDisabled = disabled || !onKeyPress;

  const renderKey = (key: KeyLayout) => {
    const keyMarkers = markerMap.get(key.midi) ?? [];
    const roles = [...new Set(keyMarkers.map((marker) => marker.role))];
    const markerText = markerDescription(keyMarkers);
    const keyClassName = [
      "piano-keyboard__key",
      `piano-keyboard__key--${key.kind}`,
      ...roles.map((role) => `piano-keyboard__key--has-${role}`)
    ].join(" ");
    const keyStyle = key.kind === "black"
      ? ({ left: `${key.leftPercent}%` } as CSSProperties)
      : undefined;

    return (
      <button
        key={key.midi}
        type="button"
        className={keyClassName}
        style={keyStyle}
        disabled={keyDisabled}
        onClick={() => onKeyPress?.(key.midi)}
        aria-label={`${noteLabel(key.midi)}${markerText ? `; ${markerText}` : ""}`}
        data-midi={key.midi}
      >
        <KeyMarkers markers={keyMarkers} />
        {showLabels && <span className="piano-keyboard__label">{noteLabel(key.midi)}</span>}
      </button>
    );
  };

  return (
    <div
      className={`piano-keyboard ${showLabels ? "piano-keyboard--labels" : ""} ${className}`.trim()}
      style={keyboardStyle}
      role="group"
      aria-label={keyboardLabel}
      data-start-midi={startMidi}
      data-end-midi={endMidi}
    >
      <div className="piano-keyboard__white-keys">
        {whiteKeys.map(renderKey)}
      </div>
      {blackKeys.map(renderKey)}
    </div>
  );
}
