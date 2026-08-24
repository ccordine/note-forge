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

## Realtime delivery contract

The 20 ms detector hop is infrastructure cadence, not React render cadence.
Capture, detection, latest observation, live-note reduction, bounded history,
and consumer notification live in one app-lifetime `AudioKernel` outside the
React component tree.

- The kernel exposes a stable imperative `latest()`/`subscribe()` observation
  API and separate slow-changing transport status.
- Games consume the observation stream directly or read the latest snapshot on
  their own render loop. They never require the provider tree to reconcile for
  each detector window.
- React adapters use granular external-store subscriptions: transport status,
  current pitch/note, counters, and opt-in history are independent snapshots.
- Presentation coalescing may bound steady analog motion, but sparse semantic
  transitions must publish the exact reduced observation that caused them.
  Voiced/unvoiced/uncertain changes, discontinuities or authority epochs, and
  domain step/completion transitions may never be represented by a later frame.
- Never copy the full frame ring or meter history into React state on every hop.
  History is mutable bounded kernel storage and becomes an immutable snapshot
  only when an explicit diagnostic consumer requests it.
- A component interested only in whether input is enabled must not rerender
  because frequency, confidence, counters, or history changed.
- Context may provide the stable kernel/controller identity. It may not publish
  a newly allocated high-rate controller object as its value.

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

## Complexity and interaction-authority rules

React is a projection of authoritative data. It is not an audio engine,
exercise scheduler, timer graph, or workflow interpreter.

- A feature component must have one obvious responsibility. At 300 lines it
  requires an explicit extraction review; above 400 lines it fails release
  until orchestration, pure state, persistence, and presentation are separated. A
  1,000+ line component is a release blocker, not an acceptable large feature.
- A JSX component with more than 50 control-flow branches, more than 15
  state/ref/effect hooks, or conditional-render depth above four fails release.
  Split authority and presentation; do not compress, rename, or hide the same
  state machine to satisfy the counter.
- No production executable source file may exceed 600 lines. Support and proof
  sources may cross 600 only through a named boundary review recorded by the
  audit, and none may exceed 1,000. Do not compress or minify source to satisfy
  these rules; reduce responsibilities. A handwritten production line longer
  than 500 characters is itself a release failure because minification and
  unreadable JSX cannot masquerade as a small file.
- Stylesheets are not exempt from ownership. Split feature styles by stable
  surface or component before 600 lines. Feature styles load beside their lazy
  product surface; only shell foundations load from `main.tsx`. CSS `@import`
  chains are prohibited. New selectors must be scoped to the owning
  feature/component and obsolete selectors must be deleted with the UI they served.
- Do not encode an interaction as a forest of boolean flags, mirrored refs,
  timers, and nested `if`/ternary render branches. Mutually exclusive product
  states belong in one small pure reducer/controller with legal transitions.
- A normal live workflow may expose at most `idle`, `tracking`, and `complete`
  to its view. Transport recovery, confidence, silence, uncertainty, prompt
  playback, and release are observations or infrastructure details, never
  alternate full-screen workflows.
- Never nest conditional render expressions. Compute a named view model first,
  then render one stable component tree. The same tuner must not unmount and be
  replaced because a prompt finished, evidence became uncertain, or a score was
  produced.
- One workflow gets one canonical live-note/tuner presentation. Do not mount a
  setup meter, target meter, isolation meter, hold meter, diagnostic meter, and
  advanced copy of the same stream. Additional visualization must add a distinct
  dimension without reproducing the input authority.
- Multi-step work belongs in one explicit, bounded workflow surface driven by a
  small pure state model. Render the current actionable step; do not stack
  setup, instructions, live work, grading, history, diagnostics, and future
  steps down one page and make scrolling act as navigation. The primary action
  and current evidence must be visible without searching the page.
- A workflow shell may keep stable shared instrumentation mounted while its
  user-commanded step content advances. Detector confidence, silence, prompt
  completion, or transport details may update that shell but may not swap the
  user into a different page or hidden workflow.
- Every shipped screen or nested mode must have an obvious reachable entry and
  exit. Top-level navigation is for distinct user jobs, not every experiment;
  related variants share one route and an explicit mode/workflow selector.
  Delete orphaned screens, dead exports, duplicate routes, and tests that are
  the only remaining callers of obsolete product code.
