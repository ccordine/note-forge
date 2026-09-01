import {
  assert,
  delay,
  evaluate,
  waitForBrowser,
} from "./devtools-runtime.mjs";
import {
  TOGGLE,
  clickRadio,
  clickSelector,
  describe,
  nextTrial,
  promptMidi,
} from "./tone-map-ui.mjs";

const VOICE_CONTROL = "[data-voice-answer-control]";
const COMMIT = "[data-voice-answer-action=commit]";
const HOP_SAMPLES = 960;

export const TONE_MAP_VOICE_INSTRUMENTATION_SOURCE = `(() => {
  const proof = {
    getUserMediaCalls: 0,
    streams: 0,
    tracks: 0,
    generatorContexts: 0,
    productionAudioContexts: 0,
    mediaStreamSources: 0,
    knownStreamSources: 0,
    workletNodes: 0,
    workletModuleUrls: [],
    workletSampleEvents: [],
    productionOscillatorEvents: [],
    trackInitialStates: [],
    trackConstraintApplications: [],
    trackEnabledWrites: [],
    trackStopCalls: [],
    generatorCommands: [],
    statusSnapshots: [],
    instrumentationErrors: [],
  };
  const knownStreams = new WeakSet();
  const knownTracks = new WeakSet();
  const productionContexts = new WeakSet();
  const productionFrequencyParams = new WeakSet();
  const productionOscillators = [];
  const NativeAudioContext = window.AudioContext;
  let generator = null;
  let uuidOrdinal = 0;

  const currentVoiceSnapshot = () => {
    const root = document.querySelector('[data-voice-answer-control]');
    if (!root) return null;
    const numberAttribute = (name) => {
      const raw = root.getAttribute(name);
      return raw === null || raw === '' ? null : Number(raw);
    };
    return {
      at: performance.now(),
      status: root.querySelector('.voice-answer-status')?.textContent?.trim() ?? null,
      ready: root.getAttribute('data-answer-ready'),
      answered: root.getAttribute('data-answered'),
      transport: root.getAttribute('data-transport-state'),
      sampleRate: numberAttribute('data-status-sample-rate'),
      startSample: numberAttribute('data-status-start-sample'),
      endSample: numberAttribute('data-status-end-sample'),
      captureEpoch: numberAttribute('data-status-capture-epoch'),
      continuityEpoch: numberAttribute('data-status-continuity-epoch'),
      graphGeneration: numberAttribute('data-status-graph-generation'),
      workletOrdinal: proof.workletSampleEvents.length,
    };
  };
  const recordVoiceSnapshot = () => {
    const snapshot = currentVoiceSnapshot();
    if (!snapshot) return;
    const previous = proof.statusSnapshots.at(-1);
    const comparable = ({ at: _at, ...value }) => value;
    if (!previous || JSON.stringify(comparable(previous)) !== JSON.stringify(comparable(snapshot))) {
      proof.statusSnapshots.push(snapshot);
    }
  };
  new MutationObserver(recordVoiceSnapshot).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'data-answer-ready',
      'data-answered',
      'data-transport-state',
      'data-status-sample-rate',
      'data-status-start-sample',
      'data-status-end-sample',
      'data-status-capture-epoch',
      'data-status-continuity-epoch',
      'data-status-graph-generation',
    ],
  });

  const snapshot = () => JSON.parse(JSON.stringify({
    ...proof,
    productionOscillatorFrequencies: productionOscillators.map(
      (oscillator) => oscillator.frequency.value,
    ),
    generator: generator ? {
      contextState: generator.context.state,
      frequencyHz: generator.oscillator.frequency.value,
      gain: generator.gain.gain.value,
      trackState: generator.stream.getAudioTracks()[0]?.readyState ?? null,
    } : null,
    currentVoice: currentVoiceSnapshot(),
  }));
  const setMidi = async (midi, cents = 0, amplitude = 0.16) => {
    if (!generator) throw new Error('Generated microphone is not open.');
    if (!Number.isFinite(midi) || !Number.isFinite(cents) || !Number.isFinite(amplitude)) {
      throw new TypeError('Generated microphone values must be finite.');
    }
    await generator.context.resume();
    const frequencyHz = 440 * 2 ** (((midi + cents / 100) - 69) / 12);
    const at = generator.context.currentTime;
    generator.oscillator.frequency.setValueAtTime(frequencyHz, at);
    generator.gain.gain.setValueAtTime(amplitude, at);
    proof.generatorCommands.push({ kind: 'tone', at: performance.now(), midi, cents, frequencyHz, amplitude });
    return { frequencyHz, state: generator.context.state };
  };
  const silence = async () => {
    if (!generator) throw new Error('Generated microphone is not open.');
    await generator.context.resume();
    generator.gain.gain.setValueAtTime(0, generator.context.currentTime);
    proof.generatorCommands.push({ kind: 'silence', at: performance.now() });
    return { state: generator.context.state };
  };
  Object.defineProperty(window, '__noteforgeToneMapVoiceProof', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ snapshot, setMidi, silence }),
  });

  try {
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        const suffix = String(uuidOrdinal++).padStart(12, '0');
        return '00000000-0000-4000-8000-' + suffix;
      },
    });
  } catch (error) {
    proof.instrumentationErrors.push('deterministic curriculum seed: ' + String(error));
  }

  if (typeof NativeAudioContext !== 'function') {
    proof.instrumentationErrors.push('AudioContext unavailable');
  } else {
    try {
      const nativeCreateMediaStreamSource = NativeAudioContext.prototype.createMediaStreamSource;
      const nativeCreateOscillator = NativeAudioContext.prototype.createOscillator;
      Object.defineProperty(NativeAudioContext.prototype, 'createMediaStreamSource', {
        configurable: true,
        writable: true,
        value(stream) {
          proof.mediaStreamSources += 1;
          if (knownStreams.has(stream)
            || stream.getAudioTracks().some((track) => knownTracks.has(track))) {
            proof.knownStreamSources += 1;
          }
          return Reflect.apply(nativeCreateMediaStreamSource, this, [stream]);
        },
      });
      Object.defineProperty(NativeAudioContext.prototype, 'createOscillator', {
        configurable: true,
        writable: true,
        value(...args) {
          const oscillator = Reflect.apply(nativeCreateOscillator, this, args);
          if (productionContexts.has(this)) {
            productionFrequencyParams.add(oscillator.frequency);
            productionOscillators.push(oscillator);
          }
          return oscillator;
        },
      });
      for (const method of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']) {
        const nativeMethod = window.AudioParam.prototype[method];
        Object.defineProperty(window.AudioParam.prototype, method, {
          configurable: true,
          writable: true,
          value(value, audioTime) {
            if (productionFrequencyParams.has(this)) {
              proof.productionOscillatorEvents.push({
                method,
                frequencyHz: Number(value),
                audioTime: Number(audioTime),
                at: performance.now(),
              });
            }
            return Reflect.apply(nativeMethod, this, [value, audioTime]);
          },
        });
      }
      window.AudioContext = new Proxy(NativeAudioContext, {
        construct(target, args) {
          proof.productionAudioContexts += 1;
          const context = Reflect.construct(target, args, target);
          productionContexts.add(context);
          return context;
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('AudioContext instrumentation: ' + String(error));
    }
  }

  const nativeAddModule = window.AudioWorklet?.prototype?.addModule;
  if (typeof nativeAddModule !== 'function') {
    proof.instrumentationErrors.push('AudioWorklet.addModule unavailable');
  } else {
    try {
      Object.defineProperty(window.AudioWorklet.prototype, 'addModule', {
        configurable: true,
        writable: true,
        value(...args) {
          proof.workletModuleUrls.push(new URL(String(args[0]), document.baseURI).href);
          return Reflect.apply(nativeAddModule, this, args);
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('AudioWorklet.addModule instrumentation: ' + String(error));
    }
  }

  const NativeAudioWorkletNode = window.AudioWorkletNode;
  if (typeof NativeAudioWorkletNode !== 'function') {
    proof.instrumentationErrors.push('AudioWorkletNode unavailable');
  } else {
    try {
      window.AudioWorkletNode = new Proxy(NativeAudioWorkletNode, {
        construct(target, args) {
          const node = Reflect.construct(target, args, target);
          proof.workletNodes += 1;
          node.port.addEventListener('message', (event) => {
            if (event.data?.type !== 'samples') return;
            proof.workletSampleEvents.push({
              at: performance.now(),
              sampleCount: event.data.samples?.length ?? null,
              sampleRate: args[0]?.sampleRate ?? null,
              startSample: event.data.startSample,
              endSample: event.data.endSample,
              captureEpoch: event.data.captureEpoch,
              continuityEpoch: event.data.continuityEpoch,
              graphGeneration: event.data.graphGeneration,
              processedSampleCount: event.data.processedSampleCount,
              processCount: event.data.processCount,
            });
          });
          return node;
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('AudioWorkletNode instrumentation: ' + String(error));
    }
  }

  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia || typeof NativeAudioContext !== 'function') {
    proof.instrumentationErrors.push('getUserMedia generated-stream boundary unavailable');
  } else {
    const instrumentTrack = (track) => {
      proof.tracks += 1;
      proof.trackInitialStates.push({ enabled: track.enabled, kind: track.kind, readyState: track.readyState });
      let prototype = track;
      let descriptor;
      while (prototype && !descriptor) {
        prototype = Object.getPrototypeOf(prototype);
        descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'enabled');
      }
      if (descriptor?.get && descriptor?.set) {
        try {
          Object.defineProperty(track, 'enabled', {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() { return descriptor.get.call(track); },
            set(value) {
              proof.trackEnabledWrites.push(Boolean(value));
              return descriptor.set.call(track, value);
            },
          });
        } catch (error) {
          proof.instrumentationErrors.push('track.enabled instrumentation: ' + String(error));
        }
      } else {
        proof.instrumentationErrors.push('MediaStreamTrack.enabled descriptor unavailable');
      }
      const originalApplyConstraints = track.applyConstraints.bind(track);
      try {
        Object.defineProperty(track, 'applyConstraints', {
          configurable: true,
          value: async (constraints) => {
            const record = { constraints, acceptedAsRawGeneratedAudio: false, error: null };
            proof.trackConstraintApplications.push(record);
            const entries = Object.entries(constraints ?? {});
            if (entries.length > 0 && entries.every(([key, value]) => (
              (['echoCancellation', 'noiseSuppression', 'autoGainControl'].includes(key)
                && value === false)
              || (key === 'channelCount' && value?.ideal === 1)
              || (key === 'latency' && value?.ideal === 0)
            ))) {
              // MediaStreamAudioDestinationNode is already raw generated PCM;
              // Chromium exposes no capture-DSP toggles on this synthetic track.
              record.acceptedAsRawGeneratedAudio = true;
              return;
            }
            try {
              await originalApplyConstraints(constraints);
            } catch (error) {
              record.error = String(error);
              throw error;
            }
          },
        });
      } catch (error) {
        proof.instrumentationErrors.push('track.applyConstraints instrumentation: ' + String(error));
      }
      const originalStop = track.stop.bind(track);
      try {
        Object.defineProperty(track, 'stop', {
          configurable: true,
          value() {
            proof.trackStopCalls.push({ kind: track.kind, readyState: track.readyState, at: performance.now() });
            return originalStop();
          },
        });
      } catch (error) {
        proof.instrumentationErrors.push('track.stop instrumentation: ' + String(error));
      }
    };
    try {
      Object.defineProperty(devices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          proof.getUserMediaCalls += 1;
          if (generator) return generator.stream;
          const context = new NativeAudioContext({ latencyHint: 'interactive', sampleRate: 48_000 });
          const destination = context.createMediaStreamDestination();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = 130.81278265;
          gain.gain.value = 0;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await context.resume();
          generator = { context, destination, oscillator, gain, stream: destination.stream };
          proof.generatorContexts += 1;
          proof.streams += 1;
          knownStreams.add(generator.stream);
          generator.stream.getAudioTracks().forEach((track) => {
            knownTracks.add(track);
            instrumentTrack(track);
          });
          return generator.stream;
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('getUserMedia override: ' + String(error));
    }
  }
})();`;

