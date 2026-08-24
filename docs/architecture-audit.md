# NoteForge architecture audit

Date: 2026-08-24

This is a release audit, not a test-coverage summary. It records product-state,
navigation, rendering, input-authority, and source-health failures that green
unit tests previously allowed.

## Initial verdict

The reported architecture failure is substantiated.

The app-owned microphone substrate is persistent, but much of the feature layer
was still written as independent SPA demos: local phase forests recreated the
same tuner in multiple branches, ordinary observations were turned into UI
gates, named handoffs discarded their task, and several pages stacked setup,
work, diagnostics, results, and future steps into one scrolling document.

The first enforceable inventory found 31 release violations across 179 source
files. The most serious measured examples were:

| Surface | Measured evidence | Product consequence |
| --- | --- | --- |
| Old Range Loop | 1,887 lines, eight UI phases, three `NoteInput` sites, mirrored refs/timers | Visually changed applications during one note attempt and could throw away valid dwell |
| Song Rail | 1,370-line file, 1,068-line component, 183 branches, 38 state/ref/effect hooks, two tuners | The guide-isolation failure became a normal product phase and locked scoring |
| Resonance | 1,364-line file, 1,150-line component, 178 branches, depth 6, 53 state/ref/effect hooks, three tuners | Tutorial gates, microphone actions, game phases, and presentation share one component |
| Old Range Simulator | 742-line component, 144 branches, depth 9, 44 state/ref/effect hooks | Setup, probing, prompt, dwell, rating, persistence, and completion had overlapping authorities |
| Pitch Maze | 601-line component, 39 state/ref/effect hooks, three tuners | Modal state, game state, release state, and detector state competed |
| Pitch Pong | Three tuners and a feature-level `connecting` phase | A continuously available controller was represented as repeatedly acquired UI |
| Echo Run | Three tuners, a headphone hard gate, five phases | Prompt and detector evidence controlled replacement screens |
| Song Lab | 34 state/ref/effect hooks; transport, three setup panels, tuner, practice, recorder, and takes stacked | Scrolling acted as workflow navigation |
| Shared input scope | Direct pitch plus waveform meter and 22 raw PCM/transport fields expanded on every use | The actual task was pushed below developer instrumentation |
| Styles | `styles-arcade.css` 3,630 lines; old Range Loop CSS 2,450 lines | Deleted interactions remained encoded as a global selector dump |
| Browser proof | 1,620-line script | One proof owned server, browser protocol, instrumentation, assertions, and reporting |

## Final result

The overhaul deleted the accidental runtimes instead of redistributing them.
The final enforceable scan covers 303 source files and 131 JSX components,
reaches all 178 application modules from `main.tsx`, and reports zero release
violations, zero unreachable application modules, and zero feature raw-stream
reads. The tracked diff removes more than 22,000 net lines while retaining the
domain, DSP, and verification foundations.

The largest JSX component is now 340 lines. Range Loop's entry file is 36
lines; Pong's feature hook is 109 lines; Song Rail's is 85 lines; and Song Lab's
workspace hook is 108 lines. These reductions came from moving shared realtime,
attempt, persistence, and cancellation authority to canonical infrastructure
and deleting feature-owned copies.

## Reproduced audio/UI defect

The loud reference followed by a quieter persistent copy was literal program
behavior, not user perception:

- Range Loop played the target for 0.9 seconds at amplitude `0.21`.
- The synthesizer's ordinary sustain level reduced that to `0.1638`.
- It then stopped that oscillator and immediately started the default unison
  support oscillator for 3,600 seconds at amplitude `0.085`, settling to
  `0.0663`.
- The isolation branch then treated matching live microphone observations as
  guide leakage and locked scoring.

That guide/support/isolation model has been deleted. Reference playback is now
one explicit 0.5-second action and has no scoring or detector state.

## Navigation and reachability

All former top-level sidebar pages were technically reachable. The deeper
failure was task reachability:

- Every meaningful lab mode and Arcade cabinet lived only in component state.
- Reloading an active game returned to the Arcade cabinet.
- Browser Back from a game left Arcade instead of returning to its cabinet.
- Home's “cold attacks” action opened Pitch Mirror's default Glide mode.
- Home's interval-production block opened Interval Recognition.
- Interval, Harmony, and Melody handoffs retained only one MIDI number and lost
  the originating mission and return destination.
- Skill Map mapped 38 catalog IDs through a heuristic to generic page defaults;
  it could not launch the task it named.
- Invalid nested hashes rendered Home while leaving the invalid URL visible.
- Navigation controls were buttons, so tasks were not copyable links.

The replacement uses the maintained React Router `HashRouter`, exact typed
activity paths, actual links, invalid-route canonicalization, and Back/Forward
restoration. Permanent navigation is now exactly Practice, Arcade, Explore,
Songs, and Progress; Home remains reachable from the brand. The application
shell dispatches those product surfaces, while Practice owns its nine lazy
activities and selector. The old capability hashes, heuristic Skill Map
launcher, and fake Home “20-minute session” were deleted without aliases.

Navigation no longer shares a provider with musical coordinates or user
preferences. `MusicalProvider` and `UserPreferencesProvider` expose independent
authorities, and React Router derives the current route directly from location.

## Interaction authority

The required dependency direction is:

```text
app microphone provider
  -> immutable PitchObservation stream
  -> pure note/dwell/game controller
  -> one feature view model
  -> one stable rendered workflow surface
```

The prohibited inverse dependencies are:

```text
React phase/effect
  -X-> start, stop, suspend, reopen, or reset microphone
pitch absence/confidence
  -X-> replace the workflow, clear valid dwell, or request recovery
reference playback
  -X-> hide telemetry, reset scoring, or start a persistent guide
```

