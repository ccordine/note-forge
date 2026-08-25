import { frequencyToMidi, splitMidiPitch } from "@noteforge/music-core";
import { clamp } from "@/lib/numeric";
import { LIVE_DIAGNOSTIC_SIGNAL_BOUNDS } from "@/diagnostics/live-signal-contract";

const DATABASE_NAME = "noteforge";
const DATABASE_VERSION = 1;
const MAX_RECENT_ATTEMPTS = 100;
const MAX_ATTEMPT_PITCH_FRAMES = 2_048;
const MAX_SETTING_ENTRIES_PER_TRANSACTION = 64;
const MAX_STORAGE_KEY_LENGTH = 128;
const LOCAL_PITCH_MINIMUM_FREQUENCY_HZ =
  LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.detectorFrequencyHz.minimum;
const LOCAL_PITCH_MAXIMUM_FREQUENCY_HZ =
  LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.detectorFrequencyHz.maximum;
const LOCAL_PITCH_MINIMUM_MIDI = frequencyToMidi(LOCAL_PITCH_MINIMUM_FREQUENCY_HZ);
const LOCAL_PITCH_MAXIMUM_MIDI = frequencyToMidi(LOCAL_PITCH_MAXIMUM_FREQUENCY_HZ);
const LOCAL_PITCH_MINIMUM_NEAREST_MIDI = splitMidiPitch(LOCAL_PITCH_MINIMUM_MIDI).nearestMidi;
const LOCAL_PITCH_MAXIMUM_NEAREST_MIDI = splitMidiPitch(LOCAL_PITCH_MAXIMUM_MIDI).nearestMidi;

/** The derived contour fields that may be retained locally for an attempt. */
export interface LocalPitchFrame {
  timeSeconds: number;
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidi: number | null;
  centsFromNearest: number | null;
  rms: number;
  confidence: number;
  voiced: boolean;
}

export interface LocalAttempt {
  id: string;
  exerciseType: string;
  target: unknown;
  metrics: Record<string, number | undefined>;
  pitchFrames?: LocalPitchFrame[];
  startedAt: string;
  completedAt: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB !== "object") {
    return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  }

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const rejectOpening = (error: DOMException | Error | null, fallback: string) => {
      if (settled) return;
      settled = true;
      if (databasePromise === opening) databasePromise = null;
      reject(error ?? new Error(fallback));
    };

    request.onerror = () => rejectOpening(request.error, "Could not open the NoteForge database.");
    request.onblocked = () => rejectOpening(
      new Error("A different NoteForge tab is blocking the local database upgrade."),
      "The NoteForge database upgrade is blocked.",
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      if (!transaction) {
        rejectOpening(new Error("IndexedDB did not provide an upgrade transaction."), "Database upgrade failed.");
        return;
      }
      try {
        const attempts = database.objectStoreNames.contains("attempts")
          ? transaction.objectStore("attempts")
          : database.createObjectStore("attempts", { keyPath: "id" });
        if (!attempts.indexNames.contains("completedAt")) attempts.createIndex("completedAt", "completedAt");
        if (!attempts.indexNames.contains("exerciseType")) attempts.createIndex("exerciseType", "exerciseType");
        if (!database.objectStoreNames.contains("settings")) {
          database.createObjectStore("settings", { keyPath: "key" });
        }
      } catch (error) {
        try { transaction.abort(); } catch { /* It may already be aborting. */ }
        rejectOpening(error instanceof Error ? error : null, "Database upgrade failed.");
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => {
        database.close();
        if (databasePromise === opening) databasePromise = null;
      };
      database.onclose = () => {
        if (databasePromise === opening) databasePromise = null;
      };
      resolve(database);
    };
  });
  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = null;
  });
  return opening;
}

