import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkReaderQualification } from "./check-reader-qualification.js";
import Ajv2020 from "ajv/dist/2020.js";
import corpusSchema from "../contracts/semantic-benchmark.schema.json" with { type: "json" };
import layoutSchema from "../contracts/layout.schema.json" with { type: "json" };

const exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flatten = (n) => [n, ...(n.children || []).flatMap(flatten)];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validateCorpus = new Ajv2020({ allErrors: true }).addSchema(layoutSchema).compile(corpusSchema);

/** Score independently authored semantic expectations; no validator pass is used as an expected answer. */
export function scoreSemanticCase(expected, semantic, tagging) {
  const checks = [], bySource = new Map(semantic.nodes.map((n) => [n.sourceBlockId, n]));
  const tags = flatten(tagging.root), position = new Map(semantic.orderedNodeIds.map((id, i) => [id, i]));
  const id = (source) => bySource.get(source)?.id;
  const add = (dimension, target, pass) => checks.push({ dimension, target, status: pass ? "pass" : "fail" });
  const owner = (source) => tags.find((t) => t.sourceNodeIds?.includes(id(source)));
  for (const [source, role] of Object.entries(expected.roles || {})) add("headings", source, bySource.get(source)?.role === role);
  for (const [a, b] of expected.order || []) add("readingOrder", `${a} -> ${b}`, position.has(id(a)) && position.has(id(b)) && position.get(id(a)) < position.get(id(b)));
  for (const [widget, sources] of Object.entries(expected.labels || {})) {
    const actual = semantic.relations.filter((r) => r.type === "labels" && r.to === `widget:${widget}`).map((r) => r.from).sort();
    add("formLabels", widget, JSON.stringify(actual) === JSON.stringify(sources.map(id).sort()));
  }
  for (const [widget, sources] of Object.entries(expected.descriptions || {})) {
    const actual = semantic.relations.filter((r) => r.type === "describes" && r.to === `widget:${widget}`).map((r) => r.from).sort();
    add("formInstructions", widget, JSON.stringify(actual) === JSON.stringify(sources.map(id).sort()));
  }
  for (const [a, b] of expected.sameList || []) add("lists", `${a},${b}`, Boolean(bySource.get(a)?.listGroupId) && bySource.get(a).listGroupId === bySource.get(b)?.listGroupId);
  for (const [a, b] of expected.separateLists || []) add("lists", `${a},${b}`, Boolean(bySource.get(a)?.listGroupId) && Boolean(bySource.get(b)?.listGroupId) && bySource.get(a).listGroupId !== bySource.get(b).listGroupId);
  for (const [a, b] of expected.sameParagraph || []) add("paragraphs", `${a},${b}`, Boolean(bySource.get(a)?.paragraphGroupId) && bySource.get(a).paragraphGroupId === bySource.get(b)?.paragraphGroupId);
  for (const [a, b] of expected.listBodies || []) add("lists", `${a},${b}`, bySource.get(b)?.listContinuationOf === id(a));
  for (const [source, numbering] of Object.entries(expected.listNumbering || {})) {
    const list = tags.filter((t) => t.type === "L" && flatten(t).some((n) => n.sourceNodeIds?.includes(id(source)))).at(-1);
    add("listNumbering", source, list?.listNumbering === numbering);
  }
  for (const [type, count] of Object.entries(expected.tagCounts || {})) add("tagStructure", type, tags.filter((t) => t.type === type).length === count);
  for (const [source, sources] of Object.entries(expected.headers || {})) {
    const actual = owner(source)?.tableAttrs?.Headers || [];
    const target = sources.map((s) => owner(s)?.headerId);
    add("tableHeaders", source, target.every(Boolean) && JSON.stringify([...actual].sort()) === JSON.stringify(target.sort()));
  }
  for (const code of expected.reviewCodes || []) add("ambiguityReview", code, semantic.semanticReviewTasks.some((t) => t.code === code));
  for (const n of semantic.nodes.filter((n) => n.role !== "Artifact"))
    add("contentOwnership", n.sourceBlockId, tags.filter((t) => t.sourceNodeIds?.includes(n.id)).length === 1);
  return checks;
}

