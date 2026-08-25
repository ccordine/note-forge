import {
  assert,
  delay,
  evaluate,
  waitForBrowser,
} from "./devtools-runtime.mjs";
import { clickHitTested } from "./monitoring-browser.mjs";

export const SETTINGS_TOLERANCE_SELECTOR = "[data-settings-tolerance]";

export const SETTINGS_ACCEPTANCE_INSTRUMENTATION_SOURCE = `(() => {
  const readSettings = async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noteforge', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('settings', 'readonly');
        const request = transaction.objectStore('settings').getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    } finally {
      database.close();
    }
  };
  Object.defineProperty(window, '__noteforgeSettingsAcceptanceProof', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ readSettings }),
  });
})();`;

export async function openSettings(session, description = "Settings") {
  // The mobile shell hides/reveals its sticky action row as the document
  // scrolls. Return to its user-visible resting position before hit-testing
  // the global Settings control.
  await evaluate(session, `(async () => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return window.scrollY;
  })()`, true);
  await clickHitTested(session, "[data-settings-open]", description);
  await waitForBrowser(
    session,
    `Boolean(document.querySelector(${JSON.stringify(SETTINGS_TOLERANCE_SELECTOR)}))`,
    `${description} tolerance control`,
  );
}

export async function closeSettings(session, description = "Settings") {
  await clickHitTested(
    session,
    'button[aria-label="Close settings"]',
    `${description} close`,
  );
  await waitForBrowser(
    session,
    "!document.querySelector('.settings-drawer')",
    `${description} dismissal`,
  );
}

export async function waitForPreferenceState(session, state = "saved") {
  await waitForBrowser(
    session,
    `document.querySelector('.settings-drawer')?.getAttribute('data-settings-persistence') === ${JSON.stringify(state)}`,
    `global preferences persistence state ${state}`,
  );
}

export async function readToleranceControl(session) {
  return evaluate(session, `(async () => {
    const input = document.querySelector(${JSON.stringify(SETTINGS_TOLERANCE_SELECTOR)});
    if (!(input instanceof HTMLInputElement)) return null;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const label = input.closest('label');
    const rectangle = input.getBoundingClientRect();
    return {
      value: input.value,
      disabled: input.disabled,
      label: label?.innerText.replace(/\\s+/gu, ' ').trim() ?? '',
      rectangle: rectangle.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`, true);
}

export async function setVisibleTolerance(session, cents) {
  const result = await evaluate(session, `(async () => {
    const input = document.querySelector(${JSON.stringify(SETTINGS_TOLERANCE_SELECTOR)});
    if (!(input instanceof HTMLInputElement)) return { error: 'missing' };
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rectangle = input.getBoundingClientRect();
    const x = rectangle.left + rectangle.width / 2;
    const y = rectangle.top + rectangle.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === input || input.contains(hit))) {
      return { error: 'not-hit-testable', rectangle: rectangle.toJSON(), hit: hit?.tagName ?? null };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return { error: 'native-value-setter-missing' };
    setter.call(input, ${JSON.stringify(String(cents))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { error: null, value: input.value, rectangle: rectangle.toJSON() };
  })()`, true);
  assert(!result?.error && result.value === String(cents),
    `Could not operate the visible acceptance-tolerance control: ${JSON.stringify(result)}.`);
  await waitForBrowser(
    session,
    `document.querySelector(${JSON.stringify(SETTINGS_TOLERANCE_SELECTOR)})?.value === ${JSON.stringify(String(cents))}`,
    `visible acceptance tolerance ${cents}`,
  );
}

export async function readUserPreferencesRecord(session) {
  const records = await evaluate(
    session,
    "window.__noteforgeSettingsAcceptanceProof.readSettings()",
    true,
  );
  return records.find((record) => record?.key === "user.preferences") ?? null;
}

export async function waitForStoredTolerance(session, cents, timeoutMilliseconds = 8_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readUserPreferencesRecord(session);
    if (latest?.value?.version === 1 && latest.value.toleranceCents === cents) return latest;
    await delay(80);
  }
  throw new Error(
    `user.preferences did not persist toleranceCents=${cents}; saw ${JSON.stringify(latest)}.`,
  );
}

export async function setGeneratedMicrophone(session, midi, cents, amplitude = 0.16) {
  return evaluate(
    session,
    `window.__noteforgeToneMapVoiceProof.setMidi(${JSON.stringify(midi)}, ${JSON.stringify(cents)}, ${JSON.stringify(amplitude)})`,
    true,
  );
}

export async function generatedMicrophoneSnapshot(session) {
  return evaluate(session, "window.__noteforgeToneMapVoiceProof.snapshot()");
}

export async function waitForGeneratedWindows(
  session,
  before,
  count,
  description,
) {
  await waitForBrowser(
    session,
    `window.__noteforgeToneMapVoiceProof.snapshot().workletSampleEvents.length >= ${before + count}`,
    description,
    8_000,
  );
}
