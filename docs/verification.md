# Verification authority

NoteForge uses different test layers for different claims. Passing a narrower
layer must never be reported as proof of a wider one.

## Authority by layer

| Layer | Establishes | Does not establish |
| --- | --- | --- |
| Real Chromium fake-microphone proof | The built, stamped `dist` bundle; permission; `getUserMedia`; the production AudioWorklet; capture ownership; one detector result per PCM window; React rendering; prompt/navigation continuity; track lifecycle; full detector range; quiet input; silence/noise rejection; and measured browser timing | Behavior of every physical microphone, OS DSP stack, room, or browser engine |
| Detector PCM tests | The stateless detector's result for deterministic sample arrays, configured rates/range, adversarial spectra, silence, and seeded noise | Browser capture, permission, worklet delivery, React ownership, or rendered UI |
| Pure model/controller tests | Deterministic state transitions, validation, immutability, scoring, scheduling, and bounded outputs for the supplied observations | Microphone capture or UI wiring |
| Server tests | Static/SPA serving and rejection/acceptance of the bounded diagnostic schema | Browser-side capture or rendering |
| Static SSR tests | Initial rendered HTML and accessibility attributes for explicitly supplied props | Effects, focus movement, event wiring, microphone lifecycle, or browser layout |

There are no tests that read component source as raw text and then treat the
presence or order of strings as behavioral evidence. Generated PCM integration
tests whose filenames contain `pcm` remain supplemental; they are not called
microphone or browser proofs.

## Canonical commands

```bash
npm test -- --maxWorkers=1 --no-file-parallelism --no-cache
npm run test:coverage -- --maxWorkers=1 --no-file-parallelism --no-cache
npm run typecheck
npm run build
npm run proof:note-input:browser
npm run proof:offline:browser
GOCACHE=/tmp/noteforge-go-cache GOTMPDIR=/tmp/noteforge-go-tmp go test -count=1 ./...
```

The Chromium proof is the authority for the live-note path. Its exact contract
and latest checked-in result are recorded in
[`docs/feature-proofs/voice-input.md`](feature-proofs/voice-input.md).

## Explicit remaining limits

- The fake-microphone proof cannot certify a particular physical device or its
  operating-system processing. Failures there require the same worklet/frame
  counters and negotiated-settings evidence, not a favorable synthetic test.
- Most non-microphone feature UIs currently have pure-model and static-render
  coverage, not full browser interaction coverage. Those tests must not be
  described as end-to-end. The current honest all-production baseline is 42.02%
  line coverage (40.09% statements, 34.87% branches, 40.07% functions); the
  report includes uncovered production files instead of silently omitting them.
- A production build proves bundling and type integration. It is not a runtime
  behavior proof by itself.
