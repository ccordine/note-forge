package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

var fixedTestTime = time.Date(2026, time.August, 23, 18, 30, 0, 123_000_000, time.UTC)

func testDistribution() fs.FS {
	return fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>NoteForge</title><main>shell</main>")},
		"assets/index-abc.js":  {Data: []byte("globalThis.noteforge = true;")},
		"worklets/capture.js":  {Data: []byte("registerProcessor('capture', class {});")},
		"sw.js":                {Data: []byte("self.addEventListener('fetch', () => {});")},
		"manifest.webmanifest": {Data: []byte(`{"name":"NoteForge"}`)},
	}
}

func newTestServer(output io.Writer) *appServer {
	return newAppServer(testDistribution(), output, serverOptions{
		Now:             func() time.Time { return fixedTestTime },
		DiagnosticRate:  1_000,
		DiagnosticBurst: 1_000,
	})
}

func TestHealthAndStaticRoutes(t *testing.T) {
	t.Parallel()
	server := newTestServer(io.Discard)
	tests := []struct {
		name         string
		method       string
		path         string
		status       int
		bodyContains string
		cacheControl string
		accept       string
		fetchMode    string
		contentType  string
	}{
		{name: "health", method: http.MethodGet, path: "/healthz", status: http.StatusOK, bodyContains: "ok\n", cacheControl: noStoreCacheControl},
		{name: "shell", method: http.MethodGet, path: "/", status: http.StatusOK, bodyContains: "NoteForge", cacheControl: defaultDocumentCacheControl},
		{name: "SPA HTML fallback", method: http.MethodGet, path: "/range-map", status: http.StatusOK, bodyContains: "NoteForge", cacheControl: defaultDocumentCacheControl, accept: "text/html,application/xhtml+xml"},
		{name: "SPA navigation fallback", method: http.MethodGet, path: "/pitch-mirror", status: http.StatusOK, bodyContains: "NoteForge", cacheControl: defaultDocumentCacheControl, fetchMode: "navigate"},
		{name: "immutable asset", method: http.MethodGet, path: "/assets/index-abc.js", status: http.StatusOK, bodyContains: "noteforge", cacheControl: immutableAssetCacheControl},
		{name: "worklet", method: http.MethodGet, path: "/worklets/capture.js", status: http.StatusOK, bodyContains: "registerProcessor", cacheControl: defaultDocumentCacheControl},
		{name: "service worker", method: http.MethodGet, path: "/sw.js", status: http.StatusOK, bodyContains: "addEventListener", cacheControl: defaultDocumentCacheControl},
		{name: "web manifest", method: http.MethodGet, path: "/manifest.webmanifest", status: http.StatusOK, bodyContains: "NoteForge", cacheControl: defaultDocumentCacheControl, contentType: "application/manifest+json"},
		{name: "missing immutable asset", method: http.MethodGet, path: "/assets/missing.js", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
		{name: "missing worklet", method: http.MethodGet, path: "/worklets/missing.js", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
		{name: "missing root script", method: http.MethodGet, path: "/missing.js", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
		{name: "missing favicon", method: http.MethodGet, path: "/favicon.ico", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
		{name: "missing route without navigation authority", method: http.MethodGet, path: "/range-map", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
		{name: "generic fetch is not navigation", method: http.MethodGet, path: "/range-map", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl, accept: "*/*"},
		{name: "non-HTML route request", method: http.MethodGet, path: "/range-map", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl, accept: "application/json"},
		{name: "unknown API", method: http.MethodGet, path: "/api/nope", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
		{name: "noncanonical path", method: http.MethodGet, path: "/assets/../index.html", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
		{name: "double slash path", method: http.MethodGet, path: "//", status: http.StatusNotFound, bodyContains: "404", cacheControl: noStoreCacheControl},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(test.method, "https://noteforge.test"+test.path, nil)
			if test.accept != "" {
				request.Header.Set("Accept", test.accept)
			}
			if test.fetchMode != "" {
				request.Header.Set("Sec-Fetch-Mode", test.fetchMode)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, test.status, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), test.bodyContains) {
				t.Errorf("body %q does not contain %q", response.Body.String(), test.bodyContains)
			}
			if got := response.Header().Get("Cache-Control"); got != test.cacheControl {
				t.Errorf("Cache-Control = %q, want %q", got, test.cacheControl)
			}
			if test.contentType != "" && response.Header().Get("Content-Type") != test.contentType {
				t.Errorf("Content-Type = %q, want %q", response.Header().Get("Content-Type"), test.contentType)
			}
			assertSecurityHeaders(t, response.Header())
		})
	}
}

func TestStaticAndHealthMethodsAreBounded(t *testing.T) {
	t.Parallel()
	server := newTestServer(io.Discard)
	for _, target := range []string{"/", "/healthz"} {
		request := httptest.NewRequest(http.MethodPost, "https://noteforge.test"+target, nil)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s status = %d, want %d", target, response.Code, http.StatusMethodNotAllowed)
		}
		if allow := response.Header().Get("Allow"); !strings.Contains(allow, http.MethodGet) {
			t.Errorf("POST %s Allow = %q, want GET", target, allow)
		}
		if got := response.Header().Get("Cache-Control"); got != noStoreCacheControl {
			t.Errorf("POST %s Cache-Control = %q, want %q", target, got, noStoreCacheControl)
		}
	}
}

func TestPitchDiagnosticsAcceptAndLogDerivedMetrics(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	server := newTestServer(&output)
	batch := validDiagnosticBatch()

	response := performDiagnosticRequest(server, batch, nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != noStoreCacheControl {
		t.Errorf("Cache-Control = %q, want %q", got, noStoreCacheControl)
	}
	if response.Body.Len() != 0 {
		t.Errorf("204 response body = %q, want empty", response.Body.String())
	}

	lines := decodeLogLines(t, output.Bytes())
	if len(lines) != len(batch.Events) {
		t.Fatalf("logged %d lines, want %d", len(lines), len(batch.Events))
	}
	for index, line := range lines {
		if line.Component != "pitch-diagnostics" || line.SchemaVersion != batch.Version {
			t.Errorf("line %d has unexpected envelope: %+v", index, line)
		}
		if line.Timestamp != fixedTestTime.Format(time.RFC3339Nano) {
			t.Errorf("line %d timestamp = %q", index, line.Timestamp)
		}
		if line.SessionID != batch.SessionID || line.Sequence != batch.Sequence || line.Flow != batch.Flow || line.EventIndex != index {
			t.Errorf("line %d lost batch identity: %+v", index, line)
		}
	}
	pitchFrame := lines[0].Event.Pitch.Frame
	if pitchFrame.ObservationKind != "voiced" ||
		pitchFrame.EndSample == nil || *pitchFrame.EndSample != 12_288 ||
		pitchFrame.ProcessedSampleCount == nil || *pitchFrame.ProcessedSampleCount != 12_288 ||
		pitchFrame.CaptureEpoch == nil || *pitchFrame.CaptureEpoch != 1 ||
		pitchFrame.ContinuityEpoch == nil || *pitchFrame.ContinuityEpoch != 0 ||
		pitchFrame.GraphGeneration == nil || *pitchFrame.GraphGeneration != 1 ||
		pitchFrame.WorkletProcessCount == nil || *pitchFrame.WorkletProcessCount != 96 ||
		pitchFrame.Brightness == nil || *pitchFrame.Brightness != 0.24 ||
		pitchFrame.BrightnessConfidence == nil || *pitchFrame.BrightnessConfidence != 0.91 ||
		pitchFrame.Discontinuity == nil || *pitchFrame.Discontinuity {
		t.Errorf("logged frame lost continuous-stream coordinates: %+v", pitchFrame)
	}
	logText := output.String()
	for _, forbidden := range []string{"remoteAddr", "userAgent", "deviceId", "groupId", "waveform", "samples"} {
		if strings.Contains(logText, forbidden) {
			t.Errorf("diagnostic log unexpectedly contains %q", forbidden)
		}
	}
}

func TestPitchDiagnosticsRejectInvalidRequestsWithoutLoggingBodies(t *testing.T) {
	t.Parallel()
	validJSON := mustMarshal(t, validDiagnosticBatch())
	unknownTopLevel := strings.TrimSuffix(string(validJSON), "}") + `,"samples":[0.1,-0.2]}`
	unknownNested := strings.Replace(string(validJSON), `"frame":{`, `"frame":{"samples":[0.1],`, 1)
	tooMany := validDiagnosticBatch()
	tooMany.Events = make([]DiagnosticEvent, maxDiagnosticEvents+1)
	for index := range tooMany.Events {
		tooMany.Events[index] = DiagnosticEvent{
			ElapsedMS: uint64(index),
			Kind:      "microphone-state",
			Microphone: &MicrophoneDiagnostic{
				State: "ready",
			},
		}
	}
	badReason := validDiagnosticBatch()
	badReason.Events[0].Pitch.Frame.Reason = "arbitrary-message"
	badReason.Events[0].Pitch.Frame.ObservationKind = "unvoiced"
	badReason.Events[0].Pitch.Frame.Voiced = false
	badReason.Events[0].Pitch.Frame.FrequencyHz = nil
	badReason.Events[0].Pitch.Frame.MIDIFloat = nil
	badReason.Events[0].Pitch.Frame.NearestMIDI = nil
	badReason.Events[0].Pitch.Frame.CentsFromNearest = nil
	badFrame := validDiagnosticBatch()
	badFrame.Events[0].Pitch.Input.ClippedSampleCount = badFrame.Events[0].Pitch.Input.SampleCount + 1
	badTiming := validDiagnosticBatch()
	badTiming.Events[0].Pitch.ProcessingMS = 1_001
	badFrequencyCoordinate := validDiagnosticBatch()
	badFrequencyCoordinate.Events[0].Pitch.Frame.FrequencyHz = pointer(440.0)
	badNearestCoordinate := validDiagnosticBatch()
	badNearestCoordinate.Events[0].Pitch.Frame.NearestMIDI = pointer(49)
	badCentsCoordinate := validDiagnosticBatch()
	badCentsCoordinate.Events[0].Pitch.Frame.CentsFromNearest = pointer(4.0)
	badHeadroom := validDiagnosticBatch()
	badHeadroom.Events[0].Pitch.Input.HeadroomDB = 3
	badClipRatio := validDiagnosticBatch()
	badClipRatio.Events[0].Pitch.Input.ClipRatio = 0.25
	wrongPayload := validDiagnosticBatch()
	wrongPayload.Events[0].Microphone = &MicrophoneDiagnostic{State: "off"}
	badSession := validDiagnosticBatch()
	badSession.SessionID = "../../voice"
	badFlow := validDiagnosticBatch()
	badFlow.Flow = "arbitrary"
	oldSchema := validDiagnosticBatch()
	oldSchema.Version = 1
	badObservationKind := validDiagnosticBatch()
	badObservationKind.Events[0].Pitch.Frame.ObservationKind = "pitch"
	badVoicedFlag := validDiagnosticBatch()
	badVoicedFlag.Events[0].Pitch.Frame.Voiced = false
	uncertainWithPitch := validDiagnosticBatch()
	uncertainWithPitch.Events[0].Pitch.Frame.ObservationKind = "uncertain"
	uncertainWithPitch.Events[0].Pitch.Frame.Voiced = false
	missingFrameTime := validDiagnosticBatch()
	missingFrameTime.Events[0].Pitch.Frame.TimeSeconds = nil
	badFrameSampleRate := validDiagnosticBatch()
	badFrameSampleRate.Events[0].Pitch.Frame.SampleRate = pointer(2_400.0)
	belowLiveFrequency := validDiagnosticBatch()
	belowLiveFrequency.Events[0].Pitch.Frame.FrequencyHz = pointer(20.0)
	belowLiveFrequency.Events[0].Pitch.Frame.MIDIFloat = pointer(15.4868)
	belowLiveFrequency.Events[0].Pitch.Frame.NearestMIDI = pointer(15)
	belowLiveFrequency.Events[0].Pitch.Frame.CentsFromNearest = pointer(48.68)
	activeMicrophoneMissingRange := validDiagnosticBatch()
	activeMicrophoneMissingRange.Events = []DiagnosticEvent{{
		Kind: "microphone-state",
		Microphone: &MicrophoneDiagnostic{
			State:      "ready",
			SampleRate: pointer(48_000.0),
			BufferSize: pointer(uint64(4_096)),
		},
	}}
	wrongMicrophoneRange := validDiagnosticBatch()
	wrongMicrophoneRange.Events = []DiagnosticEvent{{
		Kind: "microphone-state",
		Microphone: &MicrophoneDiagnostic{
			State:          "ready",
			SampleRate:     pointer(48_000.0),
			BufferSize:     pointer(uint64(4_096)),
			MinFrequencyHz: pointer(50.0),
			MaxFrequencyHz: pointer(1_200.0),
		},
	}}
	emptyFrameWindow := validDiagnosticBatch()
	emptyFrameWindow.Events[0].Pitch.Frame.StartSample = emptyFrameWindow.Events[0].Pitch.Frame.EndSample
	badProcessedCount := validDiagnosticBatch()
	badProcessedCount.Events[0].Pitch.Frame.ProcessedSampleCount = pointer(
		*badProcessedCount.Events[0].Pitch.Frame.EndSample + 1,
	)
	unsafeFrameCoordinate := validDiagnosticBatch()
	unsafeFrameCoordinate.Events[0].Pitch.Frame.EndSample = pointer(maxDiagnosticSafeInteger + 1)
	unsafeFrameCoordinate.Events[0].Pitch.Frame.ProcessedSampleCount = pointer(maxDiagnosticSafeInteger + 1)
	missingContinuityCounter := validDiagnosticBatch()
	missingContinuityCounter.Events[0].Pitch.Frame.ContinuityEpoch = nil
	missingDiscontinuity := validDiagnosticBatch()
	missingDiscontinuity.Events[0].Pitch.Frame.Discontinuity = nil
	badPeriodicity := validDiagnosticBatch()
	badPeriodicity.Events[0].Pitch.Frame.Periodicity = pointer(1.001)

	tests := []struct {
		name        string
		method      string
		contentType string
		body        []byte
		headers     map[string]string
		status      int
	}{
		{name: "wrong method", method: http.MethodGet, contentType: "application/json", body: validJSON, status: http.StatusMethodNotAllowed},
		{name: "wrong content type", method: http.MethodPost, contentType: "text/plain", body: validJSON, status: http.StatusUnsupportedMediaType},
		{name: "cross site fetch", method: http.MethodPost, contentType: "application/json", body: validJSON, headers: map[string]string{"Sec-Fetch-Site": "cross-site"}, status: http.StatusForbidden},
		{name: "same site is not same origin", method: http.MethodPost, contentType: "application/json", body: validJSON, headers: map[string]string{"Sec-Fetch-Site": "same-site"}, status: http.StatusForbidden},
		{name: "foreign origin", method: http.MethodPost, contentType: "application/json", body: validJSON, headers: map[string]string{"Origin": "https://attacker.test", "Sec-Fetch-Site": "same-origin"}, status: http.StatusForbidden},
		{name: "scheme mismatch behind proxy", method: http.MethodPost, contentType: "application/json", body: validJSON, headers: map[string]string{"Origin": "http://noteforge.test", "X-Forwarded-Proto": "https", "Sec-Fetch-Site": "same-origin"}, status: http.StatusForbidden},
		{name: "malformed JSON", method: http.MethodPost, contentType: "application/json", body: []byte(`{"version":`), status: http.StatusBadRequest},
		{name: "trailing JSON", method: http.MethodPost, contentType: "application/json", body: append(validJSON, []byte(` {}`)...), status: http.StatusBadRequest},
		{name: "unknown raw field", method: http.MethodPost, contentType: "application/json", body: []byte(unknownTopLevel), status: http.StatusBadRequest},
		{name: "unknown nested samples", method: http.MethodPost, contentType: "application/json", body: []byte(unknownNested), status: http.StatusBadRequest},
		{name: "too many events", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, tooMany), status: http.StatusBadRequest},
		{name: "obsolete schema", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, oldSchema), status: http.StatusBadRequest},
		{name: "unknown observation kind", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badObservationKind), status: http.StatusBadRequest},
		{name: "voiced kind with false flag", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badVoicedFlag), status: http.StatusBadRequest},
		{name: "uncertain kind with admitted pitch", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, uncertainWithPitch), status: http.StatusBadRequest},
		{name: "missing frame time", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, missingFrameTime), status: http.StatusBadRequest},
		{name: "invalid frame sample rate", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badFrameSampleRate), status: http.StatusBadRequest},
		{name: "frequency below canonical transport allowance", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, belowLiveFrequency), status: http.StatusBadRequest},
		{name: "active microphone missing canonical range", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, activeMicrophoneMissingRange), status: http.StatusBadRequest},
		{name: "active microphone changed canonical range", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, wrongMicrophoneRange), status: http.StatusBadRequest},
		{name: "empty frame window", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, emptyFrameWindow), status: http.StatusBadRequest},
		{name: "processed count disagrees with frame end", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badProcessedCount), status: http.StatusBadRequest},
		{name: "unsafe frame coordinate", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, unsafeFrameCoordinate), status: http.StatusBadRequest},
		{name: "missing continuity counter", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, missingContinuityCounter), status: http.StatusBadRequest},
		{name: "missing discontinuity flag", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, missingDiscontinuity), status: http.StatusBadRequest},
		{name: "invalid periodicity", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badPeriodicity), status: http.StatusBadRequest},
		{name: "unknown pitch reason", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badReason), status: http.StatusBadRequest},
		{name: "invalid sample counts", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badFrame), status: http.StatusBadRequest},
		{name: "invalid detector processing time", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badTiming), status: http.StatusBadRequest},
		{name: "contradictory frequency coordinate", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badFrequencyCoordinate), status: http.StatusBadRequest},
		{name: "contradictory nearest note", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badNearestCoordinate), status: http.StatusBadRequest},
		{name: "contradictory cents coordinate", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badCentsCoordinate), status: http.StatusBadRequest},
		{name: "contradictory input headroom", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badHeadroom), status: http.StatusBadRequest},
		{name: "contradictory input clip ratio", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badClipRatio), status: http.StatusBadRequest},
		{name: "multiple payloads", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, wrongPayload), status: http.StatusBadRequest},
		{name: "invalid session", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badSession), status: http.StatusBadRequest},
		{name: "invalid flow", method: http.MethodPost, contentType: "application/json", body: mustMarshal(t, badFlow), status: http.StatusBadRequest},
		{name: "oversized body", method: http.MethodPost, contentType: "application/json", body: bytes.Repeat([]byte("x"), int(maxDiagnosticBodyBytes)+1), status: http.StatusRequestEntityTooLarge},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var output bytes.Buffer
			server := newTestServer(&output)
			request := httptest.NewRequest(test.method, "https://noteforge.test"+pitchDiagnosticsPath, bytes.NewReader(test.body))
			request.Header.Set("Content-Type", test.contentType)
			request.Header.Set("X-Diagnostic-Secret", "must-not-leak")
			for name, value := range test.headers {
				request.Header.Set(name, value)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d; response = %q", response.Code, test.status, response.Body.String())
			}
			if output.Len() != 0 {
				t.Errorf("rejected request was logged: %q", output.String())
			}
			if strings.Contains(response.Body.String(), "must-not-leak") || strings.Contains(response.Body.String(), "0.1") {
				t.Errorf("response reflected request data: %q", response.Body.String())
			}
		})
	}
}

