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
  -> raw YIN/harmonic-family candidate
  -> one shared target-independent temporal pitch tracker
  -> one authoritative PitchObservation per window
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
  pitchCandidate?: PitchCandidateTelemetry;
  pitchTrackingDecision?: PitchTrackingDecision;
};
```

- Silence and non-periodic noise are `unvoiced` observations.
- Ambiguous or invalid detector evidence is an `uncertain` observation.
- A credible F0 is a `voiced` observation.
- `pitchCandidate` preserves the estimator's raw per-window musical candidate;
  `pitchTrackingDecision` records the target-independent causal admission
  decision. Neither field grants a feature permission to reinterpret pitch.
- No observation kind changes microphone lifecycle state.
- A discontinuity is explicit sample authority, not a user-facing recovery mode.

The shared temporal tracker is the only authority between an independently
estimated detector candidate and musical pitch state. Fine motion up to 45 cents
and a cold attack are immediate. A single remote candidate is published on its
exact window as `uncertain`/`temporally-ambiguous`, with its candidate telemetry
preserved and no stale previous note displayed; one coherent candidate on the
next 20 ms hop confirms a real step or fast contour. Silence is immediate. This
rule is target-, activity-, and score-independent: it rejects physically
incoherent one-window teleports without making the requested answer sticky.

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

## Direct vocal-monitoring contract

Vocal monitoring is one global audio-environment capability, never an exercise
feature. It uses the same persistent interactive `AudioContext`, retained
microphone track, and `MediaStreamAudioSourceNode` as detector capture:

```text
                              -> monitor GainNode -> AudioContext.destination
one microphone source node -|
                              -> AudioWorklet -> zero GainNode -> destination
