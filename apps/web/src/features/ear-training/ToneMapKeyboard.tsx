import {
  PianoKeyboardViewport,
  type PianoKeyMarker,
} from "@/ui/PianoKeyboard";

export interface ToneMapKeyboardProps {
  readonly targetMidi: number;
  readonly answerMidi: number | null;
  readonly disabled?: boolean;
  readonly onAnswer: (midi: number) => void;
}

const PHYSICAL_PIANO_FIRST_MIDI = 21;
const PHYSICAL_PIANO_LAST_MIDI = 108;

function reviewMarkers(targetMidi: number, answerMidi: number): PianoKeyMarker[] {
  return [
    {
      midi: answerMidi,
      role: answerMidi === targetMidi ? "guess" : "wrong",
      label: "your answer",
    },
    { midi: targetMidi, role: "target", label: "target tone" },
  ];
}

/**
 * A model-independent answer surface. Until an answer exists, every target
 * renders the same unlabeled full-range keyboard with the same scroll origin.
 */
export function ToneMapKeyboard({
  targetMidi,
  answerMidi,
  disabled = false,
  onAnswer,
}: ToneMapKeyboardProps) {
  const reviewed = answerMidi !== null;
  const markers = reviewed ? reviewMarkers(targetMidi, answerMidi) : [];
  return (
    <div className="tone-map-keyboard">
      <PianoKeyboardViewport
        startMidi={PHYSICAL_PIANO_FIRST_MIDI}
        endMidi={PHYSICAL_PIANO_LAST_MIDI}
        showLabels={reviewed}
        markers={markers}
        onKeyPress={onAnswer}
        disabled={disabled || reviewed}
        viewportAriaLabel="Full-range tone answer keyboard"
      />
      {reviewed && (
        <div className="tone-map-keyboard__legend" aria-label="Answer review key">
          <span><i aria-hidden="true">{answerMidi === targetMidi ? "●" : "×"}</i> Your answer</span>
          <span><i aria-hidden="true">◎</i> Target</span>
        </div>
      )}
    </div>
  );
}
