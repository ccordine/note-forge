import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";
import { printArchitectureReport } from "./audit-support/report.mjs";
import { auditUserOwnedLiveLifetime } from "./audit-support/user-owned-live-lifetime.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const APPLICATION_ROOT = join(REPOSITORY_ROOT, "apps/web/src");
const SCAN_ROOTS = [REPOSITORY_ROOT];
const TEXT_EXTENSIONS = new Set([".css", ".go", ".js", ".mjs", ".ts", ".tsx"]);
const PROGRAM_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const EXECUTABLE_EXTENSIONS = new Set([".go", ...PROGRAM_EXTENSIONS]);
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".css"];
const enforce = process.argv.includes("--enforce");
const REVIEWED_LARGE_SUPPORT_FILES = new Map([
  ["cmd/noteforge-server/server_test.go", "HTTP/security integration matrix"],
  ["scripts/prove-note-input-browser.mjs", "browser assertion/report coordinator; protocol, fixture, instrumentation, and analysis are extracted"],
  ["scripts/prove-voice-draw-browser.mjs", "cabinet browser assertion/report coordinator over shared proof support"],
  ["scripts/audit-support/user-owned-live-lifetime.mjs", "single AST authority registry and verifier for every user-owned live reducer"],
  ["tests/note-input-engine.test.ts", "exhaustive detector range, timbre, sample-rate, and confounder matrix"],
  ["tests/pitch-diagnostic-transport.test.ts", "exact diagnostic transport schema and sample-identity matrix"],
  ["tests/range-simulator.test.ts", "range-profile migration and full-depth probing matrix"],
]);
function isSupportSource(relativePath) {
  return relativePath.startsWith("scripts/")
    || relativePath.startsWith("tests/")
    || relativePath.includes("/test/")
    || /(?:\.test\.[cm]?[jt]sx?|_test\.go)$/u.test(relativePath);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".agents", ".codex", ".git", "coverage", "dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function lineNumber(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && node.parent
    && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
  ) return node.parent.name.text;
  return "<anonymous>";
}

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function jsxTagName(node) {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

function analyzeFunction(node, sourceFile) {
  const startLine = lineNumber(sourceFile, node.getStart(sourceFile));
  const endLine = lineNumber(sourceFile, node.end);
  const calls = new Map();
  const jsxTags = new Map();
  const stateNames = [];
  const refNames = [];
  let branches = 0;
  let conditionalExpressions = 0;
  let nestedConditionalRenders = 0;
  const nestedConditionalRenderLines = [];
  let maximumControlDepth = 0;
  let jsxNodes = 0;

  function containsJsx(root) {
    let found = false;
    function inspect(candidate) {
      if (found) return;
      if (
        ts.isJsxElement(candidate)
        || ts.isJsxSelfClosingElement(candidate)
        || ts.isJsxFragment(candidate)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(candidate, inspect);
    }
    inspect(root);
    return found;
  }

  function visit(child, controlDepth, insideJsx = false, renderConditionalDepth = 0) {
    if (
      ts.isFunctionDeclaration(child)
      || ts.isFunctionExpression(child)
      || ts.isArrowFunction(child)
      || ts.isMethodDeclaration(child)
    ) return;
    let nextDepth = controlDepth;
    const nextInsideJsx = insideJsx
      || ts.isJsxElement(child)
      || ts.isJsxSelfClosingElement(child)
      || ts.isJsxFragment(child);
    const renderConditional = ts.isConditionalExpression(child)
      && (insideJsx || containsJsx(child.whenTrue) || containsJsx(child.whenFalse));
    if (renderConditional && renderConditionalDepth > 0) {
      nestedConditionalRenders += 1;
      nestedConditionalRenderLines.push(lineNumber(sourceFile, child.getStart(sourceFile)));
    }
    const nextRenderConditionalDepth = renderConditional
      ? renderConditionalDepth + 1
      : renderConditionalDepth;
    if (
      ts.isIfStatement(child)
      || ts.isConditionalExpression(child)
      || ts.isSwitchStatement(child)
      || ts.isForStatement(child)
      || ts.isForInStatement(child)
      || ts.isForOfStatement(child)
      || ts.isWhileStatement(child)
      || ts.isDoStatement(child)
      || ts.isTryStatement(child)
    ) {
      branches += 1;
      nextDepth += 1;
      maximumControlDepth = Math.max(maximumControlDepth, nextDepth);
    }
    if (ts.isConditionalExpression(child)) conditionalExpressions += 1;
    if (ts.isCallExpression(child)) {
      const name = calledName(child.expression);
      if (name) calls.set(name, (calls.get(name) ?? 0) + 1);
      if (
        (name === "useState" || name === "useReducer")
        && ts.isVariableDeclaration(child.parent)
        && ts.isArrayBindingPattern(child.parent.name)
      ) {
        const stateName = child.parent.name.elements[0]?.name.getText(sourceFile);
        if (stateName) stateNames.push(stateName);
      }
      if (
        name === "useRef"
        && ts.isVariableDeclaration(child.parent)
        && ts.isIdentifier(child.parent.name)
      ) refNames.push(child.parent.name.text);
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      jsxNodes += 1;
      const tag = jsxTagName(child);
      jsxTags.set(tag, (jsxTags.get(tag) ?? 0) + 1);
    }
    ts.forEachChild(child, (descendant) => visit(
      descendant,
      nextDepth,
      nextInsideJsx,
      nextRenderConditionalDepth,
    ));
  }
  if (node.body) visit(node.body, 0);
  const name = functionName(node);
  return {
    name,
    startLine,
    endLine,
    lines: endLine - startLine + 1,
    isComponent: /^[A-Z]/u.test(name) && jsxNodes > 0,
    isRenderFunction: jsxNodes > 0,
    branches,
    conditionalExpressions,
    nestedConditionalRenders,
    nestedConditionalRenderLines,
    maximumControlDepth,
    jsxNodes,
    noteInputs: jsxTags.get("NoteInput") ?? 0,
    workflowDialogs: jsxTags.get("WorkflowDialog") ?? 0,
    surface: {
      panels: jsxTags.get("Panel") ?? 0,
      details: jsxTags.get("details") ?? 0,
      headings: (jsxTags.get("h1") ?? 0) + (jsxTags.get("h2") ?? 0) + (jsxTags.get("h3") ?? 0),
      buttons: (jsxTags.get("button") ?? 0) + (jsxTags.get("ActionButton") ?? 0) + (jsxTags.get("PlayButton") ?? 0),
      selects: (jsxTags.get("select") ?? 0) + (jsxTags.get("Select") ?? 0),
    },
    stateNames,
    refNames,
    hooks: {
      state: calls.get("useState") ?? 0,
      reducer: calls.get("useReducer") ?? 0,
      ref: calls.get("useRef") ?? 0,
      effect: (calls.get("useEffect") ?? 0) + (calls.get("useLayoutEffect") ?? 0),
      memo: (calls.get("useMemo") ?? 0) + (calls.get("useCallback") ?? 0),
    },
    timers: (calls.get("setTimeout") ?? 0) + (calls.get("setInterval") ?? 0),
    animationFrames: calls.get("requestAnimationFrame") ?? 0,
  };
}

function scriptKind(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function analyzeProgram(path, source) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const functions = [];
  const dependencies = [];
  const captureCalls = [];
  const inputLifecycleCalls = [];
  const rawInputStreamCalls = [];
  const reactWriters = new Set();
  const onFrameRefBridges = new Set();
  const realtimeReactWrites = [];

  function collectReactWriter(node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isArrayBindingPattern(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && (calledName(node.initializer.expression) === "useState" || calledName(node.initializer.expression) === "useReducer")
    ) {
      const writer = node.name.elements[1]?.name.getText(sourceFile);
      if (writer) reactWriters.add(writer);
    }
    ts.forEachChild(node, collectReactWriter);
  }

  function callbackReactWrites(callback) {
    const writes = [];
    function inspect(node) {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && reactWriters.has(node.expression.text)) {
          writes.push(node.expression.text);
        }
        if (
          ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "current"
          && ts.isIdentifier(node.expression.expression)
        ) onFrameRefBridges.add(node.expression.expression.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(callback);
    return writes;
  }

  collectReactWriter(sourceFile);

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
    ) functions.push(analyzeFunction(node, sourceFile));

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])
    ) dependencies.push(node.arguments[0].text);
    else if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "URL"
      && node.arguments?.[0]
      && ts.isStringLiteral(node.arguments[0])
    ) dependencies.push(node.arguments[0].text);

    const text = node.getText(sourceFile);
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node))
      && /(?:getUserMedia|AudioContext|webkitAudioContext|createMediaStreamSource|createMediaStreamTrackSource|\.suspend\()/u.test(text)
    ) captureCalls.push({ line: lineNumber(sourceFile, node.getStart(sourceFile)), text: text.slice(0, 100) });
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(sourceFile);
      const method = node.expression.name.text;
      if (/input(?:Ref\.current)?$/iu.test(receiver) && (method === "enable" || method === "disable")) {
        inputLifecycleCalls.push({ line: lineNumber(sourceFile, node.getStart(sourceFile)), text: text.slice(0, 100) });
      }
      if (/input(?:Ref\.current)?$/iu.test(receiver) && method === "getStream") {
        rawInputStreamCalls.push({ line: lineNumber(sourceFile, node.getStart(sourceFile)), text: text.slice(0, 100) });
      }
    }
    if (
      ts.isPropertyAssignment(node)
      && node.name.getText(sourceFile) === "onFrame"
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const writes = callbackReactWrites(node.initializer);
      if (writes.length > 0) {
        realtimeReactWrites.push({
          line: lineNumber(sourceFile, node.initializer.getStart(sourceFile)),
          writers: [...new Set(writes)],
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  function findRefBridgeWrites(node) {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === "current"
      && ts.isIdentifier(node.left.expression)
      && onFrameRefBridges.has(node.left.expression.text)
      && (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right))
    ) {
      const writes = callbackReactWrites(node.right);
      if (writes.length > 0) {
        realtimeReactWrites.push({
          line: lineNumber(sourceFile, node.right.getStart(sourceFile)),
          writers: [...new Set(writes)],
        });
      }
    }
    ts.forEachChild(node, findRefBridgeWrites);
  }
  findRefBridgeWrites(sourceFile);
  return {
    functions,
    dependencies,
    captureCalls,
    inputLifecycleCalls,
    rawInputStreamCalls,
    realtimeReactWrites,
  };
}

async function resolveDependency(fromPath, specifier, knownFiles) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const base = specifier.startsWith("@/")
    ? join(APPLICATION_ROOT, specifier.slice(2))
    : resolve(fromPath, "..", specifier);
  const candidates = [
    base,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

const paths = (await Promise.all(SCAN_ROOTS.map(walk))).flat().sort();
const records = [];
for (const path of paths) {
  const source = await readFile(path, "utf8");
  const sourceLines = source.split(/\r?\n/u);
  const program = PROGRAM_EXTENSIONS.has(extname(path)) ? analyzeProgram(path, source) : null;
  records.push({
    path,
    relativePath: relative(REPOSITORY_ROOT, path),
    lines: sourceLines.length,
    maximumLineLength: Math.max(...sourceLines.map((line) => line.length)),
    source,
    ...program,
  });
}

const knownFiles = new Set(records.map((record) => record.path));
const byPath = new Map(records.map((record) => [record.path, record]));
for (const record of records) {
  record.resolvedDependencies = [];
  for (const dependency of record.dependencies ?? []) {
    const resolved = await resolveDependency(record.path, dependency, knownFiles);
    if (resolved) record.resolvedDependencies.push(resolved);
  }
}

const reachable = new Set();
const queue = [join(APPLICATION_ROOT, "main.tsx")];
while (queue.length) {
  const path = queue.shift();
  if (!path || reachable.has(path)) continue;
  reachable.add(path);
  for (const dependency of byPath.get(path)?.resolvedDependencies ?? []) queue.push(dependency);
}

const components = records.flatMap((record) => (record.functions ?? [])
  .filter((fn) => fn.isComponent)
  .map((fn) => ({ ...fn, path: record.relativePath })));
const renderFunctions = records.flatMap((record) => (record.functions ?? [])
  .filter((fn) => fn.isRenderFunction)
  .map((fn) => ({ ...fn, path: record.relativePath })));
const largestFiles = [...records].sort((left, right) => right.lines - left.lines).slice(0, 30);
const largestComponents = [...components].sort((left, right) => right.lines - left.lines).slice(0, 30);
const complexComponents = [...components].sort((left, right) =>
  right.maximumControlDepth - left.maximumControlDepth
  || right.branches - left.branches
  || right.lines - left.lines).slice(0, 30);
const stateHeavyComponents = [...components].sort((left, right) => {
  const rightState = right.hooks.state + right.hooks.ref + right.hooks.effect;
  const leftState = left.hooks.state + left.hooks.ref + left.hooks.effect;
  return rightState - leftState || right.lines - left.lines;
}).slice(0, 30);
const surfaceHeavyComponents = [...components].sort((left, right) => {
  const rightSurface = right.surface.panels + right.surface.details + right.surface.headings;
  const leftSurface = left.surface.panels + left.surface.details + left.surface.headings;
  return rightSurface - leftSurface || right.lines - left.lines;
}).slice(0, 30);
const unreachableApplicationFiles = records.filter((record) =>
  record.path.startsWith(APPLICATION_ROOT)
  && PROGRAM_EXTENSIONS.has(extname(record.path))
  && !record.path.endsWith("vite-env.d.ts")
  && !reachable.has(record.path));

const violations = [];
violations.push(...auditUserOwnedLiveLifetime(records));
for (const record of records) {
  const extension = extname(record.path);
  const supportSource = isSupportSource(record.relativePath);
  if (EXECUTABLE_EXTENSIONS.has(extension) && !supportSource && record.lines > 600) {
    violations.push(`${record.relativePath}: ${record.lines} lines (production executable source exceeds 600)`);
  }
  if (EXECUTABLE_EXTENSIONS.has(extension) && supportSource && record.lines > 1_000) {
    violations.push(`${record.relativePath}: ${record.lines} lines (support executable source exceeds 1,000)`);
  }
  if (
    EXECUTABLE_EXTENSIONS.has(extension)
    && supportSource
    && record.lines > 600
    && !REVIEWED_LARGE_SUPPORT_FILES.has(record.relativePath)
  ) {
    violations.push(`${record.relativePath}: ${record.lines} lines (support source crossed 600 without a named boundary review)`);
  }
  if (extension === ".css" && record.lines > 600) {
    violations.push(`${record.relativePath}: ${record.lines} lines (stylesheet exceeds 600)`);
  }
  if (!supportSource && record.maximumLineLength > 500) {
    violations.push(`${record.relativePath}: ${record.maximumLineLength}-character source line (minified/compressed handwritten source)`);
  }
  if (extension === ".css" && /@import\s/u.test(record.source)) {
    violations.push(`${record.relativePath}: CSS @import obscures feature ownership and loading`);
  }
  const noteInputs = (record.source.match(/<NoteInput(?:\s|\/|>)/gu) ?? []).length;
  if (record.path.endsWith(".tsx") && noteInputs > 1) {
    violations.push(`${record.relativePath}: ${noteInputs} NoteInput mounts in one feature file`);
  }
  if (
    record.captureCalls?.length
    && record.path.startsWith(APPLICATION_ROOT)
    && !record.relativePath.startsWith("apps/web/src/audio/")
  ) {
    violations.push(`${record.relativePath}: capture lifecycle calls outside the audio subsystem`);
  }
  if (record.relativePath.startsWith("apps/web/src/features/") && record.inputLifecycleCalls?.length) {
    violations.push(`${record.relativePath}: feature calls input.enable()/disable() and owns microphone lifecycle`);
  }
  if (record.relativePath.startsWith("apps/web/src/features/") && record.rawInputStreamCalls?.length) {
    violations.push(`${record.relativePath}: feature reads the raw app-owned MediaStream instead of using an audio-owner capability`);
  }
  if (
    record.relativePath.startsWith("apps/web/src/features/")
    && PROGRAM_EXTENSIONS.has(extname(record.path))
  ) {
    for (const write of record.realtimeReactWrites ?? []) {
      violations.push(`${record.relativePath}:${write.line} detector onFrame writes React state (${write.writers.join(", ")})`);
    }
    if (/\binput\.(?:liveFrame|frames)\b/u.test(record.source)) {
      violations.push(`${record.relativePath}: feature reads a high-rate controller snapshot directly instead of a coherent bounded session snapshot`);
    }
  }
}
for (const record of unreachableApplicationFiles) {
  violations.push(`${record.relativePath}: production application module is unreachable from main.tsx`);
}
for (const component of components) {
  if (component.lines > 400) violations.push(`${component.path}:${component.startLine} ${component.name}: ${component.lines}-line component`);
  if (component.maximumControlDepth > 4) violations.push(`${component.path}:${component.startLine} ${component.name}: control depth ${component.maximumControlDepth}`);
  const mutableHookCount = component.hooks.state + component.hooks.ref + component.hooks.effect;
  if (mutableHookCount > 15) violations.push(`${component.path}:${component.startLine} ${component.name}: ${mutableHookCount} state/ref/effect hooks`);
  if (component.branches > 50) violations.push(`${component.path}:${component.startLine} ${component.name}: ${component.branches} control branches`);
  const stateNames = new Set(component.stateNames.map((name) => name.toLocaleLowerCase("en-US")));
  const mirroredRefs = component.refNames.filter((name) => {
    const normalized = name.toLocaleLowerCase("en-US");
    return normalized.endsWith("ref") && stateNames.has(normalized.slice(0, -3));
  });
  if (mirroredRefs.length > 0) {
    violations.push(`${component.path}:${component.startLine} ${component.name}: React state mirrored by ${mirroredRefs.join(", ")}`);
  }
}
for (const renderFunction of renderFunctions) {
  if (renderFunction.nestedConditionalRenders > 0) {
    violations.push(`${renderFunction.path}:${renderFunction.startLine} ${renderFunction.name}: ${renderFunction.nestedConditionalRenders} nested conditional render expressions at lines ${renderFunction.nestedConditionalRenderLines.join(", ")}`);
  }
}
for (const [path] of REVIEWED_LARGE_SUPPORT_FILES) {
  const record = records.find((candidate) => candidate.relativePath === path);
  if (!record || record.lines <= 600) {
    violations.push(`${path}: stale large-support review entry must be deleted`);
  }
}
const recordByRelativePath = new Map(records.map((record) => [record.relativePath, record]));
const appSource = recordByRelativePath.get("apps/web/src/App.tsx")?.source ?? "";
const mainSource = recordByRelativePath.get("apps/web/src/main.tsx")?.source ?? "";
const navigationSource = recordByRelativePath.get("apps/web/src/navigation.ts")?.source ?? "";
const routerSource = recordByRelativePath.get("apps/web/src/routing/use-app-navigation.ts")?.source ?? "";
const controlsSource = recordByRelativePath.get("apps/web/src/ui/Controls.tsx")?.source ?? "";
const musicalSource = recordByRelativePath.get("apps/web/src/state/MusicalContext.tsx")?.source ?? "";
const preferencesSource = recordByRelativePath.get("apps/web/src/state/UserPreferencesContext.tsx")?.source ?? "";
const practiceSource = recordByRelativePath.get("apps/web/src/features/practice/Practice.tsx")?.source ?? "";
const homeSource = recordByRelativePath.get("apps/web/src/features/home/Home.tsx")?.source ?? "";
const noteInputSource = recordByRelativePath.get("apps/web/src/ui/voice/NoteInput.tsx")?.source ?? "";
if (recordByRelativePath.has("apps/web/src/state/LabContext.tsx")) {
  violations.push("apps/web/src/state/LabContext.tsx: aggregate route/music/preferences authority must be deleted");
}
const entryStyles = [...mainSource.matchAll(/import\s+"\.\/(styles(?:-[^"\n]+)?\.css)"/gu)].map((match) => match[1]);
if (entryStyles.join(",") !== "styles.css,styles-responsive.css") {
  violations.push("apps/web/src/main.tsx: only application-shell foundations may load globally; feature styles belong with their surface");
}
if (!mainSource.includes('HashRouter } from "react-router"') || !routerSource.includes("matchRoutes") || !controlsSource.includes("<Link")) {
  violations.push("apps/web/src: maintained React Router must own hash/history matching and anchors");
}
if (/hashchange|popstate|pushState|replaceState|location\.hash/u.test(appSource + routerSource + controlsSource)) {
  violations.push("apps/web/src: application-specific hash/history lifecycle remains");
}
if (/route|navigate|toleranceCents|expertMode|labelsHidden/u.test(musicalSource)
  || /selectedMidi|tonicPitchClass|scaleId|chordQuality|timbre|route|navigate/u.test(preferencesSource)) {
  violations.push("apps/web/src/state: musical state and user preferences must remain separate authorities");
}
if (!navigationSource.includes("PRODUCT_SURFACES") || (navigationSource.match(/label: "(?:Practice|Arcade|Explore|Songs|Progress)"/gu) ?? []).length !== 5) {
  violations.push("apps/web/src/navigation.ts: permanent navigation must expose exactly five user-job surfaces");
}
if (!appSource.includes("const SURFACES = {") || appSource.includes("const SCREENS") || !practiceSource.includes("const ACTIVITIES = {")) {
  violations.push("apps/web/src: App must dispatch product surfaces while Practice owns activity dispatch");
}
if ((appSource.match(/<dialog/gu) ?? []).length !== 2 || /FOCUSABLE|querySelectorAll<HTMLElement>|addEventListener\("keydown"/u.test(appSource)) {
  violations.push("apps/web/src/App.tsx: native dialogs must replace hand-written focus traps");
}
if (!appSource.includes("<RouteLink") || /SkillMap|coordinate-strip/u.test(appSource)) {
  violations.push("apps/web/src/App.tsx: shell navigation must use anchors and expose no Skill Map/global coordinate fiction");
}
if (/SKILL_CATALOG|sessionBlocks|starter circuit|skill map/iu.test(homeSource)) {
  violations.push("apps/web/src/features/home/Home.tsx: fake starter/Skill Map navigation remains");
}
const noteInputCallSource = records
  .filter((record) => record.path.startsWith(APPLICATION_ROOT)
    && record.path.endsWith(".tsx")
    && record.relativePath !== "apps/web/src/ui/voice/NoteInput.tsx")
  .map((record) => record.source)
  .join("\n");
const noteInputVariants = [...new Set(
  [...noteInputSource.matchAll(/\bvariant:\s*"([a-z-]+)"/gu)].map((match) => match[1]),
)];
for (const variant of noteInputVariants) {
  const callPattern = new RegExp(`<NoteInput\\b[^>]*\\bvariant="${variant}"`, "u");
  if (!callPattern.test(noteInputCallSource)) {
    violations.push(`apps/web/src/ui/voice/NoteInput.tsx: ${variant} variant has no production caller`);
  }
}
const urlOwnedModes = [
  ["apps/web/src/features/sound-lab/SoundLab.tsx", "explore", "sound", /\[mode,\s*setMode\]/u],
  ["apps/web/src/features/pitch-mirror/PitchMirror.tsx", "practice", "pitch-match", /\[mode,\s*setMode\]/u],
  ["apps/web/src/features/hum-lab/HumLab.tsx", "practice", "hum", /\[mode,\s*setMode\]/u],
  ["apps/web/src/features/pitch-control/PitchControl.tsx", "practice", "pitch-control", /\[envelopeType,\s*setEnvelopeType\]/u],
  ["apps/web/src/features/ear-training/EarLab.tsx", "practice", "note-recognition", /\[mode,\s*setMode\]/u],
  ["apps/web/src/features/intervals/IntervalLab.tsx", "practice", "intervals", /\[exercise,\s*setExercise\]/u],
  ["apps/web/src/features/harmony/HarmonyLab.tsx", "practice", "harmony", /\[(?:view|degreeMode),\s*set/u],
  ["apps/web/src/features/melody/MelodyLab.tsx", "practice", "melody", /\[mode,\s*setMode\]/u],
  ["apps/web/src/features/voice-arcade/VoiceArcade.tsx", "arcade", "", /\[mode,\s*setMode\]/u],
];
for (const [path, surface, activity, obsoleteState] of urlOwnedModes) {
  const source = recordByRelativePath.get(path)?.source ?? "";
  const hasSurface = source.includes(`route.surface === "${surface}"`);
  const hasActivity = activity === "" || source.includes(`route.activity === "${activity}"`);
  if (obsoleteState.test(source) || !hasSurface || !hasActivity) {
    violations.push(`${path}: primary mode must be derived from typed AppRoute`);
  }
}
printArchitectureReport({
  records,
  components,
  reachable,
  violations,
  largestFiles,
  largestComponents,
  complexComponents,
  stateHeavyComponents,
  surfaceHeavyComponents,
  unreachableApplicationFiles,
  reviewedLargeSupportFiles: REVIEWED_LARGE_SUPPORT_FILES,
});
if (enforce && violations.length) process.exitCode = 1;
