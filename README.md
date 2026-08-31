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
npm run proof:range-loop-noisy:browser
npm run proof:user-owned-traces:browser
npm run proof:sustained-note:browser
npm run proof:monitoring:browser
npm run proof:mobile-note-playback:layout
npm run proof:pitch-tunnel:browser
npm run proof:voice-draw:browser
npm run proof:vocal-flight:browser
npm run proof:pitch-match:responsive
npm run proof:tone-map:browser
npm run proof:offline:browser
```

## WorkNet deployment

NoteForge runs as an unprivileged Go application container on the external `worknet_net` network. The Go binary serves the built React application, health checks, SPA fallbacks, and the explicitly opted-in bounded derived-pitch diagnostics endpoint. It publishes no host port; WorkNet's Published Apps flow owns DNS, trusted HTTPS, and edge routing for `https://noteforge.worknet`.

```bash
npm run deploy:worknet
```

That entrypoint is deliberately pinned to Docker context `default`. It first
requires the pre-existing external `worknet_net` network and refuses to deploy
if it is absent; neither the script, Compose, nor the image ever creates or
substitutes a network.

Register or update the running `noteforge-app` container through WorkNet's **Published Apps** flow. Use Docker-network ingress, upstream `noteforge-app:8080`, hostname `noteforge.worknet`, and the WorkNet CA. Trusted HTTPS is required because browsers do not allow microphone capture or service workers on an insecure custom hostname.

The Compose deployment uses Docker's bounded `local` log driver with three 10 MB files. When explicitly enabled, derived pitch diagnostics therefore cannot grow the host log store without limit.

## What is working

