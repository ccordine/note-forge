package main

import (
	"errors"
	"fmt"
	"math"

	diagnosticschema "noteforge/packages/diagnostic-schema/src"
)

func validateDiagnosticBatch(batch DiagnosticBatch) error {
	if batch.Version != diagnosticschema.Version() {
		return errors.New("unsupported schema version")
	}
	if !validSessionID(batch.SessionID) {
		return errors.New("invalid session ID")
	}
	if batch.Sequence > 1_000_000_000 || batch.DroppedEvents > 1_000_000_000 {
		return errors.New("invalid batch counter")
	}
	if !validDiagnosticFlow(batch.Flow) {
		return errors.New("invalid diagnostic flow")
	}
	if len(batch.Events) == 0 || len(batch.Events) > maxDiagnosticEvents {
		return errors.New("invalid event count")
	}
	for index := range batch.Events {
		if err := validateDiagnosticEvent(batch.Events[index]); err != nil {
			return fmt.Errorf("event %d: %w", index, err)
		}
	}
	return nil
}

func validateDiagnosticEvent(event DiagnosticEvent) error {
	if event.ElapsedMS > maxDiagnosticSessionAgeMS {
		return errors.New("elapsed time is out of range")
	}
	payloads := 0
	if event.Microphone != nil {
		payloads++
	}
	if event.Pitch != nil {
		payloads++
	}
	if event.Workflow != nil {
		payloads++
	}
	if payloads != 1 {
		return errors.New("event must contain exactly one payload")
	}
	switch event.Kind {
	case "microphone-state":
		if event.Microphone == nil {
			return errors.New("microphone event has the wrong payload")
		}
		return validateMicrophoneDiagnostic(*event.Microphone)
	case "pitch-frame":
		if event.Pitch == nil {
			return errors.New("pitch event has the wrong payload")
		}
		return validatePitchDiagnostic(*event.Pitch)
	case "workflow":
		if event.Workflow == nil {
			return errors.New("workflow event has the wrong payload")
		}
		return validateWorkflowDiagnostic(*event.Workflow)
	default:
		return errors.New("unknown event kind")
	}
}

func validateMicrophoneDiagnostic(value MicrophoneDiagnostic) error {
	switch value.State {
	case "off", "starting", "ready", "error", "stream-ended":
	default:
		return errors.New("unknown microphone state")
	}
	if err := optionalFloat("sample rate", value.SampleRate, 8_000, 768_000); err != nil {
		return err
	}
	if value.BufferSize != nil && (*value.BufferSize < 128 || *value.BufferSize > 262_144) {
		return errors.New("buffer size is out of range")
	}
	if err := optionalFloat("minimum frequency", value.MinFrequencyHz, 10, 20_000); err != nil {
		return err
	}
	if err := optionalFloat("maximum frequency", value.MaxFrequencyHz, 10, 20_000); err != nil {
		return err
	}
	if value.MinFrequencyHz != nil && value.MaxFrequencyHz != nil && *value.MinFrequencyHz >= *value.MaxFrequencyHz {
		return errors.New("frequency bounds are reversed")
	}
	if err := optionalFloat("YIN threshold", value.YINThreshold, 0, 1); err != nil {
		return err
	}
	if err := optionalFloat("minimum confidence", value.MinConfidence, 0, 1); err != nil {
		return err
	}
	if value.ErrorCode != nil && !validToken(*value.ErrorCode, 1, 48) {
		return errors.New("invalid microphone error code")
	}
	return nil
}

func validatePitchDiagnostic(value PitchDiagnostic) error {
	if err := validateFrameDiagnostic(value.Frame); err != nil {
		return fmt.Errorf("frame: %w", err)
	}
	if err := finiteRange("detector processing time", value.ProcessingMS, 0, 1_000); err != nil {
		return err
	}
	if value.Input != nil {
		if err := validateInputDiagnostic(*value.Input); err != nil {
			return err
		}
	}
	if value.Tracking != nil {
		if err := validateTrackingDiagnostic(*value.Tracking, value.Frame); err != nil {
			return err
		}
	}
	return nil
}