func TestPitchDiagnosticsBoundStreamingBodiesWithUnknownLength(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	server := newTestServer(&output)
	payload := append(mustMarshal(t, validDiagnosticBatch()), bytes.Repeat([]byte(" "), int(maxDiagnosticBodyBytes))...)
	request := httptest.NewRequest(http.MethodPost, "https://noteforge.test"+pitchDiagnosticsPath, bytes.NewReader(payload))
	request.ContentLength = -1
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://noteforge.test")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d; response = %q", response.Code, http.StatusRequestEntityTooLarge, response.Body.String())
	}
	if output.Len() != 0 {
		t.Errorf("oversized streamed request was logged: %q", output.String())
	}
}

func TestPitchDiagnosticsAcceptEveryTypedEvent(t *testing.T) {
	t.Parallel()
	bufferSize := uint64(4_096)
	sampleRate := 48_000.0
	minFrequencyHz := 45.0
	maxFrequencyHz := 1_200.0
	batch := validDiagnosticBatch()
	batch.Events = []DiagnosticEvent{
		{
			ElapsedMS: 0,
			Kind:      "microphone-state",
			Microphone: &MicrophoneDiagnostic{
				State:          "ready",
				SampleRate:     &sampleRate,
				BufferSize:     &bufferSize,
				MinFrequencyHz: &minFrequencyHz,
				MaxFrequencyHz: &maxFrequencyHz,
			},
		},
		validDiagnosticBatch().Events[0],
	}
	var output bytes.Buffer
	response := performDiagnosticRequest(newTestServer(&output), batch, nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
	}
	if lines := decodeLogLines(t, output.Bytes()); len(lines) != len(batch.Events) {
		t.Errorf("logged %d typed events, want %d", len(lines), len(batch.Events))
	}
}