```

- The monitor branch fans out directly at the source. It never crosses an
  AudioWorklet, detector, worker, callback, JavaScript PCM buffer, React state,
  or feature runtime before playback.
- The monitor gain is capture-lifetime and begins at exactly zero. On, level,
  and Off mutate only that one `AudioParam`, using a five-millisecond ramp.
  They may not connect/disconnect nodes, open/stop capture, resume a context,
  replace a worklet, or change detector input.
- PCM-heartbeat repair replaces only the analysis worklet/zero-gain branch.
  The source and monitor branch remain attached, so detector recovery cannot
  produce an audible monitoring dropout.
- Saved `enabled` and `level` are desired global settings. Effective monitoring
  is `input running && desired enabled`. A saved On setting never opens the
  microphone; it becomes effective only after the user's explicit global
  Enable voice action. Global Disable ends effective monitoring without
  silently deleting the saved preference.
- Monitoring defaults Off. The UI always warns about speaker feedback and
  Bluetooth buffering, but warning copy is not another blocking workflow.
- Monitor level never changes pitch analysis, scoring, recording, or reference
  playback gain. The analyzer always receives the raw source branch.
- Input latency is requested only when the browser reports that constraint.
  Sample rate is never forced. Diagnostics show negotiated processing settings
  and finite browser-reported base/output/input latency when available; they
  must say those numbers are estimates, never measured round-trip latency.
- Output selection is progressive enhancement. It is offered only when both
  the user-mediated output chooser and shared-context `setSinkId` exist. Since
  the sink belongs to the one context, it is labeled Audio output and routes
  monitoring plus NoteForge playback together. Unsupported browsers truthfully
  use System default and no second output/context implementation is allowed.
- React subscribes to the slow monitoring preference/effective snapshot only.
  Detector observations do not publish monitoring state, and monitoring never
  becomes another RMS or pitch meter.

## Sample authority and diagnostic boundaries

`realtime/observation-continuity.ts` is the only application authority for
deciding whether two observations are consecutive. A feature may consume its
accepted/boundary/delta result; it may not compare epochs, reconstruct hops,
divide sample deltas, or invent a local `sameAuthority` helper.

- Inside one capture, continuity epoch, graph generation, sample coordinates,
  processed-sample count, and worklet count are monotonic. A graph advance
  requires a continuity advance; a sample-rate change requires both. A new
  capture may reset subordinate coordinates.
- Only the exact next configured overlapping hop is continuous. Missing windows,
  explicit discontinuities, and valid authority changes establish fresh
  authority with zero catch-up time.
- Invalid, malformed, duplicate, reordered, or regressed observations are
  rejected and may not replace retained authority. They are not fabricated
  boundaries. A changed window depth under unchanged capture configuration is
  malformed framing, not an ordinary gap.
- `AudioKernel` owns capture, detection, immutable observation publication,
  counters, bounded local history, and low-level transport/detector diagnostics
  only. It may never accept or derive an activity target, tolerance, hold,
  workflow phase, in-band result, reset reason, score, or curriculum state.
- Remote derived diagnostics are off by default and require a visible explicit
  user opt-in. Turning them off clears queued events. Diagnostic conversion,
  validation, storage, or transport failure is deliberately lossy and may never
  delay, reject, or alter an authoritative observation. Remote events contain no
  PCM and no activity/workflow semantics; local live diagnostics do not depend
  on remote sharing.

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
- Every user-facing isolated note, target, tonic, or reference uses the one
  app-owned sustained-note lane and the one canonical visible **Play / Stop**
  toggle. Its public request contains frequency, timbre, and amplitude only;
  duration, deadline, schedule time, decay, automatic cutoff, and a quieter
  replacement voice are deliberately unrepresentable.
- The user's visible toggle is the playback lifetime authority. Start, Finish,
  reset, scoring, target achievement, workflow transitions, persistence,
  silence, and detector evidence may not stop playback. Changing the selected
  target or timbre retunes the same running lane in place. Only the same visible
  toggle's explicit **Stop** action or unmounting the owning product surface may
  release it.
- Authored temporal gestures are a separate transport. Intervals, comparisons,
  chords, melodies, compass demonstrations, songs, and accompaniments may have
  authored note durations, but they may not impersonate an isolated-note
  toggle or become its fallback implementation.
- Do not preserve a removed interaction through dormant enums, branches,
  storage fields, compatibility adapters, or tests. Delete the obsolete model
  so it cannot become authoritative again.

## Permanent user-owned live lifetime

Across every mode in NoteForge, a user-started live vocal session has no
duration and no automatic cutoff. The user owns both Start and Stop. This is a
type-level product invariant, not copy, a preference, or a configurable timeout.

- A shared live-trace `begin` action accepts configuration only. Its state and
  actions contain no duration, deadline, countdown, timeout, or automatic
  completion threshold.
- Incoming observations may advance sample-authoritative time, evidence, game
  state, checkpoints, and scores. They may never stop observation or turn a
  running user-owned session into a stopped/restart-required workflow.
- Elapsed time, silence, uncertainty, scoring readiness, target achievement,
  course completion, a full presentation history, route rerenders, and React
  lifecycle are never Stop authority.
- Only an explicit user action may end/reset the feature session. Only the
  global Disable voice action may stop app-owned microphone capture. Feature
  code may not call, simulate, schedule, or infer either action.
- `Start`, `Finish`, and `Stop` are reserved session-lifetime commands. They may
  be dispatched only from a control whose visible meaning is that exact user
  choice. A settings change, detector callback, media `ended` event, storage
  failure, score handoff, promise continuation, React effect, timeout, or
  interval may not dispatch or call one of those commands on the user's behalf.
- Natural playback/course completion records playback state or an achievement;
  it does not finish the surrounding live vocal session. Persistence failure
  marks the result or take unsavable while the live operation remains under the
  user's Stop control. Only an actual underlying media-resource failure may
  force infrastructure teardown, and it must not masquerade as normal Finish.
- A result or achievement may be recorded without replacing the still-live
  control surface. Continued observations remain authoritative until the user
  explicitly leaves or ends the mode.
- `Finish` is a real feature-state boundary, not decorative copy. After it, new
  observations may refresh shared telemetry but may not silently resume motion,
  scoring, recording, or qualified-time accumulation. Resumption requires a new
  explicit `Start` command.
- Runtime evidence retention must be bounded without changing session state.
  Dropping old presentation/history samples is not permission to stop, reset,
  replace, grade-and-dismiss, or otherwise cut off the live session.
- A hold requirement is an achievement threshold, never an occupancy cap.
  Exact current and peak sample-time hold continue beyond the threshold until
  credible out-of-range evidence or an explicit user action changes the task.
  Reaching a checkpoint may enable Next; it may not stop measurement.
- Bounded recent history is presentation evidence, not a substitute for the
  full session. Whole-session scoring uses bounded online aggregates that keep
  silence, wrong notes, confidence, sample authority, hold runs, and error
  moments exact; deleting old frames may never bridge or relabel them.
- Regression proof must advance beyond every former cutoff (including an hour
  of wall time) and leave the session active. Architecture tests must reject
  duration-driven termination anywhere in shared live-session infrastructure.
- Every observation-driven reducer with a terminal action is registered in the
  repository lifetime audit. The audit traces terminal reducer transitions and
  rejects authority from non-user actions, automatic callbacks, timers, effects,
  media completion, and storage failure; a new unregistered reducer fails the
  release gate rather than silently inventing another lifetime model.

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

## Ear-to-note learning contract

The canonical tone-map activity trains commitment before feedback. A learner
hears a prompt and answers from memory; the requested note, its keyboard marker,
the detected vocal note, frequency, cents, and correctness remain absent from
the visible answer surface until the learner explicitly commits an answer.
Guided trials may deliberately show the note label while first establishing an
association, but guided correctness never counts as blind mastery.

- Recognition spans the physical 88-key piano, MIDI 21 through 108. The piano
  is one shared component inside its own horizontally scrolling viewport. At
  phone widths only the keyboard scrolls horizontally; the document and the
  prompt/progress controls remain width-contained and stationary.
- A hidden target may not choose the keyboard scroll position, focus a key,
  alter pre-answer styling, add a marker, or otherwise leak its location.
  Labels and answer/target markers appear only in committed-answer review.
- Curriculum levels introduce six new MIDI tones. The active pool is cumulative:
  level N schedules all tones from levels 1 through N. Trial order is randomized
  from persisted curriculum order and current evidence, avoids immediate
  repeats, and may emphasize weak/confused tones; it may never expose a fixed
  pattern the learner can memorize instead of the sound mapping.
- Keyboard identification and vocal production are independent evidence for
  every MIDI. Each retains lifetime attempts/correct answers, recent stability,
  current blind streak, and best streak. A miss resets and revokes only the
  contradicted note/skill's current blind gate, retains history, and reopens a
  bounded guided recovery. It never erases unrelated notes or the whole level.
- Early guided correctness establishes the sound/label association; later
  blind answers establish recall. A tone becomes stable only through consecutive
  blind evidence after its scaffold is hidden. All required evidence in the
  cumulative active pool plus a fresh current-level confirmation is required
  before the user may explicitly advance. Advancement is never automatic.
- Vocal answering consumes the shared target-independent `LiveNote`/observation
  authority. It never displays the detected answer before commitment, never
  owns capture, and never auto-commits on a detector callback. The learner must
  explicitly commit the currently stable sung note. Exact `onFrame` evidence
  feeds the canonical note-dwell authority at ±20 cents; coalesced `LiveNote`
  presentation time is not scoring authority. A task change and every prompt
  Play/Stop cycle invalidate prior evidence. The answer may arm only after the
  prompt is visibly Off, a fresh authoritative unvoiced boundary has occurred,
  and the new candidate earns its own sample-timed dwell. Prompt leakage and a
  note held across trials therefore cannot become a production answer.
- Recognition range and production range are different facts. A note outside
  the demonstrated usable voice profile may be marked unreachable without a
  miss, accuracy penalty, or fake success. That reversible eligibility excludes
  only vocal scheduling/gating; keyboard recognition remains required and the
  lifetime history remains intact.
- One-note prompts use the canonical sustained **Play / Stop** lane and have no
  duration or automatic cutoff. Answering, Next, a correct response, a miss, or
  a level gate never stops it. Authored multi-tone Simon sequences use the
  separate finite gesture transport, collect the complete untimed answer, then
  reveal and grade the sequence; they do not create another isolated-note player.
- Tone-map progress is persisted locally through one storage authority. Reload,
  route changes, and offline use preserve curriculum order, level, evidence,
  scaffold state, and vocal eligibility without creating a second scheduler or
  feature-specific microphone path. Missing storage may initialize a course;
  invalid, unsupported, or internally inconsistent storage may never be silently
  replaced. It remains read-only until the user explicitly chooses the visible
  reset action. Settings writes are ordered by one app-lifetime coordinator so
  a remounted route cannot hydrate an older snapshot while its previous mount
  still has writes queued.
- The accepted-answer reducer owns a stable trial ordinal, attempt id, and
  commitment timestamp. Attempt history is derived only from that accepted
  state and uses an idempotent IndexedDB put. A double click, stale callback, or
  rejected reducer action may never create a second history row or evidence
  result.

## Numeric boundary authority

`AudioKernel` stores and publishes exact sensor evidence. It never clamps a
frequency, MIDI coordinate, cents error, confidence value, brightness value, or
sample coordinate on behalf of a view. Downstream projections may saturate only
at a real declared domain boundary, through one reviewable authority:

- `lib/numeric.ts` owns generic interval, unit-axis, signed-axis, and percentage
  saturation syntax for the web application. Features may not declare private
  `clamp`, `clamp01`, or `clampUnit` helpers or hide saturation inside nested
  `Math.min`/`Math.max` expressions.
- `pitch-meter-scale.ts` owns the musical-coordinate-to-pixel projection for
  live pitch meters and traces. A target lens may compress the outer detector
  depth, but it may not alias distinct supported pitches or mutate the stored
  observation.
- A game or exercise may define a named physical boundary such as canvas edge,
  paddle travel, asymmetric calibrated control extent, or score percentage.
  Its named adapter may use the shared numeric primitive; it may not become a
  competing sensor, confidence, musical-range, or session-lifetime authority.
- Detector search heuristics must not silently become stronger admission gates
  than the canonical live-input policy. Level is diagnostic, literal silence is
  ordinary unvoiced evidence, and arbitrarily quiet nonzero periodic evidence
  must reach the same detector/confidence policy.
- Capacity bounds may limit a presentation snapshot or storage query. They may
  not evict user-created artifacts without an explicit command, truncate the
  authoritative session used for scoring/profile evidence, overwrite prior
  accomplishments with a partial run, or terminate a live workflow.

The architecture audit enforces the generic numeric owner and inline-saturation
ban. Domain tests must additionally prove monotonic pitch projection, asymmetric
control normalization, geometry boundaries, whole-session aggregates, and
evidence behavior immediately below every former detector gate.

## Detector contract

- Canonical live range is 45–1,200 Hz everywhere.
- Full-range acceptance includes every enclosed equal-tempered semitone, MIDI
  30–86 (F-sharp 1 through D6), plus literal 45 and 1,200 Hz boundaries.
- Quiet valid pitched evidence must not be rejected by calibration, sensitivity,
  amplitude, clipping, target range, or saved profile state.
- Preserve `frequencyHz` and `midiFloat`; nearest-note interpretation must not
  destroy bends, vibrato, blue notes, glides, or microtonal coordinates.
- Level/clipping telemetry is diagnostic only and never admits pitch.
- High-rate hardware PCM may be normalized for bounded detector work, but every
  decimation stage must low-pass before halving. Sample dropping, stride-only
  decimation, and detector fallback at the unfiltered rate are prohibited
  because they fold out-of-band energy into false vocal fundamentals. The
  production normalizer uses a private allocation-stable cascade of 129-tap
  Kaiser half-band FIR stages until analysis is at most 48 kHz; capture rates up
  to 768 kHz remain valid. Observation coordinates and sample authority remain
  in the original capture-rate sample domain.
- Realtime detector scratch is instance-owned, private, grow-only workspace.
  Steady capture may not allocate lag/Hann/harmonic typed arrays per frame;
  workspaces may never be module globals or escape into immutable observations.
  Independent engines must remain reentrant-safe and sample-exact when
  interleaved or resized.
- Use WASM/Worker/SIMD only if production profiling proves JavaScript detector
  work cannot remain below the hop cadence. WASM must never be used to disguise
  a lifecycle or ownership bug.

## Live pitch presentation contract

The visible meter and trace are evidence, not decorative approximations. A
correct detected note whose marker is pinned, aliased, stale, or drawn from a
different frame is a product failure.

- Every credible voiced coordinate across the complete 45–1,200 Hz detector
  range has one unique monotonic visual coordinate. Every enclosed semitone,
  MIDI 30–86, must move strictly left-to-right on a horizontal meter and
  bottom-to-top on a vertical trace. Only the literal detector boundaries may
  occupy the visual edges.
- Target-relative displays may reserve a wide central lens for fine intonation,
  but pitches outside that lens remain monotonically visible in the outer
  wings. Never clamp all errors below or above an arbitrary cents limit onto
  one edge.
- Every live pitch meter and trace uses the shared full-depth projection. A
  feature may choose its focus width; it may not recreate the projection with
  local clamp, percentage, or CSS math.
- Note text, cents, marker geometry, and scrolling trace geometry must identify
  the exact authoritative detector frame that produced them. A trace segment
  exposes capture epoch, continuity epoch, graph generation, start sample, end
  sample, and live MIDI for its actual last point; proof may not pair it with a
  newer independently coalesced readout.
- Unvoiced and uncertain frames remove the live marker rather than leaving a
  stale pitch in place. They do not reset, stop, or recover microphone input.
- The built Chromium release proof must drive production PCM through all 57
  supported semitones, read computed marker pixels from the rendered page,
  require 57 distinct strictly monotonic positions, reject non-boundary edge
  aliases, and reconcile representative scrolling-trace points by exact sample
  identity. Label-only, DOM-string-only, or pure-function tests are not
  sufficient release evidence.

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
- Completing the authored trajectory latches a nonterminal achievement while
  whole-trace aggregates and exact sample time continue to grow. Only the
  user's explicit Finish freezes scoring; current F0, observation kind, exact
  sample coordinates, and observation count remain live afterward.
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
- Completing the authored gate course records a nonterminal achievement. The
  aircraft, continuation lane, sample-time scoring, and online aggregates keep
  advancing until the player presses Finish. Finish freezes only Vocal Flight
  state; the app-owned observation stream remains live until global Disable.
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
- Feature- or target-aware note-agreement gates and stale-pitch holding. The one
  shared target-independent temporal tracker above is sensor interpretation,
  never a scoring exception or feature-owned gate.
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
-> MicrophoneCapture -> NoteInputEngine -> AudioKernel -> React -> rendered DOM
```

