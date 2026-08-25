import ts from "typescript";

const WEB_SOURCE_PREFIX = "apps/web/src/";
const CONTINUITY_AUTHORITY = "apps/web/src/realtime/observation-continuity.ts";
const TRANSPORT_AUTHORITIES = new Set([
  "apps/web/src/audio/microphone.ts",
  "apps/web/src/audio/note-input.ts",
]);
const STREAM_FIELDS = new Set([
  "sampleRate",
  "captureEpoch",
  "continuityEpoch",
  "graphGeneration",
]);
const SAMPLE_FIELDS = new Set([
  "startSample",
  "endSample",
  "processedSampleCount",
  "workletProcessCount",
]);
const COMPARISON_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function scriptKind(path) {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) current = current.expression;
  return current;
}

function directCoordinate(expression, sourceFile) {
  const value = unwrap(expression);
  if (!ts.isPropertyAccessExpression(value)) return null;
  const field = value.name.text;
  if (!STREAM_FIELDS.has(field) && !SAMPLE_FIELDS.has(field)) return null;
  return {
    field,
    owner: value.expression.getText(sourceFile),
  };
}

function coordinate(expression, sourceFile, aliases) {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return aliases.get(value.text) ?? null;
  return directCoordinate(value, sourceFile);
}

function collectAliases(sourceFile) {
  const aliases = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const source = directCoordinate(node.initializer, sourceFile);
        if (source) aliases.set(node.name.text, source);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const property = element.propertyName?.getText(sourceFile) ?? element.name.text;
          if (!STREAM_FIELDS.has(property) && !SAMPLE_FIELDS.has(property)) continue;
          aliases.set(element.name.text, {
            field: property,
            owner: node.initializer.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return aliases;
}

function containsExpectedHopConstant(node) {
  let found = false;
  function visit(candidate) {
    if (found) return;
    if (
      ts.isIdentifier(candidate)
      && /(?:ANALYSIS_HOP|CAPTURE_HOP|EXPECTED_HOP|HOP_SECONDS)/u.test(candidate.text)
    ) {
      found = true;
      return;
    }
    if (ts.isNumericLiteral(candidate) && Number(candidate.text) === 0.02) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

function containsSampleRate(node) {
  let found = false;
  function visit(candidate) {
    if (found) return;
    if (
      (ts.isIdentifier(candidate) && candidate.text === "sampleRate")
      || (ts.isPropertyAccessExpression(candidate) && candidate.name.text === "sampleRate")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

/**
 * Features may consume the central continuity result; they may not recreate
 * epoch identity, sample ordering, or the expected overlapping detector hop.
 */
export function auditObservationContinuityAuthority(records) {
  const violations = [];
  for (const record of records) {
    if (
      !record.relativePath.startsWith(WEB_SOURCE_PREFIX)
      || !/\.tsx?$/u.test(record.relativePath)
      || record.relativePath === CONTINUITY_AUTHORITY
      || TRANSPORT_AUTHORITIES.has(record.relativePath)
    ) continue;
    const sourceFile = ts.createSourceFile(
      record.relativePath,
      record.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(record.relativePath),
    );
    const aliases = collectAliases(sourceFile);
    function visit(node) {
      if (ts.isBinaryExpression(node)) {
        const left = coordinate(node.left, sourceFile, aliases);
        const right = coordinate(node.right, sourceFile, aliases);
        if (
          COMPARISON_OPERATORS.has(node.operatorToken.kind)
          && left !== null
          && right !== null
          && left.field === right.field
          && left.owner !== right.owner
          && STREAM_FIELDS.has(left.field)
        ) {
          violations.push(
            `${record.relativePath}:${lineOf(sourceFile, node)} recreates ${left.field} stream identity; use observationContinuity()/sameObservationStream()`,
          );
        }
        if (
          node.operatorToken.kind === ts.SyntaxKind.MinusToken
          && left !== null
          && right !== null
          && left.field === right.field
          && left.owner !== right.owner
          && SAMPLE_FIELDS.has(left.field)
        ) {
          violations.push(
            `${record.relativePath}:${lineOf(sourceFile, node)} recreates ${left.field} sample delta; use observationContinuity().deltaSamples/deltaSeconds`,
          );
        }
        if (
          node.operatorToken.kind === ts.SyntaxKind.AsteriskToken
          && containsSampleRate(node)
          && containsExpectedHopConstant(node)
        ) {
          violations.push(
            `${record.relativePath}:${lineOf(sourceFile, node)} recreates the detector hop; use observationContinuity()`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return violations;
}