async function transact<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let request: IDBRequest<T>;
    const rejectTransaction = (error: DOMException | Error | null, fallback: string) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error(fallback));
    };

    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(storeName, mode);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(request.result);
      };
      transaction.onerror = () => rejectTransaction(
        transaction.error,
        `The ${storeName} transaction failed.`,
      );
      transaction.onabort = () => rejectTransaction(
        transaction.error,
        `The ${storeName} transaction was aborted.`,
      );
      request = action(transaction.objectStore(storeName));
      request.onerror = () => rejectTransaction(request.error, `The ${storeName} request failed.`);
    } catch (error) {
      rejectTransaction(error instanceof Error ? error : null, `Could not start the ${storeName} transaction.`);
    }
  });
}

async function writeTransaction(
  storeName: string,
  action: (store: IDBObjectStore) => void,
): Promise<void> {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let transaction: IDBTransaction | null = null;
    const rejectTransaction = (error: DOMException | Error | null, fallback: string) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error(fallback));
    };

    try {
      transaction = database.transaction(storeName, "readwrite");
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => rejectTransaction(
        transaction?.error ?? null,
        `The ${storeName} transaction failed.`,
      );
      transaction.onabort = () => rejectTransaction(
        transaction?.error ?? null,
        `The ${storeName} transaction was aborted.`,
      );
      action(transaction.objectStore(storeName));
    } catch (error) {
      try { transaction?.abort(); } catch { /* It may already be inactive. */ }
      rejectTransaction(error instanceof Error ? error : null, `Could not start the ${storeName} transaction.`);
    }
  });
}

async function writeAttempt(attempt: LocalAttempt): Promise<void> {
  // Attempts are user history, not a presentation cache. Browser quota errors
  // are reported by the transaction; a successful new write never authorizes
  // silently deleting older sessions.
  return writeTransaction("attempts", (store) => { store.put(attempt); });
}

interface MetadataBudget {
  nodes: number;
  characters: number;
  maxNodes: number;
  maxCharacters: number;
  seen: WeakSet<object>;
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RangeError(`${label} must contain 1-${maximumLength} non-padding characters.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside its supported range.`);
  }
  return value;
}

function sanitizeMetadata(value: unknown, budget: MetadataBudget, depth = 0): unknown {
  budget.nodes += 1;
  if (depth > 12 || budget.nodes > budget.maxNodes) {
    throw new RangeError("Local metadata is too deeply nested or contains too many values.");
  }
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Local metadata numbers must be finite.");
    return value;
  }
  if (typeof value === "string") {
    budget.characters += value.length;
    if (budget.characters > budget.maxCharacters) {
      throw new RangeError("Local metadata contains too much text.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Local metadata may contain only plain structured data.");
  }
  if (budget.seen.has(value)) throw new TypeError("Local metadata must not contain cycles or aliases.");
  budget.seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > 256) throw new RangeError("Local metadata arrays may contain at most 256 values.");
    return value.map((item) => sanitizeMetadata(item, budget, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Local metadata may contain only plain objects, not binary or class instances.");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) throw new RangeError("Local metadata objects may contain at most 128 fields.");
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, candidate] of entries) {
    budget.characters += key.length;
    if (budget.characters > budget.maxCharacters) {
      throw new RangeError("Local metadata contains too much text.");
    }
    boundedString(key, "Local metadata field name", MAX_STORAGE_KEY_LENGTH);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("Local metadata contains an unsafe field name.");
    }
    output[key] = sanitizeMetadata(candidate, budget, depth + 1);
  }
  return output;
}

function boundedMetadata(value: unknown, maxNodes: number, maxCharacters: number): unknown {
  return sanitizeMetadata(value, {
    nodes: 0,
    characters: 0,
    maxNodes,
    maxCharacters,
    seen: new WeakSet(),
  });
}