function readVoiceControl(session) {
  return evaluate(session, `(() => {
    const root = document.querySelector(${JSON.stringify(VOICE_CONTROL)});
    const commit = root?.querySelector(${JSON.stringify(COMMIT)});
    const numberAttribute = (name) => {
      const raw = root?.getAttribute(name);
      return raw === null || raw === undefined || raw === '' ? null : Number(raw);
    };
    return {
      exists: Boolean(root),
      ready: root?.getAttribute('data-answer-ready') ?? null,
      answered: root?.getAttribute('data-answered') ?? null,
      transport: root?.getAttribute('data-transport-state') ?? null,
      status: root?.querySelector('.voice-answer-status')?.textContent?.trim() ?? null,
      commitDisabled: commit instanceof HTMLButtonElement ? commit.disabled : null,
      sampleRate: numberAttribute('data-status-sample-rate'),
      startSample: numberAttribute('data-status-start-sample'),
      endSample: numberAttribute('data-status-end-sample'),
      captureEpoch: numberAttribute('data-status-capture-epoch'),
      continuityEpoch: numberAttribute('data-status-continuity-epoch'),
      graphGeneration: numberAttribute('data-status-graph-generation'),
      review: Boolean(document.querySelector('[data-tone-map-review]')),
    };
  })()`);
}

