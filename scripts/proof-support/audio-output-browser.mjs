import {
  delay,
  evaluate,
} from "./devtools-runtime.mjs";

export const OUTPUT_DEVICE_ID = "noteforge-proof-usb-output";
export const OUTPUT_DEVICE_LABEL = "USB Studio Headphones";
export const REJECT_OUTPUT_STORAGE_KEY = "__noteforgeOutputProofRejectSinkId";

export const AUDIO_OUTPUT_INSTRUMENTATION_SOURCE = `(() => {
  const OUTPUT_DEVICE_ID = 'noteforge-proof-usb-output';
  const OUTPUT_DEVICE_LABEL = 'USB Studio Headphones';
  const REJECT_OUTPUT_STORAGE_KEY = '__noteforgeOutputProofRejectSinkId';
  const proof = {
    contexts: [],
    chooserCalls: [],
    sinkCalls: [],
    getUserMediaCalls: [],
    sources: [],
    worklets: [],
    trackStops: [],
    instrumentationErrors: [],
  };
  const contextIds = new WeakMap();
  const contextReferences = new Map();
  let nextContextId = 1;

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
        request.onsuccess = () => resolve(request.result ?? null);
      });
    } finally {
      database.close();
    }
  };

  const snapshot = () => JSON.parse(JSON.stringify({
    ...proof,
    contexts: proof.contexts.map((context) => ({
      ...context,
      state: contextReferences.get(context.id)?.state ?? null,
    })),
  }));
  Object.defineProperty(window, '__noteforgeAudioOutputProof', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ snapshot, readMonitoringSetting }),
  });

  const NativeAudioContext = window.AudioContext;
  if (typeof NativeAudioContext !== 'function') {
    proof.instrumentationErrors.push('AudioContext unavailable');
    return;
  }

  try {
    const nativeCreateMediaStreamSource = NativeAudioContext.prototype.createMediaStreamSource;
    Object.defineProperty(NativeAudioContext.prototype, 'createMediaStreamSource', {
      configurable: true,
      writable: true,
      value(stream) {
        proof.sources.push({
          contextId: contextIds.get(this) ?? null,
          trackCount: stream.getAudioTracks().length,
        });
        return Reflect.apply(nativeCreateMediaStreamSource, this, [stream]);
      },
    });

    Object.defineProperty(NativeAudioContext.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      async value(sinkId) {
        const rejected = localStorage.getItem(REJECT_OUTPUT_STORAGE_KEY) === String(sinkId);
        proof.sinkCalls.push({
          contextId: contextIds.get(this) ?? null,
          sinkId: String(sinkId),
          rejected,
          state: this.state,
        });
        if (rejected) throw new DOMException('The selected output is unavailable.', 'NotFoundError');
      },
    });

    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(target, args) {
        const context = Reflect.construct(target, args, target);
        const id = nextContextId++;
        contextIds.set(context, id);
        contextReferences.set(id, context);
        proof.contexts.push({
          id,
          options: args[0] ?? null,
          sampleRate: context.sampleRate,
        });
        return context;
      },
    });
  } catch (error) {
    proof.instrumentationErrors.push('AudioContext instrumentation: ' + String(error));
  }

  const NativeAudioWorkletNode = window.AudioWorkletNode;
  if (typeof NativeAudioWorkletNode !== 'function') {
    proof.instrumentationErrors.push('AudioWorkletNode unavailable');
  } else {
    try {
      window.AudioWorkletNode = new Proxy(NativeAudioWorkletNode, {
        construct(target, args) {
          const node = Reflect.construct(target, args, target);
          proof.worklets.push({
            contextId: contextIds.get(args[0]) ?? null,
            name: String(args[1] ?? ''),
          });
          return node;
        },
      });
    } catch (error) {
      proof.instrumentationErrors.push('AudioWorklet instrumentation: ' + String(error));
    }
  }

  const devices = navigator.mediaDevices;
  if (!devices) {
    proof.instrumentationErrors.push('MediaDevices unavailable');
    return;
  }
  try {
    const nativeGetUserMedia = devices.getUserMedia.bind(devices);
    Object.defineProperty(devices, 'getUserMedia', {
      configurable: true,
      writable: true,
      async value(constraints) {
        proof.getUserMediaCalls.push(constraints);
        const stream = await nativeGetUserMedia(constraints);
        for (const track of stream.getAudioTracks()) {
          const nativeStop = track.stop.bind(track);
          Object.defineProperty(track, 'stop', {
            configurable: true,
            value() {
              proof.trackStops.push({ kind: track.kind, readyState: track.readyState });
              return nativeStop();
            },
          });
        }
        return stream;
      },
    });
    Object.defineProperty(devices, 'selectAudioOutput', {
      configurable: true,
      writable: true,
      async value() {
        proof.chooserCalls.push({ at: performance.now() });
        return {
          deviceId: OUTPUT_DEVICE_ID,
          groupId: 'noteforge-proof-output-group',
          kind: 'audiooutput',
          label: OUTPUT_DEVICE_LABEL,
          toJSON() {
            return {
              deviceId: this.deviceId,
              groupId: this.groupId,
              kind: this.kind,
              label: this.label,
            };
          },
        };
      },
    });
  } catch (error) {
    proof.instrumentationErrors.push('MediaDevices instrumentation: ' + String(error));
  }
})();`;

export async function outputProofSnapshot(session) {
  return evaluate(session, "window.__noteforgeAudioOutputProof.snapshot()");
}

export async function readAudioMonitoringRecord(session) {
  return evaluate(
    session,
    "window.__noteforgeAudioOutputProof.readMonitoringSetting()",
    true,
  );
}

export async function waitForStoredPreferredOutput(
  session,
  preferredOutput,
  timeoutMilliseconds = 8_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readAudioMonitoringRecord(session);
    const stored = latest?.value?.preferredOutput;
    const matches = preferredOutput === null
      ? stored === null
      : stored?.deviceId === preferredOutput.deviceId
        && stored?.label === preferredOutput.label;
    if (latest?.key === "audio.monitoring"
      && latest.value?.version === 2
      && matches) return latest;
    await delay(80);
  }
  throw new Error(
    `audio.monitoring did not persist preferredOutput=${JSON.stringify(preferredOutput)}; `
      + `saw ${JSON.stringify(latest)}.`,
  );
}

export async function inspectOutputSettings(session) {
  return evaluate(session, `(() => {
    const label = document.querySelector('[data-audio-output-label]');
    const chooser = document.querySelector('[data-audio-output-select]');
    const error = document.querySelector('.audio-output-error[role="alert"]');
    return {
      label: label?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null,
      chooser: chooser instanceof HTMLButtonElement
        ? { text: chooser.textContent?.trim() ?? '', disabled: chooser.disabled }
        : null,
      error: error?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null,
    };
  })()`);
}

export async function rejectSavedOutputAfterReload(session, sinkId) {
  return evaluate(
    session,
    `localStorage.setItem(${JSON.stringify(REJECT_OUTPUT_STORAGE_KEY)}, ${JSON.stringify(sinkId)}); true`,
  );
}
