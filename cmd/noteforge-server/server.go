package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	diagnosticschema "noteforge/packages/diagnostic-schema/src"
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
	diagnosticMIDITolerance      = 0.002
	diagnosticCentsTolerance     = 0.02
	diagnosticDBTolerance        = 0.02
	diagnosticRatioTolerance     = 0.000_001
	maxDiagnosticSafeInteger     = uint64(9_007_199_254_740_991)
	immutableAssetCacheControl   = "public, max-age=31536000, immutable"
	defaultDocumentCacheControl  = "no-cache"
	noStoreCacheControl          = "no-store"
)

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"

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
	Workflow   *WorkflowDiagnostic   `json:"workflow,omitempty"`
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
	Frame        FrameDiagnostic     `json:"frame"`
	ProcessingMS float64             `json:"processingMs"`
	Input        *InputDiagnostic    `json:"input,omitempty"`
	Tracking     *TrackingDiagnostic `json:"tracking,omitempty"`
}

type FrameDiagnostic struct {
	ObservationKind      string   `json:"observationKind"`
	TimeSeconds          *float64 `json:"timeSeconds"`
	SampleRate           *float64 `json:"sampleRate"`
	StartSample          *uint64  `json:"startSample"`
	EndSample            *uint64  `json:"endSample"`
	ProcessedSampleCount *uint64  `json:"processedSampleCount"`
	CaptureEpoch         *uint64  `json:"captureEpoch"`
	ContinuityEpoch      *uint64  `json:"continuityEpoch"`
	GraphGeneration      *uint64  `json:"graphGeneration"`
	Discontinuity        *bool    `json:"discontinuity"`
	WorkletProcessCount  *uint64  `json:"workletProcessCount"`
	Periodicity          *float64 `json:"periodicity"`
	Voiced               bool     `json:"voiced"`
	FrequencyHz          *float64 `json:"frequencyHz"`
	MIDIFloat            *float64 `json:"midiFloat"`
	NearestMIDI          *int     `json:"nearestMidi"`
	CentsFromNearest     *float64 `json:"centsFromNearest"`
	RMS                  float64  `json:"rms"`
	Confidence           float64  `json:"confidence"`
	YINValue             *float64 `json:"yinValue"`
	PeriodSamples        *float64 `json:"periodSamples"`
	Reason               string   `json:"reason"`
}

type InputDiagnostic struct {
	RMSDBFS            float64 `json:"rmsDbfs"`
	PeakDBFS           float64 `json:"peakDbfs"`
	HeadroomDB         float64 `json:"headroomDb"`
	ClipRatio          float64 `json:"clipRatio"`
	ClippedSampleCount uint64  `json:"clippedSampleCount"`
	SampleCount        uint64  `json:"sampleCount"`
}

type TrackingDiagnostic struct {
	Phase          string   `json:"phase"`
	TargetMIDI     *float64 `json:"targetMidi,omitempty"`
	ToleranceCents *float64 `json:"toleranceCents,omitempty"`
	ErrorCents     *float64 `json:"errorCents,omitempty"`
	InBand         *bool    `json:"inBand,omitempty"`
	StableMS       *float64 `json:"stableMs,omitempty"`
	RequiredHoldMS *float64 `json:"requiredHoldMs,omitempty"`
	ResetReason    *string  `json:"resetReason,omitempty"`
}

