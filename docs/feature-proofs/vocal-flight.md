# Vocal Flight executable proof

`npm run proof:vocal-flight:browser` builds and stamps production, serves that
exact bundle, and launches Chromium with a generated fake microphone. It enters
the real `/arcade/flight` cabinet and operates the visible six-stage calibration
before launching Free Flight. It never injects an observation or invokes the
detector, control adapter, calibration reducer, or flight runtime directly.
The fresh profile receives the 18 real tutorial completion IDs through the
canonical IndexedDB settings record before Arcade hydrates; the proof then
requires the advanced modes to render unlocked. This isolates the combined-axis
flight proof without weakening or bypassing production's progression checks.

The fixture supplies neutral C3, asymmetric upper/lower pitch plateaus,
same-F0 dark and bright harmonic envelopes, three leave-and-return gestures,
isolated pitch and brightness gameplay, combined control, silence, and voiced
resumption. Browser instrumentation independently requires:

- one `getUserMedia`, stream, track, `AudioContext`, media-stream source,
  `AudioWorkletNode`, and content-hashed production worklet;
- exact worklet/detector/React publication sample identity, with every worklet
  observation consumed while React publications remain bounded below sensor
  cadence;
- same-F0 dark/bright separation in the shared derived observation, isolated
  pitch elevator and brightness roll, combined axes, neutral silence, and one
  zero-time authority frame on voiced resumption;
- deterministic aircraft attitude responding to those controls while the one
  canvas continues rendering on `requestAnimationFrame`;
- no oscillator, buffer-source, media-element playback, track-enabled write,
  pre-exit track stop, capture rebuild, or route-owned microphone lifecycle;
- continued PCM after leaving the cabinet; and
- horizontal containment, vertical reachability, and control hit testing at
  1440, 760, 430, 390, and 320 CSS pixels in calibration and flight.

The script also measures the combined production detector and brightness work
for every diagnostic frame and rejects any maximum at or above the 20 ms
analysis hop. This is evidence for the checked-in Chromium software path, not a
claim about every physical microphone, room, operating-system audio stack, or
browser engine.

## Verified result — 2026-08-24

The final production run consumed all 1,734 pre-exit AudioWorklet observations
and retained exact sample identity in 718 bounded React publications. Route exit
left the one track alive while worklet evidence advanced to 1,826 windows; there
were zero track writes or stops. The same-F0 fixture measured brightness
`0.00428` dark versus `0.26584` bright at MIDI `48.0000`/`47.9999`, while the
neutral envelope measured `0.09466`. Normalized gameplay reached `+0.713960`
and `-0.682013` on isolated pitch, `-1` dark roll, and `+1` bright roll. Silence,
the exact resumed authority frame, combined input, aircraft response, and
independent rAF presentation all passed.

Maximum combined production detector/brightness time was 9.8 ms. Calibration
and active flight passed horizontal containment, vertical reachability, and
control hit testing at 1440, 760, 430, 390, and 320 CSS pixels. The run used one
permission request, stream, track, context, source, worklet, root, and canvas;
it created no playback source and navigation did not stop capture.
