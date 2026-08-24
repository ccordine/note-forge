/** Raw-input diagnostics only. Nothing in this module admits or rejects pitch. */
const DEFAULT_DBFS_FLOOR = -120;

function assertDbFloor(dbFloor: number): void {
  if (!Number.isFinite(dbFloor) || dbFloor > 0) {
    throw new RangeError("dbFloor must be a finite value at or below 0 dBFS.");
  }
}

export function amplitudeToDbfs(
  amplitude: number,
  dbFloor = DEFAULT_DBFS_FLOOR,
): number {
  assertDbFloor(dbFloor);
  if (!Number.isFinite(amplitude) || amplitude === 0) return dbFloor;
  return Math.max(dbFloor, 20 * Math.log10(Math.abs(amplitude)));
}