- Never mirror the same mutable fact across React state and multiple refs. One
  reducer/controller owns it; React subscribes and renders the returned value.
  Refs may bridge a callback to the latest pure consumer, not form a second
  hidden state machine.
- Coached activities share one `SessionMachine`/attempt runner for legal stage
  transitions, one abort scope, prompt effects, observation admission, scoring
  handoff, and persistence handoff. A feature supplies targets/rules/view copy;
  it does not recreate timers, generation counters, mounted guards, and promise
  cancellation machinery.
- Ending a session aborts its one scope. Do not accumulate arrays of timers or
  forests of session IDs/generation refs to invalidate individual callbacks.
- Feature code must not start, stop, suspend, rebuild, or reinterpret capture.
  It receives `PitchObservation` values from the app-owned stream and returns
  derived state.
- Exercise time comes from sample coordinates. `Date.now()`,
  `performance.now()`, animation frames, and React effect timing have no scoring
  authority.
- Unvoiced or uncertain evidence may pause qualified-time accumulation; it may
  not erase already observed in-range sample time. Only a credible voiced
  observation outside the target region can reset target occupancy.
- Reference playback is an explicit, short, one-shot user action. It never
  changes detector state, clears occupancy, gates the live readout, starts a
  quieter sustained replacement, or opens an isolation sub-workflow. Sustained
  accompaniment belongs in a separately requested and independently proven
  music feature, not a default pitch-input path.
- Do not preserve a removed interaction through dormant enums, branches,
  storage fields, compatibility adapters, or tests. Delete the obsolete model
  so it cannot become authoritative again.

## Product information architecture

The permanent navigation describes user jobs, never the implementation
catalog. The product surfaces are Practice, Arcade, Explore, Songs, and
Progress; the brand/dashboard may link Home without turning every exercise into
a sidebar destination.

- Pitch match, sustain, range work, recognition, intervals, harmony, and melody
  are deep-linkable Practice activities, not equal permanent nav products.
- Sound experimentation belongs to Explore. Song recording/challenges belong
  to Songs. Vocal range, history, skills, and diagnostics belong to Progress.
- Activity URLs remain directly loadable, copyable, and Back/Forward-safe.
- Use a maintained router and accessible dialog/drawer primitives for their
  standard responsibilities. Do not grow another application-specific hash
  parser, focus trap, or modal framework.
- A product surface owns its child activity selector and current workflow. It
  must not render every activity's setup/results as one scrolling catalog.
- Voice Arcade cabinets have one typed registry authority. Adding a game may
  require one registry definition plus game-owned runtime, renderer, and styles;
  it may not require edits to microphone, session, persistence, curriculum,
  routing, or cabinet-dispatch infrastructure. Deleting a game must be the
  inverse: remove its definition and owned files without unrelated surgery.
- The Arcade shell owns selection, hydration, shared telemetry, curriculum,
  persistence, and navigation. A game owns its intent, pure sample-time runtime,
  and renderer. No central mode switch or feature-owned capture lifecycle is
  permitted.

Before calling a feature production-ready, inspect file sizes, conditional
depth, duplicated input presentations, effect/ref ownership, timers, and audio
calls. Green tests that merely codify a bad state machine are not acceptance.
The browser proof must operate the exact user-visible workflow and fail on UI
replacement, observation loss, hidden gating, duplicate capture presentation,
or unexpected audio playback.

Run `npm run audit:architecture` as a release gate. Any reported oversized
source/component, duplicated `NoteInput`, capture ownership violation, excessive
control depth, or unreachable application module must be resolved or narrowed
by improving the audit itself when it has produced a documented false positive.

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

## Pitch Tunnel contract

Pitch Tunnel is the canonical fine-F0 steering laboratory. It consumes the
authoritative observation stream and may never own capture, playback, a second
tuner, a wall-clock scheduler, or another detector.

