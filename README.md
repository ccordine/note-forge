# NoteForge

NoteForge is a local-first auditory–motor music laboratory. It treats pitch as one navigable object across five views:

```text
heard sound ↔ vocal mechanics ↔ musical label ↔ harmonic function ↔ instrument space
```

The application is intentionally not a sequence of disconnected quiz apps. Sound Laboratory, Pitch Mirror, Hum Laboratory, the guided Range Simulator, the endless Range Loop, Voice Arcade, recognition, intervals, harmony, melody, and song work all share the same target pitch, cents offset, tonic, scale, chord, timbre, and tolerance.

## Run it

Requirements: a current Chromium, Firefox, or Safari release and Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. Microphone capture works on localhost or HTTPS. Headphones are strongly recommended for production and Song Lab work.

Verification commands:

```bash
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run proof:note-input:browser
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
- **First-party coached-workflow components:** Range Loop, Range Simulator, Pitch Maze, and Resonance use the same staged modal shell, progress semantics, focus/exit behavior, direct live voice feedback, microphone meter, and diagnostic disclosure. Exactly one current stage is mounted; later stages do not sit underneath the active task.
- **Universal Input Scope:** every live-listening workflow shows the same direct detector result: target-relative cents, detected note and frequency, confidence, dBFS RMS and peak history, clipping, headroom, and negotiated browser processing. Level is diagnostic only; there is no sensitivity, calibration, or amplitude gate in front of pitch. Once enabled, one app-scoped input session survives prompts and navigation. Every AudioWorklet pitch window is processed even when React consumers change, and the microphone track remains enabled until **Stop input**, stream failure, or application teardown.
- **Hum Laboratory:** comfortable-anchor discovery plus target matching, glide landing, and sustained-hum practice across M, N, and NG gestures, with voiced continuity and pitch evidence kept distinct from unmeasured resonance or placement.
- **Range Simulator:** a subjective-first guided map that compares up to five nearby pitches to choose a comfortable baseline, probes outward chromatically, collects the singer's 1 effortless → 5 unreliable rating on every attempt, expands lower and upper directions independently, rechecks one unstable edge, and saves a conservative current-range profile without assigning a voice type or physiological limit. Comfort ratings remain separate from detector-backed pitch evidence and explicit clean-phonation claims.
- **Range Loop:** the canonical voice-training workflow: setup gives way to a focused full-screen sequence of microphone connection, audible target, live target-relative tuner, uninterrupted hold meter, evidence-backed grade, release, and the next note. It has no failure timer, keeps a same-note guide sounding for unison matching, can instead prompt-and-silence or sustain a harmony guide, advances through saved natural or chromatic register families, and wraps for ongoing review. Detection remains live through every phase; only the local scoring rule decides whether a frame advances a hold. Successful holds build a personal pitch-stability map; clean phonation, accuracy challenges, and directional register shifts remain singer-confirmed observations.
- **Voice Arcade:** six game workflows driven by the same retained microphone: Pitch Pong trains continuous pitch-to-position control through a shared analog axis; Pitch Maze trains distinct nearby-note selection, sustain, release, and route planning; Vocal Canvas anchors Up to the singer's baseline and maps that plus the next seven chromatic notes clockwise to eight cursor directions for free drawing, scored tracing, and unscored drawing prompts; Echo Run combines Simon memory and DDR-style pitch-lock timing; Song Rail transfers the controller into an uploaded track’s locally generated target lanes; Resonance turns direct pitch and capped normalized voice energy into a stylized acoustic field for local physics puzzles. Every cabinet has an orthogonal three-stage curriculum—Deliberate shows full correction, Reflex removes numeric and upcoming-note assistance, and Background makes the game itself the feedback—plus separate mechanical intensity and per-cabinet mastery evidence. Stage presentation and scoring never control microphone capture or note detection. Song Rail reports dominant periodic cues rather than claiming melody transcription, Vocal Canvas scores only explicit trace geometry rather than pretending to understand free-form pictures, and uploaded audio never leaves the browser. Bullet Choir remains a future F0-controlled divided-attention cabinet; spectral brightness, distortion, and timbre controls are not claimed until those signal dimensions have independent proofs.
- **Pitch & Dynamics:** steady, crescendo, decrescendo, diamond, pulse, and free-volume envelopes with pitch and loudness scored independently.
- **Note Recognition:** same/different, direction, reference-backed navigation, pitch class, octave-only, complete note, octave family, and cross-timbre practice. Pitch-class and octave answers remain separate.
- **Interval Laboratory:** melodic ascending/descending and harmonic recognition, production missions, comparisons, phrase mutation, and sound-first presentation.
- **Harmony Laboratory:** chromatic scale-degree recognition/production against an established tonic, chord-tone and tension production, progression missions, voice-leading maps, and fixed-interval versus chord-aware harmony views.
- **Melody Laboratory:** generated call-and-response phrases, contour isolation, continuous pitch drawing and synthesis, and a small hearing-to-piano-roll-to-voice loop.
- **Song Laboratory:** local audio loading, waveform overview, manual looping, speed control, rate-based transpose preview, manual key/chord/phrase notes, breath and phrase markers, and opt-in temporary voice takes across Shadow / Understand / Mutate passes. Recording and diagnostics consume the same owned microphone stream.
- **Skill graph preview:** a 38-primitive catalog with explicit prerequisites, representations, difficulty, hardened progression primitives, and a deterministic 60 / 20 / 20 scheduler. The current Skill Map presents an unmeasured starter/catalog preview; it does not claim that exercise attempts already update persistent global mastery.
- **Offline/local storage:** the production service worker atomically precaches the stamped HTML, hashed JavaScript/CSS, workers, manifest, icon, and pitch worklet, so the first successful install is sufficient for a complete offline reload. IndexedDB stores bounded derived contours, settings, and feature-specific progress, and resolves writes only after transaction commit. Normal pitch sessions do not retain microphone audio. Global adaptive skill mastery is not yet persisted or updated by training attempts.

Rate-based transpose in the current Song Lab also changes transport speed. Independent time-stretch/pitch-shift belongs in a later profiled DSP milestone; the interface states this rather than pretending otherwise.

## Architecture

```text
apps/web
  src/audio             Web Audio synthesis, persistent capture, hashed worklet
  src/diagnostics       Derived-only client batching and allowlisted schema
  src/features          One connected laboratory interface
  src/state             Shared musical coordinate state
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
            → pitch-engine YIN → immutable observation → LiveNote → rendered note
                                                               └→ feature-local scoring
