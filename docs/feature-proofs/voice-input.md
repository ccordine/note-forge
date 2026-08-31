# Voice-input executable proof

The authoritative note-input proof is `npm run proof:note-input:browser`. It first builds and stamps the production `dist` bundle, serves that exact output with Vite Preview, launches it in Chromium, and supplies deterministic audio through Chromium's fake microphone device. The script rejects Vite development/source entry modules before testing the same browser path used by a physical microphone:

`getUserMedia -> MediaStreamAudioSourceNode -> AudioWorkletNode -> MicrophoneCapture -> NoteInputEngine -> direct per-window YIN candidate -> shared target-independent temporal tracker -> authoritative observation -> AudioKernel -> rendered note`

Generated-PCM unit tests are useful detector tests, but they are not described as browser or microphone proof because they do not cross that chain.

The per-window detector candidate and the authoritative observation are
deliberately different evidence. Fine motion and a cold attack can be admitted
immediately. A single remote candidate is retained in `pitchCandidate`, while
that exact observation is `uncertain` with reason `temporally-ambiguous`; it
does not expose the stale previous note. A sequence of four coherent 20 ms
candidates becomes the new voiced authority. The tracker has no target,
tolerance, score, or workflow input, so this behavior cannot favor the answer
an exercise expects.

The candidate stage publishes YIN's estimate directly, using the canonical
`0.08` local-minimum threshold. No harmonic-family selector, target hint, or
octave-repair pass may transpose a candidate after estimation. The later
tracker handles only target-independent temporal admission and never changes a
candidate's octave.

## Browser acceptance contract

The proof instruments the browser independently of the application and fails unless all of these are true:

1. Chromium grants one real `getUserMedia` request and the rendered input state becomes `running`.
2. The fake microphone's known changing notes appear in the production `data-detected-note` readout.
3. Coverage spans the canonical 45–1,200 Hz range rather than a hand-picked octave: every enclosed semitone, MIDI 30–86 (F♯1–D6), must appear. Missing or unvoiced pitched input is a failure.
4. A separate quiet pass covers the low register below the former `-42 dBFS` admission threshold. Low fundamentals must still render as notes and may not be reported as inactivity merely because they are low or quiet.
5. Pitch Mirror continues receiving and rendering frames while its prompt/exercise phase changes.
6. Frames continue across a non-microphone route and into Hum Laboratory without another permission request, track disable, detector reset, or stale-note hold.
7. After the proof explicitly enables the visible remote-diagnostics consent setting, independently counted AudioWorklet `samples` messages match production detector diagnostics bijectively by exact `(captureEpoch, startSample, endSample)`, and every interval advances by the configured overlapping hop.
8. The microphone track is never disabled or stopped before the proof presses the real **Disable voice** control. Explicit Disable then stops the owned track exactly once.
9. PCM samples, worklet callbacks, detector windows, and rendered sample identity remain monotonic through silence, prompt changes, navigation, and a route with no microphone consumer.
10. A cold attack publishes on its exact detector frame. For a remote change,
    three consecutive pending windows remain uncertain with no stale note, and
    the fourth coherent 20 ms window must render the new note at its exact
    `endSample`. Any pending candidate projected by React must retain its exact
    detector identity; steady uncertainty may otherwise be coalesced. Neither an
    unbounded agreement gate nor substitution of a later frame may pass.
11. Every frame reports synchronous production detector execution time, and even the maximum must remain below the 960/48 kHz (20 ms) analysis-hop budget.
12. Digital silence and loud deterministic broadband noise continuously produce unvoiced observations and never render a note. Noise RMS must sit above the removed level gate.
13. The app requests the content-hashed worklet emitted by the production build, and that exact asset is included in the stamped offline precache.
14. The rendered meter gives every supported semitone one distinct strictly
    monotonic computed position; no non-boundary note may alias either edge.
15. The scrolling trace exposes the exact capture/sample/continuity/graph
    authority of its actual last point and may not pair geometry with a newer
    independently coalesced label.

The script operates the real opt-in setting, then listens to production diagnostic requests and DOM changes. It does not inject pitch frames, replace the detector, call `NoteInputEngine.process()` itself, fabricate a React controller, or mark an unvoiced frame as success. Outside this explicit proof consent, remote diagnostics remain off.

## Sustained-note and Range Loop acceptance

`npm run proof:sustained-note:browser` uses the same built-bundle Chromium path
for a longer voice-like fixture. It requires at least eight uninterrupted
seconds of correct evidence at F♯1, quiet C3, C4, and D6, with vibrato,
amplitude movement, harmonics, and seeded breath noise. The quiet C3 remains
below the removed level gate. The proof then navigates the same still-running
track into Range Loop and requires:

- one retained tuner DOM identity through wrong pitch, silence, reference, and success;
- earned cumulative sample-time credit continuing while the canonical target note is
  explicitly toggled on;
- one shared sustained playback lane with one full attack and four oscillator
  voices, no duration or automatic cutoff, no quieter continuation, and no
  Stop caused by Start, achievement, or Finish;
- six separated quiet-C3 attempts collectively crossing 30 seconds, with each
  breath adding no time, bridging no gap, and erasing no prior credit;
- collective credit continuing beyond the achievement threshold until visible
  **Finish**, while PCM and live-note
  telemetry continue without a stream, track, AudioContext, or worklet
  replacement;
- visible **I can’t reach this note** excluding D3 without a pass or false
  credit, moving to E3, and visible **Recheck excluded notes** restoring D3
  without replacing the active target, tuner, or capture; and
- exact worklet/detector sample-coordinate pairing until the one explicit
  **Disable voice** action.

## Noisy Range Loop acceptance

`npm run proof:range-loop-noisy:browser` reproduces the user-facing failure at
the full application boundary. A generated fake microphone holds one C3 while
the fixture moves through 13 deterministic stages: the red-team +10 dB seed,
clean C3, broadband noise at +30, +20, +10, +6, and +3 dB SNR, short impulses,
dominant second and third harmonics, brief amplitude drops, changing broadband
noise, and clean recovery. The proof mounts the real `/practice/range-loop`
route and the same shared `NoteInput` component used elsewhere. It does not
inject frames, mock the detector, call the tracker directly, or implement a
test-only hold.

The assertions are about authoritative observations, not about pretending every
raw candidate is correct. An uncertain observation may pause new qualified
time, but it may not grant a contradictory note authority or regress already
earned C3 credit. The real C3 gate must collect at least 30 seconds and enable
**Next target** before the fixture changes. Then a persistent D3 must become
authoritative and collect its own 30 seconds on
the same mounted `NoteInput`, proving the tracker is responsive to a genuine
change rather than merely sticky. The browser stages stop at +3 dB SNR. A +0 dB
case exists only in the supplemental unit matrix and must not be reported as a
browser result.

## Pitch Tunnel acceptance

`npm run proof:pitch-tunnel:browser` enters the exact built Practice route and
anchors from a real rendered C3 observation. Its generated microphone fixture
then drives the production worklet, detector, external realtime store, and one
stable lane through `0, +25, +50, +75, +100, +75, +50, +25, 0` cents. An
independent detector-frame oracle reconstructs each checkpoint from sample
coordinates and requires exactly 1.00 second inside disjoint ±10-cent walls.
Every checkpoint/status DOM transition must retain the exact completing frame.
The fixture also proves silence pauses retained dwell, a credible wrong pitch
resets only current dwell, trajectory achievement remains an active live trace,
scoring continues until visible **Finish**, live F0 continues afterward, and no
playback or feature-owned capture operation occurs.

## Supplemental detector contract

`tests/note-input-engine.test.ts`, `tests/note-input-antialias.test.ts`,
`tests/noisy-vocal-pitch-tracker.test.ts`,
`tests/low-register-pitch-regression.test.ts`, and
`packages/pitch-engine/test/b2-octave-regression.test.ts` call the production
engine and DSP with deterministic capture-sized windows. `NoteInputEngine` is
stateful by design: it owns private reusable
normalization/detector workspace and the shared temporal tracker state for its
capture authority. Their assertions require:

- every semitone from F♯1 through D6 plus the literal 45/1,200 Hz boundaries
  across the supported capture-rate matrix;
- immediate cold attacks and fine continuation, an exact uncertain candidate
  frame for a remote change, and coherent four-window acceptance;
- quiet harmonic detection far below the removed sensitivity gate, including the lowest supported octave;
- weak-fundamental, dominant-second low spectra across multiple phases and sample rates;
- pure-high and mains-plus-noise confounders that must not be folded into a false low octave;
- allocation-stable 129-tap Kaiser half-band anti-alias stages for high-rate
  analysis copies through the 768 kHz public capture limit, without changing
  original capture/sample authority;
- rejection of image-frequency aliases while retaining a -126 dBFS real
  fundamental beneath out-of-band interference;
- noisy steady-C3 matrices across multiple seeds and +30 through +0 dB SNR,
  plus a persistent noisy C3→C2 change that must become authoritative;
- digital silence and seeded broadband noise remaining unvoiced; and
- reported per-window processing measurements.

Controller and gameplay tests consume those real detector frames to check their local scoring behavior. They do not redefine whether a note exists.

## Running the proof

