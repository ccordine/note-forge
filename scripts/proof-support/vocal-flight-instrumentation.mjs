export const VOCAL_FLIGHT_INSTRUMENTATION_SOURCE = `(() => {
  const proof = {
    mediaStreamSources: 0,
    bufferSourceStarts: 0,
    mediaElementPlayCalls: 0,
    rootElements: 0,
    canvasElements: 0,
    publications: [],
    instrumentationErrors: [],
  };
  const knownRoots = new WeakMap();
  const knownCanvases = new WeakMap();
  const numberAttribute = (element, name) => {
    const raw = element?.getAttribute(name);
    return raw === null || raw === undefined || raw === '' ? null : Number(raw);
  };
  const text = (root, selector) => root.querySelector(selector)?.textContent?.trim() || null;
  const snapshot = () => {
    const root = document.querySelector('[data-vocal-flight]');
    const canvas = root?.querySelector('[data-testid=vocal-flight-canvas]');
    const reticle = root?.querySelector('.vocal-control-reticle');
    if (!root) return null;
    if (!knownRoots.has(root)) {
      proof.rootElements += 1;
      knownRoots.set(root, proof.rootElements);
    }
    if (canvas && !knownCanvases.has(canvas)) {
      proof.canvasElements += 1;
      knownCanvases.set(canvas, proof.canvasElements);
    }
    return {
      at: performance.now(),
      rootId: knownRoots.get(root),
      canvasId: canvas ? knownCanvases.get(canvas) : null,
      hash: location.hash,
      phase: root.getAttribute('data-phase'),
      calibrationStage: root.getAttribute('data-calibration-stage'),
      observationKind: root.getAttribute('data-observation-kind'),
      observedFrames: numberAttribute(root, 'data-observed-frames'),
      simulatedFrames: numberAttribute(root, 'data-simulated-frames'),
      publicationCount: numberAttribute(root, 'data-react-publications')
        ?? numberAttribute(root, 'data-publication-count'),
      sampleRate: numberAttribute(root, 'data-sample-rate'),
      startSample: numberAttribute(root, 'data-start-sample'),
      endSample: numberAttribute(root, 'data-end-sample'),
      processedSampleCount: numberAttribute(root, 'data-processed-samples')
        ?? numberAttribute(root, 'data-processed-sample-count'),
      captureEpoch: numberAttribute(root, 'data-capture-epoch'),
      continuityEpoch: numberAttribute(root, 'data-continuity-epoch'),
      graphGeneration: numberAttribute(root, 'data-graph-generation'),
      pitchAxis: numberAttribute(root, 'data-pitch-axis')
        ?? numberAttribute(reticle, 'data-pitch-axis'),
      brightnessAxis: numberAttribute(root, 'data-brightness-axis')
        ?? numberAttribute(reticle, 'data-brightness-axis'),
      pitchConfidence: numberAttribute(root, 'data-pitch-confidence'),
      brightnessConfidence: numberAttribute(root, 'data-brightness-confidence'),
      active: (root.getAttribute('data-control-active')
        ?? root.getAttribute('data-vector-active')
        ?? reticle?.getAttribute('data-active')) === 'true',
      flightX: numberAttribute(root, 'data-aircraft-x') ?? numberAttribute(root, 'data-flight-x'),
      flightY: numberAttribute(root, 'data-aircraft-y') ?? numberAttribute(root, 'data-flight-y'),
      flightZ: numberAttribute(root, 'data-aircraft-z') ?? numberAttribute(root, 'data-flight-z'),
      flightPitch: numberAttribute(root, 'data-aircraft-pitch') ?? numberAttribute(root, 'data-flight-pitch'),
      flightRoll: numberAttribute(root, 'data-aircraft-roll') ?? numberAttribute(root, 'data-flight-roll'),
      flightHeading: numberAttribute(root, 'data-aircraft-yaw') ?? numberAttribute(root, 'data-flight-heading'),
      flightElapsedSeconds: numberAttribute(root, 'data-flight-elapsed-seconds'),
      fixedStepCount: numberAttribute(root, 'data-fixed-steps')
        ?? numberAttribute(root, 'data-flight-fixed-steps'),
      recoveryCount: numberAttribute(root, 'data-calibration-recoveries'),
      calibrationCenterHz: numberAttribute(root, 'data-calibration-center-hz'),
      calibrationCenterBrightness: numberAttribute(root, 'data-calibration-center-brightness'),
      calibrationLowerCents: numberAttribute(root, 'data-calibration-pitch-lower')
        ?? numberAttribute(root, 'data-calibration-lower-cents'),
      calibrationUpperCents: numberAttribute(root, 'data-calibration-pitch-upper')
        ?? numberAttribute(root, 'data-calibration-upper-cents'),
      calibrationDarkerDelta: numberAttribute(root, 'data-calibration-brightness-darker')
        ?? numberAttribute(root, 'data-calibration-darker-delta'),
      calibrationBrighterDelta: numberAttribute(root, 'data-calibration-brightness-brighter')
        ?? numberAttribute(root, 'data-calibration-brighter-delta'),
      brightnessAvailable: root.getAttribute('data-calibration-brightness')
        ?? root.getAttribute('data-brightness-available'),
      renderFrames: canvas ? Number(canvas.dataset.renderFrames || 0) : 0,
      hudAttitude: text(root, '.vocal-flight-hud > div:nth-of-type(3) strong'),
      hudBank: text(root, '.vocal-flight-hud > div:nth-of-type(4) strong'),
    };
  };
  const record = () => {
    const next = snapshot();
    if (!next || !Number.isSafeInteger(next.observedFrames)) return;
    const previous = proof.publications.at(-1);
    const signature = JSON.stringify(next, (key, value) => ['at', 'renderFrames'].includes(key) ? undefined : value);
    const priorSignature = previous
      ? JSON.stringify(previous, (key, value) => ['at', 'renderFrames'].includes(key) ? undefined : value)
      : null;
    if (signature === priorSignature) return;
    proof.publications.push(next);
    if (proof.publications.length > 4096) proof.publications.shift();
  };
  Object.defineProperty(window, '__noteforgeVocalFlightProof', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      snapshot: () => JSON.parse(JSON.stringify({ ...proof, current: snapshot() })),
    }),
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
  const nativePlay = mediaPrototype?.play;
  if (typeof nativePlay === 'function') {
    try {
      Object.defineProperty(mediaPrototype, 'play', {
        configurable: true,
        writable: true,
        value(...args) {
          proof.mediaElementPlayCalls += 1;
          return Reflect.apply(nativePlay, this, args);
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('Media playback instrumentation: ' + String(error));
    }
  }
  const observer = new MutationObserver(record);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'data-phase', 'data-calibration-stage', 'data-observation-kind',
      'data-observed-frames', 'data-simulated-frames', 'data-publication-count',
      'data-react-publications',
      'data-sample-rate', 'data-start-sample', 'data-end-sample',
      'data-processed-sample-count', 'data-processed-samples', 'data-capture-epoch',
      'data-continuity-epoch', 'data-graph-generation', 'data-pitch-axis',
      'data-brightness-axis', 'data-pitch-confidence',
      'data-brightness-confidence', 'data-vector-active', 'data-control-active', 'data-active',
      'data-flight-x', 'data-flight-y', 'data-flight-z', 'data-flight-pitch',
      'data-flight-roll', 'data-flight-heading', 'data-flight-elapsed-seconds',
      'data-flight-fixed-steps', 'data-fixed-steps', 'data-aircraft-x',
      'data-aircraft-y', 'data-aircraft-z', 'data-aircraft-pitch',
      'data-aircraft-roll', 'data-aircraft-yaw', 'data-calibration-recoveries',
      'data-calibration-center-hz', 'data-calibration-center-brightness',
      'data-calibration-lower-cents', 'data-calibration-upper-cents',
      'data-calibration-darker-delta', 'data-calibration-brighter-delta',
      'data-calibration-pitch-lower', 'data-calibration-pitch-upper',
      'data-calibration-brightness-darker', 'data-calibration-brightness-brighter',
      'data-calibration-brightness', 'data-brightness-available',
    ],
  });
})();`;
