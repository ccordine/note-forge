export function formatNegotiatedAudioSwitch(
  value: boolean | string | undefined,
): string {
  if (value === undefined) return "Not reported";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return value;
}

export function formatReportedLatency(seconds: number | null | undefined): string {
  return seconds == null || !Number.isFinite(seconds)
    ? "Not reported"
    : `${(seconds * 1_000).toFixed(1)} ms`;
}
