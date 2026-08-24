# NoteForge

NoteForge is a local-first auditory–motor music laboratory. It treats pitch as one navigable object across five views:

```text
heard sound ↔ vocal mechanics ↔ musical label ↔ harmonic function ↔ instrument space
```

The application is organized around five user jobs: **Practice**, **Arcade**, **Explore**, **Songs**, and **Progress**. Pitch match, hum, range work, recognition, intervals, harmony, and melody are exact deep-linked Practice activities rather than permanent sidebar products. They share one continuous voice-input kernel while musical selections and user preferences remain separate state authorities.

## Run it

Requirements: a current Chromium, Firefox, or Safari release and Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. Microphone capture works on localhost or HTTPS. Headphones are strongly recommended for production and Song Lab work.

Verification commands:

```bash
npm run audit:architecture
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run proof:note-input:browser
npm run proof:sustained-note:browser
npm run proof:pitch-tunnel:browser
npm run proof:voice-draw:browser
npm run proof:vocal-flight:browser
npm run proof:pitch-match:responsive
npm run proof:offline:browser
```

## WorkNet deployment

NoteForge runs as an unprivileged Go application container on the external `worknet_net` network. The Go binary serves the built React application, health checks, SPA fallbacks, and the bounded derived-pitch diagnostics endpoint. It publishes no host port; WorkNet's Published Apps flow owns DNS, trusted HTTPS, and edge routing for `https://noteforge.worknet`.

```bash
docker --context default compose up -d --build
```

Register or update the running `noteforge-app` container through WorkNet's **Published Apps** flow. Use Docker-network ingress, upstream `noteforge-app:8080`, hostname `noteforge.worknet`, and the WorkNet CA. Trusted HTTPS is required because browsers do not allow microphone capture or service workers on an insecure custom hostname.

The Compose deployment uses Docker's bounded `local` log driver with three 10 MB files. Derived pitch diagnostics therefore cannot grow the host log store without limit.

## What is working

- **Sound Laboratory:** playable keyboard, chromatic wheel, continuous frequency and one-cent detuning, note/dyad/chord playback, drone, multiple synthesized timbres, label hiding, major/minor/pentatonic/blues contexts, and non-prescriptive tension/resolution analysis.
- **Pitch Mirror:** glide, delayed match, cold attack, memory anchor, and silent-preparation modes; minimally processed microphone requests; AudioWorklet capture; continuous YIN tracking; time-history ribbon; separate attack, center, MAE, in-band, stability, drift, duration, confidence, volume, and vibrato evidence.
- **Pitch Tunnel:** one exact live-F0 anchor drives a 0 → +25 → +50 → +75 → +100-cent round trip and return through disjoint ±10-cent walls. Each checkpoint requires one continuous sample-timed second in lane; silence or uncertainty pauses the hold, a credible wrong pitch resets only the current hold, and completion freezes the score while the same live point keeps following the sensor. It owns no microphone lifecycle, reference playback, alternate tuner, wall clock, or amplitude/confidence gate, and reports only what fundamental-pitch evidence can establish.
- **Continuous voice workflows:** Range Loop, Range Simulator, Pitch Maze, and Resonance consume the same app-owned observation stream through one stable feature surface and one canonical tuner. Setup, current action, and results no longer stack into a scrolling substitute for navigation.
- **Universal Input Scope:** every live-listening workflow reads the same direct detector result: target-relative cents, detected note and frequency, confidence, and opt-in diagnostics. Level is diagnostic only; there is no sensitivity, calibration, or amplitude gate in front of pitch. Once enabled, one app-scoped input session survives prompts and navigation. Every AudioWorklet pitch window is processed even when React consumers change, and the microphone track remains enabled until the user explicitly chooses **Disable voice**, the stream fails, or the application is torn down.
- **Hum Laboratory:** comfortable-anchor discovery plus target matching, glide landing, and sustained-hum practice across M, N, and NG gestures, with voiced continuity and pitch evidence kept distinct from unmeasured resonance or placement.
- **Range Simulator:** a subjective-first guided map that compares up to five nearby pitches to choose a comfortable baseline, probes outward chromatically, collects the singer's 1 effortless → 5 unreliable rating on every attempt, expands lower and upper directions independently, rechecks one unstable edge, and saves a conservative current-range profile without assigning a voice type or physiological limit. Comfort ratings remain separate from detector-backed pitch evidence and explicit clean-phonation claims.
- **Range Loop:** one stable target surface with one live tuner and one sample-coordinate hold. A brief reference is a user-requested 0.5-second action; it never gates detection, starts accompaniment, clears earned time, or opens an isolation workflow. Unvoiced and uncertain observations pause credited dwell without erasing it; only a credible wrong pitch resets an unfinished hold. Natural or chromatic sequences span the complete detector-backed F♯1–D6 curriculum and advance only when the user chooses the next target.
- **Voice Arcade:** seven game workflows driven by the same retained microphone: Pitch Pong trains continuous pitch-to-position control through a shared analog axis; Pitch Maze trains nearby-note selection and route planning; Vocal Canvas maps eight notes to eight drawing directions; Echo Run combines memory and rhythmic pitch entry; Song Rail uses locally derived target lanes; Resonance turns each continuous voiced pitch observation into a stylized deterministic field; and Vocal Flight calibrates an asymmetric pitch/brightness control surface around a personal neutral vocal center. Flight physics advance only from exact observation sample time while canvas presentation runs independently on `requestAnimationFrame`. Uploaded audio and raw microphone audio remain local.
- **Pitch & Dynamics:** steady, crescendo, decrescendo, diamond, pulse, and free-volume envelopes with pitch and loudness scored independently.
- **Note Recognition:** same/different, direction, reference-backed navigation, pitch class, octave-only, complete note, octave family, and cross-timbre practice. Pitch-class and octave answers remain separate.
- **Interval Laboratory:** melodic ascending/descending and harmonic recognition, production missions, comparisons, phrase mutation, and sound-first presentation.
- **Harmony Laboratory:** chromatic scale-degree recognition/production against an established tonic, chord-tone and tension production, progression missions, voice-leading maps, and fixed-interval versus chord-aware harmony views.
- **Melody Laboratory:** generated call-and-response phrases, contour isolation, continuous pitch drawing and synthesis, and a small hearing-to-piano-roll-to-voice loop.
- **Song Laboratory:** local audio loading, waveform overview, manual looping, speed control, rate-based transpose preview, manual key/chord/phrase notes, breath and phrase markers, and opt-in temporary voice takes across Shadow / Understand / Mutate passes. Recording and diagnostics consume the same owned microphone stream.
- **Offline/local storage:** the production service worker atomically precaches the stamped HTML, hashed JavaScript/CSS, workers, manifest, icon, and pitch worklet, so the first successful install is sufficient for a complete offline reload. IndexedDB stores bounded derived contours, settings, and feature-specific progress, and resolves writes only after transaction commit. Normal pitch sessions do not retain microphone audio. Global adaptive skill mastery is not yet persisted or updated by training attempts.

