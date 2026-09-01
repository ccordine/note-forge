import {
  assert,
  delay,
  evaluate,
  waitForBrowser,
} from "./devtools-runtime.mjs";

export const ROOT = "[data-tone-map-root]";
export const TRIAL = "[data-tone-map-trial]";
export const KEYBOARD_VIEWPORT = "[data-piano-keyboard-viewport=true]";
export const TOGGLE = "[data-note-playback-toggle=true]";

export function describe(value) {
  return JSON.stringify(value, null, 2);
}

async function clickPreparedPoint(session, point, description) {
  assert(point && !point.error, `${description} is unavailable: ${describe(point)}`);
  assert(!point.disabled, `${description} is disabled.`);
  assert(point.hit, `${description} is clipped or covered: ${describe(point)}`);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
}

export async function clickSelector(session, selector, description = selector) {
  const point = await evaluate(session, `(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: 'missing element' };
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: Boolean(element.disabled),
      error: rect.width <= 0 || rect.height <= 0 ? 'zero-sized element' : null,
      hit: Boolean(hit && (hit === element || element.contains(hit))),
      x, y, rect: rect.toJSON(),
    };
  })()`, true);
  await clickPreparedPoint(session, point, description);
}

export async function clickRadio(session, label, option) {
  const point = await evaluate(session, `(async () => {
    const group = [...document.querySelectorAll('[role=radiogroup]')]
      .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
    const element = group && [...group.querySelectorAll('[role=radio]')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(option)});
    if (!(element instanceof HTMLElement)) return { error: 'missing radio' };
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: Boolean(element.disabled),
      error: rect.width <= 0 || rect.height <= 0 ? 'zero-sized element' : null,
      hit: Boolean(hit && (hit === element || element.contains(hit))),
      x, y,
    };
  })()`, true);
  await clickPreparedPoint(session, point, `${label}: ${option}`);
}

export async function clickMidi(session, midi) {
  const point = await evaluate(session, `(async () => {
    const viewport = document.querySelector(${JSON.stringify(KEYBOARD_VIEWPORT)});
    const key = viewport?.querySelector('[data-midi="${midi}"]');
    if (!(viewport instanceof HTMLElement) || !(key instanceof HTMLButtonElement)) {
      return { error: 'missing keyboard key' };
    }
    viewport.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const keyCenter = key.offsetLeft + key.offsetWidth / 2;
    viewport.scrollLeft = Math.max(0, Math.min(maximum, keyCenter - viewport.clientWidth / 2));
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const rect = key.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: key.disabled,
      error: rect.width <= 0 || rect.height <= 0 ? 'zero-sized key' : null,
      hit: Boolean(hit && (hit === key || key.contains(hit))),
      x, y, scrollLeft: viewport.scrollLeft,
    };
  })()`, true);
  await clickPreparedPoint(session, point, `piano key MIDI ${midi}`);
  return point;
}

export async function inspectLayout(session) {
  return evaluate(session, `(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.body.style.scrollBehavior = 'auto';
    const scrollRoot = document.scrollingElement ?? document.documentElement;
    const viewport = document.querySelector(${JSON.stringify(KEYBOARD_VIEWPORT)});
    const initial = {
      rootScrollLeft: scrollRoot.scrollLeft,
      bodyScrollLeft: document.body.scrollLeft,
      keyboardScrollLeft: viewport?.scrollLeft ?? null,
    };
    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, left: 0, behavior: 'instant' });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const maximumY = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    const reachedBottom = Math.abs(scrollRoot.scrollTop - maximumY) <= 2;
    scrollRoot.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        maximumY,
        reachedBottom,
      },
      initial,
      keyboard: viewport ? {
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        maximumX: viewport.scrollWidth - viewport.clientWidth,
      } : null,
    };
  })()`, true);
}

export async function proveKeyboardScrolling(session) {
  return evaluate(session, `(async () => {
    const viewport = document.querySelector(${JSON.stringify(KEYBOARD_VIEWPORT)});
    const root = document.scrollingElement ?? document.documentElement;
    if (!(viewport instanceof HTMLElement)) return { error: 'missing keyboard viewport' };
    viewport.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    const maximum = viewport.scrollWidth - viewport.clientWidth;
    const probes = [
      { midi: 21, scrollLeft: 0 },
      { midi: 64, scrollLeft: maximum / 2 },
      { midi: 108, scrollLeft: maximum },
    ];
    const results = [];
    for (const probe of probes) {
      viewport.scrollLeft = probe.scrollLeft;
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      const key = viewport.querySelector('[data-midi="' + probe.midi + '"]');
      if (!(key instanceof HTMLButtonElement)) return { error: 'missing MIDI ' + probe.midi };
      const rect = key.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      results.push({
        midi: probe.midi,
        requested: probe.scrollLeft,
        actual: viewport.scrollLeft,
        hit: Boolean(hit && (hit === key || key.contains(hit))),
        rect: rect.toJSON(),
        documentScrollLeft: root.scrollLeft,
        bodyScrollLeft: document.body.scrollLeft,
      });
    }
    viewport.scrollLeft = 0;
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    return { maximum, results, restored: viewport.scrollLeft };
  })()`, true);
}

