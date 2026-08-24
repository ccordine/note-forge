# NoteForge engineering contract

## Primary invariant: NoteForge has ears

Once the user explicitly enables voice input, NoteForge continuously samples
and analyzes the retained microphone stream until the user explicitly disables
it, permission is revoked, the device disappears, or the browser/OS tears down
the underlying media resource.

The only authoritative live path is:

```text
one app-owned MediaStream
  -> one AudioWorklet capture graph
  -> monotonic PCM ring buffer
  -> deep overlapping analysis windows
  -> short analysis hops
  -> one PitchObservation per window
  -> one shared live stream
  -> any number of downstream consumers
```

At 48 kHz the production contract is a 4,096-sample analysis window and a
960-sample (20 ms) hop. Window depth supplies low-frequency evidence down to
45 Hz; hop size supplies real-time response. These must never be collapsed back
into non-overlapping capture transactions.

While input is enabled, worklet `processCount`, `processedSampleCount`, window
coordinates, and detector-window count are monotonic. Silence still advances
all of them. The acquisition heartbeat is PCM progression, never the arrival of
a voiced pitch.

## Domain model

The public input lifecycle is only:

```text
disabled -> opening -> running -> error
```

`running` means the transport is alive. It does not mean a note is voiced.
There is deliberately no `stalled` state.

Every overlapping analysis window becomes exactly one immutable observation:

```ts
type PitchObservation = {
  observationKind: "voiced" | "unvoiced" | "uncertain";
  timeSeconds: number;
  sampleRate: number;
  startSample: number;
  endSample: number;
  processedSampleCount: number;
  captureEpoch: number;
  continuityEpoch: number;
  graphGeneration: number;
  workletProcessCount: number;
  discontinuity: boolean;
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidi: number | null;
  centsFromNearest: number | null;
  confidence: number;
  periodicity: number;
  rms: number;
};
```

- Silence and non-periodic noise are `unvoiced` observations.
- Ambiguous or invalid detector evidence is an `uncertain` observation.
- A credible F0 is a `voiced` observation.
- No observation kind changes microphone lifecycle state.
- A discontinuity is explicit sample authority, not a user-facing recovery mode.

The pure `LiveNote` reducer derives the current nearest note, continuous F0,
entry sample, held samples/seconds, and stability from that stream. Sustain,
attacks, drift, range, glides, Pong, DDR, maze movement, and scoring are further
downstream mathematics. They may never create another microphone path.

Voice-controlled motion integrates from observation sample coordinates, never
from callback arrival time or animation-frame time. Silence, uncertainty, an
unmapped note, and a discontinuity stop motion immediately; the first credible
observation after any such boundary establishes fresh sample-time authority and
must move zero distance. No consumer may catch up across missing evidence.

## Ownership rules

- React routes, exercises, prompts, game phases, and consumers never own the
  MediaStream, AudioContext, worklet graph, ring buffer, or detector.
- Navigation and consumer mount/unmount never stop, disable, detach, reset,
  narrow, suspend, or restart capture/detection.
- Feature scoring may accept or reject an observation locally. It may not hide,
  delay, gate, debounce, hold, or rewrite the shared observation.
- Lack of pitch, lack of confidence, silence, a breath, prompt playback, and
  lack of a mounted consumer are all normal continuous operation.
- No feature may run an elapsed-frame watchdog, freeze/terminate gameplay, or
  ask the user to restart because pitch callbacks were absent.
- The microphone track remains enabled after the first explicit Enable action.
  Only an explicit Disable action, an ended track, permission/device loss, or
  app-provider teardown may call `track.stop()`.
- Unexpected AudioContext suspension and missing PCM progression are internal
  infrastructure faults. The capture subsystem resumes the context or rebuilds
  only the processing attachment around the same MediaStream, increments
  continuity/graph authority, and continues. Games do not participate.
