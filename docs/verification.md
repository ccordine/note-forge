# Verification authority

NoteForge uses different test layers for different claims. Passing a narrower
layer must never be reported as proof of a wider one.

## Authority by layer

| Layer | Establishes | Does not establish |
| --- | --- | --- |
| Real Chromium fake-microphone proof | The built, stamped `dist` bundle; permission; `getUserMedia`; the production AudioWorklet; capture ownership; one authoritative observation per PCM window; exact raw-candidate/temporal-tracker decisions; React rendering; prompt/navigation continuity; track lifecycle; full detector range; quiet input; silence/noise rejection; exact Pitch Tunnel sample-time dwell/transition behavior; Vocal Flight calibration/control/flight wiring; and measured browser timing | Behavior of every physical microphone, OS DSP stack, room, or browser engine |
| Noisy Range Loop Chromium proof | One continuous C3 mixed over time with clean, +30/+20/+10/+6/+3 dB broadband noise, impulses, dominant harmonics, amplitude drops, and changing noise crosses the real MediaStream/worklet/engine/shared-tracker/`NoteInput`/Range Loop path; uncertainty may pause but cannot regress hold; persistent D3 must replace C3 and earn the next hold | +0 dB browser behavior (covered only by the unit matrix), every real room/noise source, or every physical microphone |
| Mobile playback Chromium proof | The built production routes at 320×568 and 390×844 have no page-level horizontal overflow, reach their vertical end, expose hit-testable controls, and use the same visible Play/Stop/Play note toggle | Every route, browser engine, zoom/font override, or authored temporal-gesture transport |
| Responsive Chromium proof | Built Pitch Match layout and interaction at every shipped shell/feature breakpoint; descendant clipping; horizontal containment; vertical reachability; hit testing; compact action copy; one canonical input; and idle/tracking/complete continuity with a fake microphone | Every route, browser engine, zoom level, font override, or physical microphone |
| Detector/engine PCM tests | Per-window YIN and harmonic-family candidates, target-independent temporal tracking, anti-aliased high-rate normalization, configured rates/range, adversarial spectra and noise strengths, silence, and seeded-noise behavior for deterministic sample arrays | Browser capture, permission, worklet delivery, React ownership, or rendered UI |
| Pure model/controller tests | Deterministic state transitions, validation, immutability, scoring, scheduling, and bounded outputs for the supplied observations | Microphone capture or UI wiring |
| Architecture inventory | File/component size, conditional depth, hook/timer density, import reachability, route/style/input ownership, and prohibited lifecycle calls in the checked-in source | Runtime interaction behavior or microphone correctness |
| Headless kernel stress | Ten minutes of exact sample-time progression with no feature or React subscriber, uninterrupted unvoiced observations, and zero capture stops | Browser permission, Web Audio delivery, physical hardware, or rendered UI |
| Arcade registration tests | One typed registry drives cabinet dispatch, lazy runtime/styles, routes, curriculum, and progress; adding/deleting a game does not require shell surgery | Gameplay behavior or microphone integration |
| Server tests | Static/SPA serving and rejection/acceptance of the bounded diagnostic schema | Browser-side capture or rendering |
| Static SSR tests | Initial rendered HTML and accessibility attributes for explicitly supplied props | Effects, focus movement, event wiring, microphone lifecycle, or browser layout |

Static architecture tests deliberately inspect source, but their claims stop at
structure and ownership. They are never substituted for runtime behavior.
Generated PCM integration tests whose filenames contain `pcm` remain
supplemental; they are not called microphone or browser proofs.

## Canonical commands

```bash
npm test -- --maxWorkers=1 --no-file-parallelism --no-cache
npm run test:coverage -- --maxWorkers=1 --no-file-parallelism --no-cache
npm run audit:architecture
npm run typecheck
npm run build
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
GOCACHE=/tmp/noteforge-go-cache GOTMPDIR=/tmp/noteforge-go-tmp go test -count=1 ./...
GOCACHE=/tmp/noteforge-go-race GOTMPDIR=/tmp/noteforge-go-race-tmp go test -race -count=1 ./...
GOCACHE=/tmp/noteforge-go-vet GOTMPDIR=/tmp/noteforge-go-vet-tmp go vet ./...
```

The Chromium proof is the authority for the live-note path. Its exact contract
and latest checked-in result are recorded in
[`docs/feature-proofs/voice-input.md`](feature-proofs/voice-input.md).
Vocal Flight's cabinet-level calibration, derived-brightness, deterministic
physics, route-continuity, and responsive assertions are recorded separately in
[`docs/feature-proofs/vocal-flight.md`](feature-proofs/vocal-flight.md).

## Explicit remaining limits

- The fake-microphone proof cannot certify a particular physical device or its
  operating-system processing. Failures there require the same worklet/frame
  counters and negotiated-settings evidence, not a favorable synthetic test.
- Most non-microphone feature UIs have pure-model and static-render coverage,
  not full browser interaction coverage. Those tests must not be described as
  end-to-end. The coverage command includes uncovered production files instead
  of silently omitting them; its current percentages belong to the generated
  report for the exact revision under test, not to this authority table.
- A production build proves bundling and type integration. It is not a runtime
  behavior proof by itself.