- Version one's frozen trajectory is `0, +25, +50, +75, +100, +75, +50, +25,
  0` cents relative to the singer's exact current voiced F0.
- The lane is ±10 cents: 20 cents wide with a 5-cent gap between adjacent
  25-cent checkpoints. A fixed pitch therefore cannot pass two neighboring
  checkpoints.
- Each checkpoint requires one continuous second inside its lane, accumulated
  only from exact consecutive sample intervals. The anchor frame contributes
  zero elapsed time.
- Unvoiced and uncertain observations pause checkpoint occupancy without
  erasing it. A credible voiced observation outside the lane resets the current
  continuous hold while preserving aggregate session evidence.
- Duplicate, reordered, discontinuous, changed-authority, or oversized sample
  gaps credit zero time and establish fresh authority without catch-up.
- Completion freezes scored aggregates, not the instrument: current F0,
  observation kind, exact sample coordinates, and observation count continue to
  update while capture remains enabled.
- The one horizontal lane is the canonical live input visualization. Do not add
  `NoteInput`, a level meter, a setup tuner, a results tuner, reference audio, or
  a second input action beside it.
- Fundamental pitch is the only measured vocal dimension in version one.
  Instructions may ask for a consistent vowel, loudness, resonance, or timbre;
  results must not claim those dimensions remained fixed until they are measured.

## Vocal Flight contract

Vocal Flight is an Arcade consumer of the shared derived observation stream,
not an audio subsystem. Its only control boundary is `VocalObservation ->
VocalControlVector -> deterministic flight/course/scoring runtime -> renderer`.

- Relative F0 controls elevator and the shared pitch-relative harmonic
  brightness coordinate controls roll. Neither axis may use raw Hz, RMS,
  periodicity, detector confidence, or absolute notes as a disguised substitute.
- Calibration retains online derived moments only, never PCM, observations, or
  another frame history. It measures asymmetric lower/upper and darker/brighter
  extents, neutral variance, and voiced center recovery using sample time.
- RMS recorded at neutral is diagnostic only. It may not admit calibration,
  normalize control, affect score, or create a louder-is-better incentive.
- Pitch and brightness qualify independently. If usable brightness cannot be
  demonstrated, the workflow must offer an honest pitch-only surface and retry;
  it may not fabricate a roll axis or block all play.
- A discontinuity, authority change, gap, duplicate, reorder, uncertain window,
  or silence applies zero vocal force immediately and never catches up. Constant
  forward propulsion is autonomous flight behavior and may advance only on
  contiguous PCM sample time with the vocal vector neutralized.
- Physics, gate crossings, course duration, and scoring use exact observation
  deltas. `requestAnimationFrame` renders the latest authoritative state and
  never advances simulation or owns game truth.
- Course scores report only measured dimensions. Unattempted recovery or
  single-axis evidence is `N/A`, never free 100% mastery. Loudness is never a
  scoring input.
- The canvas and one XY vocal reticle remain stable across calibration, flight,
  and results. Vocal Flight mounts no `NoteInput`, local mic action, playback
  prompt, second tuner, or duplicate level meter.
- Registration is the only shell integration. Deleting the `flight` registry
  entry and its owned files must remove the game without routing, persistence,
  capture, curriculum, or unrelated Arcade surgery.

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

`npm run proof:sustained-note:browser` is the long-form continuity authority.
It drives 8.5-second voice-like sustains at F-sharp1, quiet C3 below the former
level gate, C4, and D6 through the real production microphone path. Every
target must retain at least eight seconds of correct contiguous detector
evidence while PCM/worklet/window counters remain monotonic. The same still-live
track then enters Range Loop, retains one tuner DOM identity through wrong
pitch, silence, reference playback, and success, and earns exactly three
sample-timed seconds on C3. No stream, track, context, or worklet replacement
and no pre-Disable stop is permitted.

`npm run proof:voice-draw:browser` is the cabinet-level authority for Vocal
Canvas. It must enter the built Voice Arcade through the real cabinet button,
enable the shared microphone once, and drive the production worklet and
detector with generated microphone PCM. It proves that C3, D3, E3, and F-sharp3
produce Up, Right, Down, and Left motion; that intervening silence advances PCM
while cursor position remains exact; and that the resulting SVG contains four
coalesced connected strokes. Its final runtime observation count must equal the
native worklet-window count; every bounded React publication must identify the
exact worklet ordinal it represents. It may read native/worklet/diagnostic/DOM
evidence, but it may never inject a `PitchObservation` or call the drawing
reducer.

`tests/audio-kernel-headless.test.ts` is the consumer-independence stress
authority. It advances 30,000 exact silence windows—ten minutes of 50 Hz sample
time—with no React subscriber and no exercise, then requires a running kernel,
exact counters, an unvoiced latest observation, and zero capture stops. It is a
kernel continuity proof, not a substitute for the Chromium microphone proof.

`npm run proof:pitch-tunnel:browser` is the built-interaction authority for fine
pitch steering. It enters the exact Practice deep link, enables the global
microphone once, anchors from the real rendered C3 observation, and drives the
quarter-tone ascent/reversal through generated microphone PCM. It must reconcile
every post-anchor session observation to a native worklet window by exact sample
identity, prove bounded React publications retain that authority, cross all nine
checkpoints on their exact completing observations, publish the first voiced
frame after silence without a one-hop delay, exercise silence and
credible-wrong-pitch semantics, retain one lane DOM identity through
idle/tracking/complete, and keep live F0 updating after the score latches. It may
observe native calls, diagnostics, and DOM attributes; it may never inject an
observation or call the reducer/detector directly.

`npm run proof:pitch-match:responsive` is the built-layout authority for Pitch
Match. It must exercise all five modes at 1440, 1261/1260, 1041/1040, 761/760,
431/430, 390, and 320 CSS pixels. It rejects descendant clipping even when the
document hides horizontal overflow, scrolls and hit-tests every control, and
runs idle, tracking, complete, and reset with the real fake-microphone path on
both phone widths. A root `scrollWidth` assertion alone is never sufficient.

## Overhaul completion ledger

1. Inventory every file, component, route, nested mode, input mount, lifecycle
   hook, timer, branch depth, and import edge with an enforceable repository
   audit. **Complete; the first scan found 31 release violations.**
2. Delete Range Loop's guide/isolation/phase architecture and replace it with
   one tuner plus pure sample-coordinate dwell. **Complete.**
3. Remove default diagnostic and meter duplication; replace stacked Song Lab
   content with one explicit stage at a time. **Complete.**
4. Replace page-only/custom hash state with maintained React Router authority,
   exact activity URLs, and permanent Practice/Arcade/Explore/Songs/Progress
   navigation. Split route, musical, and preference authority; delete false
   launchers and old URL aliases. **Complete.**
5. Rebuild every remaining Arcade feature that mounts multiple tuners or owns a
   connecting/recovery/release/isolation phase. **Complete.**
6. Split Range Simulator, Resonance, Song Rail, physics, proof, and stylesheet
   dumping grounds at real ownership boundaries until the architecture audit is
   clean. **Complete.**
7. Run full unit/type/build/Go verification, real production Chromium PCM,
   route/history, workflow identity, audio-playback, and responsive proofs.
   **Complete.**
8. Build and deploy the production container only after every release gate is
   green. **Complete; image `sha256:b8eb712983d4…` is deployed on the production
   Docker context and the routed HTTPS health check is green.**

## Final-tree release evidence — 2026-08-24

The authoritative built-bundle Chromium proof passed with:

- 57/57 semitones MIDI 30–86;
- 45 Hz measured at 45.000 Hz (+0.01 cents) and 1,200 Hz at 1,200.372 Hz
  (+0.54 cents);
- 18/18 quiet low notes at median -60.0 dBFS;
- 55 silence observations and 187/187 loud-noise observations unvoiced;
- exact 1,943/1,943 native AudioWorklet-to-detector `(captureEpoch, endSample)`
  pairs at a 960-sample hop;
- immediate DOM changes on the first C3, E3, and G3 detector frames, matched by
  exact `endSample`;
- detector time 2.2 ms median, 3.0 ms p95, and 11.4 ms maximum, every frame
  below the 20 ms hop budget;
- 1,095 Pitch Mirror observations, 116 observations with no consumer mounted,
  and 725 Hum Lab observations, with a 94 ms maximum diagnostic gap and 23 ms
  maximum no-consumer gap;
- rendered C3 occupancy entered at zero and every bounded React publication
  retained the exact detector sample coordinate and hop-multiple dwell, then
  reset on note departure and cleared by silence;
- a real AudioContext suspension automatically resumed with continuity epoch
  0→1 and `discontinuity=true`, while stream, track, and worklet ownership all
  remained singular;
- one `getUserMedia`, zero track disables, zero pre-Disable stops, and exactly
  one explicit stop;
- the 38-second sustain proof paired 2,533/2,533 native windows and detector
  frames; F-sharp1, quiet C3, C4, and D6 each retained more than 8.4 seconds of
  uninterrupted evidence; quiet C3 reached exactly 3.0 seconds in Range Loop
  without replacing its tuner, stream, context, or worklet;
- Vocal Canvas used one stream, track, source, and worklet to consume all 452
  native PCM windows while React emitted 202 bounded publications; five silence
  intervals were stationary, C3/D3/E3/F-sharp3 moved Up/Right/Down/Left, and
  four SVG strokes closed with 0.0 px error and 0.0 px opposite-side mismatch;
- Pitch Tunnel consumed 784/784 post-anchor observations in exact order while
  React emitted 351 exact bounded publications; nine independently reconstructed
  1.00-second dwells and every checkpoint/completion DOM transition matched the
  causing detector frame; silence retained 0.44 seconds, credible wrong pitch
  reset only current dwell, and the same no-playback lane stayed live afterward;
- Vocal Flight consumed all 1,734 pre-exit worklet observations, retained exact
  sample identity in 718 bounded React publications, and advanced to 1,826
  observations after leaving the route without stopping capture; isolated pitch
  reached +0.713960/-0.682013 elevator input, same-F0 dark/bright spectra reached
  -1/+1 roll, silence applied zero force, the first resumed frame advanced zero
  simulation time, and deterministic aircraft motion remained independent from
  the continuing `requestAnimationFrame` renderer;
- Vocal Flight calibration and active flight passed containment, reachability,
  and hit testing at 1440, 760, 430, 390, and 320 CSS pixels; its shared
  pitch-plus-brightness processing measured 9.8 ms maximum against the 20 ms hop;
- Pitch Match passed 55 idle mode/viewport combinations at all 11 shell and
  feature breakpoint widths, plus real idle/tracking/complete/reset workflows
  at 390 and 320 pixels; every visible control remained horizontally contained,
  vertically reachable, and hit-testable with one canonical `NoteInput`;
- the headless kernel consumed 30,000 silence windows (ten minutes of sample
  time) with no React subscriber or feature attachment and zero capture stops;
- the final frontend suite passed 822/822 across 86 files; production-inclusive
  coverage is 62.20% statements, 57.45% branches, 53.67% functions, and 64.55%
  lines; pitch-engine statement coverage is 94.36%;
- the architecture audit scanned 337 source files and 139 JSX components,
  reached all 200 application modules, and reported zero violations, zero
  unreachable application modules, and zero feature raw-stream reads;
- fresh-profile offline Chromium proof with 70 precached resources, the exact
  hashed worklet, 14 canonical activity routes, nested Arcade reload/Back,
  and zero API/health/missing-asset shell fallbacks;
- Go tests, race tests, vet, typecheck, production build, and desktop/mobile
  selector-gated visual inspection all passed.
- the final hardened container runs as UID/GID 65532 with a read-only root
  filesystem and all Linux capabilities dropped; Docker reports it healthy on
  `worknet_net`, the in-container health endpoint returns `ok`, and
  `https://noteforge.worknet/healthz` returns HTTP 200. The routed homepage
  serves `index-CHdlnUCJ.js`; `VocalFlight-DyCYHbVh.js` and the hashed
  `pitch-capture-worklet-BImFxh7e.js` both return HTTP 200; service worker
  `f5a026312ca2` precaches all 70 resources; browser-navigation requests for
  `/arcade/flight` return the SPA document; and the deployed image is
  `sha256:b8eb712983d4…`.

These measurements establish the final checked-in software path. They do not
certify a particular physical microphone, room, OS audio stack, hot-plug event,
or non-Chromium browser; those require the same live counters and device evidence.

Because every production detector call completed within its 20 ms hop and the
stream accumulated no detector backlog, WASM is not justified by current
measurements. Re-profile before changing that decision.

## Working rules

- Prefer architectural deletion over compatibility preservation.
- Use exact runtime evidence; never substitute source scanning for behavior.
- Report commands, counts, sample identities, missing evidence, and timing.
- If the browser proof finds a defect, fix production and rerun the proof. Never
  relax the assertion to make broken behavior pass.