export async function runSemanticBenchmark({ manifestPath = path.join(root, "test/fixtures/semantic-quality-corpus.json"), pdfPath, readerEvidencePath, requireReader = false } = {}) {
  const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
  if (!validateCorpus(manifest) || new Set(manifest.cases.map((c) => c.id)).size !== manifest.cases.length)
    throw new Error("Benchmark requires unique, nonempty cases with explicit expectations");
  const temp = await mkdtemp(path.join(os.tmpdir(), "semantic-benchmark-"));
  const cases = [];
  try {
    for (let index = 0; index < manifest.cases.length; index++) {
      const c = manifest.cases[index], layout = path.join(temp, `${index}-layout.json`), semantic = path.join(temp, `${index}-semantic.json`), ordered = path.join(temp, `${index}-ordered.json`);
      await writeFile(layout, JSON.stringify(c.layout));
      const run = async (script, input) => (await exec(process.execPath, [path.join(root, script), input], { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout;
      await writeFile(semantic, await run("modules/semantic-engine/index.js", layout));
      const orderedJson = await run("modules/reading-order/index.js", semantic); await writeFile(ordered, orderedJson);
      const tagging = JSON.parse(await run("modules/tag-builder/index.js", ordered));
      const checks = scoreSemanticCase(c.expected, JSON.parse(orderedJson), tagging);
      cases.push({ id: c.id, provenance: c.provenance || "unspecified", expertReview: c.expertReview || "pending", checks, status: checks.some((k) => k.status === "fail") ? "fail" : "pass" });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  const dimensions = {};
  for (const c of cases) for (const k of c.checks) {
    const count = dimensions[k.dimension] ||= { passed: 0, failed: 0 };
    count[k.status === "pass" ? "passed" : "failed"]++;
  }
  let reader = { status: "pending", reason: "No human reader observation was supplied" };
  if (readerEvidencePath) {
    if (!pdfPath) throw new Error("Reader evidence requires --pdf for exact candidate binding");
    const evidence = JSON.parse(await readFile(readerEvidencePath, "utf8"));
    reader = await checkReaderQualification(pdfPath, evidence);
    if (requireReader && reader.status === "recorded" && evidence.sessions.some((s) => !s.viewer || !s.viewerVersion))
      reader = { status: "incomplete", reason: "Release qualification requires the PDF viewer and its version for every reader session" };
  }
  const candidateHash = pdfPath ? hash(await readFile(pdfPath)) : null;
  if (reader.status === "recorded" && reader.candidateHash !== candidateHash) reader = { status: "stale", reason: "PDF changed during qualification" };
  const automaticPass = cases.every((c) => c.status === "pass");
  const expertReviewComplete = manifest.cases.every((c) => c.expertReview === "reviewed" && typeof c.reviewer === "string" && c.reviewer.trim() && typeof c.reviewedAt === "string" && Number.isFinite(Date.parse(c.reviewedAt)));
  return { schemaVersion: "1.0.0", manifestSha256: hash(bytes), automaticStatus: automaticPass ? "pass" : "fail", dimensions, cases, reader, expertReviewComplete,
    candidateHash,
    disposition: !automaticPass ? "rejected" : requireReader && (reader.status !== "recorded" || !expertReviewComplete) ? "review_required" : "automated_pass",
    limitations: ["Synthetic references establish regression behavior; independent expert review remains explicit.", "Reader evidence is recorded against exact PDF bytes; automated results do not establish observed assistive-technology behavior."] };
}
async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!["--manifest", "--output", "--pdf", "--reader-evidence", "--require-reader"].includes(process.argv[i]) || !process.argv[i + 1] || args.has(process.argv[i])) throw new Error("Invalid benchmark arguments");
    args.set(process.argv[i], process.argv[i + 1]);
  }
  if (args.has("--require-reader") && !["true", "false"].includes(args.get("--require-reader"))) throw new Error("Invalid --require-reader value");
  const result = await runSemanticBenchmark({ manifestPath: args.get("--manifest"), pdfPath: args.get("--pdf"), readerEvidencePath: args.get("--reader-evidence"), requireReader: args.get("--require-reader") === "true" });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.has("--output")) {
    const output = path.resolve(args.get("--output"));
    if ([args.get("--manifest") || path.join(root, "test/fixtures/semantic-quality-corpus.json"), args.get("--pdf"), args.get("--reader-evidence")].filter(Boolean).some((p) => path.resolve(p).toLowerCase() === output.toLowerCase())) throw new Error("Benchmark output must not overwrite an input");
    await writeFile(output, json);
  }
  process.stdout.write(json);
  if (result.disposition === "rejected") process.exitCode = 1;
  else if (result.disposition === "review_required") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
