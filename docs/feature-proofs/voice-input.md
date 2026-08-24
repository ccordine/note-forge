# Voice-input executable proof

The authoritative note-input proof is `npm run proof:note-input:browser`. It first builds and stamps the production `dist` bundle, serves that exact output with Vite Preview, launches it in Chromium, and supplies deterministic audio through Chromium's fake microphone device. The script rejects Vite development/source entry modules before testing the same browser path used by a physical microphone:

`getUserMedia -> MediaStreamAudioSourceNode -> AudioWorkletNode -> MicrophoneCapture -> NoteInputEngine -> React -> rendered note`

Generated-PCM unit tests are useful detector tests, but they are not described as browser or microphone proof because they do not cross that chain.

## Browser acceptance contract

The proof instruments the browser independently of the application and fails unless all of these are true:

1. Chromium grants one real `getUserMedia` request and the rendered input state becomes `running`.
2. The fake microphone's known changing notes appear in the production `data-detected-note` readout.
3. Coverage spans the canonical 45–1,200 Hz range rather than a hand-picked octave: every enclosed semitone, MIDI 30–86 (F♯1–D6), must appear. Missing or unvoiced pitched input is a failure.
4. A separate quiet pass covers the low register below the former `-42 dBFS` admission threshold. Low fundamentals must still render as notes and may not be reported as inactivity merely because they are low or quiet.
5. Pitch Mirror continues receiving and rendering frames while its prompt/exercise phase changes.
6. Frames continue across a non-microphone route and into Hum Laboratory without another permission request, track disable, detector reset, or stale-note hold.
7. Independently counted AudioWorklet `samples` messages match production detector diagnostics bijectively by exact `(captureEpoch, startSample, endSample)`, and every interval advances by the configured overlapping hop.
8. The microphone track is never disabled or stopped before the proof presses the real **Disable voice** control. Explicit Disable then stops the owned track exactly once.
9. PCM samples, worklet callbacks, detector windows, and rendered sample identity remain monotonic through silence, prompt changes, navigation, and a route with no microphone consumer.
10. The first detector observation that changes to each immediate-change challenge note is the exact `endSample` rendered in the DOM; a hidden multi-frame gate cannot pass.
11. Every frame reports synchronous production detector execution time, and even the maximum must remain below the 960/48 kHz (20 ms) analysis-hop budget.
12. Digital silence and loud deterministic broadband noise continuously produce unvoiced observations and never render a note. Noise RMS must sit above the removed level gate.
13. The app requests the content-hashed worklet emitted by the production build, and that exact asset is included in the stamped offline precache.

The script listens to production diagnostic requests and DOM changes, but it does not inject pitch frames, replace the detector, call `NoteInputEngine.process()` itself, fabricate a React controller, or mark an unvoiced frame as success.

## Sustained-note and Range Loop acceptance

`npm run proof:sustained-note:browser` uses the same built-bundle Chromium path
for a longer voice-like fixture. It requires at least eight uninterrupted
seconds of correct evidence at F♯1, quiet C3, C4, and D6, with vibrato,
amplitude movement, harmonics, and seeded breath noise. The quiet C3 remains
below the removed level gate. The proof then navigates the same still-running
track into Range Loop and requires:

- one retained tuner DOM identity through wrong pitch, silence, reference, and success;
- earned sample-time dwell continuing during one real short-reference click;
- exactly one bounded reference oscillator and no quieter persistent replacement;
- exactly three seconds of credited quiet C3 without a stream, track,
  AudioContext, or worklet replacement; and
- exact worklet/detector sample-coordinate pairing until the one explicit
  **Disable voice** action.

## Pitch Tunnel acceptance

`npm run proof:pitch-tunnel:browser` enters the exact built Practice route and
anchors from a real rendered C3 observation. Its generated microphone fixture
then drives the production worklet, detector, external realtime store, and one
stable lane through `0, +25, +50, +75, +100, +75, +50, +25, 0` cents. An
independent detector-frame oracle reconstructs each checkpoint from sample
coordinates and requires exactly 1.00 second inside disjoint ±10-cent walls.
Every checkpoint/status DOM transition must retain the exact completing frame.
The fixture also proves silence pauses retained dwell, a credible wrong pitch
resets only current dwell, completion leaves live F0 running, and no playback or
feature-owned capture operation occurs.

## Supplemental detector contract

`tests/note-input-engine.test.ts` calls the production stateless engine with deterministic capture-sized windows. Its assertions require:

- every semitone from F♯1 through D6 plus the literal 45/1,200 Hz boundaries on the first PCM window at each supported capture rate;
- immediate identity changes with no acquisition or held-note delay;
- quiet harmonic detection far below the removed sensitivity gate, including the lowest supported octave;
- weak-fundamental, dominant-second low spectra across multiple phases and sample rates;
- pure-high and mains-plus-noise confounders that must not be folded into a false low octave;
- correct normalization at 96 and 192 kHz;
- digital silence and seeded broadband noise remaining unvoiced; and
- reported per-window processing measurements.

Controller and gameplay tests consume those real detector frames to check their local scoring behavior. They do not redefine whether a note exists.

## Running the proof

```bash
npm run proof:note-input:browser
npm run proof:sustained-note:browser
npm run proof:voice-draw:browser
npm run proof:pitch-tunnel:browser
npm run proof:offline:browser
npm test -- --maxWorkers=1 --no-file-parallelism --no-cache
npm run audit:architecture
npm run typecheck
npm run build
```

The browser command requires an installed Chromium and starts only local Vite Preview/Chrome processes after the production build. It generates its WAV in a temporary directory and removes that directory and both processes when complete.

## Verified result — 2026-08-24

The final run against the built production bundle reported:

- 57/57 enclosed semitones, MIDI 30–86;
- 45 Hz measured as 45.000 Hz (-0.02 cents) and 1,200 Hz as 1,200.372 Hz (+0.54 cents);
- 18/18 quiet low notes, MIDI 30–47, at median -60.0 dBFS;
- digital silence unvoiced for 56 detector observations and 14 consecutive rendered samples;
- loud seeded broadband noise unvoiced for 189/189 detector observations and 44 consecutive rendered samples, despite a measured level above the removed gate;
- exact 1,946/1,946 AudioWorklet-to-detector sample-identity pairs at a 960-sample hop;
- the exact runtime-requested `/assets/pitch-capture-worklet-BImFxh7e.js` matched the sole hashed pitch worklet in the stamped service-worker precache;
- the first C3, E3, and G3 changes rendered from their exact first detector `endSample`;
- rendered C3 occupancy entered at zero; every bounded React publication retained the exact authoritative sample coordinate and hop-multiple dwell, then reset at E3 entry and cleared during silence;
- a forced production AudioContext suspension recovered automatically with continuity epoch 0→1 and `discontinuity=true`, retaining one stream, track, and worklet;
- detector execution median 2.1 ms, p95 2.8 ms, maximum 10.3 ms, all below the 20 ms hop budget;
- 1,096 observations in Pitch Mirror, 116 with no microphone consumer mounted, and 728 in Hum Laboratory, with a 76 ms maximum diagnostic gap and 24 ms maximum no-consumer gap;
- live notes present while the Pitch Mirror prompt advanced;
- one `getUserMedia` call, zero track disables, zero pre-Disable track stops, and exactly one stop after the real global Disable control.

The 38-second sustain proof independently paired 2,533/2,533 worklet windows
and detector frames. F♯1, quiet C3 at median -62.9 dBFS, C4, and D6 each
retained more than 8.4 seconds of uninterrupted correct evidence. Range Loop
kept one tuner identity, ended its single 0.5-second reference oscillator with
no quieter replacement, and credited exactly 3.0 seconds of quiet C3 without a
stream, context, or worklet reset.

Vocal Canvas consumed all 452 native worklet observations while React emitted
202 bounded publications. Each published sample identified its exact worklet
ordinal; C3/D3/E3/F♯3 moved Up/Right/Down/Left, five silence intervals remained
stationary, and four SVG strokes returned to origin with 0.0 px closure error.

Pitch Tunnel consumed 784/784 post-anchor worklet observations in exact order
while React emitted 351 bounded exact publications across 15.66 sample-seconds.
All nine independently reconstructed 1.00-second dwells and their DOM
transitions matched exact detector frames. Silence retained 0.44 seconds,
credible wrong pitch reset current dwell without erasing aggregate evidence,
and the same lane remained live after completion with no playback.

The headless kernel stress consumed 30,000 silence windows—ten minutes of sample
time—with no React subscriber or exercise attached and zero capture stops. The
complete final frontend suite passed 753/753 tests across 79 files. Coverage is
62.21% statements, 57.35% branches, 52.83% functions, and 64.66% lines; the
pitch engine has 94.36% statement coverage.

## Scope of the claim

The deterministic browser proof establishes that the checked-in production software does not drop pitched windows because of amplitude gates, prompt state, React ownership, or navigation. The detector fixtures establish its explicit signal/range boundary. Neither is a claim that every physical microphone, operating-system DSP stack, room, or vocal timbre is identical. Hardware-specific failures must be diagnosed from the same uninterrupted worklet and detector counters; they may not be dismissed by substituting a synthetic unit test.