type WorkflowDiagnostic struct {
	Phase          string   `json:"phase"`
	State          string   `json:"state"`
	TargetMIDI     *float64 `json:"targetMidi,omitempty"`
	AttemptID      *uint64  `json:"attemptId,omitempty"`
	HoldMS         *float64 `json:"holdMs,omitempty"`
	RequiredHoldMS *float64 `json:"requiredHoldMs,omitempty"`
	ResetReason    *string  `json:"resetReason,omitempty"`
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

type tokenBucket struct {
	mu         sync.Mutex
	rate       float64
	capacity   float64
	tokens     float64
	lastRefill time.Time
	now        func() time.Time
}

type sessionTokenState struct {
	tokens     float64
	lastRefill time.Time
	lastSeen   time.Time
}

type sessionTokenBuckets struct {
	mu       sync.Mutex
	rate     float64
	capacity float64
	now      func() time.Time
	sessions map[string]sessionTokenState
}

func newTokenBucket(rate float64, burst int, now func() time.Time) *tokenBucket {
	startedAt := now()
	return &tokenBucket{
		rate:       rate,
		capacity:   float64(burst),
		tokens:     float64(burst),
		lastRefill: startedAt,
		now:        now,
	}
}

func (limiter *tokenBucket) Allow() bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now()
	elapsed := now.Sub(limiter.lastRefill).Seconds()
	if elapsed > 0 {
		limiter.tokens = math.Min(limiter.capacity, limiter.tokens+elapsed*limiter.rate)
		limiter.lastRefill = now
	}
	if limiter.tokens < 1 {
		return false
	}
	limiter.tokens--
	return true
}

func newSessionTokenBuckets(rate float64, burst int, now func() time.Time) *sessionTokenBuckets {
	return &sessionTokenBuckets{
		rate:     rate,
		capacity: float64(burst),
		now:      now,
		sessions: make(map[string]sessionTokenState),
	}
}

func (limiter *sessionTokenBuckets) Allow(sessionID string) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	now := limiter.now()
	state, exists := limiter.sessions[sessionID]
	if !exists {
		if len(limiter.sessions) >= maxDiagnosticRateSessions {
			limiter.prune(now)
		}
		if len(limiter.sessions) >= maxDiagnosticRateSessions {
			limiter.evictOldest()
		}
		state = sessionTokenState{
			tokens:     limiter.capacity,
			lastRefill: now,
			lastSeen:   now,
		}
	}

	elapsed := now.Sub(state.lastRefill).Seconds()
	if elapsed > 0 {
		state.tokens = math.Min(limiter.capacity, state.tokens+elapsed*limiter.rate)
		state.lastRefill = now
	}
	if now.After(state.lastSeen) {
		state.lastSeen = now
	}
	allowed := state.tokens >= 1
	if allowed {
		state.tokens--
	}
	limiter.sessions[sessionID] = state
	return allowed
}

func (limiter *sessionTokenBuckets) prune(now time.Time) {
	for sessionID, state := range limiter.sessions {
		if now.Sub(state.lastSeen) > diagnosticRateSessionMaxAge {
			delete(limiter.sessions, sessionID)
		}
	}
}

func (limiter *sessionTokenBuckets) evictOldest() {
	var oldestSession string
	var oldestTime time.Time
	for sessionID, state := range limiter.sessions {
		if oldestSession == "" || state.lastSeen.Before(oldestTime) {
			oldestSession = sessionID
			oldestTime = state.lastSeen
		}
	}
	if oldestSession != "" {
		delete(limiter.sessions, oldestSession)
	}
}

type serverOptions struct {
	Now                   func() time.Time
	DiagnosticRate        float64
	DiagnosticBurst       int
	DiagnosticGlobalRate  float64
	DiagnosticGlobalBurst int
}

type appServer struct {
	distFS         fs.FS
	fileServer     http.Handler
	indexHTML      []byte
	indexTime      time.Time
	diagnostics    *diagnosticJSONLogger
	sessionLimiter *sessionTokenBuckets
	globalLimiter  *tokenBucket
}