func TestPitchDiagnosticsAcceptClientRoundedCrossFieldEvidence(t *testing.T) {
	t.Parallel()
	precisionScale := math.Pow10(diagnosticSignalBounds.FrequencyDecimalPlaces)
	roundedDetectorMinimum := math.Round(
		diagnosticSignalBounds.DetectorFrequencyHz.Minimum*precisionScale,
	) / precisionScale
	roundedDetectorMaximum := math.Round(
		diagnosticSignalBounds.DetectorFrequencyHz.Maximum*precisionScale,
	) / precisionScale
	for _, frequencyHz := range []float64{
		roundedDetectorMinimum,
		45,
		440,
		1_200,
		roundedDetectorMaximum,
	} {
		frequencyHz := frequencyHz
		t.Run(fmt.Sprintf("%.4f Hz", frequencyHz), func(t *testing.T) {
			t.Parallel()
			midiRaw := 69 + 12*math.Log2(frequencyHz/440)
			midiRounded := math.Round(midiRaw*10_000) / 10_000
			nearest := int(math.Floor(midiRaw + 0.5))
			centsRounded := math.Round((midiRaw-float64(nearest))*100*10_000) / 10_000
			batch := validDiagnosticBatch()
			batch.Events[0].Pitch.Frame.FrequencyHz = pointer(frequencyHz)
			batch.Events[0].Pitch.Frame.MIDIFloat = pointer(midiRounded)
			batch.Events[0].Pitch.Frame.NearestMIDI = pointer(nearest)
			batch.Events[0].Pitch.Frame.CentsFromNearest = pointer(centsRounded)
			batch.Events[0].Pitch.Input.PeakDBFS = -12.35
			batch.Events[0].Pitch.Input.HeadroomDB = 12.35
			batch.Events[0].Pitch.Input.ClippedSampleCount = 1
			batch.Events[0].Pitch.Input.SampleCount = 3
			batch.Events[0].Pitch.Input.ClipRatio = 0.333333

			if err := validateDiagnosticBatch(batch); err != nil {
				t.Fatalf("client-rounded diagnostic was rejected: %v", err)
			}
		})
	}
}