Silence, uncertainty, and low confidence are observations. They are not input
lifecycle states. PCM progression is the transport heartbeat.

## Remediation ledger

Completed in this overhaul:

- Added the enforceable `npm run audit:architecture` inventory and release gate.
- Replaced Range Loop with one tuner and a pure sample-coordinate dwell reducer.
- Deleted support modes, sustained guides, isolation checks, release gates,
  grace timers, tests-only grading code, and obsolete profile evidence history.
- Reduced Range Loop CSS from 2,450 to 446 lines.
- Reduced Pitch Pong to one stable tuner and removed its `connecting` phase.
- Collapsed raw PCM instrumentation behind closed Advanced diagnostics.
- Removed the duplicated microphone-level/confidence meter from target coaching.
- Replaced Song Lab's scrolling document with Configure, Practice, and Review
  stages over one retained local track and one reducer-owned state model.
- Replaced Range Simulator's modal/prompt/reconnect forest with one stable tuner,
  a 267-line pure sample-coordinate controller, a cohesive resource hook, and a
  single current-action surface. Its UI is 294 lines and its stylesheet fell
  from 1,001 to 396 lines; every implementation boundary is below 600 lines.
- Changed the one legitimate user microphone shutdown to a global app control;
  feature input surfaces no longer expose local Stop buttons.
- Replaced Resonance's 1,364-line, 53-hook workflow with a 334-line stable
  chamber surface, one tuner, and a pure sample-hop session/controller. Generated
  chambers are immediate, the guide is optional, and the twelve-proof lock,
  prompt exclusion, release check, wall-clock animation authority, amplitude
  admission, duplicate tuners, and feature microphone controls are deleted.
- Split Resonance field sampling and vector mathematics from the deterministic
  physics engine; every implementation file is below 1,000 lines and the
  Resonance stylesheet fell from 939 to 294 lines.
- Replaced the custom hashchange/popstate/pushState lifecycle with maintained
  React Router matching, links, and navigation. Converted all 51 exact activity
  paths to the five-surface URL model and retained no old-path aliases.
- Collapsed the permanent sidebar from the capability catalog to Practice,
  Arcade, Explore, Songs, and Progress. App now dispatches only Home plus those
  five surfaces; Practice owns its child activity registry and selector.
- Deleted the aggregate `LabContext`; musical coordinates and user preferences
  now have separate providers. Replaced both App focus traps with native
  dialogs and made the Topbar the single voice Enable/Disable/Retry authority.
- Moved capture, detection, current-note reduction, counters, and bounded
  history into an app-lifetime `AudioKernel`. Authoritative consumers receive
  every observation synchronously while React publications remain bounded and
  transition-exact.
- Rebuilt Pong, Song Rail, Maze, Echo Run, Resonance, and Vocal Canvas around
  sample-time runtimes and one shared observation stream. None controls capture.
- Added one typed Arcade game registry. Cabinet rendering, routing, curriculum,
  progress, lazy component loading, and styles derive from it; the shell has no
  mode-specific import or dispatch forest.
- Replaced Song Lab's mounted flags and generation counters with one scoped
  workspace runtime. Recording cannot be hidden by navigation, and unmount
  synchronously stops the recorder.
- Converted Pitch Mirror, Hum, Pitch & Dynamics, Range Loop, and Range Simulator
  to one current step and frozen attempt/dwell configuration. Back/Forward aborts
  obsolete attempts instead of leaving hidden work active.
- Added Pitch Tunnel as one exact deep-linked Practice activity over the shared
  observation stream: one live lane, a pure sample-coordinate reducer, disjoint
  ±10-cent walls, and no capture, playback, timer, level gate, or alternate tuner.
- Added sparse semantic publication authority to the shared realtime store.
  Observation-kind, checkpoint, completion, discontinuity, and epoch changes
  publish their exact causing frame while steady analog motion remains bounded.
- Decomposed Arcade and workflow styles, removed obsolete selectors and dormant
  alternate UIs, and split browser proof support without weakening runtime
  assertions.

## Release acceptance

Release evidence for the final tree:

1. `npm run audit:architecture` reports zero violations and zero unreachable
   production modules. **Passed: 303 sources, 178 reachable application files.**
2. Full tests, typecheck, production build, Go tests, race tests, and vet pass.
   **Passed: 753/753 frontend tests plus all named gates.**
3. The real Chromium microphone proof crosses the production MediaStream,
   AudioWorklet, overlapping detector, React subscription, and DOM without
   injected frames. **Passed: 1,946/1,946 exact worklet/detector identities.**
4. Range Loop browser proof demonstrates uninterrupted PCM and dwell through
   silence/reference playback, exact reset only on reliable wrong pitch, one
   tuner identity, and no guide/isolation audio. **Passed across a 38-second
   fixture with 2,533/2,533 exact windows.**
5. Route proof exposes exactly five permanent product links, reloads exact
   Practice and Arcade activities, verifies Back/Forward, and rejects every
   retired capability hash. **Passed across 14 offline canonical routes.**
6. Pitch Tunnel's production browser proof independently reconstructs each
   sample-timed checkpoint and requires exact transition-frame publication.
   **Passed: 784/784 post-anchor observations, nine exact 1.00-second dwells,
   351 bounded publications, silence pause, wrong-pitch reset, and live completion.**
7. Desktop and mobile viewport proof confirms the current action and evidence
   are visible without scrolling past unrelated workflow stages. **Passed for
   Range Loop, Arcade, Vocal Canvas, and Pitch Tunnel production captures.**
8. A fresh production container is deployed only after the above artifacts are
   generated from the final tree. **Passed: hardened image
   `sha256:5a7fe22b4eb5…` is healthy on the production Docker context, and both
   the in-container and routed HTTPS health endpoints return `ok`.**