func newAppServer(distFS fs.FS, diagnosticOutput io.Writer, options serverOptions) *appServer {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	rate := options.DiagnosticRate
	if rate <= 0 || math.IsNaN(rate) || math.IsInf(rate, 0) {
		rate = defaultDiagnosticRate
	}
	burst := options.DiagnosticBurst
	if burst <= 0 {
		burst = defaultDiagnosticRateBurst
	}
	globalRate := options.DiagnosticGlobalRate
	if globalRate <= 0 || math.IsNaN(globalRate) || math.IsInf(globalRate, 0) {
		globalRate = defaultDiagnosticGlobalRate
	}
	globalBurst := options.DiagnosticGlobalBurst
	if globalBurst <= 0 {
		globalBurst = defaultDiagnosticGlobalBurst
	}
	indexHTML, _ := fs.ReadFile(distFS, "index.html")
	var indexTime time.Time
	if indexInfo, err := fs.Stat(distFS, "index.html"); err == nil {
		indexTime = indexInfo.ModTime()
	}
	return &appServer{
		distFS:         distFS,
		fileServer:     http.FileServer(http.FS(distFS)),
		indexHTML:      indexHTML,
		indexTime:      indexTime,
		diagnostics:    newDiagnosticJSONLogger(diagnosticOutput, now),
		sessionLimiter: newSessionTokenBuckets(rate, burst, now),
		globalLimiter:  newTokenBucket(globalRate, globalBurst, now),
	}
}

func (server *appServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	setSecurityHeaders(writer.Header())
	if !canonicalRequestPath(request.URL.Path) {
		writer.Header().Set("Cache-Control", noStoreCacheControl)
		http.NotFound(writer, request)
		return
	}
	switch {
	case request.URL.Path == "/healthz":
		server.serveHealth(writer, request)
	case request.URL.Path == pitchDiagnosticsPath:
		server.servePitchDiagnostics(writer, request)
	case request.URL.Path == "/api" || strings.HasPrefix(request.URL.Path, "/api/"):
		writer.Header().Set("Cache-Control", noStoreCacheControl)
		http.NotFound(writer, request)
	default:
		server.serveStatic(writer, request)
	}
}

func canonicalRequestPath(requestPath string) bool {
	if requestPath == "" || requestPath[0] != '/' || strings.Contains(requestPath, "//") {
		return false
	}
	cleaned := path.Clean(requestPath)
	if cleaned == requestPath {
		return true
	}
	return requestPath != "/" && strings.HasSuffix(requestPath, "/") && cleaned+"/" == requestPath
}

func setSecurityHeaders(header http.Header) {
	header.Set("Content-Security-Policy", contentSecurityPolicy)
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
	header.Set("Referrer-Policy", "same-origin")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
}

func (server *appServer) serveHealth(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", noStoreCacheControl)
	if request.Method != http.MethodGet {
		methodNotAllowed(writer, http.MethodGet)
		return
	}
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, "ok\n")
}

func (server *appServer) serveStatic(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Cache-Control", noStoreCacheControl)
		methodNotAllowed(writer, http.MethodGet, http.MethodHead)
		return
	}

	requestPath := request.URL.Path
	if strings.HasPrefix(requestPath, "/assets/") {
		writer.Header().Set("Cache-Control", immutableAssetCacheControl)
	} else {
		writer.Header().Set("Cache-Control", defaultDocumentCacheControl)
	}

	name := strings.TrimPrefix(path.Clean("/"+requestPath), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	info, err := fs.Stat(server.distFS, name)
	if err == nil && !info.IsDir() {
		if name == "index.html" {
			server.serveIndex(writer, request)
			return
		}
		if name == "manifest.webmanifest" {
			// .webmanifest is absent from some minimal images' MIME databases.
			// Set the standardized type explicitly so installability cannot vary
			// with the runtime base image.
			writer.Header().Set("Content-Type", "application/manifest+json")
		}
		servePath(server.fileServer, writer, request, "/"+name)
		return
	}
	if err == nil && info.IsDir() {
		indexName := strings.TrimSuffix(name, "/") + "/index.html"
		if _, indexErr := fs.Stat(server.distFS, indexName); indexErr == nil {
			servePath(server.fileServer, writer, request, requestPath)
			return
		}
		notFoundNoStore(writer, request)
		return
	}

	if errors.Is(err, fs.ErrPermission) || !errors.Is(err, fs.ErrNotExist) {
		notFoundNoStore(writer, request)
		return
	}
	if strings.HasPrefix(requestPath, "/assets/") ||
		strings.HasPrefix(requestPath, "/worklets/") ||
		requestPath == "/sw.js" {
		notFoundNoStore(writer, request)
		return
	}
	if !requestMayUseSPAFallback(request) {
		notFoundNoStore(writer, request)
		return
	}
	if len(server.indexHTML) == 0 {
		notFoundNoStore(writer, request)
		return
	}
	server.serveIndex(writer, request)
}

