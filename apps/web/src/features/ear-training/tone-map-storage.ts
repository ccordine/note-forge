import {
  requireToneMapSimonLength,
  type ToneMapChallengeMode,
} from "./tone-map-config";
import {
  restoreToneMapCourse,
  type ToneMapCourseState,
} from "./tone-map-model";
import type { ToneMapResponseMode } from "./tone-map-session";

export interface StoredToneMapState {
  readonly version: 1;
  readonly course: ToneMapCourseState;
  readonly responseMode: ToneMapResponseMode;
  readonly challengeMode: ToneMapChallengeMode;
  readonly simonLength: number;
}

export type ToneMapStoredStateResult =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "valid"; state: StoredToneMapState }>
  | Readonly<{ kind: "invalid"; reason: string }>;

function requireRecord(candidate: unknown): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError("Stored tone-map state must be an object.");
  }
  return candidate as Record<string, unknown>;
}

function requireResponseMode(candidate: unknown): ToneMapResponseMode {
  if (candidate !== "keyboard" && candidate !== "voice" && candidate !== "mixed") {
    throw new RangeError("Stored tone-map response mode is invalid.");
  }
  return candidate;
}

function requireChallengeMode(candidate: unknown): ToneMapChallengeMode {
  if (candidate !== "single" && candidate !== "simon") {
    throw new RangeError("Stored tone-map challenge mode is invalid.");
  }
  return candidate;
}

function restoreStoredToneMap(candidate: unknown): StoredToneMapState {
  const record = requireRecord(candidate);
  if (record.version !== 1) throw new RangeError("Unsupported stored tone-map version.");
  const responseMode = requireResponseMode(record.responseMode);
  const challengeMode = requireChallengeMode(record.challengeMode);
  if (challengeMode === "simon" && responseMode !== "keyboard") {
    throw new RangeError("Simon sequence requires keyboard response mode.");
  }
  return {
    version: 1,
    course: restoreToneMapCourse(record.course),
    responseMode,
    challengeMode,
    simonLength: requireToneMapSimonLength(record.simonLength),
  };
}

/** Only an absent value is new storage. Invalid data remains present and must never be replaced silently. */
export function classifyStoredToneMap(candidate: unknown): ToneMapStoredStateResult {
  if (candidate === undefined) return { kind: "missing" };
  try {
    return { kind: "valid", state: restoreStoredToneMap(candidate) };
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : "Stored tone-map state is invalid.",
    };
  }
}

export function mayWriteToneMapStorage(
  readable: boolean,
  stored: ToneMapStoredStateResult,
): boolean {
  return readable && stored.kind !== "invalid";
}