export async function inspectHiddenAnswer(session) {
  return evaluate(session, `(() => {
    const trial = document.querySelector(${JSON.stringify(TRIAL)});
    const keyboard = trial?.querySelector('.piano-keyboard');
    const viewport = trial?.querySelector(${JSON.stringify(KEYBOARD_VIEWPORT)});
    return {
      cue: trial?.getAttribute('data-cue-visibility') ?? null,
      skill: trial?.getAttribute('data-response-skill') ?? null,
      keys: keyboard?.querySelectorAll('[data-midi]').length ?? 0,
      labels: keyboard?.querySelectorAll('.piano-keyboard__label').length ?? 0,
      markers: keyboard?.querySelectorAll('[data-marker-role]').length ?? 0,
      targetAttributes: keyboard?.querySelectorAll('[data-target-midi],[data-tone-map-target-midi]').length ?? 0,
      review: document.querySelectorAll('[data-tone-map-review]').length,
      guidedLabel: document.querySelector('[data-tone-map-guided-label] strong')?.textContent?.trim() ?? null,
      scrollLeft: viewport?.scrollLeft ?? null,
    };
  })()`);
}

export function assertHiddenAnswer(hidden, description) {
  assert(hidden.keys === 88, `${description}: expected 88 physical piano keys: ${describe(hidden)}`);
  assert(hidden.labels === 88 && hidden.markers === 0 && hidden.targetAttributes === 0,
    `${description}: a target identity leaked into the answer keyboard: ${describe(hidden)}`);
  assert(hidden.guidedLabel === null,
    `${description}: the prompt named its hidden target: ${describe(hidden)}`);
  assert(hidden.review === 0, `${description}: review rendered before commitment: ${describe(hidden)}`);
  assert(hidden.skill === "identification", `${description}: expected keyboard identification: ${describe(hidden)}`);
}

export async function promptMidi(session) {
  const prompt = await evaluate(session, `(() => {
    const proof = window.__noteforgeToneMapVoiceProof?.snapshot();
    const events = proof?.productionOscillatorEvents ?? [];
    const event = events.at(-1) ?? null;
    return {
      pressed: document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed'),
      frequencyHz: event?.frequencyHz ?? proof?.productionOscillatorFrequencies?.at(-1) ?? null,
      eventOrdinal: events.length,
    };
  })()`);
  const midiFloat = prompt.frequencyHz === null
    ? null
    : 69 + 12 * Math.log2(prompt.frequencyHz / 440);
  const midi = midiFloat === null ? null : Math.round(midiFloat);
  assert(prompt.pressed === "true" && Number.isInteger(midi)
    && Math.abs(midiFloat - midi) < 0.001 && midi >= 21 && midi <= 108,
  `The audible prompt did not resolve to one piano MIDI: ${describe({ ...prompt, midiFloat, midi })}`);
  return { ...prompt, midi };
}

export async function answerAudiblePrompt(session) {
  const prompt = await promptMidi(session);
  await clickMidi(session, prompt.midi);
  await waitForBrowser(session, "Boolean(document.querySelector('[data-tone-map-review]'))", "prompt answer review");
  const review = await evaluate(session, `(() => {
    const root = document.querySelector('[data-tone-map-review]');
    return {
      target: Number(root?.getAttribute('data-tone-map-target-midi')),
      correct: root?.classList.contains('correct') ?? false,
      labels: document.querySelectorAll(${JSON.stringify(`${KEYBOARD_VIEWPORT} .piano-keyboard__label`)}).length,
      roles: [...document.querySelectorAll(${JSON.stringify(`${KEYBOARD_VIEWPORT} [data-marker-role]`)})]
        .map((marker) => marker.getAttribute('data-marker-role')),
    };
  })()`);
  assert(review.correct && review.target === prompt.midi,
    `The audible prompt did not commit through its matching labeled key: ${describe({ prompt, review })}`);
  assert(review.labels === 88 && review.roles.includes("guess") && review.roles.includes("target"),
    `Correct review omitted labeled-key or answer/target evidence: ${describe(review)}`);
  return { ...prompt, review };
}

export async function nextTrial(session) {
  await clickSelector(session, "[data-tone-map-review] .action-button", "Next randomized tone");
  await waitForBrowser(session, "!document.querySelector('[data-tone-map-review]')", "next randomized tone");
  await evaluate(session, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
}