Remote derived diagnostics are a lossy, opt-in side branch from published
observations. They are not between detection and any realtime consumer.

It must fail unless all of the following hold:

1. All 57 semitones MIDI 30–86 and both literal frequency boundaries are
   detected accurately.
2. All 18 low notes MIDI 30–47 render below the removed level gate.
3. Silence and loud deterministic broadband noise continuously emit unvoiced
   detector evidence and never render a note.
4. After the proof visibly opts into remote diagnostics, every native worklet
   window has exactly one diagnostic observation with the same capture epoch
   and half-open sample interval.
5. Worklet and detector coordinates advance by the configured overlapping hop.
6. A remote raw candidate is exposed on its exact first window while the DOM
   becomes uncertain with no stale note. One coherent next-hop candidate makes
   the new authoritative note render at that exact `endSample`; no feature or
   target-specific agreement gate may delay it further.
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

`npm run proof:sustained-note:browser` is the long-form continuity and isolated-
note-playback authority.
It drives 8.5-second voice-like sustains at F-sharp1, quiet C3 below the former
level gate, C4, and D6 through the real production microphone path. Every
target must retain at least eight seconds of correct contiguous detector
evidence while PCM/worklet/window counters remain monotonic. The same still-live
track then enters Range Loop, proves that no dwell is credited before the
visible Start command, retains one tuner DOM identity through wrong pitch,
silence, playback, and achievement, and continues accumulating exact sample-
timed C3 dwell beyond the former three-second requirement. Its visible note
toggle must start one sustained lane, remain pressed with zero oscillator stops
beyond every former cutoff and across Start, achievement, and Finish, and use
that same still-mounted control for the first oscillator stop. No lower-volume
replacement or second oscillator bank is permitted. Only visible Finish may
freeze feature dwell, and shared PCM/live-note telemetry must continue
afterward. No stream, track, context, or worklet replacement and no pre-Disable
microphone stop is permitted.