async function generatedMicrophone(session, method, ...args) {
  return evaluate(
    session,
    `window.__noteforgeToneMapVoiceProof.${method}(${args.map((value) => JSON.stringify(value)).join(",")})`,
    true,
  );
}

function sameAuthority(frame, status) {
  return frame.sampleRate === status.sampleRate
    && frame.startSample === status.startSample
    && frame.endSample === status.endSample
    && frame.captureEpoch === status.captureEpoch
    && frame.continuityEpoch === status.continuityEpoch
    && frame.graphGeneration === status.graphGeneration;
}

export async function proveToneMapVoicePath(session, origin, route) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    screenWidth: 390, screenHeight: 844,
  });
  await session.send("Page.navigate", { url: "about:blank" });
  await waitForBrowser(session, "location.href === 'about:blank'", "voice proof blank reset");
  await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await session.send("Page.navigate", { url: `${origin}/#${route}` });
  await waitForBrowser(session, "Boolean(document.querySelector('[data-tone-map-root]'))", "voice Tone Map route", 15_000);

  await clickRadio(session, "Answer path", "Sing it");
  await waitForBrowser(session, `Boolean(document.querySelector(${JSON.stringify(VOICE_CONTROL)}))`, "canonical voice answer control");
  await clickSelector(session, TOGGLE, "Play voice prompt");
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed') === 'true'`, "voice prompt playing");
  const audiblePrompt = await promptMidi(session);
  const targetMidi = audiblePrompt.midi;
  const exposedTarget = await evaluate(session,
    "document.querySelector('[data-tone-map-guided-label]')?.textContent?.trim() ?? null");
  assert(exposedTarget === null && targetMidi >= 30 && targetMidi <= 86,
    `Voice prompt leaked its target or escaped detector range: ${describe({ exposedTarget, audiblePrompt })}`);
  await clickSelector(session, "[data-global-mic-enable]", "Enable voice once");
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(VOICE_CONTROL)})?.getAttribute('data-transport-state') === 'running'`, "generated microphone running", 12_000);
  await generatedMicrophone(session, "setMidi", targetMidi, 0, 0.16);
  const playingStart = await evaluate(session, "window.__noteforgeToneMapVoiceProof.snapshot().workletSampleEvents.length");
  await waitForBrowser(session, `window.__noteforgeToneMapVoiceProof.snapshot().workletSampleEvents.length >= ${playingStart + 24}`, "matching PCM while prompt plays");
  const whilePlaying = await readVoiceControl(session);
  assert(whilePlaying.ready === "false" && whilePlaying.commitDisabled && !whilePlaying.review,
    `Matching microphone pitch armed or graded while prompt played: ${describe(whilePlaying)}`);

  await clickSelector(session, TOGGLE, "Stop voice prompt");
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed') === 'false'`, "explicit voice prompt stop");
  const stoppedStart = await evaluate(session, "window.__noteforgeToneMapVoiceProof.snapshot().workletSampleEvents.length");
  await waitForBrowser(session, `window.__noteforgeToneMapVoiceProof.snapshot().workletSampleEvents.length >= ${stoppedStart + 24}`, "stale held pitch after prompt stop");
  const stale = await readVoiceControl(session);
  assert(stale.ready === "false" && stale.commitDisabled && !stale.review
    && stale.status === "Let the prior sound clear, then sing.",
  `Held prompt-era pitch inherited readiness after Stop: ${describe(stale)}`);

  await generatedMicrophone(session, "silence");
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(VOICE_CONTROL)})?.querySelector('.voice-answer-status')?.textContent?.trim() === 'Sing and hold one steady pitch.'`, "fresh unvoiced release boundary", 5_000);
  const released = await readVoiceControl(session);
  assert(Number.isSafeInteger(released.endSample) && released.ready === "false" && released.commitDisabled,
    `The unvoiced release did not publish exact listening authority: ${describe(released)}`);

  await generatedMicrophone(session, "setMidi", targetMidi, 10, 0.16);
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(VOICE_CONTROL)})?.getAttribute('data-answer-ready') === 'true'`, "250 ms in-lane sung answer", 5_000);
  const ready = await readVoiceControl(session);
  await delay(500);
  const beforeCommit = await readVoiceControl(session);
  assert(ready.ready === "true" && !ready.commitDisabled && !ready.review
    && beforeCommit.ready === "true" && !beforeCommit.review,
  `Voice evidence graded without explicit Commit: ${describe({ ready, beforeCommit })}`);
  assert(sameAuthority(ready, beforeCommit),
    `Steady ready frames republished or replaced the exact semantic transition authority: ${describe({ ready, beforeCommit })}`);
  assert(ready.endSample - released.endSample >= HOP_SAMPLES * 13,
    `Ready status credited less than 250 ms of post-release sample time: ${describe({ released, ready })}`);

  const proofAtReady = await evaluate(session, "window.__noteforgeToneMapVoiceProof.snapshot()");
  const exactFrame = proofAtReady.workletSampleEvents.find((frame) => sameAuthority(frame, ready));
  assert(exactFrame && exactFrame.sampleCount === 4_096 && exactFrame.processedSampleCount === exactFrame.endSample,
    `Rendered ready state did not reconcile to one exact production worklet window: ${describe({ ready, exactFrame })}`);
  assert(proofAtReady.workletSampleEvents.every((frame, index, frames) => index === 0
    || frame.endSample - frames[index - 1].endSample === HOP_SAMPLES),
  "Generated microphone worklet evidence was not one monotonic 20 ms overlapping stream.");

  await clickSelector(session, COMMIT, "Commit sung answer");
  await waitForBrowser(session, "Boolean(document.querySelector('[data-tone-map-review]'))", "voice answer review after Commit");
  const review = await evaluate(session, `(() => {
    const root = document.querySelector('[data-tone-map-review]');
    return {
      target: Number(root?.getAttribute('data-tone-map-target-midi')),
      correct: root?.classList.contains('correct') ?? false,
      promptPressed: document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed'),
    };
  })()`);
  assert(review.correct && review.target === targetMidi && review.promptPressed === "false",
    `Explicit voice Commit did not alone grade the detected matching pitch: ${describe(review)}`);

  await nextTrial(session);
  const nextStart = await evaluate(session, "window.__noteforgeToneMapVoiceProof.snapshot().workletSampleEvents.length");
  await waitForBrowser(session, `window.__noteforgeToneMapVoiceProof.snapshot().workletSampleEvents.length >= ${nextStart + 24}`, "same held tone on next trial");
  const next = await readVoiceControl(session);
  assert(next.ready === "false" && next.commitDisabled && !next.review
    && next.status === "Let the prior sound clear, then sing.",
  `Next inherited readiness from the continuously held prior tone: ${describe(next)}`);

  const finalProof = await evaluate(session, "window.__noteforgeToneMapVoiceProof.snapshot()");
  assert(finalProof.instrumentationErrors.length === 0,
    `Tone Map voice instrumentation failed: ${describe(finalProof.instrumentationErrors)}`);
  assert(finalProof.getUserMediaCalls === 1 && finalProof.streams === 1 && finalProof.tracks === 1
    && finalProof.generatorContexts === 1 && finalProof.productionAudioContexts === 1
    && finalProof.mediaStreamSources === 1 && finalProof.knownStreamSources === 1
    && finalProof.workletNodes === 1
    && finalProof.workletModuleUrls.length === 1
    && /\/assets\/pitch-capture-worklet-[A-Za-z0-9_-]+\.js$/u.test(finalProof.workletModuleUrls[0]),
  `Voice mode did not retain one production microphone path: ${describe(finalProof)}`);
  assert(finalProof.trackEnabledWrites.length === 0 && finalProof.trackStopCalls.length === 0,
    `Tone Map changed or stopped the retained microphone: ${describe({
      enabledWrites: finalProof.trackEnabledWrites,
      stops: finalProof.trackStopCalls,
    })}`);
  assert(finalProof.generatorCommands.map((command) => command.kind).join(",") === "tone,silence,tone"
    && finalProof.generatorCommands[0].midi === targetMidi
    && finalProof.generatorCommands[0].cents === 0
    && finalProof.generatorCommands[2].midi === targetMidi
    && finalProof.generatorCommands[2].cents === 10,
    `Generated input did not cross the required tone/silence/tone path: ${describe(finalProof.generatorCommands)}`);
  const authoritativeStatuses = finalProof.statusSnapshots.filter((status) => Number.isSafeInteger(status.endSample));
  assert(authoritativeStatuses.length >= 2
    && authoritativeStatuses.every((status) => finalProof.workletSampleEvents.some((frame) => sameAuthority(frame, status)))
    && finalProof.statusSnapshots.length < finalProof.workletSampleEvents.length / 4,
  `Semantic voice status publication lost exact worklet authority or became the audio clock: ${describe({
    statuses: finalProof.statusSnapshots,
    workletWindows: finalProof.workletSampleEvents.length,
  })}`);
  return {
    target: { midi: targetMidi, cents: 10 },
    workletWindows: finalProof.workletSampleEvents.length,
    semanticStatusPublications: finalProof.statusSnapshots.length,
    releaseAuthority: released,
    readyAuthority: ready,
    promptPlayingWindows: 24,
    staleHeldWindows: 24,
    sameToneNextTrialWindows: 24,
    microphone: {
      getUserMediaCalls: finalProof.getUserMediaCalls,
      streams: finalProof.streams,
      tracks: finalProof.tracks,
      sources: finalProof.mediaStreamSources,
      worklets: finalProof.workletNodes,
      stops: finalProof.trackStopCalls.length,
    },
  };
}
