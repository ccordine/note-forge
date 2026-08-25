import { Select } from "@/ui/Controls";
import { ACCEPTANCE_TOLERANCE_CENTS_OPTIONS } from "@/state/user-preferences-settings";
import {
  RANGE_FAMILIES,
  type FamilyNoteSet,
  type RangeFamilyId,
} from "./model";
import {
  RANGE_LOOP_HOLD_OPTIONS,
  type RangeLoopOrder,
} from "./range-loop-session";
import type { RangeLoopSession } from "./use-range-loop-session";

type SettingsProps = Pick<
  RangeLoopSession,
  | "changeFamily"
  | "changeHold"
  | "changeNoteSet"
  | "changeOrder"
  | "changeTolerance"
  | "family"
  | "holdSeconds"
  | "hydrated"
  | "noteSet"
  | "order"
  | "persistenceState"
  | "toleranceCents"
>;

function persistenceLabel(session: SettingsProps): string {
  if (!session.hydrated) return "Loading local settings";
  if (session.persistenceState === "saving") return "Saving locally";
  if (session.persistenceState === "saved") return "Saved locally";
  return "Local storage unavailable";
}

export function RangeLoopSettings({ session }: { readonly session: SettingsProps }) {
  return (
    <details className="range-loop-settings">
      <summary>
        <span>Change settings</span>
        <b>{session.family.label} · {session.noteSet} · {session.order} · {session.holdSeconds.toFixed(1)} sec · ±{session.toleranceCents}¢</b>
        <small>{persistenceLabel(session)}</small>
      </summary>
      <div className="range-loop-fields">
        <Select
          label="Family"
          value={session.family.id}
          disabled={!session.hydrated}
          onChange={(event) => session.changeFamily(event.target.value as RangeFamilyId)}
        >
          {RANGE_FAMILIES.map((family) => (
            <option value={family.id} key={family.id}>{family.label} · {family.rangeLabel}</option>
          ))}
        </Select>
        <Select
          label="Notes"
          value={session.noteSet}
          disabled={!session.hydrated}
          onChange={(event) => session.changeNoteSet(event.target.value as FamilyNoteSet)}
        >
          <option value="natural">Natural</option>
          <option value="chromatic">Chromatic</option>
        </Select>
        <Select
          label="Direction"
          value={session.order}
          disabled={!session.hydrated}
          onChange={(event) => session.changeOrder(event.target.value as RangeLoopOrder)}
        >
          <option value="ascending">Ascending</option>
          <option value="descending">Descending</option>
        </Select>
        <Select
          label="Hold"
          value={session.holdSeconds}
          disabled={!session.hydrated}
          onChange={(event) => session.changeHold(Number(event.target.value))}
        >
          {RANGE_LOOP_HOLD_OPTIONS.map((seconds) => (
            <option value={seconds} key={seconds}>{seconds.toFixed(1)} sec</option>
          ))}
        </Select>
        <Select
          label="Lane"
          value={session.toleranceCents}
          disabled={!session.hydrated}
          onChange={(event) => session.changeTolerance(Number(event.target.value))}
        >
          {ACCEPTANCE_TOLERANCE_CENTS_OPTIONS.map((cents) => (
            <option value={cents} key={cents}>±{cents} cents</option>
          ))}
        </Select>
      </div>
    </details>
  );
}