`npm run proof:range-loop-noisy:browser` is the user-facing sustained-note
authority. It constructs one deterministic fake microphone containing a
continuous C3 plus changing interference, then crosses the built production
path through `getUserMedia`, `MediaStreamAudioSourceNode`, `AudioWorklet`, the
real pitch engine, the shared temporal tracker, shared `NoteInput`, and the
actual Range Loop DOM. Browser stages include clean C3, a known failing seed,
+30, +20, +10, +6, and +3 dB SNR, impulses, dominant second/third harmonics,
brief amplitude drops, changing noise amplitude, and clean recovery. The 0 dB
sweep belongs to the supplemental detector matrix, not this browser proof.

The proof must show that sufficient dominant C3 evidence earns the real range
dwell without any regression, enables and visibly advances to D3, and that a
persistent D3 then earns its own dwell in the same mounted component. A raw
contradictory candidate may become an uncertain authoritative observation, but
no C3 stage may publish a contradictory authoritative note. Uncertain evidence
may pause new dwell credit; it may not erase prior credit. The D3 half is
mandatory: a fix that merely makes C3 sticky fails. No detector mock, injected
observation, test-only scorer, or duplicated range component is permitted.

`npm run proof:mobile-note-playback:layout` is the mobile note-control authority.
At 320x568 and 390x844 it traverses every surface that offers an isolated-note
control, proves page-end reachability, descendant containment and hit testing,
and operates the canonical toggle through Play -> Stop -> Play. Hiding document
overflow without making the controls reachable is a failure.