- **Sound Laboratory:** playable keyboard, chromatic wheel, continuous frequency and one-cent detuning, note/dyad/chord playback, drone, multiple synthesized timbres, label hiding, major/minor/pentatonic/blues contexts, and non-prescriptive tension/resolution analysis.
- **Pitch Mirror:** glide, delayed match, cold attack, memory anchor, and silent-preparation modes consume the shared app-owned AudioWorklet/YIN telemetry; its time-history ribbon derives separate attack, center, MAE, in-band, stability, drift, duration, confidence, volume, and vibrato evidence without owning capture.
- **Pitch Tunnel:** one exact live-F0 anchor drives a 0 → +25 → +50 → +75 → +100-cent round trip and return through disjoint ±10-cent walls. Each checkpoint requires one continuous sample-timed second in lane; silence or uncertainty pauses the hold, a credible wrong pitch resets only the current hold, and reaching the authored trajectory is nonterminal. Scoring and the live point continue until the user chooses **Finish**. It owns no microphone lifecycle, reference playback, alternate tuner, wall clock, or amplitude/confidence gate, and reports only what fundamental-pitch evidence can establish.
- **Continuous voice workflows:** Range Loop, Range Simulator, Pitch Maze, and Resonance consume the same app-owned observation stream through one stable feature surface and one canonical tuner. Setup, current action, and results no longer stack into a scrolling substitute for navigation.
- **Universal Input Scope:** every live-listening workflow reads the same authoritative voiced/unvoiced/uncertain observation, continuous frequency, confidence, and sample authority, then derives target-relative error and scoring downstream. The per-window estimator candidate remains inspectable, but one target-independent shared temporal tracker—not an exercise or scorer—decides whether contradictory evidence is authoritative. Level is diagnostic only; there is no sensitivity, calibration, or amplitude gate in front of pitch. Remote derived diagnostics are off by default and visibly opt-in. Once enabled, one app-scoped input session survives prompts and navigation. Every AudioWorklet pitch window is processed even when React consumers change, and the microphone track remains enabled until the user explicitly chooses **Disable voice**, the stream fails, or the application is torn down.
- **Direct vocal monitoring:** the global headphones-only control fans the retained raw microphone source directly into one capture-lifetime gain and the shared interactive AudioContext output, alongside—not through—the pitch worklet. Off/On and level changes automate only that gain with a 5 ms ramp; they never rebuild capture or alter detector/scoring input. The preference is stored separately from exercises, defaults Off, and cannot open the microphone on reload. Settings show negotiated input processing and browser-reported latency estimates without calling them measured round-trip latency; output selection is offered only where the browser supports the user-mediated chooser and shared-context sink API.
- **Isolated-note playback:** every user-facing target, tonic, and individual reference uses one centralized sustained **Play / Stop** toggle. It has no duration, decay, quieter continuation, or automatic cutoff. Target and timbre changes retune the running lane in place; training Start/Finish/reset/scoring transitions cannot stop it. Authored intervals, chords, melodies, songs, and other temporal gestures remain a separate transport.
- **Hum Laboratory:** comfortable-anchor discovery plus target matching, glide landing, and sustained-hum practice across M, N, and NG gestures, with voiced continuity and pitch evidence kept distinct from unmeasured resonance or placement.
- **Range Simulator:** a subjective-first guided map that compares up to five nearby pitches to choose a comfortable baseline, probes outward chromatically, collects the singer's 1 effortless → 5 unreliable rating on every attempt, expands lower and upper directions independently, rechecks one unstable edge, and saves a conservative current-range profile without assigning a voice type or physiological limit. Comfort ratings remain separate from detector-backed pitch evidence and explicit clean-phonation claims.
- **Range Loop:** one stable target surface with one live tuner and one sample-coordinate cumulative-credit reducer. Every in-lane millisecond earns one practice point toward a fixed 30,000-point/30-second goal; breaths, uncertain evidence, missing windows, and credible wrong pitches pause new credit without erasing any prior credit or bridging the gap. Credit continues beyond the milestone and freezes only when the user chooses **Finish**; only visible **Next target** records the note as earned. **I can’t reach this note** persistently excludes a pitch without awarding it, advances to another trainable note, and remains reversible through **Recheck excluded notes**. Families expand outward from the saved baseline, so a C3 baseline enters Deep at B2 rather than jumping to C2. C2 (65.41 Hz) is inside the detector’s 45–1,200 Hz search range, but detector support never overrides the singer’s explicit reachability judgment. The target note uses the shared sustained **Play / Stop** toggle and remains independent of scoring and capture lifetime.
- **Voice Arcade:** seven game workflows driven by the same retained microphone: Pitch Pong trains continuous pitch-to-position control through a shared analog axis; Pitch Maze trains nearby-note selection and route planning; Vocal Canvas maps eight notes to eight drawing directions; Echo Run combines memory and rhythmic pitch entry; Song Rail uses locally derived target lanes; Resonance turns each continuous voiced pitch observation into a stylized deterministic field; and Vocal Flight calibrates an asymmetric pitch/brightness control surface around a personal neutral vocal center. Flight physics advance only from exact observation sample time while canvas presentation runs independently on `requestAnimationFrame`. Uploaded audio and raw microphone audio remain local.
- **Pitch & Dynamics:** steady, crescendo, decrescendo, diamond, pulse, and free-volume envelopes with pitch and loudness scored independently.
- **Note Recognition:** Tone Map teaches exact sound-to-key and sound-to-voice recall over the full 88-key piano in cumulative six-tone levels. Guided labels disappear before blind mastery, keyboard and vocal evidence remain independent, every prior tone requires current-level reconfirmation, mistakes retain lifetime history while revoking the affected streak, and explicit advancement is never timed. Its isolated prompt is the canonical indefinite **Play / Stop** lane; its separate Simon transport locks answers until the authored sequence finishes, then leaves recall untimed. The laboratory also includes same/different, direction, reference-backed navigation, pitch class, octave-only, complete note, octave family, and cross-timbre practice.
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
packages/pitch-engine   Deterministic direct-YIN pitch estimation
packages/trainer-core   Scoring, skill graph, progression, scheduling
packages/diagnostic-schema  Shared client/server diagnostic version and flow allowlist
```

The dependency direction is deliberate:

```text
MediaStream → AudioWorklet ring buffer → overlapping PCM window → NoteInputEngine
            → anti-aliased analysis copy → direct per-window YIN candidate
            → target-independent temporal tracker → immutable observation → AudioKernel
            → pure LiveNote/session reducers → granular React view or game loop
