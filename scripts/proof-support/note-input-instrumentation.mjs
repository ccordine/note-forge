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
    gainNodes: 0,
    gainParamEvents: [],
    audioContextSuspendRequests: 0,
    audioContextSuspendRequestedAt: null,
    workletModuleUrls: [],
    workletNodes: 0,
    workletSampleMessages: 0,
    workletLevelMessages: 0,
    workletSampleEvents: [],
    domFrameMutations: [],
    pitchPresentationClaims: [],
    ribbonMutations: [],
    trackInitialStates: [],
    trackConstraintApplications: [],
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
          const nativeCreateGain = context.createGain.bind(context);
          context.createGain = (...gainArgs) => {
            const gain = nativeCreateGain(...gainArgs);
            const gainNodeId = ++proof.gainNodes;
            const parameter = gain.gain;
            for (const method of [
              'setValueAtTime',
              'linearRampToValueAtTime',
              'exponentialRampToValueAtTime',
              'cancelScheduledValues',
            ]) {
              const nativeMethod = parameter[method].bind(parameter);
              parameter[method] = (...methodArgs) => {
                proof.gainParamEvents.push({
                  gainNodeId,
                  method,
                  at: performance.now(),
                  contextTime: context.currentTime,
                  value: method === 'cancelScheduledValues' ? null : methodArgs[0],
                  when: method === 'cancelScheduledValues' ? methodArgs[0] : methodArgs[1],
                });
                if (proof.gainParamEvents.length > 4096) proof.gainParamEvents.shift();
                return nativeMethod(...methodArgs);
              };
            }
            return gain;
          };
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
  const recordPitchPresentationClaims = (mutations) => {
    const records = mutations.filter((mutation) =>
      mutation.type === 'attributes'
        && mutation.attributeName === 'data-pitch-presentation-claim'
        && mutation.target instanceof Element);
    for (const [index, mutation] of records.entries()) {
      const following = records.slice(index + 1).find((candidate) =>
        candidate.target === mutation.target);
      const serialized = following?.oldValue
        ?? mutation.target.getAttribute('data-pitch-presentation-claim');
      if (!serialized) continue;
      try {
        const values = JSON.parse(serialized);
        const observation = {
          at: performance.now(),
          endSample: values[0],
          captureEpoch: values[1],
          continuityEpoch: values[2],
          graphGeneration: values[3],
          observationKind: values[4],
          trackingDecision: values[5],
          candidateMidi: values[6],
          candidateFrequencyHz: values[7],
          candidateRawFrequencyHz: values[8],
          displayedMidi: values[9],
          inputState: values[10],
        };
        if (!Number.isSafeInteger(observation.endSample)) continue;
        const previous = proof.pitchPresentationClaims.at(-1);
        if (previous
          && previous.captureEpoch === observation.captureEpoch
          && previous.endSample === observation.endSample) continue;
        proof.pitchPresentationClaims.push(observation);
        if (proof.pitchPresentationClaims.length > 8192) {
          proof.pitchPresentationClaims.shift();
        }
      } catch (error) {
        proof.instrumentationErrors.push('pitch presentation claim: ' + String(error));
      }
    }
  };
  const recordRenderedFrame = () => {
    const scope = document.querySelector('[data-note-input]');
    const pitch = document.querySelector('[data-detected-note]');
    const pitchMeter = scope?.querySelector('[data-live-pitch-meter]');
    const pitchMarker = pitchMeter?.querySelector('[data-live-pitch-marker]');
    const rawEndSample = scope?.getAttribute('data-end-sample');
    const rawHeldSamples = scope?.getAttribute('data-held-samples');
    const rawHeldSeconds = scope?.getAttribute('data-held-seconds');
    if (!scope || !pitch || rawEndSample === null || rawEndSample === '') return;
    const optionalNumberAttribute = (name) => {
      const raw = scope.getAttribute(name);
      return raw === null || raw === '' ? null : Number(raw);
    };
    const meterRectangle = pitchMeter?.getBoundingClientRect();
    const markerRectangle = pitchMarker?.getBoundingClientRect();
    const markerComputedLeft = pitchMarker
      ? Number.parseFloat(getComputedStyle(pitchMarker).left)
      : Number.NaN;
    const markerInlineLeft = pitchMarker
      ? Number.parseFloat(pitchMarker.style.left)
      : Number.NaN;
    const rawMeterLiveMidi = pitchMeter?.getAttribute('data-live-midi');
    const rawMeterPosition = pitchMeter?.getAttribute('data-pitch-position');
    const markerCenterPercent = meterRectangle && markerRectangle
      && meterRectangle.width > 0
      ? (markerRectangle.left + markerRectangle.width / 2 - meterRectangle.left)
        / meterRectangle.width * 100
      : Number.NaN;
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
      observationKind: scope.getAttribute('data-observation-kind') || null,
      trackingDecision: scope.getAttribute('data-pitch-tracking-decision') || null,
      candidateMidi: optionalNumberAttribute('data-pitch-candidate-midi'),
      candidateFrequencyHz: optionalNumberAttribute('data-pitch-candidate-frequency'),
      candidateRawFrequencyHz: optionalNumberAttribute('data-pitch-candidate-raw-frequency'),
      inputState: scope.getAttribute('data-input-state'),
      hash: location.hash,
      meter: pitchMeter ? {
        scale: pitchMeter.getAttribute('data-pitch-scale'),
        liveMidi: rawMeterLiveMidi === null || rawMeterLiveMidi === ''
          ? null
          : Number(rawMeterLiveMidi),
        declaredPositionPercent: rawMeterPosition === null || rawMeterPosition === ''
          ? null
          : Number(rawMeterPosition),
        markerInlinePositionPercent: Number.isFinite(markerInlineLeft)
          ? markerInlineLeft
          : null,
        markerComputedLeftPixels: Number.isFinite(markerComputedLeft)
          ? markerComputedLeft
          : null,
        markerCenterPercent: Number.isFinite(markerCenterPercent)
          ? markerCenterPercent
          : null,
        widthPixels: meterRectangle && Number.isFinite(meterRectangle.width)
          ? meterRectangle.width
          : null,
      } : null,
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
  const recordPitchRibbon = () => {
    const ribbon = document.querySelector('[data-full-depth-pitch-ribbon]');
    const segments = ribbon
      ? [...ribbon.querySelectorAll('[data-pitch-trace-segment]')]
      : [];
    const latestSegment = segments.at(-1);
    const latestPath = latestSegment?.getAttribute('d') ?? '';
    const points = [...latestPath.matchAll(/[ML]\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)/gu)];
    const lastPoint = points.at(-1);
    const numberAttribute = (name) => {
      const raw = latestSegment?.getAttribute(name);
      return raw === null || raw === undefined || raw === '' ? null : Number(raw);
    };
    if (!ribbon || !latestSegment || !lastPoint) return;
    const observation = {
      at: performance.now(),
      startSample: numberAttribute('data-start-sample'),
      endSample: numberAttribute('data-end-sample'),
      captureEpoch: numberAttribute('data-capture-epoch'),
      continuityEpoch: numberAttribute('data-continuity-epoch'),
      graphGeneration: numberAttribute('data-graph-generation'),
      liveMidi: numberAttribute('data-live-midi'),
      segmentCount: segments.length,
      latestX: Number(lastPoint[1]),
      latestY: Number(lastPoint[2]),
      hash: location.hash,
    };
    if (!Number.isSafeInteger(observation.endSample)
      || !Number.isFinite(observation.latestX)
      || !Number.isFinite(observation.latestY)) return;
    const previous = proof.ribbonMutations.at(-1);
    if (previous
      && previous.endSample === observation.endSample
      && previous.latestX === observation.latestX
      && previous.latestY === observation.latestY
      && previous.hash === observation.hash) return;
    proof.ribbonMutations.push(observation);
    if (proof.ribbonMutations.length > 4096) proof.ribbonMutations.shift();
  };
  const renderedFrameObserver = new MutationObserver((mutations) => {
    recordPitchPresentationClaims(mutations);
    recordRenderedFrame();
    recordPitchRibbon();
  });
  renderedFrameObserver.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      'data-detected-note',
      'data-frame-count',
      'data-observation-kind',
      'data-end-sample',
      'data-capture-epoch',
      'data-continuity-epoch',
      'data-graph-generation',
      'data-held-samples',
      'data-held-seconds',
      'data-pitch-tracking-decision',
      'data-pitch-candidate-midi',
      'data-pitch-candidate-frequency',
      'data-pitch-candidate-raw-frequency',
      'data-pitch-presentation-claim',
      'data-input-state',
      'data-live-midi',
      'data-pitch-position',
      'data-pitch-scale',
      'd',
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
    const originalApplyConstraints = track.applyConstraints.bind(track);
    try {
      Object.defineProperty(track, 'applyConstraints', {
        configurable: true,
        value: async (constraints) => {
          const record = { at: performance.now(), constraints, settings: null, error: null };
          proof.trackConstraintApplications.push(record);
          try {
            await originalApplyConstraints(constraints);
            record.settings = track.getSettings();
          } catch (error) {
            record.error = String(error);
            throw error;
          }
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('applyConstraints instrumentation: ' + String(error));
    }
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