`npm run proof:monitoring:browser` is the built direct-monitor authority. It
must instrument exact Web Audio node identities and edges, then prove one
interactive production context, one microphone stream/track/source, one stable
monitor gain, and one worklet analysis branch. The monitor begins muted; visible
On, level changes, and Off automate only that same gain while real generated C3
continues through the production worklet/detector with monotonic samples and no
track writes/stops. Route changes may not create audio resources. At 320x568 and
390x844 both global controls must be in-bounds/hit-testable, the Settings drawer
must scroll to every monitor/diagnostic control without document horizontal
overflow, and the headphone/latency truth must remain visible. A reload with
saved On/level must leave `getUserMedia` untouched until explicit Enable, then
apply that level; only global Disable may stop the track. This proves the
shortest software topology and continuity, not physical acoustic round-trip
latency, which requires external loopback measurement.

`npm run proof:tone-map:browser` is the built-interaction authority for the
ear-to-note curriculum. At 320x568 and 390x844 it must prove that the page owns
no horizontal overflow, only the complete 88-key keyboard scrolls sideways,
all keys remain hit-testable, hidden targets cannot alter markup or scroll
position, the isolated prompt remains On across answer and Next until explicit
Stop, guided evidence actually becomes blind, and a blind miss reopens the
same tone's visible recovery without changing the level. Its Simon leg must
lock input before/during complete authored playback, leave the full response
untimed, reveal only after every position is committed, and require explicit
Next. Its voice leg must enter generated PCM only through the visible global
Enable and the production `getUserMedia` -> `AudioWorklet` -> detector path. It
must reconcile semantic release/readiness to exact worklet sample authority,
reject prompt-era and cross-trial held notes, remain ungraded indefinitely
until visible Commit, retain one stream/source/worklet with zero track writes
or stops, and never inject an observation or call a detector/reducer directly.

