export const PITCH_TUNNEL_INSTRUMENTATION_SOURCE = `(() => {
  const proof = {
    mediaStreamSources: 0,
    bufferSourceStarts: 0,
    mediaElementPlayCalls: 0,
    laneElements: 0,
    tunnelSnapshots: [],
    instrumentationErrors: [],
  };
  Object.defineProperty(window, '__noteforgePitchTunnelProof', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ snapshot: () => JSON.parse(JSON.stringify(proof)) }),
  });
  const contextPrototype = window.AudioContext?.prototype;
  const nativeCreateMediaStreamSource = contextPrototype?.createMediaStreamSource;
  if (typeof nativeCreateMediaStreamSource !== 'function') {
    proof.instrumentationErrors.push('createMediaStreamSource unavailable');
  } else {
    try {
      Object.defineProperty(contextPrototype, 'createMediaStreamSource', {
        configurable: true,
        writable: true,
        value(...args) {
          proof.mediaStreamSources += 1;
          return Reflect.apply(nativeCreateMediaStreamSource, this, args);
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('MediaStream source instrumentation: ' + String(error));
    }
  }
  const nativeCreateBufferSource = contextPrototype?.createBufferSource;
  if (typeof nativeCreateBufferSource === 'function') {
    try {
      Object.defineProperty(contextPrototype, 'createBufferSource', {
        configurable: true,
        writable: true,
        value(...args) {
          const source = Reflect.apply(nativeCreateBufferSource, this, args);
          const nativeStart = source.start.bind(source);
          source.start = (...startArgs) => {
            proof.bufferSourceStarts += 1;
            return nativeStart(...startArgs);
          };
          return source;
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('Buffer source instrumentation: ' + String(error));
    }
  }
  const mediaPrototype = window.HTMLMediaElement?.prototype;
  const nativeMediaPlay = mediaPrototype?.play;
  if (typeof nativeMediaPlay === 'function') {
    try {
      Object.defineProperty(mediaPrototype, 'play', {
        configurable: true,
        writable: true,
        value(...args) {
          proof.mediaElementPlayCalls += 1;
          return Reflect.apply(nativeMediaPlay, this, args);
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('Media element instrumentation: ' + String(error));
    }
  }
  const numberAttribute = (root, name) => {
    const raw = root.getAttribute(name);
    return raw === null || raw === '' ? null : Number(raw);
  };
  const knownLanes = new WeakMap();
  const readMetrics = (root) => Object.fromEntries(
    [...root.querySelectorAll('.pitch-tunnel-metric')].map((metric) => [
      metric.querySelector('small')?.textContent?.trim() || '',
      metric.querySelector('strong')?.textContent?.trim() || '',
    ]),
  );
  const record = () => {
    const lane = document.querySelector('[data-pitch-tunnel-lane]');
    const root = lane?.closest('[data-pitch-tunnel]');
    if (!lane || !root) return;
    const point = lane.querySelector('.pitch-tunnel-point');
    if (!knownLanes.has(lane)) {
      proof.laneElements += 1;
      knownLanes.set(lane, proof.laneElements);
    }
    const snapshot = {
      at: performance.now(),
      laneId: knownLanes.get(lane),
      workflowStep: lane.getAttribute('data-workflow-step'),
      inputState: lane.getAttribute('data-input-state'),
      observationKind: lane.getAttribute('data-observation-kind') || null,
      observedFrameCount: numberAttribute(lane, 'data-observed-frame-count'),
      sampleRate: numberAttribute(lane, 'data-sample-rate'),
      startSample: numberAttribute(lane, 'data-start-sample'),
      endSample: numberAttribute(lane, 'data-end-sample'),
      processedSampleCount: numberAttribute(lane, 'data-processed-sample-count'),
      workletProcessCount: numberAttribute(lane, 'data-worklet-process-count'),
      captureEpoch: numberAttribute(lane, 'data-capture-epoch'),
      continuityEpoch: numberAttribute(lane, 'data-continuity-epoch'),
      graphGeneration: numberAttribute(lane, 'data-graph-generation'),
      targetOffsetCents: numberAttribute(lane, 'data-target-offset-cents'),
      targetMidi: numberAttribute(lane, 'data-target-midi'),
      liveMidi: numberAttribute(lane, 'data-live-midi'),
      errorCents: numberAttribute(lane, 'data-error-cents'),
      confidence: numberAttribute(lane, 'data-confidence'),
      inLane: lane.getAttribute('data-in-lane') || null,
      elapsedSeconds: numberAttribute(lane, 'data-elapsed-seconds'),
      inLaneSeconds: numberAttribute(lane, 'data-in-lane-seconds'),
      trackingLossSeconds: numberAttribute(lane, 'data-tracking-loss-seconds'),
      checkpointIndex: numberAttribute(lane, 'data-checkpoint-index'),
      checkpointHeldSeconds: numberAttribute(lane, 'data-checkpoint-held-seconds'),
      completedCheckpointCount: root.querySelectorAll('.pitch-tunnel-checkpoint.complete').length,
      laneLabel: lane.querySelector('.pitch-tunnel-lane-label')?.textContent?.trim() || '',
      heading: root.querySelector('.pitch-tunnel-heading h2')?.textContent?.trim() || '',
      pointOpacity: point ? Number(getComputedStyle(point).opacity) : null,
      metrics: readMetrics(root),
    };
    if (!Number.isSafeInteger(snapshot.endSample) || snapshot.endSample < 0) return;
    const signature = JSON.stringify(snapshot, (key, value) => key === 'at' ? undefined : value);
    const previous = proof.tunnelSnapshots.at(-1);
    const previousSignature = previous
      ? JSON.stringify(previous, (key, value) => key === 'at' ? undefined : value)
      : null;
    if (signature !== previousSignature) proof.tunnelSnapshots.push(snapshot);
  };
  const observer = new MutationObserver(record);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'class', 'data-workflow-step', 'data-input-state', 'data-observation-kind',
      'data-observed-frame-count', 'data-sample-rate', 'data-start-sample',
      'data-end-sample', 'data-processed-sample-count', 'data-worklet-process-count',
      'data-capture-epoch', 'data-continuity-epoch', 'data-graph-generation',
      'data-target-offset-cents', 'data-target-midi', 'data-live-midi',
      'data-error-cents', 'data-confidence', 'data-in-lane', 'data-elapsed-seconds',
      'data-in-lane-seconds', 'data-tracking-loss-seconds', 'data-checkpoint-index',
      'data-checkpoint-held-seconds', 'style',
    ],
  });
})();`;
