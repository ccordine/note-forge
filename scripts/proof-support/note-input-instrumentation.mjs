export const BROWSER_INSTRUMENTATION_SOURCE = `(() => {
  const proof = {
    getUserMediaCalls: 0,
    streams: 0,
    tracks: 0,
    audioContexts: 0,
    audioContextStateEvents: [],
    oscillators: 0,
    oscillatorStarts: [],
    oscillatorStops: [],
    audioContextSuspendRequests: 0,
    audioContextSuspendRequestedAt: null,
    workletModuleUrls: [],
    workletNodes: 0,
    workletSampleMessages: 0,
    workletLevelMessages: 0,
    workletSampleEvents: [],
    domFrameMutations: [],
    trackInitialStates: [],
    trackEnabledWrites: [],
    trackStopCalls: [],
    stopOnNextSample: false,
    explicitStopRequestedAt: null,
    explicitStopSampleMessageCount: null,
    stopButtonClicks: 0,
    stopButtonMissing: false,
    instrumentationErrors: [],
  };
  let capturedAudioContext = null;
  const proofControl = Object.freeze({
    snapshot: () => JSON.parse(JSON.stringify(proof)),
    suspendCapturedAudioContext: async () => {
      if (!capturedAudioContext) return { suspended: false, state: null };
      proof.audioContextSuspendRequests += 1;
      proof.audioContextSuspendRequestedAt = performance.now();
      await capturedAudioContext.suspend();
      return { suspended: true, state: capturedAudioContext.state };
    },
    armStopOnNextSample: () => {
      proof.stopOnNextSample = true;
      return true;
    },
  });
  Object.defineProperty(window, '__noteforgeNoteInputProof', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: proofControl,
  });
  const NativeAudioContext = window.AudioContext;
  if (typeof NativeAudioContext !== 'function') {
    proof.instrumentationErrors.push('AudioContext unavailable');
  } else {
    try {
      window.AudioContext = new Proxy(NativeAudioContext, {
        construct(target, args) {
          const context = Reflect.construct(target, args, target);
          capturedAudioContext = context;
          proof.audioContexts += 1;
          const nativeCreateOscillator = context.createOscillator.bind(context);
          context.createOscillator = (...oscillatorArgs) => {
            const oscillator = nativeCreateOscillator(...oscillatorArgs);
            const oscillatorId = ++proof.oscillators;
            const nativeStart = oscillator.start.bind(oscillator);
            const nativeStop = oscillator.stop.bind(oscillator);
            oscillator.start = (when = 0) => {
              proof.oscillatorStarts.push({
                id: oscillatorId,
                at: performance.now(),
                contextTime: context.currentTime,
                when,
              });
              return nativeStart(when);
            };
            oscillator.stop = (when = 0) => {
              proof.oscillatorStops.push({
                id: oscillatorId,
                at: performance.now(),
                contextTime: context.currentTime,
                when,
              });
              return nativeStop(when);
            };
            return oscillator;
          };
          proof.audioContextStateEvents.push({
            at: performance.now(),
            state: context.state,
          });
          context.addEventListener('statechange', () => {
            proof.audioContextStateEvents.push({
              at: performance.now(),
              state: context.state,
            });
          });
          return context;
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('AudioContext instrumentation: ' + String(error));
    }
  }
  const audioWorkletPrototype = window.AudioWorklet?.prototype;
  const nativeAddModule = audioWorkletPrototype?.addModule;
  if (typeof nativeAddModule !== 'function') {
    proof.instrumentationErrors.push('AudioWorklet.addModule unavailable');
  } else {
    try {
      Object.defineProperty(audioWorkletPrototype, 'addModule', {
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
            if (event.data?.type === 'level') {
              proof.workletLevelMessages += 1;
              return;
            }
            if (event.data?.type !== 'samples') return;
            proof.workletSampleMessages += 1;
            proof.workletSampleEvents.push({
              at: performance.now(),
              capturedAt: event.data.capturedAt,
              sampleCount: event.data.samples?.length ?? null,
              startSample: event.data.startSample,
              endSample: event.data.endSample,
              captureEpoch: event.data.captureEpoch,
              continuityEpoch: event.data.continuityEpoch,
              graphGeneration: event.data.graphGeneration,
              processCount: event.data.processCount,
              processedSampleCount: event.data.processedSampleCount,
              discontinuity: event.data.discontinuity,
            });
            if (proof.workletSampleEvents.length > 8192) proof.workletSampleEvents.shift();
            if (proof.stopOnNextSample && proof.explicitStopRequestedAt === null) {
              proof.explicitStopRequestedAt = performance.now();
              // A zero-delay task runs after the entire MessagePort event
              // dispatch, including production's port.onmessage handler.
              // A microtask here can run between listeners in Chromium and
              // create a one-frame stop-boundary race.
              setTimeout(() => {
                const button = document.querySelector('button[data-global-mic-disable]');
                if (!button) {
                  proof.stopButtonMissing = true;
                  return;
                }
                // Establish the boundary synchronously with the actual
                // user control. Messages queued before this task are
                // Pre-Disable evidence; none may arrive after button.click().
                proof.explicitStopSampleMessageCount = proof.workletSampleMessages;
                proof.stopButtonClicks += 1;
                button.click();
              }, 0);
            }
          });
          return node;
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('AudioWorkletNode instrumentation: ' + String(error));
    }
  }
  const recordRenderedFrame = () => {
    const scope = document.querySelector('[data-note-input]');
    const pitch = document.querySelector('[data-detected-note]');
    const rawEndSample = scope?.getAttribute('data-end-sample');
    const rawHeldSamples = scope?.getAttribute('data-held-samples');
    const rawHeldSeconds = scope?.getAttribute('data-held-seconds');
    if (!scope || !pitch || rawEndSample === null || rawEndSample === '') return;
    const observation = {
      at: performance.now(),
      note: pitch.getAttribute('data-detected-note') || null,
      frameCount: Number(scope.getAttribute('data-frame-count')),
      endSample: Number(rawEndSample),
      captureEpoch: Number(scope.getAttribute('data-capture-epoch')),
      continuityEpoch: Number(scope.getAttribute('data-continuity-epoch')),
      graphGeneration: Number(scope.getAttribute('data-graph-generation')),
      heldSamples: rawHeldSamples === null || rawHeldSamples === ''
        ? null
        : Number(rawHeldSamples),
      heldSeconds: rawHeldSeconds === null || rawHeldSeconds === ''
        ? null
        : Number(rawHeldSeconds),
      inputState: scope.getAttribute('data-input-state'),
      hash: location.hash,
    };
    if (!Number.isSafeInteger(observation.endSample) || observation.endSample < 0) return;
    const previous = proof.domFrameMutations.at(-1);
    if (previous
      && previous.endSample === observation.endSample
      && previous.note === observation.note
      && previous.hash === observation.hash) return;
    proof.domFrameMutations.push(observation);
    if (proof.domFrameMutations.length > 8192) proof.domFrameMutations.shift();
  };
  const renderedFrameObserver = new MutationObserver(recordRenderedFrame);
  renderedFrameObserver.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'data-detected-note',
      'data-frame-count',
      'data-end-sample',
      'data-capture-epoch',
      'data-continuity-epoch',
      'data-graph-generation',
      'data-held-samples',
      'data-held-seconds',
      'data-input-state',
    ],
  });
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) {
    proof.instrumentationErrors.push('navigator.mediaDevices.getUserMedia unavailable');
    return;
  }
  const originalGetUserMedia = devices.getUserMedia.bind(devices);
  const instrumentTrack = (track) => {
    proof.tracks += 1;
    proof.trackInitialStates.push({
      at: performance.now(),
      enabled: track.enabled,
      kind: track.kind,
      readyState: track.readyState,
    });
    let prototype = track;
    let enabledDescriptor;
    while (prototype && !enabledDescriptor) {
      prototype = Object.getPrototypeOf(prototype);
      enabledDescriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'enabled');
    }
    if (enabledDescriptor?.get && enabledDescriptor?.set) {
      try {
        Object.defineProperty(track, 'enabled', {
          configurable: true,
          enumerable: enabledDescriptor.enumerable,
          get() { return enabledDescriptor.get.call(track); },
          set(value) {
            proof.trackEnabledWrites.push({
              at: performance.now(),
              value: Boolean(value),
              kind: track.kind,
              readyState: track.readyState,
            });
            return enabledDescriptor.set.call(track, value);
          },
        });
      } catch (error) {
        proof.instrumentationErrors.push('enabled instrumentation: ' + String(error));
      }
    } else {
      proof.instrumentationErrors.push('MediaStreamTrack.enabled descriptor unavailable');
    }
    const originalStop = track.stop.bind(track);
    try {
      Object.defineProperty(track, 'stop', {
        configurable: true,
        value() {
          proof.trackStopCalls.push({ at: performance.now(), kind: track.kind, readyState: track.readyState });
          return originalStop();
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('stop instrumentation: ' + String(error));
    }
  };
  try {
    Object.defineProperty(devices, 'getUserMedia', {
      configurable: true,
      value: async (...args) => {
        proof.getUserMediaCalls += 1;
        const stream = await originalGetUserMedia(...args);
        proof.streams += 1;
        stream.getAudioTracks().forEach(instrumentTrack);
        return stream;
      },
    });
  } catch (error) {
    proof.instrumentationErrors.push('getUserMedia instrumentation: ' + String(error));
  }
})();`;
