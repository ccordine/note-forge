export interface NumericBoundarySourceRecord {
  readonly relativePath: string;
  readonly source: string;
}

export function auditNumericBoundaryAuthority(
  records: readonly Readonly<NumericBoundarySourceRecord>[],
): readonly string[];
