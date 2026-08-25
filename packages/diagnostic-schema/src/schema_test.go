package diagnosticschema

import (
	"math"
	"testing"
)

func TestEmbeddedDiagnosticContract(t *testing.T) {
	t.Parallel()
	if got := Version(); got != 4 {
		t.Fatalf("Version() = %d, want 4", got)
	}
	expectedFlows := []string{"audio-input"}
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

	bounds := SignalBounds()
	if bounds.CanonicalFrequencyHz.Minimum != 45 || bounds.CanonicalFrequencyHz.Maximum != 1_200 {
		t.Fatalf("canonical live frequency bounds = %+v, want inclusive 45-1200 Hz", bounds.CanonicalFrequencyHz)
	}
	if !bounds.CanonicalFrequencyHz.Contains(45) ||
		!bounds.CanonicalFrequencyHz.Contains(1_200) ||
		bounds.CanonicalFrequencyHz.Contains(20) ||
		bounds.CanonicalFrequencyHz.Contains(2_000) {
		t.Errorf("canonical live frequency containment is incorrect: %+v", bounds.CanonicalFrequencyHz)
	}
	ratio := math.Pow(2, 1.0/1_200)
	expectedDetectorMinimum := 45 / ratio
	expectedDetectorMaximum := 1_200 * ratio
	if math.Abs(bounds.DetectorFrequencyHz.Minimum-expectedDetectorMinimum) > 1e-12 ||
		math.Abs(bounds.DetectorFrequencyHz.Maximum-expectedDetectorMaximum) > 1e-12 {
		t.Errorf("detector frequency allowance = %+v, want one cent around canonical boundaries", bounds.DetectorFrequencyHz)
	}
	precisionScale := math.Pow10(bounds.FrequencyDecimalPlaces)
	roundedMinimum := math.Round(expectedDetectorMinimum*precisionScale) / precisionScale
	roundedMaximum := math.Round(expectedDetectorMaximum*precisionScale) / precisionScale
	if !bounds.TransportFrequencyHz.Contains(roundedMinimum) ||
		!bounds.TransportFrequencyHz.Contains(roundedMaximum) ||
		bounds.TransportFrequencyHz.Contains(20) ||
		bounds.TransportFrequencyHz.Contains(2_000) {
		t.Errorf("wire frequency bounds do not preserve only rounded detector evidence: %+v", bounds.TransportFrequencyHz)
	}
	if bounds.CaptureSampleRateHz.Contains(2_400) ||
		!bounds.CaptureSampleRateHz.Contains(2_400.1) ||
		!bounds.CaptureSampleRateHz.Contains(768_000) ||
		bounds.CaptureSampleRateHz.Contains(768_001) {
		t.Errorf("capture sample-rate bounds are incorrect: %+v", bounds.CaptureSampleRateHz)
	}
	if bounds.AnalysisSampleRateHz.Contains(2_400) ||
		!bounds.AnalysisSampleRateHz.Contains(48_000) ||
		bounds.AnalysisSampleRateHz.Contains(48_001) {
		t.Errorf("analysis sample-rate bounds are incorrect: %+v", bounds.AnalysisSampleRateHz)
	}
	if bounds.MIDITolerance != 0.002 || bounds.CentsTolerance != 0.02 {
		t.Errorf("coordinate tolerances = MIDI %g cents %g", bounds.MIDITolerance, bounds.CentsTolerance)
	}
}