Rate-based transpose in the current Song Lab also changes transport speed. Independent time-stretch/pitch-shift belongs in a later profiled DSP milestone; the interface states this rather than pretending otherwise.

## Architecture

```text
apps/web
  src/audio             Web Audio synthesis, persistent capture, hashed worklet
  src/diagnostics       Derived-only client batching and allowlisted schema
  src/features          Product surfaces and deep-linked activities
  src/routing           Typed routes over maintained React Router matching
  src/state             Separate musical state and user preferences
  src/storage           IndexedDB adapter
  src/ui                First-party workflow and voice-controller components
cmd/noteforge-server    Go static server, health endpoint, diagnostic validation/logging

packages/music-core     Browser-independent pitch and harmony meaning
packages/pitch-engine   Deterministic YIN detector and smoothing
packages/trainer-core   Scoring, skill graph, progression, scheduling
packages/diagnostic-schema  Shared client/server diagnostic version and flow allowlist
```

The dependency direction is deliberate:

```text
MediaStream → AudioWorklet ring buffer → overlapping PCM window → NoteInputEngine
            → pitch-engine YIN → immutable observation → app-lifetime AudioKernel
            → pure LiveNote/session reducers → granular React view or game loop
```

- `music-core` has no browser dependency.
- `pitch-engine` consumes generated or captured `Float32Array` samples and never snaps continuous pitch before reporting it.
- `trainer-core` consumes observations and knows nothing about microphone capture or React.
- the app-lifetime `AudioKernel` owns permissions, capture, detection, bounded
  history, and granular subscriptions outside the React render clock;
- activities receive observations and describe rules; they cannot control capture.

React Router's `HashRouter` owns URL/history synchronization, matching, links,
and Back/Forward behavior. The application shell dispatches only Home plus the
five product surfaces; the Practice surface owns its activity selector and lazy
activity rendering. Old capability-level hashes are not compatibility aliases.

At 48 kHz the worklet keeps a monotonic PCM ring, emits 4,096-sample pitch windows every 960 samples (20 ms), and independently emits lightweight 1,024-sample level telemetry. Window sizes scale with the AudioContext rate. `NoteInputEngine` normalizes only high-rate analysis copies to at most 48 kHz and returns one voiced, unvoiced, or uncertain observation for every exact half-open sample interval across the canonical 45–1,200 Hz range. Capture epochs, continuity epochs, graph generations, process counts, and processed-sample counts remain attached to the evidence. A pure `LiveNote` reducer derives the current nearest note and same-note occupancy; features derive scoring from the same stream and cannot control capture.

## Measurement proof

The primary executable proof builds the stamped production bundle, serves that exact `dist` output locally, launches it in headless Chromium, and feeds a deterministic WAV through Chromium's fake microphone device. It rejects Vite development/source entry modules, then exercises real permission, `getUserMedia`, `AudioWorkletNode`, `MicrophoneCapture`, `NoteInputEngine`, the external-store bridge, and the rendered note readout. It checks full-range and quiet low-register notes, prompt-time continuity, cross-feature navigation, one detector result per worklet pitch window, track lifecycle, and explicit Disable behavior. See the exact assertions and current output in the [voice-input feature proof](docs/feature-proofs/voice-input.md), or run:

```bash
npm run proof:note-input:browser
npm run proof:sustained-note:browser
```

The final checked-in run detected all 57 semitones F♯1–D6, both literal 45/1,200 Hz boundaries, and all 18 quiet low notes at a measured -60.0 dBFS median. Digital silence remained unvoiced for 56 detector observations; loud seeded broadband noise remained unvoiced for 189/189 observations and note-free in the rendered UI. The proof matched 1,946/1,946 native AudioWorklet windows to detector observations by exact `(captureEpoch, endSample)`, matched the first C3, E3, and G3 detector transitions to exact DOM sample identity, proved every bounded React occupancy publication retained exact sample authority, and forced a real AudioContext suspension that recovered on the same stream with an explicit discontinuity. Chromium detector time was 2.1 ms median, 2.8 ms p95, and 10.3 ms maximum; every call completed within the 20 ms hop budget, so current measurements do not justify WASM.

The separate 38-second sustain proof paired 2,533/2,533 worklet windows and detector frames while F♯1, quiet C3, C4, and D6 each remained continuously detected for more than 8.4 seconds. Range Loop retained one tuner, stopped its single 0.5-second reference without a quieter replacement, and credited exactly three seconds of quiet C3 without rebuilding capture. Vocal Canvas consumed all 452 native observations while React emitted 202 bounded publications, drew Up/Right/Down/Left from C3/D3/E3/F♯3, stayed stationary through silence, and returned exactly to origin. A headless kernel stress also advances 30,000 silence windows—ten minutes of sample time—with no feature or React subscriber and zero capture stops.

Pitch Tunnel's independent production-browser gate consumed 784/784 post-anchor observations in exact order while React emitted 351 bounded publications across 15.66 sample-seconds. It reconstructed all nine exact 1.00-second sample-time dwells, matched every checkpoint and completion transition to its exact detector frame, retained 0.44 seconds through silence, reset only current dwell on credible wrong pitch, kept one lane and one capture graph, played no audio, and continued rendering live F0 after completion.

Vocal Flight's production-browser gate operated all six visible calibration
steps, then consumed all 1,734 pre-exit worklet observations while React emitted
718 exact bounded publications. At stable C3 the shared derived brightness
coordinate separated `0.00428` dark from `0.26584` bright without moving F0;
isolated and combined control drove the deterministic aircraft, silence zeroed
control force, the first resumed voiced frame advanced zero time, and canvas
presentation continued on rAF. Maximum detector-plus-brightness work was 9.8 ms.
The same run passed calibration and flight containment/reachability/hit testing
at 1440, 760, 430, 390, and 320 CSS pixels and retained the one microphone after
route exit.

Detector unit tests remain supplemental. They exercise every enclosed semitone from F♯1 through D6 and the literal 45/1,200 Hz boundaries, immediate note changes, very quiet low-register harmonics, weak-fundamental/dominant-second bass spectra, pure-high and mains-noise octave confounders, all production capture sizes from 44.1 through 192 kHz, silence, deterministic broadband noise, and measured processing time. Missing, unvoiced, wrong-note, and wrong-octave output all fail a pitched-note trial.

`npm run proof:offline:browser` performs a separate fresh-profile production Chromium proof. It installs the service worker online once, forces the browser offline, reloads the rendered React application, loads the actual pitch worklet from Cache Storage, and verifies that API, health, and missing-asset requests never receive the HTML shell as a fallback.

The [verification authority guide](docs/verification.md) states what each test layer can and cannot establish. Static architecture tests inspect ownership and source shape, but never substitute those checks for runtime behavior.

## Privacy model

- No account or external cloud service is required.
- Audio input requests mono capture with echo cancellation, noise suppression, and automatic gain control ideally disabled, then exposes the negotiated device settings in Expert view.
- Navigating between tools does not request permission again or leave departed detector callbacks active. The retained track and detector stay live across navigation; **Disable voice** explicitly closes them.
- Microphone input stores no sensitivity threshold or calibration profile. Derived pitch and level diagnostics are bounded and contain no PCM.
- Standard training stores pitch contours and derived metrics—not raw recordings. Bounded allowlisted pitch, input, and workflow diagnostics are sent to the same NoteForge origin and written as structured server logs; the structured diagnostic endpoint and log lines neither accept nor include PCM, waveform samples, device IDs/labels, IP-address fields, or user-agent fields.
- Song Lab voice takes are explicit, temporary, and held in browser memory in this milestone.
- Local song files are decoded in the browser and never uploaded.

## Next engineering edges

The current build establishes the application and the useful measurement loop. Deeper follow-on work should focus on recorded-voice fixtures, richer polyphonic/rhythm segmentation, phrase scoring and dynamic time warping, persistent adaptive sessions across every exercise, pitch-preserving Song Lab transposition, and then creative MIDI/export tools. Neural pitch detection, source separation, full-song transcription, accounts, and cloud synchronization remain deliberately outside the first system.
