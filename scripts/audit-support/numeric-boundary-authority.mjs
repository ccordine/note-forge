import ts from "typescript";

const WEB_SOURCE_PREFIX = "apps/web/src/";
const NUMERIC_AUTHORITY = "apps/web/src/lib/numeric.ts";
const GENERIC_BOUNDARY_NAMES = new Set([
  "clamp",
  "clamp01",
  "clampPercent",
  "clampSignedUnit",
  "clampUnit",
]);
const LIVE_COORDINATE_SELECTOR = /(?:\.scope-pitch-lane\s*>\s*b|\.nf-voice-needle|\.pitch-tunnel-point|\.echo-voice-cursor|\.song-voice-cursor|\.pitch-slot(?:\.[\w-]+)?\s+i)/u;
const COORDINATE_TRANSITION = /\btransition(?:-property)?\s*:[^;}]*\b(?:all|left|right|top|bottom|transform)\b/iu;

function scriptKind(path) {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function declaredName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

function mathBoundaryOperation(expression) {
  if (
    !ts.isPropertyAccessExpression(expression)
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== "Math"
  ) return null;
  return expression.name.text === "min" || expression.name.text === "max"
    ? expression.name.text
    : null;
}

function containsOppositeBoundaryCall(node, operation) {
  let found = false;
  function visit(candidate) {
    if (found) return;
    if (ts.isCallExpression(candidate)) {
      const nested = mathBoundaryOperation(candidate.expression);
      if (nested && nested !== operation) {
        found = true;
        return;
      }
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

/**
 * Numeric bounds must be reviewable domain decisions, not private feature
 * idioms. The shared helper owns generic saturation syntax; callers still own
 * a named musical, control, physics, geometry, or presentation policy.
 */
export function auditNumericBoundaryAuthority(records) {
  const violations = [];
  for (const record of records) {
    if (record.relativePath.startsWith(WEB_SOURCE_PREFIX) && record.relativePath.endsWith(".css")) {
      for (const rule of record.source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        if (!LIVE_COORDINATE_SELECTOR.test(rule[1]) || !COORDINATE_TRANSITION.test(rule[2])) continue;
        const line = record.source.slice(0, rule.index).split("\n").length;
        violations.push(
          `${record.relativePath}:${line} transitions an authoritative live coordinate; computed marker geometry must identify the current frame immediately`,
        );
      }
      continue;
    }
    if (
      !record.relativePath.startsWith(WEB_SOURCE_PREFIX)
      || !/\.tsx?$/u.test(record.relativePath)
      || record.relativePath === NUMERIC_AUTHORITY
    ) continue;
    const sourceFile = ts.createSourceFile(
      record.relativePath,
      record.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(record.relativePath),
    );
    function visit(node) {
      const name = declaredName(node);
      if (name && GENERIC_BOUNDARY_NAMES.has(name)) {
        violations.push(
          `${record.relativePath}:${lineOf(sourceFile, node)} declares generic numeric boundary ${name}; import the repository authority`,
        );
      }
      if (ts.isCallExpression(node)) {
        const operation = mathBoundaryOperation(node.expression);
        if (
          operation
          && node.arguments.some((argument) => containsOppositeBoundaryCall(argument, operation))
        ) {
          violations.push(
            `${record.relativePath}:${lineOf(sourceFile, node)} hides saturation in nested Math.${operation}/Math.${operation === "min" ? "max" : "min"}; use a named boundary through the repository authority`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return violations;
}
