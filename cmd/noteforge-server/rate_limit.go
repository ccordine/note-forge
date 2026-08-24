package main

import (
	"math"
	"sync"
	"time"
)

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