func TestPitchDiagnosticsAcceptExplicitUnvoicedAndUncertainObservations(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		kind   string
		reason string
	}{
		{kind: "unvoiced", reason: "below-rms-threshold"},
		{kind: "uncertain", reason: "below-confidence-threshold"},
	} {
		t.Run(test.kind, func(t *testing.T) {
			t.Parallel()
			batch := validDiagnosticBatch()
			frame := unvoicedFrame(test.reason)
			frame.ObservationKind = test.kind
			batch.Events[0].Pitch.Frame = frame
			if err := validateDiagnosticBatch(batch); err != nil {
				t.Fatalf("%s observation was rejected: %v", test.kind, err)
			}
		})
	}
}

func TestPitchDiagnosticsRejectNonFiniteObservationEvidence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*FrameDiagnostic)
	}{
		{name: "time", mutate: func(frame *FrameDiagnostic) { frame.TimeSeconds = pointer(math.NaN()) }},
		{name: "sample rate", mutate: func(frame *FrameDiagnostic) { frame.SampleRate = pointer(math.Inf(1)) }},
		{name: "periodicity", mutate: func(frame *FrameDiagnostic) { frame.Periodicity = pointer(math.NaN()) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			batch := validDiagnosticBatch()
			test.mutate(&batch.Events[0].Pitch.Frame)
			if err := validateDiagnosticBatch(batch); err == nil {
				t.Fatalf("non-finite %s was accepted", test.name)
			}
		})
	}
}

