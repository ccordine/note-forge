import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTES,
  PRACTICE_ACTIVITIES,
  appRoutePath,
  appRouteScreen,
} from "../apps/web/src/navigation";
import { matchAppRoute } from "../apps/web/src/routing/use-app-navigation";

const ROOT = resolve(import.meta.dirname, "..");
const FEATURE_FILES = Object.freeze([
  "apps/web/src/features/pitch-tunnel/pitch-tunnel-engine.ts",
  "apps/web/src/features/pitch-tunnel/pitch-tunnel-metrics.ts",
  "apps/web/src/features/pitch-tunnel/pitch-tunnel-types.ts",
  "apps/web/src/features/pitch-tunnel/use-pitch-tunnel.ts",
  "apps/web/src/features/pitch-tunnel/PitchTunnel.tsx",
  "apps/web/src/features/pitch-tunnel/PitchTunnelLane.tsx",
]);

interface ParsedSource {
  readonly path: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
}

function parse(path: string): ParsedSource {
  const text = readFileSync(resolve(ROOT, path), "utf8");
  return {
    path,
    text,
    sourceFile: ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
}

const sources = FEATURE_FILES.map(parse);

function descendants(root: ts.Node): readonly ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

function calledPath(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    return `${calledPath(expression.expression)}.${expression.name.text}`;
  }
  return expression.getText();
}

function callsIn(source: ParsedSource): readonly string[] {
  return descendants(source.sourceFile).flatMap((node) => (
    ts.isCallExpression(node) ? [calledPath(node.expression)] : []
  ));
}

function constructionsIn(source: ParsedSource): readonly string[] {
  return descendants(source.sourceFile).flatMap((node) => (
    ts.isNewExpression(node) ? [calledPath(node.expression)] : []
  ));
}

function jsxAttributeNames(source: ParsedSource): readonly string[] {
  return descendants(source.sourceFile).flatMap((node) => (
    ts.isJsxAttribute(node) ? [node.name.getText(source.sourceFile)] : []
  ));
}

function jsxTagNames(source: ParsedSource): readonly string[] {
  return descendants(source.sourceFile).flatMap((node) => {
    if (ts.isJsxElement(node)) return [node.openingElement.tagName.getText(source.sourceFile)];
    if (ts.isJsxSelfClosingElement(node)) return [node.tagName.getText(source.sourceFile)];
    return [];
  });
}

function reactWriterNames(source: ParsedSource): ReadonlySet<string> {
  const writers = new Set<string>();
  for (const node of descendants(source.sourceFile)) {
    if (
      !ts.isVariableDeclaration(node)
      || !ts.isArrayBindingPattern(node.name)
      || !node.initializer
      || !ts.isCallExpression(node.initializer)
      || !["useState", "useReducer"].includes(calledPath(node.initializer.expression))
    ) continue;
    const writerElement = node.name.elements[1];
    if (
      writerElement
      && ts.isBindingElement(writerElement)
      && ts.isIdentifier(writerElement.name)
    ) writers.add(writerElement.name.text);
  }
  return writers;
}

function variableInitializer(source: ParsedSource, name: string): ts.Expression | undefined {
  for (const node of descendants(source.sourceFile)) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
      && node.initializer
    ) return node.initializer;
  }
  return undefined;
}

function onFrameInitializers(source: ParsedSource): readonly ts.Expression[] {
  return descendants(source.sourceFile).flatMap((node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source.sourceFile) === "onFrame") {
      return [node.initializer];
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "onFrame") {
      const initializer = variableInitializer(source, node.name.text);
      return initializer ? [initializer] : [];
    }
    return [];
  });
}

