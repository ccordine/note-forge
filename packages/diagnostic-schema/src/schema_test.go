package diagnosticschema

import "testing"

func TestEmbeddedDiagnosticContract(t *testing.T) {
	t.Parallel()
	if got := Version(); got != 3 {
		t.Fatalf("Version() = %d, want 3", got)
	}
	expectedFlows := []string{
		"audio-input",
		"range-simulator",
		"range-loop",
		"voice-arcade",
		"pitch-mirror",
		"pitch-tunnel",
		"hum-lab",
		"pitch-control",
	}
	if len(currentSchema.Flows) != len(expectedFlows) {
		t.Fatalf("embedded schema has %d flows, want %d", len(currentSchema.Flows), len(expectedFlows))
	}
	for _, flow := range expectedFlows {
		if !ValidFlow(flow) {
			t.Errorf("ValidFlow(%q) = false", flow)
		}
	}
	for _, invalid := range []string{"", "AUDIO-INPUT", "pitch", "../audio-input"} {
		if ValidFlow(invalid) {
			t.Errorf("ValidFlow(%q) = true for an unconfigured flow", invalid)
		}
	}
	expectedObservationKinds := []string{"voiced", "unvoiced", "uncertain"}
	if len(currentSchema.ObservationKinds) != len(expectedObservationKinds) {
		t.Fatalf(
			"embedded schema has %d observation kinds, want %d",
			len(currentSchema.ObservationKinds),
			len(expectedObservationKinds),
		)
	}
	for _, kind := range expectedObservationKinds {
		if !ValidObservationKind(kind) {
			t.Errorf("ValidObservationKind(%q) = false", kind)
		}
	}
	for _, invalid := range []string{"", "pitch", "VOICED", "low-confidence"} {
		if ValidObservationKind(invalid) {
			t.Errorf("ValidObservationKind(%q) = true for an unconfigured kind", invalid)
		}
	}
}
