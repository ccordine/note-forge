import ts from "typescript";

const FEATURE_PREFIX = "apps/web/src/features/";
const AUTOMATIC_EVENT_NAMES = new Set([
  "onAnimationEnd",
  "onCanPlay",
  "onChange",
  "onEnded",
  "onError",
  "onFrame",
  "onInput",
  "onLoadedData",
  "onLoadedMetadata",
  "onPause",
  "onPlaying",
  "onTimeUpdate",
  "onTransitionEnd",
]);
const BASE_LIFETIME_ACTIONS = new Set([
  "begin",
  "cancel",
  "finish",
  "install",
  "launch",
  "recording-started",
  "restart",
  "run-started",
  "run-finished",
  "start",
  "stop",
]);
const CONTRACT_LIFETIME_ACTIONS = new Set([
  "change-loadout",
  "clear-track",
  "fresh",
  "recalibrate",
  "reset",
  "return-loadout",
  "select-mode",
]);
const BASE_LIFETIME_METHODS = new Set([
  "begin",
  "endActiveRound",
  "finish",
  "install",
  "launch",
  "requestRecorderStop",
  "resume",
  "resumePlayback",
  "start",
  "stop",
  "stopRecording",
]);
const CONTRACT_LIFETIME_METHODS = new Set([
  "changeLoadout",
  "clearTrack",
  "fresh",
  "recalibrate",
  "reset",
  "resetToSetup",
  "returnLoadout",
  "returnToLoadout",
]);

/**
 * The terminal field is intentionally the public live-session field, not an
 * inner course/checkpoint/playback field. Course completion may be recorded;
 * it may not terminate the surrounding user-owned session.
 */
export const USER_OWNED_LIVE_SESSION_CONTRACTS = Object.freeze([
  Object.freeze({
    path: "apps/web/src/features/training-session/attempt-runner.ts",
    reducer: "reduceAttemptRunner",
    terminalField: "status",
    terminalValues: ["complete", "idle"],
    allowedActions: ["finish", "reset"],
    requiredActions: ["finish"],
    activeField: "status",
    activeValues: ["tracking"],
    initialState: "createIdleAttemptRunner",
    requiredStartActions: ["begin"],
    scopePrefixes: [
      "apps/web/src/features/hum-lab/",
      "apps/web/src/features/pitch-control/",
      "apps/web/src/features/pitch-mirror/",
      "apps/web/src/features/training-session/",
    ],
  }),
  Object.freeze({
    path: "apps/web/src/features/range-simulator/controller.ts",
    reducer: "reduceRangeSimulatorController",
    terminalField: "status",
    terminalValues: ["complete", "idle"],
    allowedActions: ["finish", "fresh", "hydrate"],
    requiredActions: ["finish"],
    activeField: "status",
    activeValues: ["tracking"],
    initialState: "createRangeSimulatorController",
    requiredStartActions: ["begin"],
    forbiddenStartActions: ["hydrate"],
  }),
  Object.freeze({
    path: "apps/web/src/features/pitch-tunnel/pitch-tunnel-engine.ts",
    reducer: "reducePitchTunnel",
    terminalField: "status",
    terminalValues: ["complete", "idle"],
    allowedActions: ["finish", "reset", "start"],
    requiredActions: ["finish"],
    activeField: "status",
    activeValues: ["tracking"],
    initialState: "createPitchTunnel",
    requiredStartActions: ["start"],
  }),
  Object.freeze({
    path: "apps/web/src/features/range-loop/range-loop-session.ts",
    reducer: "reduceRangeLoopLiveState",
    terminalField: "phase",
    terminalValues: ["complete"],
    allowedActions: ["finish"],
    requiredActions: ["finish"],
    activeField: "phase",
    activeValues: ["tracking"],
    initialState: "createRangeLoopLiveState",
    requiredStartActions: ["start"],
  }),
  Object.freeze({
    path: "apps/web/src/features/voice-arcade/pattern-challenge-controller.ts",
    reducer: "reducePatternChallenge",
    terminalField: "phase",
    terminalValues: ["result", "setup"],
    allowedActions: ["change-loadout", "next-round", "prepare", "select-mode", "stop"],
    requiredActions: ["stop"],
    activeField: "phase",
    activeValues: ["playing"],
    initialState: "createPatternChallengeController",
    requiredStartActions: ["begin"],
  }),
  Object.freeze({
    path: "apps/web/src/features/voice-arcade/pitch-maze-session.ts",
    reducer: "reducePitchMazeSession",
    terminalField: "phase",
    terminalValues: ["campaign-result", "setup"],
    allowedActions: ["finish", "reset", "set-mapping", "start"],
    requiredActions: ["finish"],
    activeField: "phase",
    activeValues: ["playing"],
    initialState: "createPitchMazeSession",
    requiredStartActions: ["start"],
  }),
  Object.freeze({
    path: "apps/web/src/features/voice-arcade/pitch-pong-session.ts",
    reducer: "reducePitchPongState",
    terminalField: "phase",
    terminalValues: ["result", "setup"],
    allowedActions: ["cancel", "finish", "reset"],
    requiredActions: ["finish"],
    activeField: "phase",
    activeValues: ["countdown", "playing"],
    initialState: "createPitchPongState",
    requiredStartActions: ["start"],
  }),
  Object.freeze({
    path: "apps/web/src/features/voice-arcade/resonance-session.ts",
    reducer: "reduceResonanceSession",
    terminalField: "phase",
    terminalValues: ["complete"],
    allowedActions: ["finish"],
    requiredActions: ["finish"],
    activeField: "phase",
    activeValues: ["tracking"],
    initialState: "createResonanceSession",
  }),
  Object.freeze({
    path: "apps/web/src/features/voice-arcade/song-ride-session.ts",
    reducer: "reduceSongRideSession",
    terminalField: "phase",
    terminalValues: ["result"],
    allowedActions: ["run-finished"],
    requiredActions: ["run-finished"],
    activeField: "phase",
    activeValues: ["playing"],
    requiredStartActions: ["run-started"],
  }),
  Object.freeze({
    path: "apps/web/src/features/voice-arcade/vocal-flight/vocal-flight-session.ts",
    reducer: "reduceVocalFlightSession",
    terminalField: "phase",
    terminalValues: ["calibration", "complete"],
    allowedActions: ["finish", "recalibrate", "return-loadout"],
    requiredActions: ["finish"],
    activeField: "phase",
    activeValues: ["flying"],
    initialState: "createVocalFlightSession",
    requiredStartActions: ["launch"],
  }),
  Object.freeze({
    path: "apps/web/src/features/voice-arcade/voice-draw-engine.ts",
    reducer: "reduceVoiceDrawSession",
    terminalField: "phase",
    terminalValues: ["complete", "idle"],
    allowedActions: ["finish"],
    requiredActions: ["finish"],
    activeField: "phase",
    activeValues: ["drawing"],
    initialState: "createVoiceDrawState",
    requiredStartActions: ["start"],
  }),
]);

