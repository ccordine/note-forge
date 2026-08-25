import { describe, expect, it } from "vitest";
import { auditUserOwnedLiveLifetime } from "../scripts/audit-support/user-owned-live-lifetime.mjs";

const PATH = "apps/web/src/features/example/example-session.tsx";
const CONTRACT = Object.freeze({
  path: PATH,
  reducer: "reduceExample",
  terminalField: "phase",
  terminalValues: ["complete"],
  allowedActions: ["finish"],
  requiredActions: ["finish"],
  activeField: "phase",
  activeValues: ["tracking"],
  initialState: "createExample",
  requiredStartActions: ["start"],
  forbiddenStartActions: ["hydrate"],
});

function audit(source: string, contracts: readonly typeof CONTRACT[] = [CONTRACT]): readonly string[] {
  return auditUserOwnedLiveLifetime([{ relativePath: PATH, source }], contracts);
}

const VALID_REDUCER = String.raw`
  type Action =
    | { type: "start" }
    | { type: "hydrate" }
    | { type: "observation"; elapsedSeconds: number }
    | { type: "finish" };
  type State = { phase: "idle" | "tracking" | "complete"; achievement: boolean };
  export const createExample = (): State => ({ phase: "idle", achievement: false });
  const finishExample = (state: State): State => ({ ...state, phase: "complete" });
  export function reduceExample(state: State, action: Action): State {
    switch (action.type) {
      case "start":
        return { ...state, phase: "tracking" };
      case "hydrate":
        return { ...state, achievement: false };
      case "observation":
        return { ...state, achievement: action.elapsedSeconds >= 5 };
      case "finish":
        return finishExample(state);
    }
  }
`;

describe("repository user-owned live-lifetime architecture guard", () => {
  it("allows achievements, duration metadata, presentation timers, and route cleanup", () => {
    const source = `${VALID_REDUCER}
      const audioMetadata = { durationSeconds: 5, timeoutLabel: "network metadata" };
      setTimeout(() => publishPresentation(audioMetadata), 100);
      useEffect(() => () => playback.stop(), []);
    `;
    expect(audit(source)).toEqual([]);
  });

  it.each([
    [
      "detector observation",
      VALID_REDUCER.replace(
        "return { ...state, achievement: action.elapsedSeconds >= 5 };",
        "return { ...state, phase: action.elapsedSeconds >= 5 ? \"complete\" : state.phase };",
      ),
      'action "observation" can reach terminal phase',
    ],
    [
      "elapsed timer",
      `${VALID_REDUCER}\nsetTimeout(() => dispatch({ type: "finish" }), 5_000);`,
      "setTimeout callback invokes live-lifetime action \"finish\"",
    ],
    [
      "React effect",
      `${VALID_REDUCER}\nuseEffect(() => { runtime.finish(); }, [settings]);`,
      "useEffect body invokes live-lifetime finish()",
    ],
    [
      "media completion",
      `${VALID_REDUCER}\nconst view = <audio onEnded={() => runtime.finish()} />;`,
      "onEnded handler invokes live-lifetime finish()",
    ],
    [
      "detector callback",
      `${VALID_REDUCER}\nconst input = { onFrame: () => runtime.stop() };`,
      "onFrame callback invokes live-lifetime stop()",
    ],
    [
      "storage failure",
      `${VALID_REDUCER}\nfunction failRecordingStorage() { requestRecorderStop(); }`,
      "storage-failure path invokes live-lifetime requestRecorderStop()",
    ],
    [
      "automatic start",
      `${VALID_REDUCER}\nsetInterval(() => dispatch({ type: "start" }), 1_000);`,
      "setInterval callback invokes live-lifetime action \"start\"",
    ],
  ])("rejects lifetime authority from %s", (_name, source, message) => {
    expect(audit(source)).toContainEqual(expect.stringContaining(message));
  });

  it("rejects a new observation-driven terminal reducer until its authority is contracted", () => {
    expect(audit(VALID_REDUCER, [])).toContainEqual(expect.stringContaining(
      "observation-driven terminal reducer lacks a user-owned lifetime contract",
    ));
  });

  it("rejects removal of the explicit terminal transition", () => {
    const source = VALID_REDUCER.replace(
      "return finishExample(state);",
      "return state;",
    );
    expect(audit(source)).toContainEqual(expect.stringContaining(
      'explicit "finish" no longer owns a terminal phase transition',
    ));
  });

  it("rejects a default-active initializer", () => {
    const source = VALID_REDUCER.replace(
      '({ phase: "idle", achievement: false })',
      '({ phase: "tracking", achievement: false })',
    );
    expect(audit(source)).toContainEqual(expect.stringContaining(
      "initial state createExample can enter active phase",
    ));
  });

  it("rejects persistence hydration that silently starts a live session", () => {
    const source = VALID_REDUCER.replace(
      'return { ...state, achievement: false };',
      'return { ...state, phase: "tracking", achievement: false };',
    );
    expect(audit(source)).toContainEqual(expect.stringContaining(
      'non-user "hydrate" can enter active phase',
    ));
  });

  it("traces aliased starts reached from mount effects and setting changes", () => {
    const source = `${VALID_REDUCER}
      const beginFromSettings = () => dispatch({ type: "start" });
      useEffect(() => { beginFromSettings(); }, []);
      const view = <select onChange={() => beginFromSettings()} />;
    `;
    expect(audit(source)).toEqual(expect.arrayContaining([
      expect.stringContaining('useEffect body invokes live-lifetime action "start"'),
      expect.stringContaining('onChange handler invokes live-lifetime action "start"'),
    ]));
  });

  it("rejects a direct settings-handler reset but permits configuration-only changes", () => {
    const resetSource = `${VALID_REDUCER}
      const resetFromSettings = () => dispatch({ type: "reset" });
      const view = <select onChange={resetFromSettings} />;
    `;
    expect(audit(resetSource)).toContainEqual(expect.stringContaining(
      'onChange handler invokes live-lifetime action "reset"',
    ));

    const configurationSource = `${VALID_REDUCER}
      const configureTolerance = () => dispatch({ type: "configure", toleranceCents: 20 });
      const view = <select onChange={configureTolerance} />;
    `;
    expect(audit(configurationSource)).toEqual([]);
  });

  it("rejects media-promise continuations that invent Start authority", () => {
    const source = `${VALID_REDUCER}
      audio.play().then(() => dispatch({ type: "start" }));
    `;
    expect(audit(source)).toContainEqual(expect.stringContaining(
      'then callback invokes live-lifetime action "start"',
    ));
  });
});