describe("Pitch Tunnel architecture", () => {
  it("is one exact deep-linked Practice activity", () => {
    expect(appRoutePath(DEFAULT_ROUTES.pitchTunnel)).toBe("/practice/pitch-tunnel");
    expect(matchAppRoute("/practice/pitch-tunnel")).toEqual(DEFAULT_ROUTES.pitchTunnel);
    expect(appRouteScreen(DEFAULT_ROUTES.pitchTunnel)).toBe("tunnel");
    expect(PRACTICE_ACTIVITIES.filter(({ id }) => id === "pitch-tunnel")).toEqual([
      expect.objectContaining({
        label: "Pitch tunnel",
        route: DEFAULT_ROUTES.pitchTunnel,
      }),
    ]);
  });

  it("reduces every detector observation through one external realtime session", () => {
    const calls = sources.flatMap(callsIn);
    expect(calls.filter((call) => call === "useAudioInput")).toHaveLength(1);
    expect(calls.filter((call) => call === "useRealtimeSession")).toHaveLength(1);

    const callbacks = sources.flatMap(onFrameInitializers);
    expect(callbacks).toHaveLength(1);
    const callbackCalls = callbacks.flatMap((callback) => descendants(callback))
      .flatMap((node) => ts.isCallExpression(node) ? [calledPath(node.expression)] : []);
    expect(callbackCalls.some((call) => call.endsWith(".observe"))).toBe(true);

    const reactWriters = new Set(sources.flatMap((source) => [...reactWriterNames(source)]));
    expect(callbackCalls.filter((call) => reactWriters.has(call))).toEqual([]);
    expect(calls).not.toContain("useAudioPitchSnapshot");
  });

  it("has one canonical live visualization and exposes exact proof coordinates", () => {
    const tags = sources.flatMap(jsxTagNames);
    const attributes = sources.flatMap(jsxAttributeNames);
    expect(tags.filter((tag) => tag === "NoteInput")).toEqual([]);
    expect(tags.filter((tag) => tag === "PitchTunnelLane")).toHaveLength(1);
    expect(attributes.filter((attribute) => attribute === "data-note-input")).toHaveLength(1);
    expect(attributes.filter((attribute) => attribute === "data-detected-note")).toHaveLength(1);
    expect(attributes.filter((attribute) => attribute === "data-pitch-tunnel")).toHaveLength(1);
    expect(attributes.filter((attribute) => attribute === "data-pitch-tunnel-lane")).toHaveLength(1);

    for (const attribute of [
      "data-pitch-tunnel",
      "data-pitch-tunnel-lane",
      "data-workflow-step",
      "data-input-state",
      "data-end-sample",
      "data-processed-sample-count",
      "data-worklet-process-count",
      "data-capture-epoch",
      "data-continuity-epoch",
      "data-graph-generation",
      "data-observed-frame-count",
      "data-observation-kind",
      "data-target-offset-cents",
      "data-target-midi",
      "data-live-midi",
      "data-error-cents",
      "data-in-lane",
      "data-elapsed-seconds",
      "data-in-lane-seconds",
      "data-checkpoint-index",
      "data-checkpoint-held-seconds",
    ]) {
      expect(attributes, attribute).toContain(attribute);
    }

    const laneNode = sources.flatMap((source) => descendants(source.sourceFile))
      .find((node) => (
        (ts.isJsxElement(node) && node.openingElement.tagName.getText() === "PitchTunnelLane")
        || (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "PitchTunnelLane")
      ));
    expect(laneNode).toBeDefined();
    const conditionalAncestors: ts.Node[] = [];
    for (let parent = laneNode!.parent; parent; parent = parent.parent) {
      if (
        ts.isConditionalExpression(parent)
        || ts.isIfStatement(parent)
        || (ts.isBinaryExpression(parent)
          && (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))
      ) conditionalAncestors.push(parent);
    }
    expect(conditionalAncestors).toEqual([]);
  });

  it("cannot own capture, playback, wall-clock scoring, or a second detector", () => {
    const calls = sources.flatMap(callsIn);
    const constructions = sources.flatMap(constructionsIn);
    const tags = sources.flatMap(jsxTagNames);
    const forbiddenCalls = new Set([
      "setTimeout",
      "setInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date.now",
      "performance.now",
    ]);
    expect(calls.filter((call) => forbiddenCalls.has(call))).toEqual([]);
    expect(calls.filter((call) => /\.(?:enable|disable|createRecorder|getStream)$/u.test(call))).toEqual([]);
    expect(calls.filter((call) => /(?:^|\.)createOscillator$/u.test(call))).toEqual([]);
    expect(constructions).not.toContain("Audio");
    expect(tags).not.toContain("audio");

    const production = sources.map(({ text }) => text).join("\n");
    expect(production).not.toMatch(
      /\b(?:getUserMedia|AudioContext|webkitAudioContext|MicrophoneCapture|NoteInputEngine|MediaRecorder|playTone|playSequence)\b/u,
    );
    expect(production).not.toMatch(/\binput\.(?:liveFrame|frames|telemetry)\b/u);
  });

  it("keeps the sample-time reducer independent from React and presentation adapters", () => {
    const engine = sources.find(({ path }) => path.endsWith("pitch-tunnel-engine.ts"));
    expect(engine).toBeDefined();
    const imports = descendants(engine!.sourceFile).flatMap((node) => (
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        ? [node.moduleSpecifier.text]
        : []
    ));
    expect(imports).not.toContain("react");
    expect(imports.some((specifier) => specifier.includes("use-audio-input"))).toBe(false);
    expect(imports.some((specifier) => specifier.includes("use-realtime-session"))).toBe(false);
  });
});
