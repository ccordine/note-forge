import { once } from "node:events";
import { createServer } from "node:net";

export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function availablePort() {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "Could not reserve a local test port.");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

export function captureProcessOutput(child, label) {
  const lines = [];
  const append = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      lines.push(`[${label}] ${line}`);
      if (lines.length > 80) lines.shift();
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return lines;
}

export async function stopProcessGroup(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => undefined);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
  await Promise.race([exited, delay(1_000)]);
}

export async function waitForHttp(url, child, timeoutMilliseconds, output) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Process exited before ${url} became ready.\n${output.join("\n")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}\n${output.join("\n")}`);
}

export async function waitForPageTarget(debugPort, chromium, output) {
  const deadline = Date.now() + 12_000;
  let lastError = "DevTools endpoint unavailable";
  while (Date.now() < deadline) {
    if (chromium.exitCode !== null || chromium.signalCode !== null) {
      throw new Error(`Chromium exited before DevTools became ready.\n${output.join("\n")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) return page;
        lastError = "no page target";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Chromium DevTools: ${lastError}\n${output.join("\n")}`);
}

export class DevToolsSession {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(webSocketUrl);
  }

  async connect() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await Promise.race([
      new Promise((resolveConnection, rejectConnection) => {
        this.socket.addEventListener("open", resolveConnection, { once: true });
        this.socket.addEventListener("error", rejectConnection, { once: true });
      }),
      delay(5_000).then(() => { throw new Error("Timed out connecting to Chromium DevTools."); }),
    ]);
    this.socket.addEventListener("message", (event) => this.receive(event.data));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Chromium DevTools disconnected."));
      this.pending.clear();
    });
  }

  receive(data) {
    const message = JSON.parse(String(data));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}); } catch { /* a proof assertion handles collected data later */ }
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`Timed out waiting for DevTools command ${method}.`));
      }, 8_000);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolveCommand(value); },
        reject: (error) => { clearTimeout(timer); rejectCommand(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

export async function evaluate(session, expression, awaitPromise = false) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || `Browser evaluation failed: ${expression}`);
  }
  return result.result?.value;
}

export async function waitForBrowser(
  session,
  expression,
  description,
  timeoutMilliseconds = 10_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await evaluate(session, expression)) return;
    await delay(100);
  }
  const body = await evaluate(session, "document.body?.innerText?.slice(0, 4000) || ''");
  throw new Error(`Timed out waiting for ${description}.\nRendered page:\n${body}`);
}

/** Exercise the same visible consent control a user uses before collecting remote diagnostics. */
export async function enableRemotePitchDiagnostics(session) {
  const opened = await evaluate(session, `(() => {
    const button = document.querySelector('[data-settings-open]');
    button?.click();
    return Boolean(button);
  })()`);
  if (!opened) throw new Error("The visible Settings control was unavailable for diagnostic opt-in.");
  await waitForBrowser(
    session,
    "Boolean(document.querySelector('[data-remote-pitch-diagnostics-toggle]'))",
    "the remote derived-diagnostic consent control",
  );
  const enabled = await evaluate(session, `(() => {
    const control = document.querySelector('[data-remote-pitch-diagnostics-toggle]');
    if (!(control instanceof HTMLInputElement)) return false;
    if (!control.checked) control.click();
    return control.checked;
  })()`);
  if (!enabled) throw new Error("Remote derived diagnostics were not explicitly enabled.");
  await evaluate(session, `(() => {
    document.querySelector('button[aria-label="Close settings"]')?.click();
    return true;
  })()`);
  await waitForBrowser(
    session,
    "!document.querySelector('[data-remote-pitch-diagnostics-toggle]')",
    "the diagnostic consent dialog to close",
  );
}