`npm run proof:voice-draw:browser` is the cabinet-level authority for Vocal
Canvas. It must enter the built Voice Arcade through the real cabinet button,
enable the shared microphone once, and drive the production worklet and
detector with generated microphone PCM. It proves that C3, D3, E3, and F-sharp3
produce Up, Right, Down, and Left motion; that intervening silence advances PCM
while cursor position remains exact; and that the resulting SVG contains four
coalesced connected strokes. It must operate the visible Start and Finish
controls, prove no drawing before Start, and prove that shared telemetry keeps
advancing while the explicitly finished canvas remains immutable. Its final
runtime observation count must equal the native worklet-window count; every
bounded React publication must identify the exact worklet ordinal it
represents. It may read native/worklet/diagnostic/DOM evidence, but it may never
inject a `PitchObservation` or call the drawing reducer.

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
idle/tracking/achievement, and keep both scoring and live F0 updating after the
authored trajectory is achieved. Only the visible Finish command may freeze
feature scoring, while authoritative telemetry must continue afterward. It may
observe native calls, diagnostics, and DOM attributes; it may never inject an
observation or call the reducer/detector directly.

`npm run proof:user-owned-traces:browser` is the built-interaction authority for
the shared indefinite live-trace runner. It must visibly Start Pitch Match, Hum
Lab, and Pitch Control, advance each beyond its former 4-, 8-, and 12-second
cutoff, and prove that the session remains active and continues consuming exact
sample-authoritative observations. Each mode may become terminal only after its
own visible Finish command. Advancing fake or browser time, losing pitch,
reaching a score threshold, and bounded-history eviction may never finish it.

`npm run proof:vocal-flight:browser` is the built-interaction authority for
Vocal Flight. It must calibrate and Start through visible controls, reconcile
the shared worklet stream to normalized controls and deterministic simulation,
continue flight and scoring after the course achievement, then use the visible
Finish command. After Finish, PCM and observations must keep advancing while
the feature's simulation-frame count and score remain frozen. Route exit may
not stop capture, and no game-owned capture or detector path is permitted.

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
   green. **Complete; image index `sha256:63993ae781d3…` is the running healthy
   container and the exact routed bundle matches local and container bytes.**

## Final-tree release evidence — 2026-08-25

The authoritative built-bundle Chromium proofs passed with:

- 57/57 semitones MIDI 30–86 plus literal 45 and 1,200 Hz boundaries; the
  boundaries measured 45.000 Hz (+0.01 cents) and 1,200.373 Hz (+0.54 cents);
- 18/18 quiet low notes near -60 dBFS and 196/196 loud seeded-noise frames
  unvoiced;
- exact 2,177/2,177 native AudioWorklet-to-detector `(captureEpoch, endSample)`
  pairs at a 960-sample hop;
- C3 was accepted at `endSample=85696`; E3's raw candidate was exposed at
  `120256` as uncertain/no-stale-note and accepted on the coherent next hop at
  `121216`; G3 followed the same exact rule at `153856` -> `154816`;
- all 57 supported notes at distinct strictly monotonic meter positions from
  0.48% through 99.55%, with no non-boundary edge aliases; the full-depth ribbon
  independently placed F-sharp1, C3, E3, and G3 at y=299.0, 262.4, 254.2, and
  248.1 from the same exact sample authority;
- detector time 2.5 ms median, 3.9 ms p95, and 13.0 ms maximum in the complete
  note-input proof, every frame below the 20 ms hop;
- a real AudioContext suspension automatically resumed with continuity epoch
  0→1 and `discontinuity=true`, while stream, track, and worklet ownership stayed
  singular; one `getUserMedia`, zero track disables, zero pre-Disable stops, and
  exactly one explicit global Disable stop;
- the sustained proof paired 2,602/2,602 windows: F-sharp1 held for 8.420
  seconds/422 frames, quiet C3 for 8.460/424, C4 for 8.460/424, and D6 for
  8.480/425; its maximum detector time was 16.2 ms. Range Loop credited zero
  before visible Start, grew C3 dwell from 3.04 to 3.54 seconds beyond its
  achievement, and froze only on visible Finish while PCM/live C3 continued;
- the real Range Loop accepted 16.32 seconds of continuous C3 across 13 clean,
  seeded-noise, SNR, impulse, harmonic, dropout, changing-noise, and recovery
  stages with zero hold regression and zero contradictory authoritative notes.
  It then visibly advanced the same mounted workflow to D3 and a persistent D3
  earned 3.10 seconds, proving the tracker is robust but not sticky;
- steady 48 kHz `NoteInputEngine` work now allocates zero YIN typed arrays after
  one-time workspace growth. The deleted path allocated 17,104 bytes per frame,
  about 49 MiB/minute. Controlled A3/C3/marginal p95 was 3.55/3.41/7.31 ms with
  zero frames over 20 ms;
- high-rate normalization detected 342/342 supported notes across six standard
  capture rates, rejected out-of-band aliases, and retained real fundamentals
  down to -126 dBFS beneath out-of-band interference. The adversarial tracker
  matrix covers 40 seeded +10 dB streams; +30/+20/+10/+6/+3/0 dB strengths;
  impulses, harmonics, amplitude drops and changing noise; plus persistent
  noisy C3 -> C2 transitions that must relinquish C3;
- the shared live-trace proof kept Pitch Match active for 4.80 seconds, Hum Lab
  for 8.80 seconds, and Pitch Control for 12.84 seconds beyond their former
  automatic cutoffs; only visible Finish completed each session, with one
  capture and zero pre-Disable stops;
