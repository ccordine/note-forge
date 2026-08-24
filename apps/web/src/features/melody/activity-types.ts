import type { Timbre } from "@/audio/synth";
import type { MirrorMode } from "@/navigation";

export interface MelodyActivityProps {
  readonly timbre: Timbre;
  readonly rootMidi: number;
  readonly labelsHidden: boolean;
  readonly onMeasureMidi: (midi: number, mode: MirrorMode) => void;
}