```bash
npm run proof:note-input:browser
npm run proof:range-loop-noisy:browser
npm run proof:user-owned-traces:browser
npm run proof:sustained-note:browser
npm run proof:mobile-note-playback:layout
npm run proof:voice-draw:browser
npm run proof:vocal-flight:browser
npm run proof:pitch-tunnel:browser
npm run proof:pitch-match:responsive
npm run proof:offline:browser
npm test -- --maxWorkers=1 --no-file-parallelism --no-cache
npm run audit:architecture
npm run typecheck
npm run build
```

The browser command requires an installed Chromium and starts only local Vite Preview/Chrome processes after the production build. It generates its WAV in a temporary directory and removes that directory and both processes when complete.

## Verified result — 2026-08-31

The final run against the built production bundle reported:

- 57/57 enclosed semitones, MIDI 30–86;
- both literal 45/1,200 Hz boundaries and 18/18 quiet low notes, MIDI 30–47,
  near -60 dBFS;
- loud seeded broadband noise unvoiced for 192/192 observations;
- exact 2,173/2,173 AudioWorklet-to-authoritative-observation sample-identity
  pairs at a 960-sample hop;
- the runtime-requested content-hashed pitch worklet matched the sole pitch
  worklet in the stamped service-worker precache;
- C3, E3, and G3 each retained three exact uncertain windows with no stale note
  before confirmation on the fourth coherent window at `endSample` 88,576,
  123,136, and 156,736;
- all 57 supported notes occupied distinct, strictly monotonic computed meter
  positions, and representative ribbon points retained exact sample authority;
- a forced AudioContext suspension recovered automatically with continuity epoch 0→1 and `discontinuity=true`, retaining one stream, track, and worklet;
- detector execution median 2.1 ms, p95 2.5 ms, maximum 10.1 ms, all below the 20 ms hop;
- one `getUserMedia` call, zero track disables, zero pre-Disable stops, and exactly one stop after global **Disable voice**.

The sustained-note proof independently paired 3,908/3,908 worklet windows and
authoritative observations. F♯1, quiet C3 at median -62.9 dBFS, C4, and D6
retained 8.380, 8.400, 8.400, and 8.420 seconds of uninterrupted evidence.
Maximum detector work was 10.5 ms. Range Loop kept one tuner while six
separated quiet-C3 attempts collectively reached 30.08 seconds and continued
to 30.28 seconds; the intervening breaths erased no credit. It froze only on
visible **Finish** while PCM/live C3 continued. A visible D3 outside-range
decision then moved to E3 with zero false credit, and visible Recheck restored
D3 without replacing the tuner or capture. The target note used one
four-oscillator sustained lane with no automatic stop or quieter continuation;
Start, achievement, and Finish produced no playback stop.

The noisy Range Loop proof accumulated 32.50 C3 seconds through all 13 authored
interference stages. It observed zero contradictory C3 authorities and zero
credit regressions, enabled C3's **Next target**, then accepted persistent D3
and accumulated 30.04 seconds on the same `NoteInput` DOM node. +30, +20, +10, +6,
and +3 dB SNR are browser results; +0 dB is supplemental unit evidence only.

The user-owned trace proof retained Pitch Match for 4.80 seconds, Hum Lab for
8.80, and Pitch Control for 12.84 past their deleted automatic cutoffs. Only
each visible **Finish** completed its session; one capture produced zero
pre-Disable stops.

Vocal Canvas consumed all 641 worklet observations while React emitted 294
bounded exact publications. Five silence runs remained stationary; C3/D3/E3/
F♯3 moved Up/Right/Down/Left; four strokes closed with 0.0 px error.

Pitch Tunnel consumed 976 exact post-anchor observations while React emitted
447 bounded publications across 19.50 sample-seconds. All nine dwells were
exactly 1.00 second; silence retained 0.38 seconds; credible wrong pitch reset
current dwell; achievement remained nonterminal; scoring continued 9.38→10.12
seconds until visible **Finish**.

The mobile note-playback proof covered 11 real production routes at 320×568
and 390×844. All 22 cases had no horizontal overflow or unreachable control,
reached the page end, and completed the same **Play → Stop → Play** toggle
interaction.

The reusable detector and anti-alias workspaces allocate no
steady-state typed-array scratch after one-time growth. The headless kernel
consumed 30,000 silence windows—ten minutes of sample time—with no subscriber or
exercise and zero capture stops. Unit lifetime proofs retain live feature state
for an hour; history remains bounded without becoming completion authority.

## Scope of the claim

The deterministic browser proof establishes that the checked-in production software does not drop pitched windows because of amplitude gates, prompt state, React ownership, or navigation. The detector fixtures establish its explicit signal/range boundary. Neither is a claim that every physical microphone, operating-system DSP stack, room, or vocal timbre is identical. Hardware-specific failures must be diagnosed from the same uninterrupted worklet and detector counters; they may not be dismissed by substituting a synthetic unit test.
