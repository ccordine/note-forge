// Package diagnosticschema owns the wire-level diagnostic version and allowlists.
package diagnosticschema

import (
	_ "embed"
	"encoding/json"
	"math"
)

//go:embed schema.json
var encodedSchema []byte

type schemaDocument struct {
	Version          int             `json:"version"`
	Flows            map[string]bool `json:"flows"`
	ObservationKinds map[string]bool `json:"observationKinds"`
	LiveSignal       liveSignal      `json:"liveSignal"`
}

type frequencyBounds struct {
	CanonicalMinimum               float64 `json:"canonicalMinimum"`
	CanonicalMaximum               float64 `json:"canonicalMaximum"`
	DetectorBoundaryToleranceCents float64 `json:"detectorBoundaryToleranceCents"`
	DecimalPlaces                  int     `json:"decimalPlaces"`
}

type sampleRateBounds struct {
	ExclusiveMinimum float64 `json:"exclusiveMinimum"`
	Maximum          float64 `json:"maximum"`
}

type coordinateTolerance struct {
	MIDI  float64 `json:"midi"`
	Cents float64 `json:"cents"`
}

type liveSignal struct {
	FrequencyHz          frequencyBounds     `json:"frequencyHz"`
	CaptureSampleRateHz  sampleRateBounds    `json:"captureSampleRateHz"`
	AnalysisSampleRateHz sampleRateBounds    `json:"analysisSampleRateHz"`
	CoordinateTolerance  coordinateTolerance `json:"coordinateTolerance"`
}

// NumericBounds is a finite numeric interval. MinimumExclusive distinguishes
// sample-rate Nyquist boundaries from inclusive measured-coordinate bounds.
type NumericBounds struct {
	Minimum          float64
	Maximum          float64
	MinimumExclusive bool
}

// Contains reports whether value is finite and belongs to the interval.
func (bounds NumericBounds) Contains(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) || value > bounds.Maximum {
		return false
	}
	if bounds.MinimumExclusive {
		return value > bounds.Minimum
	}
	return value >= bounds.Minimum
}

// LiveSignalBounds is the shared diagnostic boundary authority. The detector
// interval is the canonical 45-1,200 Hz range plus its documented one-cent
// interpolation allowance. The wire interval additionally admits only the
// half-unit needed to serialize that evidence at FrequencyDecimalPlaces.
type LiveSignalBounds struct {
	CanonicalFrequencyHz   NumericBounds
	DetectorFrequencyHz    NumericBounds
	TransportFrequencyHz   NumericBounds
	CaptureSampleRateHz    NumericBounds
	AnalysisSampleRateHz   NumericBounds
	FrequencyDecimalPlaces int
	MIDITolerance          float64
	CentsTolerance         float64
}

var currentSchema = func() schemaDocument {
	var document schemaDocument
	if err := json.Unmarshal(encodedSchema, &document); err != nil {
		panic("invalid embedded diagnostic schema: " + err.Error())
	}
	if document.Version <= 0 || len(document.Flows) == 0 || len(document.ObservationKinds) == 0 {
		panic("embedded diagnostic schema is empty")
	}
	for flow, enabled := range document.Flows {
		if flow == "" || !enabled {
			panic("embedded diagnostic schema contains an invalid flow")
		}
	}
	for kind, enabled := range document.ObservationKinds {
		if kind == "" || !enabled {
			panic("embedded diagnostic schema contains an invalid observation kind")
		}
	}
	validateLiveSignal(document.LiveSignal)
	return document
}()

func validPositive(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0
}

func validateSampleRateBounds(name string, bounds sampleRateBounds) {
	if !validPositive(bounds.ExclusiveMinimum) ||
		!validPositive(bounds.Maximum) ||
		bounds.Maximum <= bounds.ExclusiveMinimum {
		panic("embedded diagnostic schema contains invalid " + name)
	}
}

func validateLiveSignal(signal liveSignal) {
	frequency := signal.FrequencyHz
	if !validPositive(frequency.CanonicalMinimum) ||
		!validPositive(frequency.CanonicalMaximum) ||
		frequency.CanonicalMaximum <= frequency.CanonicalMinimum ||
		!validPositive(frequency.DetectorBoundaryToleranceCents) ||
		frequency.DetectorBoundaryToleranceCents > 10 ||
		frequency.DecimalPlaces < 0 || frequency.DecimalPlaces > 12 {
		panic("embedded diagnostic schema contains invalid live frequency bounds")
	}
	validateSampleRateBounds("capture sample-rate bounds", signal.CaptureSampleRateHz)
	validateSampleRateBounds("analysis sample-rate bounds", signal.AnalysisSampleRateHz)
	if signal.CaptureSampleRateHz.ExclusiveMinimum != frequency.CanonicalMaximum*2 ||
		signal.AnalysisSampleRateHz.ExclusiveMinimum != signal.CaptureSampleRateHz.ExclusiveMinimum ||
		signal.AnalysisSampleRateHz.Maximum > signal.CaptureSampleRateHz.Maximum {
		panic("embedded diagnostic schema sample-rate bounds cannot cover the canonical live range")
	}
	if !validPositive(signal.CoordinateTolerance.MIDI) ||
		!validPositive(signal.CoordinateTolerance.Cents) {
		panic("embedded diagnostic schema contains invalid coordinate tolerances")
	}
}

// Version is the only accepted diagnostic wire schema version.
func Version() int {
	return currentSchema.Version
}

// ValidFlow reports whether a client flow is in the shared wire allowlist.
func ValidFlow(flow string) bool {
	return currentSchema.Flows[flow]
}

// ValidObservationKind reports whether kind is part of the shared wire contract.
func ValidObservationKind(kind string) bool {
	return currentSchema.ObservationKinds[kind]
}

// SignalBounds returns the named live diagnostic boundary contract by value.
func SignalBounds() LiveSignalBounds {
	signal := currentSchema.LiveSignal
	frequency := signal.FrequencyHz
	ratio := math.Pow(2, frequency.DetectorBoundaryToleranceCents/1_200)
	roundingHalfUnit := 0.5 * math.Pow10(-frequency.DecimalPlaces)
	canonical := NumericBounds{
		Minimum: frequency.CanonicalMinimum,
		Maximum: frequency.CanonicalMaximum,
	}
	detector := NumericBounds{
		Minimum: frequency.CanonicalMinimum / ratio,
		Maximum: frequency.CanonicalMaximum * ratio,
	}
	return LiveSignalBounds{
		CanonicalFrequencyHz: canonical,
		DetectorFrequencyHz:  detector,
		TransportFrequencyHz: NumericBounds{
			Minimum: detector.Minimum - roundingHalfUnit,
			Maximum: detector.Maximum + roundingHalfUnit,
		},
		CaptureSampleRateHz: NumericBounds{
			Minimum:          signal.CaptureSampleRateHz.ExclusiveMinimum,
			Maximum:          signal.CaptureSampleRateHz.Maximum,
			MinimumExclusive: true,
		},
		AnalysisSampleRateHz: NumericBounds{
			Minimum:          signal.AnalysisSampleRateHz.ExclusiveMinimum,
			Maximum:          signal.AnalysisSampleRateHz.Maximum,
			MinimumExclusive: true,
		},
		FrequencyDecimalPlaces: frequency.DecimalPlaces,
		MIDITolerance:          signal.CoordinateTolerance.MIDI,
		CentsTolerance:         signal.CoordinateTolerance.Cents,
	}
}