func TestPitchDiagnosticsRateLimitIsPerSession(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	server := newAppServer(testDistribution(), &output, serverOptions{
		Now:             func() time.Time { return fixedTestTime },
		DiagnosticRate:  1,
		DiagnosticBurst: 2,
	})
	for sequence, expected := range []int{http.StatusNoContent, http.StatusNoContent, http.StatusTooManyRequests} {
		batch := validDiagnosticBatch()
		batch.Sequence = uint64(sequence)
		response := performDiagnosticRequest(server, batch, nil)
		if response.Code != expected {
			t.Fatalf("request %d status = %d, want %d", sequence, response.Code, expected)
		}
		if expected == http.StatusTooManyRequests && response.Header().Get("Retry-After") != "1" {
			t.Errorf("rate-limited request lacks Retry-After")
		}
	}
	if lines := decodeLogLines(t, output.Bytes()); len(lines) != 2 {
		t.Errorf("logged %d accepted events, want 2", len(lines))
	}

	otherSession := validDiagnosticBatch()
	otherSession.SessionID = "pitch-other-session"
	response := performDiagnosticRequest(server, otherSession, nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("independent session status = %d, want %d", response.Code, http.StatusNoContent)
	}
}

func TestPitchDiagnosticsGlobalCapacityLimit(t *testing.T) {
	t.Parallel()
	server := newAppServer(testDistribution(), io.Discard, serverOptions{
		Now:                   func() time.Time { return fixedTestTime },
		DiagnosticRate:        1_000,
		DiagnosticBurst:       1_000,
		DiagnosticGlobalRate:  1,
		DiagnosticGlobalBurst: 2,
	})
	for index, expected := range []int{http.StatusNoContent, http.StatusNoContent, http.StatusTooManyRequests} {
		batch := validDiagnosticBatch()
		batch.SessionID = fmt.Sprintf("capacity-session-%d", index)
		response := performDiagnosticRequest(server, batch, nil)
		if response.Code != expected {
			t.Fatalf("request %d status = %d, want %d", index, response.Code, expected)
		}
	}
}