function sanitizePitchFrame(frame: Readonly<LocalPitchFrame>, index: number): LocalPitchFrame {
  if (typeof frame.voiced !== "boolean") {
    throw new TypeError(`Pitch frame ${index} has a non-boolean voiced value.`);
  }
  const timeSeconds = finiteNumber(frame.timeSeconds, `Pitch frame ${index} time`, 0, 1_000_000_000);
  const rms = finiteNumber(frame.rms, `Pitch frame ${index} RMS`, 0, 4);
  const confidence = finiteNumber(frame.confidence, `Pitch frame ${index} confidence`, 0, 1);
  if (!frame.voiced) {
    if (frame.frequencyHz !== null || frame.midiFloat !== null || frame.nearestMidi !== null
      || frame.centsFromNearest !== null) {
      throw new RangeError(`Unvoiced pitch frame ${index} must not contain pitch coordinates.`);
    }
    return {
      timeSeconds,
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
      rms,
      confidence,
      voiced: false,
    };
  }
  const frequencyHz = finiteNumber(
    frame.frequencyHz,
    `Pitch frame ${index} frequency`,
    LOCAL_PITCH_MINIMUM_FREQUENCY_HZ,
    LOCAL_PITCH_MAXIMUM_FREQUENCY_HZ,
  );
  const midiFloat = finiteNumber(
    frame.midiFloat,
    `Pitch frame ${index} MIDI`,
    LOCAL_PITCH_MINIMUM_MIDI,
    LOCAL_PITCH_MAXIMUM_MIDI,
  );
  const nearestMidi = finiteNumber(
    frame.nearestMidi,
    `Pitch frame ${index} nearest MIDI`,
    LOCAL_PITCH_MINIMUM_NEAREST_MIDI,
    LOCAL_PITCH_MAXIMUM_NEAREST_MIDI,
  );
  if (!Number.isInteger(nearestMidi)) throw new RangeError(`Pitch frame ${index} nearest MIDI must be an integer.`);
  const centsFromNearest = finiteNumber(
    frame.centsFromNearest,
    `Pitch frame ${index} cents`,
    -50,
    50,
  );
  const midiFromFrequency = frequencyToMidi(frequencyHz);
  const splitPitch = splitMidiPitch(midiFloat);
  if (Math.abs(midiFromFrequency - midiFloat) > LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.midiTolerance
    || nearestMidi !== splitPitch.nearestMidi
    || Math.abs(splitPitch.centsFromNearest - centsFromNearest)
      > LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.centsTolerance) {
    throw new RangeError(`Pitch frame ${index} contains contradictory pitch coordinates.`);
  }
  return {
    timeSeconds,
    frequencyHz,
    midiFloat,
    nearestMidi,
    centsFromNearest,
    rms,
    confidence,
    voiced: true,
  };
}

function sanitizeAttempt(attempt: Readonly<LocalAttempt>): LocalAttempt {
  const id = boundedString(attempt.id, "Attempt id", 128);
  const exerciseType = boundedString(attempt.exerciseType, "Exercise type", 128);
  const started = new Date(boundedString(attempt.startedAt, "Attempt start time", 40));
  const completed = new Date(boundedString(attempt.completedAt, "Attempt completion time", 40));
  if (!Number.isFinite(started.getTime()) || !Number.isFinite(completed.getTime())) {
    throw new RangeError("Attempt timestamps must be valid dates.");
  }
  if (completed.getTime() < started.getTime()) {
    throw new RangeError("Attempt completion time cannot precede its start time.");
  }
  if (attempt.pitchFrames !== undefined && !Array.isArray(attempt.pitchFrames)) {
    throw new TypeError("Attempt pitchFrames must be an array.");
  }
  if (attempt.pitchFrames && attempt.pitchFrames.length > MAX_ATTEMPT_PITCH_FRAMES) {
    throw new RangeError(`Attempt pitchFrames may contain at most ${MAX_ATTEMPT_PITCH_FRAMES} frames.`);
  }
  const metricEntries = Object.entries(attempt.metrics);
  if (metricEntries.length > 128) throw new RangeError("Attempt metrics may contain at most 128 fields.");
  const metrics = Object.create(null) as Record<string, number | undefined>;
  for (const [key, value] of metricEntries) {
    boundedString(key, "Attempt metric name", MAX_STORAGE_KEY_LENGTH);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("Attempt metrics contain an unsafe field name.");
    }
    if (value !== undefined) metrics[key] = finiteNumber(value, `Attempt metric ${key}`, -1_000_000_000, 1_000_000_000);
  }
  return {
    id,
    exerciseType,
    target: boundedMetadata(attempt.target, 2_048, 32_768),
    metrics,
    ...(attempt.pitchFrames
      ? { pitchFrames: attempt.pitchFrames.map((frame, index) => sanitizePitchFrame(frame, index)) }
      : {}),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
  };
}

