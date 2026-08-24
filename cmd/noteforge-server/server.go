package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	immutableAssetCacheControl  = "public, max-age=31536000, immutable"
	defaultDocumentCacheControl = "no-cache"
	noStoreCacheControl         = "no-store"
)

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"

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
