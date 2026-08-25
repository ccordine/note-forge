import {
  assert,
  delay,
  evaluate,
  waitForBrowser,
} from "./devtools-runtime.mjs";

export const MONITORING_INSTRUMENTATION_SOURCE = `(() => {
  const proof = {
    productionContexts: [],
    getUserMediaCalls: [], streams: 0, tracks: 0, sourceTrackMatches: 0,
    nodes: [], edges: [], disconnects: [], gainEvents: [],
    contextLatencyReads: [],
    workletModules: [], workletNodes: 0, workletSamples: [],
    trackSettings: [], trackEnabledWrites: [], trackStops: [],
    contextSuspends: 0, contextCloses: 0,
    instrumentationErrors: [],
  };
  const NativeAudioContext = window.AudioContext;
  const productionContexts = new WeakSet();
  const contextIds = new WeakMap();
  const nodeMetadata = new WeakMap();
  const nodeReferences = new Map();
  const knownTracks = new WeakSet();
  let nextContextId = 1;
  let nextNodeId = 1;

  const serializable = (value) => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
  };
  const nativePropertyReader = (object, name) => {
    let owner = object;
    while (owner) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor?.get) return () => descriptor.get.call(object);
      if (descriptor && 'value' in descriptor) return () => descriptor.value;
      owner = Object.getPrototypeOf(owner);
    }
    return () => undefined;
  };
  const registerNode = (node, kind, context) => {
    if (!node || !productionContexts.has(context)) return null;
    const existing = nodeMetadata.get(node);
    if (existing) return existing;
    const metadata = { id: nextNodeId++, kind, contextId: contextIds.get(context) ?? null };
    nodeMetadata.set(node, metadata);
    nodeReferences.set(metadata.id, node);
    proof.nodes.push(metadata);
    return metadata;
  };
  const instrumentGain = (gain, context) => {
    const metadata = registerNode(gain, 'gain', context);
    if (!metadata) return;
    for (const method of [
      'cancelAndHoldAtTime', 'cancelScheduledValues', 'setValueAtTime',
      'linearRampToValueAtTime', 'exponentialRampToValueAtTime',
    ]) {
      if (typeof gain.gain[method] !== 'function') continue;
      const nativeMethod = gain.gain[method].bind(gain.gain);
      try {
        gain.gain[method] = (...args) => {
          proof.gainEvents.push({
            nodeId: metadata.id, method, at: performance.now(),
            contextTime: context.currentTime,
            value: method.startsWith('cancel') ? null : args[0],
            when: method.startsWith('cancel') ? args[0] : args[1],
          });
          return nativeMethod(...args);
        };
      } catch (error) {
        proof.instrumentationErrors.push('gain.' + method + ': ' + String(error));
      }
    }
  };
  const snapshot = () => JSON.parse(JSON.stringify({
    ...proof,
    nodes: proof.nodes.map((metadata) => {
      const node = nodeReferences.get(metadata.id);
      return {
        ...metadata,
        gain: metadata.kind === 'gain' ? node?.gain?.value ?? null : null,
      };
    }),
    productionContexts: proof.productionContexts.map((item) => ({
      ...item,
      state: item.reference.state,
      sampleRate: item.reference.sampleRate,
      baseLatency: Number.isFinite(item.readBaseLatency()) ? item.readBaseLatency() : null,
      outputLatency: Number.isFinite(item.readOutputLatency()) ? item.readOutputLatency() : null,
      reference: undefined,
      readBaseLatency: undefined,
      readOutputLatency: undefined,
    })),
  }));
  const readMonitoringSetting = async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noteforge', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('settings', 'readonly');
        const request = transaction.objectStore('settings').get('audio.monitoring');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result?.value ?? null);
      });
    } finally { database.close(); }
  };
  Object.defineProperty(window, '__noteforgeMonitoringProof', {
    configurable: false, enumerable: false, writable: false,
    value: Object.freeze({ snapshot, readMonitoringSetting }),
  });

  if (typeof NativeAudioContext !== 'function') {
    proof.instrumentationErrors.push('AudioContext unavailable');
    return;
  }
  try {
    const devices = navigator.mediaDevices;
    if (devices && typeof devices.selectAudioOutput === 'function') {
      Object.defineProperty(devices, 'selectAudioOutput', { configurable: true, value: undefined });
    }
    const sinkDescriptor = Object.getOwnPropertyDescriptor(NativeAudioContext.prototype, 'setSinkId');
    if (sinkDescriptor?.configurable) {
      Object.defineProperty(NativeAudioContext.prototype, 'setSinkId', { configurable: true, value: undefined });
    }
  } catch (error) {
    proof.instrumentationErrors.push('output fallback instrumentation: ' + String(error));
  }

  const audioNodePrototype = window.AudioNode?.prototype;
  const nativeConnect = audioNodePrototype?.connect;
  const nativeDisconnect = audioNodePrototype?.disconnect;
  if (typeof nativeConnect !== 'function' || typeof nativeDisconnect !== 'function') {
    proof.instrumentationErrors.push('AudioNode graph instrumentation unavailable');
  } else {
    Object.defineProperty(audioNodePrototype, 'connect', {
      configurable: true, writable: true,
      value(destination, ...args) {
        const source = nodeMetadata.get(this);
        const target = nodeMetadata.get(destination);
        if (source && target) proof.edges.push({ from: source.id, to: target.id, args, at: performance.now() });
        return Reflect.apply(nativeConnect, this, [destination, ...args]);
      },
    });
    Object.defineProperty(audioNodePrototype, 'disconnect', {
      configurable: true, writable: true,
      value(...args) {
        const source = nodeMetadata.get(this);
        const target = args[0] && nodeMetadata.get(args[0]);
        if (source) proof.disconnects.push({ from: source.id, to: target?.id ?? null, at: performance.now() });
        return Reflect.apply(nativeDisconnect, this, args);
      },
    });
  }

  window.AudioContext = new Proxy(NativeAudioContext, {
    construct(target, args) {
      const context = Reflect.construct(target, args, target);
      const id = nextContextId++;
      const readBaseLatency = nativePropertyReader(context, 'baseLatency');
      const readOutputLatency = nativePropertyReader(context, 'outputLatency');
      for (const [name, read] of [
        ['baseLatency', readBaseLatency],
        ['outputLatency', readOutputLatency],
      ]) {
        try {
          Object.defineProperty(context, name, {
            configurable: true,
            get() {
              const value = read();
              proof.contextLatencyReads.push({ contextId: id, name, value, at: performance.now() });
              return value;
            },
          });
        } catch (error) {
          proof.instrumentationErrors.push(name + ' instrumentation: ' + String(error));
        }
      }
      productionContexts.add(context);
      contextIds.set(context, id);
      proof.productionContexts.push({
        id, options: serializable(args[0] ?? {}), reference: context,
        readBaseLatency, readOutputLatency,
      });
      registerNode(context.destination, 'destination', context);
      const nativeGain = context.createGain.bind(context);
      context.createGain = (...gainArgs) => {
        const gain = nativeGain(...gainArgs);
        instrumentGain(gain, context);
        return gain;
      };
      const nativeSource = context.createMediaStreamSource.bind(context);
      context.createMediaStreamSource = (stream) => {
        const source = nativeSource(stream);
        registerNode(source, 'media-stream-source', context);
        const tracks = stream.getAudioTracks();
        if (tracks.length === 1 && knownTracks.has(tracks[0])) proof.sourceTrackMatches += 1;
        return source;
      };
      const nativeSuspend = context.suspend.bind(context);
      context.suspend = () => { proof.contextSuspends += 1; return nativeSuspend(); };
      const nativeClose = context.close.bind(context);
      context.close = () => { proof.contextCloses += 1; return nativeClose(); };
      return context;
    },
  });

  const nativeAddModule = window.AudioWorklet?.prototype?.addModule;
  if (typeof nativeAddModule === 'function') {
    Object.defineProperty(window.AudioWorklet.prototype, 'addModule', {
      configurable: true, writable: true,
      value(url, ...args) {
        proof.workletModules.push(new URL(String(url), document.baseURI).href);
        return Reflect.apply(nativeAddModule, this, [url, ...args]);
      },
    });
  }
  const NativeWorkletNode = window.AudioWorkletNode;
  if (typeof NativeWorkletNode === 'function') {
    window.AudioWorkletNode = new Proxy(NativeWorkletNode, {
      construct(target, args) {
        const node = Reflect.construct(target, args, target);
        const metadata = registerNode(node, 'audio-worklet', args[0]);
        if (metadata) {
          proof.workletNodes += 1;
          node.port.addEventListener('message', (event) => {
            if (event.data?.type !== 'samples') return;
            proof.workletSamples.push({
              at: performance.now(), startSample: event.data.startSample,
              endSample: event.data.endSample, captureEpoch: event.data.captureEpoch,
              continuityEpoch: event.data.continuityEpoch,
              graphGeneration: event.data.graphGeneration,
              processedSampleCount: event.data.processedSampleCount,
            });
          });
        }
        return node;
      },
    });
  }

  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) {
    proof.instrumentationErrors.push('getUserMedia unavailable');
    return;
  }
  const nativeGetUserMedia = devices.getUserMedia.bind(devices);
  Object.defineProperty(devices, 'getUserMedia', {
    configurable: true,
    value: async (constraints) => {
      proof.getUserMediaCalls.push(serializable(constraints));
      const stream = await nativeGetUserMedia(constraints);
      const track = stream.getAudioTracks()[0];
      proof.streams += 1;
      proof.tracks += 1;
      knownTracks.add(track);
      proof.trackSettings.push(serializable(track.getSettings()));
      let prototype = track;
      let enabledDescriptor;
      while (prototype && !enabledDescriptor) {
        prototype = Object.getPrototypeOf(prototype);
        enabledDescriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'enabled');
      }
      if (enabledDescriptor?.get && enabledDescriptor?.set) {
        Object.defineProperty(track, 'enabled', {
          configurable: true, enumerable: enabledDescriptor.enumerable,
          get() { return enabledDescriptor.get.call(track); },
          set(value) {
            proof.trackEnabledWrites.push(Boolean(value));
            return enabledDescriptor.set.call(track, value);
          },
        });
      }
      const nativeStop = track.stop.bind(track);
      Object.defineProperty(track, 'stop', {
        configurable: true,
        value() { proof.trackStops.push({ at: performance.now(), readyState: track.readyState }); return nativeStop(); },
      });
      return stream;
    },
  });
})();`;

