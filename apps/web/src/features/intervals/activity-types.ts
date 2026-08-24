import type { Timbre } from "@/audio/synth";
import type { IntervalPresentation } from "./model";

export interface IntervalActivityProps {
  readonly presentation: IntervalPresentation;
  readonly soundFirst: boolean;
  readonly timbre: Timbre;
  readonly onMeasureMidi: (midi: number) => void;
}