- Never add a V2 path, compatibility shim, legacy fallback, second detector,
  or feature-specific capture implementation. Replace and delete in place.

## Detector contract

- Canonical live range is 45–1,200 Hz everywhere.
- Full-range acceptance includes every enclosed equal-tempered semitone, MIDI
  30–86 (F-sharp 1 through D6), plus literal 45 and 1,200 Hz boundaries.
- Quiet valid pitched evidence must not be rejected by calibration, sensitivity,
  amplitude, clipping, target range, or saved profile state.
- Preserve `frequencyHz` and `midiFloat`; nearest-note interpretation must not
  destroy bends, vibrato, blue notes, glides, or microtonal coordinates.
- Level/clipping telemetry is diagnostic only and never admits pitch.
- High-rate hardware PCM may be downsampled for bounded detector work, but
  observation coordinates and sample authority remain in the original capture
  rate and sample domain.
- Use WASM/Worker/SIMD only if production profiling proves JavaScript detector
  work cannot remain below the hop cadence. WASM must never be used to disguise
  a lifecycle or ownership bug.

## Deleted failure modes — do not restore

- `-42 dBFS` sensitivity admission and saved calibration thresholds.
- Acquiring, provisional, held, paused, waiting-for-agreement, or stalled
  detector states.
- First-note and note-change multi-frame gates.
- Prompt-time live-note hiding.
- `MediaStreamTrack.enabled = false` on consumer changes.
- Callbacks that skip detector work when no React consumer exists.
- Route/game cleanup that stops, restarts, or reconfigures input.
- UI or gameplay frame-age watchdogs.
- User-facing Resume/Restart microphone recovery flows.
- Feature-specific detector ranges or capture ownership.
- The unconditional sub-80 Hz octave-correction refusal.
- A stable public worklet URL that can split old service-worker code from new
  application code; the worklet is a content-hashed production asset.

## Proof authority

Generated-PCM unit tests prove detector mathematics. Rendered fixtures prove UI
presentation. Neither proves microphone integration.

The authoritative proof is `npm run proof:note-input:browser`. It builds and
stamps production output, launches real Chromium with a deterministic fake
microphone, and crosses:

```text
permission -> getUserMedia -> MediaStreamAudioSourceNode -> AudioWorklet
-> MicrophoneCapture -> NoteInputEngine -> diagnostics -> React -> rendered DOM
```

It must fail unless all of the following hold:

1. All 57 semitones MIDI 30–86 and both literal frequency boundaries are
   detected accurately.
2. All 18 low notes MIDI 30–47 render below the removed level gate.
3. Silence and loud deterministic broadband noise continuously emit unvoiced
   detector evidence and never render a note.
4. Every native worklet window has exactly one diagnostic observation with the
   same capture epoch and half-open sample interval.
5. Worklet and detector coordinates advance by the configured overlapping hop.
6. The first detector frame that changes to each challenge note is the exact
   `endSample` rendered in the DOM; a hidden agreement gate cannot pass.
7. PCM, worklet, detector, and DOM counters advance during silence, prompts,
   navigation, games, and periods with no microphone consumer mounted.
8. One `getUserMedia` call owns one track across navigation; there are no false
   `enabled` writes and no pre-disable `track.stop()` calls.
9. Detector p95 and maximum execution stay below the 20 ms hop budget for every
   observed production frame. If they do not, profile and move only the compute
   bottleneck off the main thread or into WASM.
10. The content-hashed worklet requested by the app is the worklet included in
    the stamped service-worker precache.

The proof may observe native calls, diagnostics, and DOM mutations. It may not
inject pitch frames, call the detector directly, fabricate a controller, start
message delivery on production's behalf, or weaken a missing/wrong-note result.