export async function proofSnapshot(session) {
  return evaluate(session, "window.__noteforgeMonitoringProof.snapshot()");
}

export async function monitoringSetting(session) {
  return evaluate(
    session,
    "window.__noteforgeMonitoringProof.readMonitoringSetting()",
    true,
  );
}

export async function waitForMonitoringSetting(session, expected) {
  const deadline = Date.now() + 5_000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await monitoringSetting(session);
    if (latest?.version === 2
      && latest.enabled === expected.enabled
      && latest.level === expected.level
      && (latest.preferredOutput === null || latest.preferredOutput === undefined)) return latest;
    await delay(80);
  }
  throw new Error(`Monitoring setting did not persist ${JSON.stringify(expected)}; saw ${JSON.stringify(latest)}.`);
}

export async function clickHitTested(session, selector, description) {
  const point = await evaluate(session, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: 'missing' };
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      error: rect.width <= 0 || rect.height <= 0 ? 'zero-size' : null,
      disabled: Boolean(element.disabled), hit: Boolean(hit && (hit === element || element.contains(hit))),
      x, y, rect: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  assert(!point?.error && !point.disabled && point.hit,
    `${description} was not reachable: ${JSON.stringify(point)}.`);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
}

export async function waitForWorkletAdvance(session, before, minimum = 18) {
  await waitForBrowser(
    session,
    `window.__noteforgeMonitoringProof.snapshot().workletSamples.length >= ${before + minimum}`,
    `${minimum} more production PCM windows`,
    8_000,
  );
}