```

- `music-core` has no browser dependency.
- `pitch-engine` consumes generated or captured `Float32Array` samples and never snaps continuous pitch before reporting it.
- `trainer-core` consumes observations and knows nothing about microphone capture or React. Its skill graph, progression, and scheduler are domain machinery; they are not yet wired to one persisted cross-activity learner model or adaptive Practice default. Arcade XP/mastery remains feature progress, not canonical skill evidence.
- the app-lifetime `AudioKernel` owns permissions, capture, detection, bounded
  history, and granular subscriptions outside the React render clock;
- the same microphone source has a direct `source → monitor GainNode → destination`
  branch; the separate `source → AudioWorklet → zero gain → destination` branch
  remains authoritative for analysis, and worklet repair never detaches monitoring;
- activities receive observations and describe rules; they cannot control capture.

React Router's `HashRouter` owns URL/history synchronization, matching, links,
and Back/Forward behavior. The application shell dispatches only Home plus the
five product surfaces; the Practice surface owns its activity selector and lazy
activity rendering. Old capability-level hashes are not compatibility aliases.

At 48 kHz the worklet keeps a monotonic PCM ring, emits 4,096-sample pitch windows every 960 samples (20 ms), and independently emits lightweight 1,024-sample level telemetry. Window sizes scale with the AudioContext rate. For capture above 48 kHz, `NoteInputEngine` sends an analysis copy through allocation-stable 129-tap Kaiser half-band FIR stages until its rate is at most 48 kHz; it never uses stride-only decimation, and published sample coordinates remain in the original capture domain. Each window publishes YIN's direct estimate using the canonical `0.08` local-minimum threshold. No harmonic-family selector or octave-repair layer may transpose that evidence after estimation. Fine motion and cold attacks are immediate; a lone remote candidate is published on its exact frame as `uncertain`/`temporally-ambiguous`, and four coherent 20 ms windows establish the new authoritative pitch. Silence is immediate and no stale prior note is substituted. The tracker has no target, tolerance, or exercise input. Every exact half-open capture interval still produces one immutable voiced, unvoiced, or uncertain observation across 45–1,200 Hz. A pure `LiveNote` reducer derives the current nearest note and same-note occupancy; features derive scoring from the same stream and cannot control capture.

## Measurement proof

The primary executable proof builds the stamped production bundle, serves that exact `dist` output locally, launches it in headless Chromium, and feeds a deterministic WAV through Chromium's fake microphone device. It rejects Vite development/source entry modules, then exercises real permission, `getUserMedia`, `AudioWorkletNode`, `MicrophoneCapture`, `NoteInputEngine`, the external-store bridge, and the rendered note readout. It checks full-range and quiet low-register notes, prompt-time continuity, cross-feature navigation, one detector result per worklet pitch window, track lifecycle, and explicit Disable behavior. See the exact assertions and current output in the [voice-input feature proof](docs/feature-proofs/voice-input.md), or run:

```bash
npm run proof:note-input:browser
npm run proof:range-loop-noisy:browser
npm run proof:sustained-note:browser
npm run proof:monitoring:browser
npm run proof:mobile-note-playback:layout
```

The final checked-in run detected all 57 semitones F♯1–D6, both literal 45/1,200 Hz boundaries, and all 18 quiet low notes near -60 dBFS. Loud seeded broadband noise remained unvoiced for 192/192 observations. The proof paired 2,173/2,173 native AudioWorklet windows with authoritative observations by exact sample identity. C3, E3, and G3 each retained three exact uncertain windows with no stale note before the fourth coherent candidate became authoritative at `endSample` 88,576, 123,136, and 156,736. This proves both transient rejection and bounded real-transition latency without pretending the raw candidates disappeared. Chromium detector time was 2.1 ms median, 2.5 ms p95, and 10.1 ms maximum; every call completed within the 20 ms hop.

The separate sustained-note proof paired 3,908/3,908 worklet windows and authoritative observations. F♯1, quiet C3, C4, and D6 each remained continuously detected for 8.38–8.42 seconds. In the same retained capture, six separated quiet-C3 attempts collectively reached 30.08 seconds in Range Loop and continued to 30.28; breath gaps erased nothing. Visible **Finish** froze only feature credit while live telemetry continued. A visible D3 outside-range decision then moved to E3 with zero false credit, and visible **Recheck** restored D3 without replacing the tuner or capture. The target reference remained one four-oscillator sustained lane: one full attack, no automatic stop, no gain reduction after any former cutoff, and no stop caused by Start, achievement, or Finish. The shared live-trace proof kept Pitch Match, Hum Lab, and Pitch Control active for 4.80, 8.80, and 12.84 sample-seconds respectively; only their visible **Finish** actions ended feature accumulation. Unit lifetime proofs advance shared traces and holds for an hour without automatic completion, while a headless kernel stress advances 30,000 silence windows—ten minutes of sample time—with no feature or React subscriber and zero capture stops.

The noisy Range Loop browser proof is deliberately a different claim from clean-tone and standalone-noise tests. It feeds one continuous C3 through the real fake-microphone, MediaStream, worklet, detector, shared tracker, shared `NoteInput`, and `/practice/range-loop` UI while applying clean intervals, broadband noise at +30, +20, +10, +6, and +3 dB SNR, deterministic impulses, dominant second and third harmonics, brief amplitude drops, changing noise, and clean recovery. Across 13 stages C3 accumulated 32.50 collective seconds with no contradictory C3 authority and no credit regression, enabling **Next target**. Uncertain observations paused new credit without erasing it. A persistent real D3 then became authoritative and accumulated its own 30.04 seconds in the same DOM component, proving the tracker and scorer are not sticky-C3 exceptions. A supplemental unit matrix also covers +0 dB; the browser fixture intentionally stops at +3 dB and must not be documented as a +0 dB browser result.

The direct-monitoring browser proof sends a deterministic 60-second C3 WAV through Chromium's fake microphone device and the production `getUserMedia` path. It verifies the exact one-source fan-out into one stable monitor gain and one AudioWorklet analysis branch, exact five-millisecond gain ramps, continuous C3 publication while monitoring is toggled and adjusted, and unchanged monotonic PCM hops. At 320x568 and 390x844 the global headphone-only state, level, device rows, diagnostics, and output-routing fallback remain reachable without horizontal overflow. A saved On setting cannot open the microphone after reload; one explicit **Enable voice** reapplies the saved level, route changes retain the same context/source/worklet, and only explicit global **Disable** stops the track. Displayed sample rate, negotiated processing settings, and reported input/base/output latencies are reconciled against the browser's native values. This proves the direct software topology and continuity—not physical microphone-to-ear round-trip latency, which requires external loopback measurement.

Vocal Canvas consumed all 641 native observations while React emitted 294 bounded publications, stayed stationary through five silence runs, drew Up/Right/Down/Left from C3/D3/E3/F♯3, and returned exactly to origin. Pitch Tunnel consumed 976/976 post-anchor observations while React emitted 447 bounded publications across 19.50 sample-seconds. It reconstructed all nine exact 1.00-second dwells, kept achievement nonterminal, continued scoring from 9.38 to 10.12 seconds, and froze only after visible **Finish**.

Vocal Flight consumed 1,735 worklet observations before route exit and 1,852
by the final capture check while React emitted 715 bounded publications. Isolated and combined pitch/brightness
control drove the deterministic aircraft; silence applied no vocal force. After
visible **Finish**, observations advanced 1,788→1,818 while simulation remained
at exactly 970 frames. Calibration and flight passed containment, scrolling,
reachability, and hit testing at 1440, 760, 430, 390, and 320 CSS pixels.

The mobile note-playback proof covers 11 production routes at 320×568 and
390×844. All 22 route/viewport cases reach the page end with no document
overflow or unreachable control, and each canonical note control completes the
visible **Play → Stop → Play** interaction without changing implementations.

The realtime detector now reuses private instance-owned lag, Hann, harmonic,
and high-rate normalization scratch. After one-time growth, steady 48 kHz A3,
C3, and marginal-confidence processing allocated zero new YIN typed arrays; the
deleted path generated about 49 MiB/minute of scratch garbage. Controlled p95
times remained 3.55, 3.41, and 7.31 ms respectively, so current measurements do
not justify WASM.

Detector and engine unit tests remain supplemental. They exercise all 57 enclosed semitones at six standard capture rates, the literal 45/1,200 Hz boundaries, quiet low-register harmonics, weak-fundamental/dominant-second bass spectra, true low notes with odd-grid evidence, and noisy doubled-period/octave confounders. High-rate cases cover the public contract through 768 kHz, reject image-frequency aliases, and retain real fundamentals down to -126 dBFS beneath out-of-band interference. The adversarial tracker matrices vary noise seeds and strength through +0 dB and require both transient contradictory evidence to remain non-authoritative and a persistent noisy C3→C2 change to become authoritative. These tests establish DSP and tracker semantics, not browser integration.

`npm run proof:offline:browser` performs a separate fresh-profile production Chromium proof. It installs the service worker online once, forces the browser offline, reloads the rendered React application, loads the actual pitch worklet from Cache Storage, and verifies that API, health, and missing-asset requests never receive the HTML shell as a fallback.

The [verification authority guide](docs/verification.md) states what each test layer can and cannot establish. Static architecture tests inspect ownership and source shape, but never substitute those checks for runtime behavior.

## Privacy model

- No account or external cloud service is required.
- Audio input requests mono capture with echo cancellation, noise suppression, and automatic gain control ideally disabled, then exposes the negotiated device settings in Expert view.
- Navigating between tools does not request permission again or leave departed detector callbacks active. The retained track and detector stay live across navigation; **Disable voice** explicitly closes them.
- Microphone input stores no sensitivity threshold or calibration profile. Derived pitch and level diagnostics are bounded and contain no PCM.
- Standard training stores pitch contours and derived metrics—not raw recordings. Remote diagnostic sharing is off by default and requires the visible **Share derived pitch diagnostics** setting. When explicitly enabled, bounded allowlisted detector-frame and input-level events go only to the same NoteForge origin; they contain no workflow target, hold, phase, reset reason, PCM, waveform samples, device IDs/labels, IP-address fields, or user-agent fields. Turning sharing off clears the unsent client queue.
- Song Lab voice takes are explicit, temporary, and held in browser memory in this milestone.
- Local song files are decoded in the browser and never uploaded.

## Next engineering edges

The current build establishes the application and the useful measurement loop. Deeper follow-on work should focus on recorded-voice fixtures, richer polyphonic/rhythm segmentation, phrase scoring and dynamic time warping, persistent adaptive sessions across every exercise, pitch-preserving Song Lab transposition, and then creative MIDI/export tools. Neural pitch detection, source separation, full-song transcription, accounts, and cloud synchronization remain deliberately outside the first system.
