import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeTaggedArtifacts } from "../../modules/pdf-writer/index.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";
import { checkSavedSemantics } from "../../scripts/check-saved-semantics.js";

test("native ownership stays disjoint across interleaved text, whitespace and inline images", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-ownership-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "source.pdf"), outputPath = path.join(dir, "candidate.pdf");
  const tagsPath = path.join(dir, "tags.json"), semanticPath = path.join(dir, "semantic.json");
  const bundledJavaHome = path.resolve("modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const jar = path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  const probe = path.resolve("modules/pdf-writer/test/fixtures/NativeOwnershipProbe.java");
  const env = await buildJavaExecEnv({ bundledJavaHome });
  const run = (file, args) => promisify(execFile)(java, ["-cp", jar, file, ...args], { windowsHide: true, env, timeout: 60000 });
  await run(probe, ["create", pdfPath, path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")]);
  const nodes = [
    { id: "a", role: "P", text: "Alpha Omega Last", bbox: [72, 80, 140, 66] },
    { id: "b", role: "P", text: "Beta", bbox: [300, 100, 60, 14] }
  ].map((n, readingOrder) => ({ ...n, sourceBlockId: n.id, pageNumber: 1, confidence: 1, readingOrder }));
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "ownership", source: { layoutDocumentId: "ownership" }, nodes }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags", source: { semanticDocumentId: "ownership" },
    root: { id: "root", type: "Document", children: nodes.map(n => ({ id: n.id, type: n.role, label: n.text, sourceNodeIds: [n.id], children: [] })) } }));
  await writeTaggedArtifacts({ pdfPath, outputPath, tagsPath, semanticPath, mode: "native" });
  assert.match((await run(probe, [outputPath])).stdout, /Balanced disjoint ownership/);
  const syntax = path.resolve("modules/pdf-writer/test/fixtures/NativeStreamSyntaxProbe.java");
  assert.match((await run(syntax, [pdfPath, outputPath])).stdout, /150 DPI pixels preserved/);
  assert.equal((await checkSavedSemantics({ pdfPath: outputPath, tagsPath })).summary.failed, 0);
  // A contradictory plan must fail before saving, rather than let the last
  // owner silently steal an operator from another structure element.
  const plan = JSON.parse(await readFile(`${outputPath}.native-tag-plan.json`, "utf8"));
  plan.pages[0].assignments[1].operators.push(plan.pages[0].assignments[0].operators[0]);
  const badPlan = path.join(dir, "conflicting-plan.json"), rejected = path.join(dir, "rejected.pdf");
  await writeFile(badPlan, JSON.stringify(plan));
  const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot: process.cwd() });
  await assert.rejects(promisify(execFile)(java, ["-cp", `${buildDir}${path.delimiter}${jar}`, "NativeContentStreamRewriter",
    "--pdf", pdfPath, "--tags", tagsPath, "--plan", badPlan, "--output", rejected], { windowsHide: true, env, timeout: 60000 }), /multiple owners/);
  await assert.rejects(access(rejected), { code: "ENOENT" });
  await t.test("a later list-body operator resembling its marker stays in the body", async () => {
    const source = path.join(dir, "list.pdf"), candidate = path.join(dir, "list-tagged.pdf");
    await run(probe, ["create-list", source, path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")]);
    await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "ownership", source: { layoutDocumentId: "ownership" },
      nodes: [{ id: "list", sourceBlockId: "list", pageNumber: 1, role: "LI", text: "1. First 1. Literal", bbox: [72, 80, 160, 46], confidence: 1 }] }));
    const leaf = (id, type, text, ids) => ({ id, type, label: text, actualText: text, sourceNodeIds: ids, children: [] });
    await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags", source: { semanticDocumentId: "ownership" },
      root: { id: "root", type: "Document", children: [{ id: "list", type: "L", children: [{ id: "item", type: "LI", children: [
        leaf("label", "Lbl", "1.", []), leaf("body", "LBody", "First 1. Literal", ["list"]) ] }] }] } }));
    await writeTaggedArtifacts({ pdfPath: source, outputPath: candidate, tagsPath, semanticPath, mode: "native" });
    assert.match((await run(probe, ["verify-list", candidate])).stdout, /Only the first operator/);
    assert.match((await run(path.resolve("modules/pdf-writer/test/fixtures/ListSplitProbe.java"), [source, candidate])).stdout, /pixels unchanged/);
    assert.equal((await checkSavedSemantics({ pdfPath: candidate, tagsPath })).summary.failed, 0);
  });
});
