export interface ObservationContinuitySourceRecord {
  readonly relativePath: string;
  readonly source: string;
}

export function auditObservationContinuityAuthority(
  records: readonly Readonly<ObservationContinuitySourceRecord>[],
): readonly string[];
