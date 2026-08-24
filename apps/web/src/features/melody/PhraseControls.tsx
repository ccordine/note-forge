import { Select, Switch } from "@/ui/Controls";

export function PhraseControls({
  length,
  chromatic,
  onLengthChange,
  onChromaticChange,
}: {
  readonly length: number;
  readonly chromatic: boolean;
  readonly onLengthChange: (length: number) => void;
  readonly onChromaticChange: (chromatic: boolean) => void;
}) {
  return (
    <div className="melody-fields">
      <Select
        label="Notes"
        value={length}
        onChange={(event) => onLengthChange(Number(event.target.value))}
      >
        <option value="2">2 notes</option>
        <option value="3">3 notes</option>
        <option value="4">4 notes</option>
        <option value="6">6 notes</option>
        <option value="8">8 notes</option>
      </Select>
      <Switch
        label="Allow chromatic notes"
        checked={chromatic}
        onChange={onChromaticChange}
      />
    </div>
  );
}