export async function setRangeValue(session, selector, value) {
  const changed = await evaluate(session, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed, `Could not change ${selector} to ${value}.`);
}

export async function inspectMobileGlobalControls(session) {
  return evaluate(session, `(() => {
    const inspect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return { exists: false };
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        exists: true, disabled: Boolean(element.disabled), rect: rect.toJSON(),
        inBounds: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1,
        hit: Boolean(hit && (hit === element || element.contains(hit))),
        visibleText: element.innerText.replace(/\\s+/gu, ' ').trim(),
        hasIcon: Boolean(element.querySelector('svg')),
      };
    };
    return {
      width: innerWidth, height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      microphone: inspect('[data-global-mic-enable],[data-global-mic-disable]'),
      monitor: inspect('[data-global-monitor-toggle]'),
    };
  })()`);
}

export async function inspectSettingsReachability(session) {
  return evaluate(session, `(async () => {
    const drawer = document.querySelector('.settings-drawer');
    const diagnostics = document.querySelector('.audio-diagnostics');
    const entries = [
      ['close', document.querySelector('button[aria-label="Close settings"]')],
      ['monitor-toggle', document.querySelector('[data-settings-monitor-toggle]')],
      ['monitor-level', document.querySelector('[data-monitor-level]')],
      ['warning', document.querySelector('.monitor-warning')],
      ['diagnostics-summary', document.querySelector('.audio-diagnostics > summary')],
      ['diagnostics', diagnostics],
      ...[...document.querySelectorAll('.audio-device-row')].map((element, index) => ['audio-device-' + index, element]),
    ];
    const chooser = document.querySelector('[data-audio-output-select]');
    if (chooser) entries.push(['output-chooser', chooser]);
    const results = [];
    for (const [selector, element] of entries) {
      if (!(element instanceof HTMLElement)) { results.push({ selector, exists: false }); continue; }
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height / 2, 20)));
      const hit = document.elementFromPoint(x, y);
      results.push({ selector, exists: true, rect: rect.toJSON(), inBounds: rect.bottom > 0 && rect.top < innerHeight,
        hit: Boolean(hit && (hit === element || element.contains(hit))) });
    }
    return {
      drawer: drawer ? { overflowY: getComputedStyle(drawer).overflowY, scrollHeight: drawer.scrollHeight, clientHeight: drawer.clientHeight } : null,
      results,
      output: [...document.querySelectorAll('.audio-device-row')].at(-1)?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      hasOutputChooser: Boolean(document.querySelector('[data-audio-output-select]')),
      warning: document.querySelector('.monitor-warning')?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      diagnosticsText: diagnostics?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      diagnosticsRows: Object.fromEntries([...diagnostics?.querySelectorAll('dl > div') ?? []].map((row) => [
        row.querySelector('dt')?.textContent?.trim() ?? '',
        row.querySelector('dd')?.textContent?.trim() ?? '',
      ])),
    };
  })()`, true);
}