- Vocal Canvas consumed all 641 authoritative windows while React emitted 294
  bounded exact projections; five silence runs were stationary, C3/D3/E3/
  F-sharp3 moved Up/Right/Down/Left, four SVG strokes closed at 0.0 px, and
  visible Finish froze only the canvas;
- Pitch Tunnel consumed 976 exact post-anchor observations while React emitted
  447 bounded publications across 19.50 sample-seconds; all nine dwells were
  exactly 1.00 second, silence retained 0.38 seconds, credible wrong pitch reset
  only current dwell, achievement remained tracking, scoring grew 9.38→10.12
  seconds, and visible Finish alone froze scoring;
- Vocal Flight consumed 1,735 exact worklet windows before exit and 1,852 after,
  with 715 unique React publications; pitch reached +0.699017/-0.682006 and
  same-F0 brightness reached -0.999914/+1. Observations advanced 1,788→1,818
  after Finish while simulated frames remained exactly 970, and route exit caused
  zero capture stops;
- Vocal Flight and Pitch Match passed containment, reachability, scrolling, and
  hit testing down to 320×568. Pitch Match covered 55 mode/viewport combinations
  plus full idle/tracking/complete/reset workflows at 390 and 320 pixels;
- fresh-install offline Chromium loaded React and the hashed pitch worklet from
  service-worker cache across 14 canonical routes; 75 resources were precached
  and no API/health/missing-asset request received an HTML fallback;
- the headless kernel consumed 30,000 silence windows—ten minutes of 50 Hz
  sample time—with no React subscriber or feature attachment and zero stops;
- the React publication contract consumed all 50 authoritative observations in
  its cadence fixture while emitting 26 pitch and 25 auxiliary presentation
  publications; uncertain-candidate, confirming-note, silence, and
  discontinuity boundaries retained their exact originating snapshot;
- the final frontend suite and its separately instrumented run passed
  1,051/1,051 across 107 files. Coverage is 65.26% statements (7,851/12,029),
  60.33% branches (5,948/9,858), 56.99% functions (1,466/2,572), and 67.68%
  lines (7,278/10,753);
- the architecture audit scanned 388 source files and 143 JSX components,
  reached all 216 application modules, and reported zero violations, zero
  unreachable application modules, and zero feature raw-stream reads;
- the production build transformed 302 modules and emitted
  `index-C_5EpVLQ.js`, `pitch-meter-scale-Ci4b38XK.js`,
  `PitchMirror-BxX7lBYA.js`, `PitchTunnel-BN4T29qz.js`, and
  `pitch-capture-worklet-BImFxh7e.js`; service worker `cc5b59194310` precaches
  75 resources;
- Go tests, race tests, vet, typecheck, production build, static lifetime
  authority, and the exhaustive visible Start/Finish inventory all passed;
- Docker rebuilt the tree while independently rerunning the zero-violation audit,
  1,051 tests, typecheck/build, Go vet, and Go tests. The deployed OCI image
  index/container identity is
  `sha256:63993ae781d3254b42d7701f3c2b4e91b93ec010d5a317947a23c60043286065`;
  its amd64 manifest is
  `sha256:6da7d017c7e4106530c8c3cbcebc6771e2d7452ef2280b58ba1387fbc94d5603`;
- the container is healthy as UID/GID 65532 with a read-only root, all
  capabilities dropped, `no-new-privileges`, 64 MiB memory, and 64-process
  limits. Internal `/healthz`, routed HTTPS `/healthz`, and routed `/` (the
  transport for canonical `/#/arcade/flight`) return HTTP 200;
- local, container, and routed SHA-256 values match exactly: `index.html`
  `e2f167352581…`, `sw.js` `89f30048b08f…`, main JS `ab58c49bb83c…`, pitch-meter
  authority `7f0deee2ba0b…`, and AudioWorklet `1645c857a4ae…`.

These measurements establish the final checked-in software path. They do not
certify a particular physical microphone, room, OS audio stack, hot-plug event,
or non-Chromium browser; those require the same live counters and device evidence.

Because every production detector call completed within its 20 ms hop and the
stream accumulated no detector backlog, WASM is not justified by current
measurements. Re-profile before changing that decision.

## Tone Map release evidence — 2026-08-25

- The built `/#/practice/note-recognition/map` workflow passed at 320x568 and
  390x844 with document width equal to viewport width, a locally scrolling
  2,302-pixel 88-key piano, hit-testable first/middle/last keys, reachable page
  bottom, zero target-driven initial scrolling, and byte-identical hidden
  answer markup for distant targets.
- The isolated prompt stayed On across 1.6 seconds, answer, and explicit Next;
  only the visible Stop toggle ended it. Twelve guided commitments reached the
  first blind task, a genuine blind miss reopened the same tone's guided
  recovery without changing level, and Simon locked answers before/during
  playback, kept an incomplete response untimed, and advanced only on visible
  Next.