```

- `music-core` has no browser dependency.
- `pitch-engine` consumes generated or captured `Float32Array` samples and never snaps continuous pitch before reporting it.
- `trainer-core` consumes observations and knows nothing about microphone capture or React.
- the web application owns permissions, audio routing, persistence, and presentation.

At 48 kHz the worklet keeps a monotonic PCM ring, emits 4,096-sample pitch windows every 960 samples (20 ms), and independently emits lightweight 1,024-sample level telemetry. Window sizes scale with the AudioContext rate. `NoteInputEngine` normalizes only high-rate analysis copies to at most 48 kHz and returns one voiced, unvoiced, or uncertain observation for every exact half-open sample interval across the canonical 45–1,200 Hz range. Capture epochs, continuity epochs, graph generations, process counts, and processed-sample counts remain attached to the evidence. A pure `LiveNote` reducer derives the current nearest note and same-note occupancy; features derive scoring from the same stream and cannot control capture.

## Measurement proof

The primary executable proof builds the stamped production bundle, serves that exact `dist` output locally, launches it in headless Chromium, and feeds a deterministic WAV through Chromium's fake microphone device. It rejects Vite development/source entry modules, then exercises real permission, `getUserMedia`, `AudioWorkletNode`, `MicrophoneCapture`, `NoteInputEngine`, React state, and the rendered note readout. It checks full-range and quiet low-register notes, prompt-time continuity, cross-feature navigation, one detector result per worklet pitch window, track lifecycle, and explicit Stop behavior. See the exact assertions and current output in the [voice-input feature proof](docs/feature-proofs/voice-input.md), or run:

```bash
npm run proof:note-input:browser
```

The final checked-in run detected all 57 semitones F♯1–D6, both literal 45/1,200 Hz boundaries, and all 18 quiet low notes at a measured -60.0 dBFS median. Digital silence remained unvoiced for 55 detector observations; loud seeded broadband noise remained unvoiced for 192/192 observations and note-free in the rendered UI. The proof matched 1,948/1,948 native AudioWorklet windows to detector observations by exact `(captureEpoch, endSample)`, matched the first C3, E3, and G3 detector transitions to exact DOM sample identity, proved rendered same-note occupancy advanced by each 960-sample hop and cleared on silence, and forced a real AudioContext suspension that recovered on the same stream with an explicit discontinuity. Chromium detector time was 2.3 ms median, 3.5 ms p95, and 12.4 ms maximum; every call completed within the 20 ms hop budget, so current measurements do not justify WASM.

Detector unit tests remain supplemental. They exercise every enclosed semitone from F♯1 through D6 and the literal 45/1,200 Hz boundaries, immediate note changes, very quiet low-register harmonics, weak-fundamental/dominant-second bass spectra, pure-high and mains-noise octave confounders, all production capture sizes from 44.1 through 192 kHz, silence, deterministic broadband noise, and measured processing time. Missing, unvoiced, wrong-note, and wrong-octave output all fail a pitched-note trial.

`npm run proof:offline:browser` performs a separate fresh-profile production Chromium proof. It installs the service worker online once, forces the browser offline, reloads the rendered React application, loads the actual pitch worklet from Cache Storage, and verifies that API, health, and missing-asset requests never receive the HTML shell as a fallback.

The [verification authority guide](docs/verification.md) states what each test layer can and cannot establish. Tests never inspect implementation source text as a substitute for runtime behavior.

## Privacy model

- No account or external cloud service is required.
- Audio input requests mono capture with echo cancellation, noise suppression, and automatic gain control ideally disabled, then exposes the negotiated device settings in Expert view.
- Navigating between tools does not request permission again or leave departed detector callbacks active. The retained track and detector stay live across navigation; **Stop input** fully closes them.
- Microphone input stores no sensitivity threshold or calibration profile. Derived pitch and level diagnostics are bounded and contain no PCM.
- Standard training stores pitch contours and derived metrics—not raw recordings. Bounded allowlisted pitch, input, and workflow diagnostics are sent to the same NoteForge origin and written as structured server logs; the structured diagnostic endpoint and log lines neither accept nor include PCM, waveform samples, device IDs/labels, IP-address fields, or user-agent fields.
- Song Lab voice takes are explicit, temporary, and held in browser memory in this milestone.
- Local song files are decoded in the browser and never uploaded.

## Next engineering edges

The current build establishes the application and the useful measurement loop. Deeper follow-on work should focus on recorded-voice fixtures, richer polyphonic/rhythm segmentation, phrase scoring and dynamic time warping, persistent adaptive sessions across every exercise, pitch-preserving Song Lab transposition, and then creative MIDI/export tools. Neural pitch detection, source separation, full-song transcription, accounts, and cloud synchronization remain deliberately outside the first system.
