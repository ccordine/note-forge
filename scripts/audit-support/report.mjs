function formatTable(headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index]).length),
  ));
  const formatRow = (row) => row
    .map((cell, index) => String(cell).padEnd(widths[index]))
    .join("  ");
  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
  ].join("\n");
}

export function printArchitectureReport(report) {
  const {
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
    reviewedLargeSupportFiles,
  } = report;
  console.log("NoteForge architecture inventory\n");
  console.log(`Scanned ${records.length} source files and ${components.length} JSX components.`);
  console.log(`Application import graph reaches ${reachable.size} files from apps/web/src/main.tsx.`);
  console.log(`Violations: ${violations.length}.\n`);
  console.log("Largest source files");
  console.log(formatTable(["lines", "file"], largestFiles.map((record) => [record.lines, record.relativePath])));
  console.log("\nLargest JSX components");
  console.log(formatTable(
    ["lines", "branches", "depth", "state/ref/effect", "component"],
    largestComponents.map((component) => [
      component.lines,
      component.branches,
      component.maximumControlDepth,
      `${component.hooks.state}/${component.hooks.ref}/${component.hooks.effect}`,
      `${component.path}:${component.startLine} ${component.name}`,
    ]),
  ));
  console.log("\nDeepest/branch-heaviest JSX components");
  console.log(formatTable(
    ["depth", "branches", "ternaries", "nested render", "lines", "component"],
    complexComponents.map((component) => [
      component.maximumControlDepth,
      component.branches,
      component.conditionalExpressions,
      component.nestedConditionalRenders,
      component.lines,
      `${component.path}:${component.startLine} ${component.name}`,
    ]),
  ));
  console.log("\nMost React state/lifecycle-heavy components");
  console.log(formatTable(
    ["state", "refs", "effects", "timers", "lines", "workflow state", "component"],
    stateHeavyComponents.map((component) => [
      component.hooks.state,
      component.hooks.ref,
      component.hooks.effect,
      component.timers,
      component.lines,
      component.stateNames
        .filter((name) => /(?:phase|mode|step|screen|stage|status|view|session|running)/iu.test(name))
        .join(",") || "—",
      `${component.path}:${component.startLine} ${component.name}`,
    ]),
  ));
  console.log("\nDensest JSX page surfaces");
  console.log(formatTable(
    ["panels", "details", "headings", "buttons", "selects", "lines", "component"],
    surfaceHeavyComponents.map((component) => [
      component.surface.panels,
      component.surface.details,
      component.surface.headings,
      component.surface.buttons,
      component.surface.selects,
      component.lines,
      `${component.path}:${component.startLine} ${component.name}`,
    ]),
  ));
  console.log("\nApplication source files unreachable from main.tsx");
  console.log(unreachableApplicationFiles.length
    ? unreachableApplicationFiles.map((record) => `- ${record.relativePath}`).join("\n")
    : "None.");
  console.log("\nFeature raw-stream reads");
  const featureRawStreamReads = records.filter((record) =>
    record.relativePath.startsWith("apps/web/src/features/") && record.rawInputStreamCalls?.length);
  console.log(featureRawStreamReads.length
    ? featureRawStreamReads.map((record) => `- ${record.relativePath}: UNAPPROVED`).join("\n")
    : "None.");
  console.log("\nReviewed large support boundaries");
  console.log([...reviewedLargeSupportFiles]
    .map(([path, boundary]) => `- ${path}: ${boundary}`)
    .join("\n"));
  console.log("\nEnforced architecture violations");
  console.log(violations.length
    ? violations.map((violation) => `- ${violation}`).join("\n")
    : "None.");
}