func validateFrameDiagnostic(value FrameDiagnostic) error {
	if !diagnosticschema.ValidObservationKind(value.ObservationKind) {
		return errors.New("unknown observation kind")
	}
	if value.TimeSeconds == nil {
		return errors.New("frame time is missing")
	}
	if err := finiteRange(
		"frame time",
		*value.TimeSeconds,
		0,
		float64(maxDiagnosticSafeInteger),
	); err != nil {
		return err
	}
	if value.SampleRate == nil {
		return errors.New("frame sample rate is missing")
	}
	if err := finiteRange("frame sample rate", *value.SampleRate, 8_000, 768_000); err != nil {
		return err
	}
	if value.StartSample == nil || value.EndSample == nil || value.ProcessedSampleCount == nil {
		return errors.New("frame sample coordinates are missing")
	}
	if *value.StartSample > maxDiagnosticSafeInteger ||
		*value.EndSample > maxDiagnosticSafeInteger ||
		*value.ProcessedSampleCount > maxDiagnosticSafeInteger {
		return errors.New("frame sample coordinates exceed JavaScript safe integers")
	}
	if *value.StartSample >= *value.EndSample {
		return errors.New("frame sample window is empty or reversed")
	}
	if *value.EndSample != *value.ProcessedSampleCount {
		return errors.New("frame end sample disagrees with processed sample count")
	}
	for label, counter := range map[string]*uint64{
		"capture epoch":         value.CaptureEpoch,
		"continuity epoch":      value.ContinuityEpoch,
		"graph generation":      value.GraphGeneration,
		"worklet process count": value.WorkletProcessCount,
	} {
		if counter == nil {
			return fmt.Errorf("%s is missing", label)
		}
		if *counter > maxDiagnosticSafeInteger {
			return fmt.Errorf("%s exceeds JavaScript safe integers", label)
		}
	}
	if value.Discontinuity == nil {
		return errors.New("frame discontinuity flag is missing")
	}
	if value.Periodicity == nil {
		return errors.New("frame periodicity is missing")
	}
	if err := finiteRange("frame periodicity", *value.Periodicity, 0, 1); err != nil {
		return err
	}
	if !validPitchReason(value.Reason) {
		return errors.New("unknown pitch reason")
	}
	if err := finiteRange("frame RMS", value.RMS, 0, 4); err != nil {
		return err
	}
	if err := finiteRange("frame confidence", value.Confidence, 0, 1); err != nil {
		return err
	}
	if value.BrightnessConfidence == nil {
		return errors.New("frame brightness confidence is missing")
	}
	if err := finiteRange("frame brightness confidence", *value.BrightnessConfidence, 0, 1); err != nil {
		return err
	}
	if err := optionalFloat("frame brightness", value.Brightness, 0, 1); err != nil {
		return err
	}
	if value.Brightness == nil && *value.BrightnessConfidence != 0 {
		return errors.New("missing frame brightness has nonzero confidence")
	}
	if err := optionalFloat("frequency", value.FrequencyHz, 10, 20_000); err != nil {
		return err
	}
	if err := optionalFloat("continuous MIDI", value.MIDIFloat, 0, 127); err != nil {
		return err
	}
	if value.NearestMIDI != nil && (*value.NearestMIDI < 0 || *value.NearestMIDI > 127) {
		return errors.New("nearest MIDI is out of range")
	}
	if err := optionalFloat("nearest-note cents", value.CentsFromNearest, -100, 100); err != nil {
		return err
	}
	if err := optionalFloat("YIN value", value.YINValue, 0, 10); err != nil {
		return err
	}
	if err := optionalFloat("pitch period", value.PeriodSamples, 1, 1_000_000); err != nil {
		return err
	}
	if value.ObservationKind == "voiced" {
		if !value.Voiced {
			return errors.New("voiced observation has a false voiced flag")
		}
		if value.FrequencyHz == nil || value.MIDIFloat == nil || value.NearestMIDI == nil || value.CentsFromNearest == nil {
			return errors.New("voiced frame is missing pitch coordinates")
		}
		if value.Reason != "detected" {
			return errors.New("voiced frame has a non-voiced reason")
		}
		midiFromFrequency := 69 + 12*math.Log2(*value.FrequencyHz/440)
		if math.Abs(midiFromFrequency-*value.MIDIFloat) > diagnosticMIDITolerance {
			return errors.New("voiced frame frequency and MIDI coordinates disagree")
		}
		nearestMIDI := int(math.Floor(*value.MIDIFloat + 0.5))
		expectedCents := (*value.MIDIFloat - float64(nearestMIDI)) * 100
		if *value.NearestMIDI != nearestMIDI ||
			math.Abs(*value.CentsFromNearest-expectedCents) > diagnosticCentsTolerance {
			return errors.New("voiced frame nearest-note coordinates disagree")
		}
	} else {
		if value.Voiced {
			return errors.New("unvoiced or uncertain observation has a true voiced flag")
		}
		if value.FrequencyHz != nil || value.MIDIFloat != nil || value.NearestMIDI != nil || value.CentsFromNearest != nil {
			return errors.New("unvoiced frame contains pitch coordinates")
		}
		if value.Reason == "detected" {
			return errors.New("unvoiced frame has a voiced reason")
		}
		if value.Brightness != nil || *value.BrightnessConfidence != 0 {
			return errors.New("unvoiced frame contains brightness evidence")
		}
	}
	return nil
}

