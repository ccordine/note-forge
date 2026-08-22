# NoteForge

NoteForge is a local-first auditory–motor music laboratory. It treats pitch as one navigable object across five views:

```text
heard sound ↔ vocal mechanics ↔ musical label ↔ harmonic function ↔ instrument space
```

The application is intentionally not a sequence of quiz apps. Sound Laboratory, Pitch Mirror, Hum Laboratory, recognition, intervals, harmony, melody, and song work all share the same target pitch, cents offset, tonic, scale, chord, timbre, and tolerance.

## Run it

Requirements: a current Chromium, Firefox, or Safari release and Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. Microphone capture works on localhost or HTTPS. Headphones are strongly recommended for production and Song Lab work.

Verification commands:

```bash
npm test
npm run typecheck
npm run build
```

## What is working

- **Sound Laboratory:** playable keyboard, chromatic wheel, continuous frequency and one-cent detuning, note/dyad/chord playback, drone, multiple synthesized timbres, label hiding, major/minor/pentatonic/blues contexts, and non-prescriptive tension/resolution analysis.
- **Pitch Mirror:** glide, delayed match, cold attack, memory anchor, and silent-preparation modes; minimally processed microphone requests; AudioWorklet capture; continuous YIN tracking; time-history ribbon; separate attack, center, MAE, in-band, stability, drift, duration, confidence, volume, and vibrato evidence.
- **Hum Laboratory:** comfortable-anchor discovery plus target matching, glide landing, and sustained-hum practice across M, N, and NG gestures, with voiced continuity and pitch evidence kept distinct from unmeasured resonance or placement.
- **Pitch & Dynamics:** steady, crescendo, decrescendo, diamond, pulse, and free-volume envelopes with pitch and loudness scored independently.
- **Note Recognition:** same/different, direction, reference-backed navigation, pitch class, octave-only, complete note, octave family, and cross-timbre practice. Pitch-class and octave answers remain separate.
- **Interval Laboratory:** melodic ascending/descending and harmonic recognition, production missions, comparisons, phrase mutation, and sound-first presentation.
- **Harmony Laboratory:** chromatic scale-degree recognition/production against an established tonic, chord-tone and tension production, progression missions, voice-leading maps, and fixed-interval versus chord-aware harmony views.
- **Melody Laboratory:** generated call-and-response phrases, contour isolation, continuous pitch drawing and synthesis, and a small hearing-to-piano-roll-to-voice loop.
- **Song Laboratory:** local audio loading, waveform overview, manual looping, speed control, rate-based transpose preview, manual key/chord/phrase notes, breath and phrase markers, and opt-in temporary voice takes across Shadow / Understand / Mutate passes.
- **Skill graph:** 38 trainable primitives with explicit prerequisites, representations, difficulty, confusion-aware state updates, and a deterministic 60 / 20 / 20 adaptive scheduler.
- **Offline/local storage:** production service-worker shell caching and IndexedDB for contours, metrics, settings, and skill state. Normal pitch sessions do not retain microphone audio.

Rate-based transpose in the current Song Lab also changes transport speed. Independent time-stretch/pitch-shift belongs in a later profiled DSP milestone; the interface states this rather than pretending otherwise.

## Architecture

```text
apps/web
  src/audio             Web Audio synthesis, microphone adapter
  src/features          One connected laboratory interface
  src/state             Shared musical coordinate state
  src/storage           IndexedDB adapter
  public/worklets       Real-time capture worklet

packages/music-core     Browser-independent pitch and harmony meaning
packages/pitch-engine   Deterministic YIN detector and smoothing
packages/trainer-core   Scoring, skill graph, progression, scheduling
```

The dependency direction is deliberate:

```text
AudioWorklet samples → pitch-engine PitchFrame[] → trainer-core scorer → UI / IndexedDB
                                          │
music-core context ────────────────────────┘
```

- `music-core` has no browser dependency.
- `pitch-engine` consumes generated or captured `Float32Array` samples and never snaps continuous pitch before reporting it.
- `trainer-core` consumes observations and knows nothing about microphone capture or React.
- the web application owns permissions, audio routing, persistence, and presentation.

## Measurement proof

The automated suite exercises every semitone across the intended vocal range, ±10/25/50-cent detuning, vibrato, harmonic-rich signals, amplitude envelopes, deterministic noise, silence, short/invalid buffers, and transient versus sustained octave changes. It also validates music conversions, contextual ninth/tension language, vibrato-aware scoring, the complete primitive graph, confusion tracking, and the 60/20/20 scheduler.

Detector failures return explicit unvoiced reasons such as `below-rms-threshold`, `insufficient-samples`, or `no-periodic-candidate`; they are not silently rounded into notes.

## Privacy model

- No account or backend is required.
- Audio input requests mono capture with echo cancellation, noise suppression, and automatic gain control ideally disabled, then exposes the negotiated device settings in Expert view.
- Standard training stores pitch contours and derived metrics—not raw recordings.
- Song Lab voice takes are explicit, temporary, and held in browser memory in this milestone.
- Local song files are decoded in the browser and never uploaded.

## Next engineering edges

The current build establishes the application and the useful measurement loop. Deeper follow-on work should focus on recorded-voice fixtures and calibration, overlapping worklet windows, rhythm/note segmentation, phrase scoring and dynamic time warping, persistent adaptive sessions across every exercise, pitch-preserving Song Lab transposition, and then creative MIDI/export tools. Neural pitch detection, source separation, full-song transcription, accounts, and cloud synchronization remain deliberately outside the first system.
# note-forge
