export const RANGE_LOOP_INSTRUMENTATION_SOURCE = `(() => {
  const proof = { actions: [], snapshots: [], canonicalInputId: null, topologyViolations: [], instrumentationErrors: [] };
  const inputIds = new WeakMap();
  let nextInputId = 1;
  let lastSignature = '';
  const numberAttribute = (element, name) => {
    const raw = element?.getAttribute(name);
    return raw === null || raw === undefined || raw === '' ? null : Number(raw);
  };
  const inputId = (element) => {
    if (!element) return null;
    if (!inputIds.has(element)) inputIds.set(element, nextInputId++);
    return inputIds.get(element);
  };
  const record = (cause) => {
    try {
      if (location.hash !== '#/practice/range-loop') return;
      const inputs = [...document.querySelectorAll('[data-note-input]')];
      const input = inputs[0] || null;
      const currentInputId = inputId(input);
      if (proof.canonicalInputId === null && inputs.length === 1) proof.canonicalInputId = currentInputId;
      if (proof.canonicalInputId !== null && (inputs.length !== 1 || currentInputId !== proof.canonicalInputId)) {
        proof.topologyViolations.push({ at: performance.now(), count: inputs.length, inputId: currentInputId });
      }
      const meter = input?.querySelector('[data-live-pitch-meter]') || null;
      const target = document.querySelector('.nf-voice-target strong');
      const nextTarget = document.querySelector('.range-loop-next b');
      const nextButton = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Next target');
      const frameDetail = input?.querySelector('.nf-voice-diagnostics b');
      const snapshot = {
        at: performance.now(),
        cause,
        noteInputCount: inputs.length,
        noteInputId: currentInputId,
        phase: document.querySelector('[data-range-loop-phase]')
          ?.getAttribute('data-range-loop-phase') || null,
        inputState: input?.getAttribute('data-input-state') || null,
        target: target?.textContent?.trim() || null,
        followingTarget: nextTarget?.textContent?.trim() || null,
        detectedNote: input?.getAttribute('data-detected-note') || null,
        observationKind: input?.getAttribute('data-observation-kind') || null,
        startSample: numberAttribute(input, 'data-start-sample'),
        endSample: numberAttribute(input, 'data-end-sample'),
        captureEpoch: numberAttribute(input, 'data-capture-epoch'),
        continuityEpoch: numberAttribute(input, 'data-continuity-epoch'),
        graphGeneration: numberAttribute(input, 'data-graph-generation'),
        trackedMidi: numberAttribute(meter, 'data-live-midi'),
        detectorDetail: frameDetail?.textContent?.trim() || null,
        heldSeconds: numberAttribute(input, 'data-held-seconds'),
        nextEnabled: Boolean(nextButton && !nextButton.disabled),
        result: document.querySelector('.range-result-next b')?.textContent?.trim() || null,
      };
      const { at: _at, cause: _cause, ...stableFields } = snapshot;
      const signature = JSON.stringify(stableFields);
      if (signature === lastSignature) return;
      lastSignature = signature;
      proof.snapshots.push(snapshot);
      if (proof.snapshots.length > 8192) proof.snapshots.shift();
    } catch (error) {
      proof.instrumentationErrors.push(String(error));
    }
  };
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const label = button?.textContent?.trim();
    if (label === 'Start Range Loop' || label === 'Next target') {
      proof.actions.push({ at: performance.now(), label });
      queueMicrotask(() => record('action:' + label));
    }
  }, true);
  const observer = new MutationObserver(() => record('mutation'));
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'data-note-input', 'data-input-state', 'data-detected-note',
      'data-observation-kind', 'data-start-sample', 'data-end-sample',
      'data-capture-epoch', 'data-continuity-epoch', 'data-graph-generation',
      'data-live-midi', 'data-held-seconds', 'data-range-loop-phase', 'disabled',
    ],
  });
  const timer = setInterval(() => record('poll'), 40);
  Object.defineProperty(window, '__noteforgeNoisyRangeProof', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      snapshot: () => JSON.parse(JSON.stringify(proof)),
      stop: () => clearInterval(timer),
    }),
  });
})();`;
