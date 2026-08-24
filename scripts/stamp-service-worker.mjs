import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const distribution = `${root}/dist`;
const workerPath = `${distribution}/sw.js`;
const buildPlaceholder = "__NOTEFORGE_BUILD__";
const precachePlaceholder = "__NOTEFORGE_PRECACHE__";

async function distributionFiles(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await distributionFiles(`${directory}/${entry.name}`, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

const worker = await readFile(workerPath, "utf8");
if (!worker.includes(buildPlaceholder) || !worker.includes(precachePlaceholder)) {
  throw new Error("The built service worker is missing its build or precache placeholder.");
}

const files = (await distributionFiles(distribution)).sort();
const revisionFiles = files.filter((file) => file !== "sw.js" && !file.endsWith(".map"));
for (const required of ["index.html", "manifest.webmanifest", "noteforge-mark.svg"]) {
  if (!revisionFiles.includes(required)) {
    throw new Error(`The production distribution is missing required offline file ${required}.`);
  }
}
const pitchCaptureWorklets = revisionFiles.filter((file) =>
  /^assets\/pitch-capture-worklet-[A-Za-z0-9_-]+\.js$/u.test(file));
if (pitchCaptureWorklets.length !== 1) {
  throw new Error(
    `The production distribution must contain exactly one content-hashed pitch worklet; found ${pitchCaptureWorklets.length}.`,
  );
}
if (revisionFiles.includes("worklets/pitch-capture.js")) {
  throw new Error("The obsolete stable pitch-worklet URL must not ship beside the hashed authority.");
}
if (!revisionFiles.some((file) => file.startsWith("assets/") && file.endsWith(".js"))) {
  throw new Error("The production distribution contains no JavaScript application asset to precache.");
}
if (!revisionFiles.some((file) => file.startsWith("assets/") && file.endsWith(".css"))) {
  throw new Error("The production distribution contains no CSS application asset to precache.");
}

const precache = revisionFiles.map((file) => file === "index.html" ? "/" : `/${file}`);
const revisionHash = createHash("sha256").update(worker);
for (const file of revisionFiles) {
  revisionHash.update(file);
  revisionHash.update(await readFile(`${distribution}/${file}`));
}
const revision = revisionHash.digest("hex").slice(0, 12);
const stamped = worker
  .replaceAll(buildPlaceholder, revision)
  .replaceAll(precachePlaceholder, JSON.stringify(precache));

if (stamped.includes(buildPlaceholder) || stamped.includes(precachePlaceholder)) {
  throw new Error("The service-worker build placeholders were not fully replaced.");
}
await writeFile(workerPath, stamped);

console.log(`Stamped service worker ${revision} with ${precache.length} offline resources.`);
