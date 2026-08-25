package main

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"time"
)

const (
	pitchDiagnosticsPath         = "/api/diagnostics/pitch"
	maxDiagnosticBodyBytes       = int64(32 * 1024)
	maxDiagnosticEvents          = 32
	maxDiagnosticSessionAgeMS    = uint64(7 * 24 * 60 * 60 * 1000)
	defaultDiagnosticRate        = 4.0
	defaultDiagnosticRateBurst   = 8
	defaultDiagnosticGlobalRate  = 64.0
	defaultDiagnosticGlobalBurst = 128
	maxDiagnosticRateSessions    = 4_096
	diagnosticRateSessionMaxAge  = 24 * time.Hour
	diagnosticDBTolerance        = 0.02
	diagnosticRatioTolerance     = 0.000_001
	maxDiagnosticSafeInteger     = uint64(9_007_199_254_740_991)
)

type DiagnosticBatch struct {
	Version       int               `json:"version"`
	SessionID     string            `json:"sessionId"`
	Sequence      uint64            `json:"sequence"`
	Flow          string            `json:"flow"`
	DroppedEvents uint64            `json:"droppedEvents,omitempty"`
	Events        []DiagnosticEvent `json:"events"`
}

type DiagnosticEvent struct {
	ElapsedMS  uint64                `json:"elapsedMs"`
	Kind       string                `json:"kind"`
	Microphone *MicrophoneDiagnostic `json:"microphone,omitempty"`
	Pitch      *PitchDiagnostic      `json:"pitch,omitempty"`
}

type MicrophoneDiagnostic struct {
	State            string   `json:"state"`
	SampleRate       *float64 `json:"sampleRate,omitempty"`
	BufferSize       *uint64  `json:"bufferSize,omitempty"`
	MinFrequencyHz   *float64 `json:"minFrequencyHz,omitempty"`
	MaxFrequencyHz   *float64 `json:"maxFrequencyHz,omitempty"`
	YINThreshold     *float64 `json:"yinThreshold,omitempty"`
	MinConfidence    *float64 `json:"minConfidence,omitempty"`
	EchoCancellation *bool    `json:"echoCancellation,omitempty"`
	NoiseSuppression *bool    `json:"noiseSuppression,omitempty"`
	AutoGainControl  *bool    `json:"autoGainControl,omitempty"`
	ErrorCode        *string  `json:"errorCode,omitempty"`
}

type PitchDiagnostic struct {
	Frame        FrameDiagnostic  `json:"frame"`
	ProcessingMS float64          `json:"processingMs"`
	Input        *InputDiagnostic `json:"input,omitempty"`
}

type FrameDiagnostic struct {
	ObservationKind       string                    `json:"observationKind"`
	TimeSeconds           *float64                  `json:"timeSeconds"`
	SampleRate            *float64                  `json:"sampleRate"`
	StartSample           *uint64                   `json:"startSample"`
	EndSample             *uint64                   `json:"endSample"`
	ProcessedSampleCount  *uint64                   `json:"processedSampleCount"`
	CaptureEpoch          *uint64                   `json:"captureEpoch"`
	ContinuityEpoch       *uint64                   `json:"continuityEpoch"`
	GraphGeneration       *uint64                   `json:"graphGeneration"`
	Discontinuity         *bool                     `json:"discontinuity"`
	WorkletProcessCount   *uint64                   `json:"workletProcessCount"`
	Periodicity           *float64                  `json:"periodicity"`
	Voiced                bool                      `json:"voiced"`
	FrequencyHz           *float64                  `json:"frequencyHz"`
	MIDIFloat             *float64                  `json:"midiFloat"`
	NearestMIDI           *int                      `json:"nearestMidi"`
	CentsFromNearest      *float64                  `json:"centsFromNearest"`
	RMS                   float64                   `json:"rms"`
	Confidence            float64                   `json:"confidence"`
	Brightness            *float64                  `json:"brightness"`
	BrightnessConfidence  *float64                  `json:"brightnessConfidence"`
	YINValue              *float64                  `json:"yinValue"`
	PeriodSamples         *float64                  `json:"periodSamples"`
	Reason                string                    `json:"reason"`
	PitchCandidate        *PitchCandidateDiagnostic `json:"pitchCandidate"`
	PitchTrackingDecision string                    `json:"pitchTrackingDecision"`
}

type PitchCandidateDiagnostic struct {
	FrequencyHz       *float64                     `json:"frequencyHz"`
	MIDIFloat         *float64                     `json:"midiFloat"`
	NearestMIDI       *int                         `json:"nearestMidi"`
	CentsFromNearest  *float64                     `json:"centsFromNearest"`
	Confidence        float64                      `json:"confidence"`
	YINValue          *float64                     `json:"yinValue"`
	PeriodSamples     *float64                     `json:"periodSamples"`
	Voiced            bool                         `json:"voiced"`
	Reason            string                       `json:"reason"`
	RawCandidate      *RawPitchCandidateDiagnostic `json:"rawCandidate"`
	HarmonicAmbiguity float64                      `json:"harmonicAmbiguity"`
}

type RawPitchCandidateDiagnostic struct {
	FrequencyHz   float64 `json:"frequencyHz"`
	PeriodSamples float64 `json:"periodSamples"`
	YINValue      float64 `json:"yinValue"`
	Confidence    float64 `json:"confidence"`
}

type InputDiagnostic struct {
	RMSDBFS            float64 `json:"rmsDbfs"`
	PeakDBFS           float64 `json:"peakDbfs"`
	HeadroomDB         float64 `json:"headroomDb"`
	ClipRatio          float64 `json:"clipRatio"`
	ClippedSampleCount uint64  `json:"clippedSampleCount"`
	SampleCount        uint64  `json:"sampleCount"`
}

type diagnosticLogLine struct {
	Timestamp     string          `json:"timestamp"`
	Component     string          `json:"component"`
	SchemaVersion int             `json:"schemaVersion"`
	SessionID     string          `json:"sessionId"`
	Sequence      uint64          `json:"sequence"`
	Flow          string          `json:"flow"`
	DroppedEvents uint64          `json:"droppedEvents,omitempty"`
	EventIndex    int             `json:"eventIndex"`
	Event         DiagnosticEvent `json:"event"`
}

type diagnosticJSONLogger struct {
	mu     sync.Mutex
	output io.Writer
	now    func() time.Time
}

func newDiagnosticJSONLogger(output io.Writer, now func() time.Time) *diagnosticJSONLogger {
	return &diagnosticJSONLogger{output: output, now: now}
}

func (logger *diagnosticJSONLogger) Log(batch DiagnosticBatch) error {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	timestamp := logger.now().UTC().Format(time.RFC3339Nano)
	for index, event := range batch.Events {
		line := diagnosticLogLine{
			Timestamp:     timestamp,
			Component:     "pitch-diagnostics",
			SchemaVersion: batch.Version,
			SessionID:     batch.SessionID,
			Sequence:      batch.Sequence,
			Flow:          batch.Flow,
			DroppedEvents: batch.DroppedEvents,
			EventIndex:    index,
			Event:         event,
		}
		if err := encoder.Encode(line); err != nil {
			return err
		}
	}

	logger.mu.Lock()
	defer logger.mu.Unlock()
	written, err := logger.output.Write(encoded.Bytes())
	if err != nil {
		return err
	}
	if written != encoded.Len() {
		return io.ErrShortWrite
	}
	return nil
}