- A generated 48 kHz `MediaStream` entered through one visible global Enable,
  one `getUserMedia`, one stream/track/source, and one production worklet. All
  133 worklet windows advanced by the exact 960-sample hop. Prompt-era pitch,
  24 post-Stop held windows, and 24 same-tone windows on the next trial could
  not arm Commit. A fresh unvoiced boundary at `endSample=58816` and subsequent
  F2+10-cent dwell armed at the exact `endSample=76096` worklet window. Only
  visible Commit graded it. Eight semantic React publications represented the
  133 audio windows; the feature made zero track writes and zero stops.
- The global mobile playback proof covered 24 route/viewport combinations with
  zero unreachable controls and exercised Tone Map's literal Play -> Stop ->
  Play control at both phone widths.
- The shared noisy Range Loop proof retained 16.24 seconds of C3 through 13
  clean/noise/transient/harmonic/dropout stages with zero hold regressions,
  then accepted persistent D3 and earned 3.00 seconds on the same shared input.
  The sustained proof paired 2,609/2,609 worklet/detector windows, retained
  F-sharp1, quiet C3 near -62.8 dBFS, C4, and D6 for more than eight seconds,
  and measured a 10.4 ms detector maximum below the 20 ms hop.
- The final frontend suite and instrumented coverage run each passed
  1,131/1,131 tests across 118 files. Coverage is 65.24% statements
  (8,339/12,781), 60.87% branches (6,385/10,488), 57.56% functions
  (1,575/2,736), and 67.68% lines (7,717/11,402).
- Typecheck and the production build passed across 322 transformed modules;
  service worker `4c9b85b1e8a8` precaches 75 resources. The fresh-install
  offline proof loaded React and the pitch worklet across 14 canonical routes.
  The architecture audit scanned 422 source files and 155 JSX components,
  reached all 236 application modules, and reported zero violations and zero
  unreachable application files. Go tests and Go vet passed.

## Direct monitoring release evidence — 2026-08-25

- The built browser proof used Chromium's real fake-microphone device with a
  deterministic 60-second C3 WAV; it did not substitute detector observations
  or route a test AudioContext into production. At both 320x568 and 390x844 it
  found exactly one interactive context, source, worklet, monitor gain, and
  analysis gain. The exact source split was source -> monitor gain -> shared
  destination and source -> worklet -> zero analysis gain -> destination.
- The monitor began at zero. Visible On, level adjustment, and Off produced
  exact five-millisecond ramps to 0.65, 0.73, and 0 on the same AudioParam.
  Every React categorical publication during those changes remained C3, every
  PCM window advanced by one exact hop, and the operations made zero capture,
  source, worklet, track-write, or track-stop changes.
- Both phone layouts kept the global headphone-only state visible and
  hit-testable before Settings opened. The scrollable Settings surface reached
  its level, input/output devices, requested interactive mode, negotiated
  processing values, reported latency values, and external-loopback disclaimer
  without page horizontal overflow. Its displayed native values reconciled
  exactly with the browser instrumentation.
- Reloading a saved On/0.73 preference made zero microphone requests. One
  explicit global Enable created capture and reapplied 0.73; a route change
  retained one context/source/worklet; only explicit global Disable stopped
  the one track. Three additional consecutive device-path runs passed the same
  continuity assertions before the final official release run.
- The final architecture audit scanned 436 source files and 157 JSX components,
  reached all 244 application modules, and reported zero violations, zero
  unreachable application modules, and zero feature raw-stream reads. The
  production container independently passed all 1,147 tests across 122 files,
  typecheck/build across 330 transformed modules, Go vet, and Go tests. Service
  worker `450e1c5436b9` precaches 74 resources.
- WorkNet runs image index
  `sha256:37f6bdc8e258b113f0099a6559587e8ec81773a0549304561ca995df8adcc455`
  (amd64 manifest
  `sha256:bee7ed477a2ac53715270b5a92f956a8595c17c592cb46afac45fe550ef46fe4`).
  The container is healthy as UID/GID 65532 with a read-only root, all
  capabilities dropped, `no-new-privileges`, a 64 MiB memory limit, and a
  64-process limit. Internal and routed HTTPS health checks return `ok`/200.
- Local, container, and routed SHA-256 values match exactly: `index.html`
  `028fc2df59dc…`, `sw.js` `63a0a0282bde…`, main JS `19590e8126e3…`, and
  AudioWorklet `1645c857a4ae…`. This establishes the deployed software graph
  and continuity. It does not claim a physical microphone-to-ear latency;
  measuring that still requires an external loopback path.

## Working rules

- Prefer architectural deletion over compatibility preservation.
- Use exact runtime evidence; never substitute source scanning for behavior.
- Report commands, counts, sample identities, missing evidence, and timing.
- If the browser proof finds a defect, fix production and rerun the proof. Never
  relax the assertion to make broken behavior pass.