function scriptKind(path) {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return node.getText();
}

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function actionLiteral(node) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property)
      && propertyName(property.name) === "type"
      && ts.isStringLiteral(property.initializer)
    ) return property.initializer.text;
  }
  return null;
}

function containsString(node, values) {
  let found = false;
  function visit(child) {
    if (found) return;
    if (ts.isStringLiteral(child) && values.has(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function localFunctions(sourceFile) {
  const functions = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) functions.set(node.name.text, node.initializer);
    if (ts.isMethodDeclaration(node) && node.name) functions.set(propertyName(node.name), node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return functions;
}

function functionNode(functions, name) {
  return functions.get(name) ?? null;
}

function namedDeclarationRoot(sourceFile, functions, name) {
  const callable = functionNode(functions, name);
  if (callable) return callable;
  let found = null;
  function visit(node) {
    if (found) return;
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
      && node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function reachesTerminal(root, contract, functions, visited = new Set()) {
  let reached = false;
  const callees = new Set();
  const terminalValues = new Set(contract.terminalValues);
  function visit(node) {
    if (reached) return;
    if (
      ts.isPropertyAssignment(node)
      && propertyName(node.name) === contract.terminalField
      && containsString(node.initializer, terminalValues)
    ) {
      reached = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (name) callees.add(name);
    }
    if (node !== root && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(root);
  if (reached) return true;
  for (const callee of callees) {
    if (visited.has(callee)) continue;
    const target = functionNode(functions, callee);
    if (!target) continue;
    const nextVisited = new Set(visited).add(callee);
    if (reachesTerminal(target, contract, functions, nextVisited)) return true;
  }
  return false;
}

function actionFromCondition(expression) {
  if (!ts.isBinaryExpression(expression)) return null;
  if (
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    && expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
  ) return null;
  const candidates = [[expression.left, expression.right], [expression.right, expression.left]];
  for (const [property, literal] of candidates) {
    if (
      ts.isPropertyAccessExpression(property)
      && property.name.text === "type"
      && ts.isStringLiteral(literal)
    ) return literal.text;
  }
  return null;
}

function reducerBranches(reducer) {
  const branches = [];
  function visit(node) {
    if (ts.isSwitchStatement(node) && /\.type$/u.test(node.expression.getText())) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
          branches.push({ action: clause.expression.text, root: clause });
        }
      }
    }
    if (ts.isIfStatement(node)) {
      const action = actionFromCondition(node.expression);
      if (action) branches.push({ action, root: node.thenStatement });
    }
    ts.forEachChild(node, visit);
  }
  visit(reducer);
  return branches;
}

function containsLifetimeControl(root, options = {}, visited = new Set()) {
  if (ts.isIdentifier(root)) {
    if (options.lifetimeMethods?.has(root.text)) return `${root.text}()`;
    const target = options.functions?.get(root.text);
    if (target && !visited.has(root.text)) {
      return containsLifetimeControl(
        target,
        { ...options, skipReturnedCleanup: false },
        new Set(visited).add(root.text),
      );
    }
  }
  if (ts.isPropertyAccessExpression(root) && options.lifetimeMethods?.has(root.name.text)) {
    return `${root.name.text}()`;
  }
  if (ts.isConditionalExpression(root)) {
    return containsLifetimeControl(root.whenTrue, options, visited)
      ?? containsLifetimeControl(root.whenFalse, options, visited);
  }
  if (
    options.skipReturnedCleanup
    && (ts.isArrowFunction(root) || ts.isFunctionExpression(root))
    && root.body
    && (ts.isArrowFunction(root.body) || ts.isFunctionExpression(root.body))
  ) return null;
  let found = null;
  function visit(node) {
    if (found) return;
    if (options.skipReturnedCleanup && ts.isReturnStatement(node)) return;
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (name && options.lifetimeMethods?.has(name)) {
        found = `${name}()`;
        return;
      }
      for (const argument of node.arguments) {
        const action = actionLiteral(argument);
        if (action && options.lifetimeActions?.has(action)) {
          found = `action ${JSON.stringify(action)}`;
          return;
        }
      }
      const target = name && options.functions?.get(name);
      if (name && target && !visited.has(name)) {
        const operation = containsLifetimeControl(
          target,
          { ...options, skipReturnedCleanup: false },
          new Set(visited).add(name),
        );
        if (operation) {
          found = operation;
          return;
        }
      }
    }
    if (node !== root && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function callbackArgument(call) {
  const candidate = call.arguments[0];
  return candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
    ? candidate
    : null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function automaticContextViolations(record, sourceFile, lifetimeActions, lifetimeMethods) {
  const violations = [];
  const functions = localFunctions(sourceFile);
  function report(node, context, operation) {
    violations.push(
      `${record.relativePath}:${lineOf(sourceFile, node)} ${context} invokes live-lifetime ${operation}`,
    );
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      const callback = callbackArgument(node);
      if (callback && (
        name === "setTimeout"
        || name === "setInterval"
        || name === "requestAnimationFrame"
        || name === "queueMicrotask"
        || name === "then"
        || name === "catch"
        || name === "finally"
      )) {
        const operation = containsLifetimeControl(callback, { functions, lifetimeActions, lifetimeMethods });
        if (operation) report(node, `${name} callback`, operation);
      }
      if (callback && (name === "useEffect" || name === "useLayoutEffect")) {
        const operation = containsLifetimeControl(callback, {
          functions,
          lifetimeActions,
          lifetimeMethods,
          skipReturnedCleanup: true,
        });
        if (operation) report(node, `${name} body`, operation);
        // The effect callback was analyzed as a unit, including the explicit
        // navigation/unmount-cleanup exemption. Do not independently re-walk
        // timers nested inside its returned cleanup.
        return;
      }
    }
    if (
      ts.isPropertyAssignment(node)
      && AUTOMATIC_EVENT_NAMES.has(propertyName(node.name))
    ) {
      const operation = containsLifetimeControl(node.initializer, {
        functions,
        lifetimeActions,
        lifetimeMethods,
      });
      if (operation) report(node, `${propertyName(node.name)} callback`, operation);
    }
    if (
      ts.isJsxAttribute(node)
      && AUTOMATIC_EVENT_NAMES.has(node.name.getText(sourceFile))
      && node.initializer
      && ts.isJsxExpression(node.initializer)
      && node.initializer.expression
    ) {
      const operation = containsLifetimeControl(node.initializer.expression, {
        functions,
        lifetimeActions,
        lifetimeMethods,
      });
      if (operation) report(node, `${node.name.getText(sourceFile)} handler`, operation);
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      && node.name
      && /(?:fail.*storage|storage.*fail)/iu.test(propertyName(node.name))
    ) {
      const operation = containsLifetimeControl(node, { functions, lifetimeActions, lifetimeMethods });
      if (operation) report(node, "storage-failure path", operation);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

export function auditUserOwnedLiveLifetime(records, contracts = USER_OWNED_LIVE_SESSION_CONTRACTS) {
  const violations = [];
  const recordsByPath = new Map(records.map((record) => [record.relativePath, record]));
  const registeredPaths = new Set(contracts.map((contract) => contract.path));

  function inContractScope(relativePath) {
    return contracts.some((contract) => {
      const slash = contract.path.lastIndexOf("/");
      const defaultPrefix = slash >= 0 ? contract.path.slice(0, slash + 1) : "";
      const prefixes = contract.scopePrefixes ?? [defaultPrefix];
      return relativePath === contract.path || prefixes.some((prefix) => relativePath.startsWith(prefix));
    });
  }

  for (const record of records) {
    if (!record.relativePath.startsWith(FEATURE_PREFIX) || !/\.[cm]?[jt]sx?$/u.test(record.relativePath)) continue;
    const sourceFile = ts.createSourceFile(
      record.relativePath,
      record.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(record.relativePath),
    );
    const lifetimeActions = new Set(BASE_LIFETIME_ACTIONS);
    const lifetimeMethods = new Set(BASE_LIFETIME_METHODS);
    if (inContractScope(record.relativePath)) {
      for (const action of CONTRACT_LIFETIME_ACTIONS) lifetimeActions.add(action);
      for (const method of CONTRACT_LIFETIME_METHODS) lifetimeMethods.add(method);
      for (const contract of contracts) {
        for (const action of contract.allowedActions ?? []) lifetimeActions.add(action);
        for (const action of contract.requiredStartActions ?? []) lifetimeActions.add(action);
        for (const action of contract.forbiddenStartActions ?? []) lifetimeActions.add(action);
      }
    }
    violations.push(...automaticContextViolations(
      record,
      sourceFile,
      lifetimeActions,
      lifetimeMethods,
    ));
    const looksLikeUnregisteredLiveReducer = /type:\s*["'](?:observation|frame|sample)["']/u.test(record.source)
      && /type:\s*["'](?:finish|stop)["']/u.test(record.source)
      && /(?:phase|status):\s*["'](?:complete|result|campaign-result)["']/u.test(record.source);
    if (looksLikeUnregisteredLiveReducer && !registeredPaths.has(record.relativePath)) {
      violations.push(`${record.relativePath}: observation-driven terminal reducer lacks a user-owned lifetime contract`);
    }
  }

  for (const contract of contracts) {
    const record = recordsByPath.get(contract.path);
    if (!record) {
      violations.push(`${contract.path}: user-owned lifetime contract points to a missing source`);
      continue;
    }
    const sourceFile = ts.createSourceFile(
      contract.path,
      record.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(contract.path),
    );
    const functions = localFunctions(sourceFile);
    const reducer = functionNode(functions, contract.reducer);
    if (!reducer) {
      violations.push(`${contract.path}: contracted reducer ${contract.reducer} is missing`);
      continue;
    }
    const branches = reducerBranches(reducer);
    const allowed = new Set(contract.allowedActions);
    for (const branch of branches) {
      if (!allowed.has(branch.action) && reachesTerminal(branch.root, contract, functions)) {
        violations.push(
          `${contract.path}: ${contract.reducer} action ${JSON.stringify(branch.action)} can reach terminal ${contract.terminalField}`,
        );
      }
    }
    for (const action of contract.requiredActions) {
      const branch = branches.find((candidate) => candidate.action === action);
      if (!branch || !reachesTerminal(branch.root, contract, functions)) {
        violations.push(
          `${contract.path}: explicit ${JSON.stringify(action)} no longer owns a terminal ${contract.terminalField} transition`,
        );
      }
    }
    if (contract.initialState && contract.activeField && contract.activeValues) {
      const initializer = namedDeclarationRoot(sourceFile, functions, contract.initialState);
      if (!initializer) {
        violations.push(`${contract.path}: contracted initial state ${contract.initialState} is missing`);
      } else if (reachesTerminal(initializer, {
        terminalField: contract.activeField,
        terminalValues: contract.activeValues,
      }, functions)) {
        violations.push(
          `${contract.path}: initial state ${contract.initialState} can enter active ${contract.activeField}`,
        );
      }
    }
    if (contract.activeField && contract.activeValues) {
      const activeContract = {
        terminalField: contract.activeField,
        terminalValues: contract.activeValues,
      };
      for (const action of contract.requiredStartActions ?? []) {
        const branch = branches.find((candidate) => candidate.action === action);
        if (!branch || !reachesTerminal(branch.root, activeContract, functions)) {
          violations.push(
            `${contract.path}: explicit ${JSON.stringify(action)} no longer owns an active ${contract.activeField} transition`,
          );
        }
      }
      for (const action of contract.forbiddenStartActions ?? []) {
        const branch = branches.find((candidate) => candidate.action === action);
        if (branch && reachesTerminal(branch.root, activeContract, functions)) {
          violations.push(
            `${contract.path}: non-user ${JSON.stringify(action)} can enter active ${contract.activeField}`,
          );
        }
      }
    }
  }
  return violations;
}