export async function saveAttempt(attempt: LocalAttempt): Promise<void> {
  const sanitized = sanitizeAttempt(attempt);
  await writeAttempt(sanitized);
}

export async function recentAttempts(limit = 12): Promise<LocalAttempt[]> {
  const boundedLimit = Number.isFinite(limit)
    ? clamp(Math.floor(limit), 0, MAX_RECENT_ATTEMPTS)
    : 12;
  if (boundedLimit === 0) return [];

  const database = await openDatabase();
  return new Promise<LocalAttempt[]>((resolve, reject) => {
    const attempts: LocalAttempt[] = [];
    let settled = false;
    const transaction = database.transaction("attempts", "readonly");
    const request = transaction.objectStore("attempts").index("completedAt").openCursor(null, "prev");
    const rejectTransaction = (error: DOMException | Error | null, fallback: string) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error(fallback));
    };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || attempts.length >= boundedLimit) return;
      try {
        attempts.push(sanitizeAttempt(cursor.value as LocalAttempt));
        cursor.continue();
      } catch (error) {
        try { transaction.abort(); } catch { /* It may already be inactive. */ }
        rejectTransaction(error instanceof Error ? error : null, "Stored attempt data is invalid.");
      }
    };
    request.onerror = () => rejectTransaction(request.error, "Could not read recent attempts.");
    transaction.onerror = () => rejectTransaction(transaction.error, "The attempts transaction failed.");
    transaction.onabort = () => rejectTransaction(transaction.error, "The attempts transaction was aborted.");
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(attempts);
    };
  });
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await setSettings([{ key, value }]);
}

/** Persist related settings atomically. */
export async function setSettings(entries: readonly { key: string; value: unknown }[]): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length > MAX_SETTING_ENTRIES_PER_TRANSACTION) {
    throw new RangeError(`A settings transaction may contain at most ${MAX_SETTING_ENTRIES_PER_TRANSACTION} entries.`);
  }
  const seenKeys = new Set<string>();
  const sanitized = entries.map((entry) => {
    const key = boundedString(entry.key, "Setting key", MAX_STORAGE_KEY_LENGTH);
    if (seenKeys.has(key)) throw new RangeError(`Setting key ${key} appears more than once in one transaction.`);
    seenKeys.add(key);
    return { key, value: boundedMetadata(entry.value, 8_192, 262_144) };
  });
  await writeTransaction("settings", (store) => {
    for (const entry of sanitized) store.put(entry);
  });
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const boundedKey = boundedString(key, "Setting key", MAX_STORAGE_KEY_LENGTH);
  const record = await transact<unknown>(
    "settings",
    "readonly",
    (store) => store.get(boundedKey),
  );
  if (record === undefined) return undefined;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Stored setting data is invalid.");
  }
  const prototype = Object.getPrototypeOf(record);
  const keys = Object.keys(record);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== 2 || !keys.includes("key") || !keys.includes("value")) {
    throw new TypeError("Stored setting data is invalid.");
  }
  const candidate = record as { key?: unknown; value?: unknown };
  if (candidate.key !== boundedKey) {
    throw new TypeError("Stored setting key does not match the requested key.");
  }
  return boundedMetadata(candidate.value, 8_192, 262_144) as T;
}