func TestRejectedDiagnosticsDoNotConsumeSessionCapacity(t *testing.T) {
	t.Parallel()
	server := newAppServer(testDistribution(), io.Discard, serverOptions{
		Now:             func() time.Time { return fixedTestTime },
		DiagnosticRate:  1,
		DiagnosticBurst: 1,
	})
	invalid := validDiagnosticBatch()
	invalid.Flow = "not-a-flow"
	if response := performDiagnosticRequest(server, invalid, nil); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid request status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if response := performDiagnosticRequest(server, validDiagnosticBatch(), nil); response.Code != http.StatusNoContent {
		t.Fatalf("valid request after rejection status = %d, want %d", response.Code, http.StatusNoContent)
	}
}

func TestConcurrentDiagnosticLogsRemainJSONLines(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	server := newTestServer(&output)
	const requests = 32
	var group sync.WaitGroup
	group.Add(requests)
	for sequence := 0; sequence < requests; sequence++ {
		sequence := sequence
		go func() {
			defer group.Done()
			batch := validDiagnosticBatch()
			batch.Sequence = uint64(sequence)
			response := performDiagnosticRequest(server, batch, nil)
			if response.Code != http.StatusNoContent {
				t.Errorf("request %d status = %d", sequence, response.Code)
			}
		}()
	}
	group.Wait()
	lines := decodeLogLines(t, output.Bytes())
	if len(lines) != requests {
		t.Fatalf("logged %d lines, want %d", len(lines), requests)
	}
	seen := make(map[uint64]bool, requests)
	for _, line := range lines {
		seen[line.Sequence] = true
	}
	if len(seen) != requests {
		t.Errorf("logged %d distinct sequences, want %d", len(seen), requests)
	}
}