`npm run proof:voice-draw:browser` is the cabinet-level authority for Vocal
Canvas. It must enter the built Voice Arcade through the real cabinet button,
enable the shared microphone once, and drive the production worklet and
detector with generated microphone PCM. It proves that C3, D3, E3, and F-sharp3
produce Up, Right, Down, and Left motion; that intervening silence advances PCM
while cursor position remains exact; and that the resulting SVG contains four
coalesced connected strokes. It may read native/worklet/diagnostic/DOM evidence,
but it may never inject a `PitchObservation` or call the drawing reducer.

## Execution plan

1. Inventory every file and authority boundary. **Complete.**
2. Replace transactional capture with persistent MediaStream ownership and an
   overlapping AudioWorklet ring buffer. **Complete.**
3. Add exact sample/epoch/process authority to every observation. **Complete.**
4. Delete stalled/recovery/gate/watchdog state from core, UI, and games.
   **Complete.**
5. Derive current-note occupancy through the pure `LiveNote` reducer.
   **Complete.**
6. Harden diagnostics, offline worklet delivery, browser proof, storage,
   server/container boundaries, package pins, and repository health.
   **Complete; rerun full verification after every substrate change.**
7. Add Vocal Canvas as a sample-time consumer of the existing stream, with
   eight-direction Free Draw, Trace, and Puzzle workflows and its own real
   microphone-to-SVG browser proof. **Complete.**

## Current verified evidence — 2026-08-24

The authoritative built-bundle Chromium proof passed with:

- 57/57 semitones MIDI 30–86;
- 45 Hz measured at 45.000 Hz (+0.02 cents) and 1,200 Hz at 1,200.372 Hz
  (+0.54 cents);
- 18/18 quiet low notes at median -60.0 dBFS;
- 56 silence observations and 193/193 loud-noise observations unvoiced;
- exact 1,950/1,950 native AudioWorklet-to-detector `(captureEpoch, endSample)`
  pairs at a 960-sample hop;
- immediate DOM changes on the first C3, E3, and G3 detector frames, matched by
  exact `endSample`;
- detector time 2.2 ms median, 3.4 ms p95, and 8.5 ms maximum, every frame
  below the 20 ms hop budget;
- 1,098 Pitch Mirror observations, 116 observations with no consumer mounted,
  and 729 Hum Lab observations, with an 80 ms maximum diagnostic gap and 24 ms
  maximum no-consumer gap;
- exact rendered C3 occupancy of 0, 960, 1,920, 2,880, 3,840, and 4,800
  samples, reset on note departure and cleared by silence;
- a real AudioContext suspension automatically resumed with continuity epoch
  0→1 and `discontinuity=true`, while stream, track, and worklet ownership all
  remained singular;
- one `getUserMedia`, zero track disables, zero pre-Disable stops, and exactly
  one explicit stop.
- Vocal Canvas used one stream, track, source, and worklet to carry 435 native
  PCM windows into 435 rendered authoritative frames; five silence intervals
  were exactly stationary, C3/D3/E3/F-sharp3 moved Up/Right/Down/Left by 0.251
  normalized units each, and four coalesced SVG strokes closed with 0.0 px
  error and 0.0 px opposite-side mismatch;
- final frontend suite 629/629 across 52 files; production-inclusive coverage
  43.59% statements, 39.55% branches, 43.54% functions, and 45.73% lines;
- fresh-profile offline Chromium proof with 31 precached resources, the exact
  hashed worklet, 14 routes, and zero API/health/missing-asset shell fallbacks;
- Go tests, race tests, and vet; production image build; and runtime `/healthz`
  all passed.

Because every production detector call completed within its 20 ms hop and the
stream accumulated no detector backlog, WASM is not justified by current
measurements. Re-profile before changing that decision.

## Working rules

- Prefer architectural deletion over compatibility preservation.
- Use exact runtime evidence; never substitute source scanning for behavior.
- Report commands, counts, sample identities, missing evidence, and timing.
- If the browser proof finds a defect, fix production and rerun the proof. Never
  relax the assertion to make broken behavior pass.