func validateInputDiagnostic(value InputDiagnostic) error {
	for label, candidate := range map[string]float64{
		"input RMS":  value.RMSDBFS,
		"input peak": value.PeakDBFS,
	} {
		if err := finiteRange(label, candidate, -200, 24); err != nil {
			return err
		}
	}
	if value.PeakDBFS < value.RMSDBFS {
		return errors.New("input peak is below RMS")
	}
	if err := finiteRange("headroom", value.HeadroomDB, 0, 200); err != nil {
		return err
	}
	if err := finiteRange("clip ratio", value.ClipRatio, 0, 1); err != nil {
		return err
	}
	if value.SampleCount == 0 || value.SampleCount > 1_048_576 || value.ClippedSampleCount > value.SampleCount {
		return errors.New("invalid sample counts")
	}
	expectedHeadroom := math.Max(0, -value.PeakDBFS)
	if math.Abs(value.HeadroomDB-expectedHeadroom) > diagnosticDBTolerance {
		return errors.New("input headroom disagrees with peak level")
	}
	expectedClipRatio := float64(value.ClippedSampleCount) / float64(value.SampleCount)
	if math.Abs(value.ClipRatio-expectedClipRatio) > diagnosticRatioTolerance {
		return errors.New("input clip ratio disagrees with sample counts")
	}
	return nil
}

func validateTrackingDiagnostic(value TrackingDiagnostic, frame FrameDiagnostic) error {
	if !validToken(value.Phase, 1, 48) {
		return errors.New("invalid tracking phase")
	}
	if err := optionalFloat("tracking target MIDI", value.TargetMIDI, 0, 127); err != nil {
		return err
	}
	if err := optionalFloat("tracking tolerance", value.ToleranceCents, 0, 1_200); err != nil {
		return err
	}
	if err := optionalFloat("tracking pitch error", value.ErrorCents, -9_600, 9_600); err != nil {
		return err
	}
	if err := optionalFloat("stable duration", value.StableMS, 0, 600_000); err != nil {
		return err
	}
	if err := optionalFloat("required hold duration", value.RequiredHoldMS, 0, 600_000); err != nil {
		return err
	}
	if value.ResetReason != nil && !validToken(*value.ResetReason, 1, 48) {
		return errors.New("invalid tracking reset reason")
	}
	if value.ErrorCents != nil {
		if value.TargetMIDI == nil || !frame.Voiced || frame.MIDIFloat == nil {
			return errors.New("tracking error lacks voiced target coordinates")
		}
		expectedError := (*frame.MIDIFloat - *value.TargetMIDI) * 100
		if math.Abs(*value.ErrorCents-expectedError) > diagnosticCentsTolerance {
			return errors.New("tracking error disagrees with frame and target")
		}
	}
	if value.InBand != nil {
		if value.ErrorCents == nil || value.ToleranceCents == nil {
			return errors.New("tracking in-band state lacks error or tolerance")
		}
		expectedInBand := math.Abs(*value.ErrorCents) <= *value.ToleranceCents
		if *value.InBand != expectedInBand {
			return errors.New("tracking in-band state disagrees with error and tolerance")
		}
	}
	return nil
}

func validateWorkflowDiagnostic(value WorkflowDiagnostic) error {
	if !validToken(value.Phase, 1, 48) || !validToken(value.State, 1, 48) {
		return errors.New("invalid workflow state")
	}
	if err := optionalFloat("workflow target MIDI", value.TargetMIDI, 0, 127); err != nil {
		return err
	}
	if value.AttemptID != nil && *value.AttemptID > 1_000_000_000 {
		return errors.New("workflow attempt ID is out of range")
	}
	if err := optionalFloat("workflow hold duration", value.HoldMS, 0, 600_000); err != nil {
		return err
	}
	if err := optionalFloat("workflow required hold duration", value.RequiredHoldMS, 0, 600_000); err != nil {
		return err
	}
	if value.ResetReason != nil && !validToken(*value.ResetReason, 1, 48) {
		return errors.New("invalid workflow reset reason")
	}
	return nil
}

func optionalFloat(label string, value *float64, minimum, maximum float64) error {
	if value == nil {
		return nil
	}
	return finiteRange(label, *value, minimum, maximum)
}

func finiteRange(label string, value, minimum, maximum float64) error {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < minimum || value > maximum {
		return fmt.Errorf("%s is out of range", label)
	}
	return nil
}

func validSessionID(value string) bool {
	if len(value) < 8 || len(value) > 32 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func validToken(value string, minimumLength, maximumLength int) bool {
	if len(value) < minimumLength || len(value) > maximumLength {
		return false
	}
	for index, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			(index > 0 && (character == '-' || character == '_' || character == '.')) {
			continue
		}
		return false
	}
	return true
}

func validDiagnosticFlow(value string) bool {
	return diagnosticschema.ValidFlow(value)
}

func validPitchReason(value string) bool {
	switch value {
	case "detected", "below-rms-threshold", "insufficient-samples", "invalid-samples", "no-periodic-candidate", "below-confidence-threshold", "frequency-out-of-range":
		return true
	default:
		return false
	}
}