func TestRequestOriginRules(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		origin  string
		fetch   string
		proto   string
		allowed bool
	}{
		{name: "non-browser client", allowed: true},
		{name: "same origin HTTPS", origin: "https://noteforge.test", fetch: "same-origin", proto: "https", allowed: true},
		{name: "top-level trusted client", origin: "https://noteforge.test", fetch: "none", proto: "https", allowed: true},
		{name: "different port", origin: "https://noteforge.test:8443", fetch: "same-origin", proto: "https", allowed: false},
		{name: "origin credentials", origin: "https://user@noteforge.test", fetch: "same-origin", proto: "https", allowed: false},
		{name: "same site", origin: "https://noteforge.test", fetch: "same-site", proto: "https", allowed: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://noteforge.test"+pitchDiagnosticsPath, nil)
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Sec-Fetch-Site", test.fetch)
			request.Header.Set("X-Forwarded-Proto", test.proto)
			if got := requestIsSameOrigin(request); got != test.allowed {
				t.Errorf("requestIsSameOrigin() = %t, want %t", got, test.allowed)
			}
		})
	}
}

func TestTokenBucketRefillsWithinCapacity(t *testing.T) {
	t.Parallel()
	now := fixedTestTime
	limiter := newTokenBucket(2, 2, func() time.Time { return now })
	if !limiter.Allow() || !limiter.Allow() || limiter.Allow() {
		t.Fatal("initial burst was not enforced")
	}
	now = now.Add(500 * time.Millisecond)
	if !limiter.Allow() || limiter.Allow() {
		t.Fatal("partial refill was not enforced")
	}
	now = now.Add(10 * time.Second)
	if !limiter.Allow() || !limiter.Allow() || limiter.Allow() {
		t.Fatal("refill did not clamp to burst capacity")
	}
}

func TestSessionTokenBucketsAreIsolatedAndBounded(t *testing.T) {
	t.Parallel()
	now := fixedTestTime
	limiter := newSessionTokenBuckets(1, 1, func() time.Time { return now })
	if !limiter.Allow("session-a") || limiter.Allow("session-a") {
		t.Fatal("session-a burst was not enforced")
	}
	if !limiter.Allow("session-b") {
		t.Fatal("session-a exhausted independent session-b capacity")
	}
	for index := 0; index < maxDiagnosticRateSessions+20; index++ {
		limiter.Allow(fmt.Sprintf("bounded-session-%d", index))
	}
	if len(limiter.sessions) != maxDiagnosticRateSessions {
		t.Fatalf("retained %d limiter sessions, want %d", len(limiter.sessions), maxDiagnosticRateSessions)
	}

	now = now.Add(diagnosticRateSessionMaxAge + time.Second)
	if !limiter.Allow("fresh-session") {
		t.Fatal("fresh session was unexpectedly rate limited")
	}
	if len(limiter.sessions) != 1 {
		t.Fatalf("retained %d expired limiter sessions, want 1", len(limiter.sessions))
	}
}