func notFoundNoStore(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", noStoreCacheControl)
	http.NotFound(writer, request)
}

func requestMayUseSPAFallback(request *http.Request) bool {
	if path.Ext(strings.TrimSuffix(request.URL.Path, "/")) != "" {
		return false
	}
	if request.Header.Get("Sec-Fetch-Mode") == "navigate" || request.Header.Get("Sec-Fetch-Dest") == "document" {
		return true
	}
	for _, value := range strings.Split(request.Header.Get("Accept"), ",") {
		mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
		if err == nil && mediaType == "text/html" {
			return true
		}
	}
	return false
}

func (server *appServer) serveIndex(writer http.ResponseWriter, request *http.Request) {
	http.ServeContent(writer, request, "index.html", server.indexTime, bytes.NewReader(server.indexHTML))
}

func servePath(fileServer http.Handler, writer http.ResponseWriter, request *http.Request, servedPath string) {
	clone := request.Clone(request.Context())
	clonedURL := *request.URL
	clonedURL.Path = servedPath
	clonedURL.RawPath = ""
	clone.URL = &clonedURL
	fileServer.ServeHTTP(writer, clone)
}

func (server *appServer) servePitchDiagnostics(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", noStoreCacheControl)
	if request.Method != http.MethodPost {
		methodNotAllowed(writer, http.MethodPost)
		return
	}
	if !requestIsSameOrigin(request) {
		http.Error(writer, "cross-origin diagnostics are forbidden", http.StatusForbidden)
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(writer, "content type must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	if request.ContentLength > maxDiagnosticBodyBytes {
		http.Error(writer, "diagnostic payload is too large", http.StatusRequestEntityTooLarge)
		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, maxDiagnosticBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var batch DiagnosticBatch
	if err := decoder.Decode(&batch); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(writer, "diagnostic payload is too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(writer, "invalid diagnostic payload", http.StatusBadRequest)
		return
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(writer, "diagnostic payload is too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(writer, "diagnostic payload must contain one JSON value", http.StatusBadRequest)
		return
	}
	if err := validateDiagnosticBatch(batch); err != nil {
		http.Error(writer, "invalid diagnostic payload", http.StatusBadRequest)
		return
	}
	if !server.sessionLimiter.Allow(batch.SessionID) || !server.globalLimiter.Allow() {
		writer.Header().Set("Retry-After", "1")
		http.Error(writer, "diagnostic rate limit exceeded", http.StatusTooManyRequests)
		return
	}
	if err := server.diagnostics.Log(batch); err != nil {
		http.Error(writer, "diagnostic logging is temporarily unavailable", http.StatusInternalServerError)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func requestIsSameOrigin(request *http.Request) bool {
	switch request.Header.Get("Sec-Fetch-Site") {
	case "", "none", "same-origin":
	default:
		return false
	}

	origin := request.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if !strings.EqualFold(parsed.Host, request.Host) {
		return false
	}
	expectedScheme := forwardedRequestScheme(request)
	return expectedScheme == "" || strings.EqualFold(parsed.Scheme, expectedScheme)
}

func forwardedRequestScheme(request *http.Request) string {
	if request.TLS != nil {
		return "https"
	}
	forwarded := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0])
	if forwarded == "http" || forwarded == "https" {
		return forwarded
	}
	return ""
}

func methodNotAllowed(writer http.ResponseWriter, allowed ...string) {
	writer.Header().Set("Allow", strings.Join(allowed, ", "))
	http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
}

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