func assertSecurityHeaders(t *testing.T, header http.Header) {
	t.Helper()
	expected := map[string]string{
		"Content-Security-Policy":      contentSecurityPolicy,
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Permissions-Policy":           "microphone=(self), camera=(), geolocation=()",
		"Referrer-Policy":              "same-origin",
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
	}
	for name, value := range expected {
		if got := header.Get(name); got != value {
			t.Errorf("%s = %q, want %q", name, got, value)
		}
	}
}

func validDiagnosticBatch() DiagnosticBatch {
	timeSeconds := 0.256
	sampleRate := 48_000.0
	startSample := uint64(8_192)
	endSample := uint64(12_288)
	processedSampleCount := endSample
	captureEpoch := uint64(1)
	continuityEpoch := uint64(0)
	graphGeneration := uint64(1)
	discontinuity := false
	workletProcessCount := uint64(96)
	periodicity := 0.99
	frequency := 130.8203
	midi := 48.001
	nearest := 48
	cents := 0.1
	yin := 0.01
	period := 366.94
	brightness := 0.24
	brightnessConfidence := 0.91
	frame := FrameDiagnostic{
		ObservationKind:      "voiced",
		TimeSeconds:          &timeSeconds,
		SampleRate:           &sampleRate,
		StartSample:          &startSample,
		EndSample:            &endSample,
		ProcessedSampleCount: &processedSampleCount,
		CaptureEpoch:         &captureEpoch,
		ContinuityEpoch:      &continuityEpoch,
		GraphGeneration:      &graphGeneration,
		Discontinuity:        &discontinuity,
		WorkletProcessCount:  &workletProcessCount,
		Periodicity:          &periodicity,
		Voiced:               true,
		FrequencyHz:          &frequency,
		MIDIFloat:            &midi,
		NearestMIDI:          &nearest,
		CentsFromNearest:     &cents,
		RMS:                  0.08,
		Confidence:           0.99,
		Brightness:           &brightness,
		BrightnessConfidence: &brightnessConfidence,
		YINValue:             &yin,
		PeriodSamples:        &period,
		Reason:               "detected",
	}
	return DiagnosticBatch{
		Version:       4,
		SessionID:     "pitch-a1b2c3d4",
		Sequence:      42,
		Flow:          "audio-input",
		DroppedEvents: 2,
		Events: []DiagnosticEvent{{
			ElapsedMS: 140,
			Kind:      "pitch-frame",
			Pitch: &PitchDiagnostic{
				Frame:        frame,
				ProcessingMS: 2.375,
				Input: &InputDiagnostic{
					RMSDBFS:            -34.2,
					PeakDBFS:           -12.1,
					HeadroomDB:         12.1,
					ClipRatio:          0,
					ClippedSampleCount: 0,
					SampleCount:        4_096,
				},
			},
		}},
	}
}

func unvoicedFrame(reason string) FrameDiagnostic {
	frame := validDiagnosticBatch().Events[0].Pitch.Frame
	frame.ObservationKind = "unvoiced"
	frame.Voiced = false
	frame.FrequencyHz = nil
	frame.MIDIFloat = nil
	frame.NearestMIDI = nil
	frame.CentsFromNearest = nil
	frame.Brightness = nil
	frame.BrightnessConfidence = pointer(0.0)
	frame.Confidence = 0.76
	frame.Reason = reason
	return frame
}

func performDiagnosticRequest(server http.Handler, batch DiagnosticBatch, headers map[string]string) *httptest.ResponseRecorder {
	body, err := json.Marshal(batch)
	if err != nil {
		panic(fmt.Sprintf("marshal diagnostic batch: %v", err))
	}
	request := httptest.NewRequest(http.MethodPost, "https://noteforge.test"+pitchDiagnosticsPath, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("Origin", "https://noteforge.test")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	result, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal test value: %v", err)
	}
	return result
}

func decodeLogLines(t *testing.T, payload []byte) []diagnosticLogLine {
	t.Helper()
	var lines []diagnosticLogLine
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	for scanner.Scan() {
		var line diagnosticLogLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatalf("decode diagnostic log line %q: %v", scanner.Text(), err)
		}
		lines = append(lines, line)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan diagnostic logs: %v", err)
	}
	return lines
}

func pointer[T any](value T) *T {
	return &value
}
