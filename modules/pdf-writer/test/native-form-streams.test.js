import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeTaggedArtifacts } from "../index.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";
import { checkSavedSemantics } from "../../../scripts/check-saved-semantics.js";

test("nested, reused and inherited-resource Forms receive distinct stream-scoped ownership", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-form-streams-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "source.pdf"), outputPath = path.join(dir, "candidate.pdf");
  const tagsPath = path.join(dir, "tags.json"), semanticPath = path.join(dir, "semantic.json");
  const bundledJavaHome = path.resolve("modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const jar = path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  const probe = path.resolve("modules/pdf-writer/test/fixtures/NativeFormProbe.java");
  const env = await buildJavaExecEnv({ bundledJavaHome });
  const run = args => promisify(execFile)(java, args, { windowsHide: true, env, timeout: 60000, maxBuffer: 50 * 1024 * 1024 });
  const inspect = async (mode, pdf) => (await run(["-cp", jar, probe, mode, pdf])).stdout.trim().split(/\r?\n/).map(line => {
    const [page, origin, index, text, owner, mcid] = line.split("\t");
    return { page: +page, streamOrigin: origin, opIndexInStream: +index, text, owner, mcid: +mcid };
  });
  const font = path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf");
  await run(["-cp", jar, probe, "create", pdfPath, font]);
  const positions = [
    [[72,72], [82,187], [87,239], [107,267], [327.5,204], [331.25,245.6], [346.25,268], [77,379], [72,450]],
    [[72,20], [82,87], [87,139], [107,167], [305,279], [72,450]]
  ];
  const expected = await inspect("inspect", pdfPath); const perPage = new Map();
  const nodes = expected.map((op, i) => {
    const seq = perPage.get(op.page) || 0; perPage.set(op.page, seq + 1);
    const [x, y] = positions[op.page-1][seq];
    return { id: `n${i}`, sourceBlockId: `b${i}`, pageNumber: op.page, role: "P", text: op.text, bbox: [x-1,y-12,100,16], confidence: 1, readingOrder: seq };
  });
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "forms", source: { layoutDocumentId: "forms" }, nodes }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags", source: { semanticDocumentId: "forms" },
    root: { id: "root", type: "Document", children: nodes.map(n => ({ id: n.id, type: n.role, label: n.text, sourceNodeIds: [n.id], children: [] })) } }));
  const report = await writeTaggedArtifacts({ pdfPath, outputPath, tagsPath, semanticPath, mode: "native" });
  assert.equal(report.matchedOperators, 15);
  const parsed = JSON.parse(await readFile(`${outputPath}.native-operators.json`, "utf8"));
  assert.deepEqual(parsed.pages.flatMap(p => p.operators.map(o => [p.pageNumber,o.streamOrigin,o.opIndexInStream,o.text])),
    expected.map(o => [o.page,o.streamOrigin,o.opIndexInStream,o.text]), "parser paths equal independent lexical traversal");
  const saved = await inspect("verify", outputPath);
  assert.deepEqual(saved.map(o => [o.page,o.text,o.owner]), expected.map((o,i) => [o.page,o.text,`oat:n${i}`]));
  const proof = await checkSavedSemantics({ pdfPath: outputPath, tagsPath, sourcePdfPath: pdfPath, ownershipPath: report.sourceOwnershipPath });
  assert.equal(proof.summary.failed, 0, JSON.stringify(proof.checks.filter(c => c.status === "fail")));
  const validation = await promisify(execFile)(process.execPath, [path.resolve("modules/validator/index.js"), "--pdf", outputPath,
    "--manifest", `${outputPath}.tags.json`], { windowsHide: true, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(JSON.parse(validation.stdout).rawSummary.failedChecks, 0, "saved Form stream ownership passes raw veraPDF");
  assert.match((await run(["-cp",jar,path.resolve("modules/pdf-writer/test/fixtures/NativeOperatorProbe.java"),"pixels",pdfPath,outputPath])).stdout,/All pages pixel-identical/);
  assert.match((await run(["-cp",jar,path.resolve("modules/pdf-writer/test/fixtures/ListSplitProbe.java"),pdfPath,outputPath])).stdout,/Glyph positions and 150 DPI pixels unchanged/);
  const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot: process.cwd() });
  const cp = `${buildDir}${path.delimiter}${jar}`;
  await t.test("a wrong Stm fails saved verification even with the same MCID", async () => {
    const corrupt = path.join(dir,"wrong-stream.pdf");
    await run(["-cp",jar,probe,"swap-stream",outputPath,corrupt]);
    const checked = await checkSavedSemantics({pdfPath:corrupt,tagsPath});
    assert.ok(checked.summary.failed > 0);
    assert.match(JSON.stringify(checked),/MCID_PARENT_TREE_MISMATCH/);
  });
  await t.test("legacy flat-tree CLI also emits reciprocal stream references", async () => {
    const flat = path.join(dir,"flat.pdf");
    await run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",`${outputPath}.native-tag-plan.json`,"--output",flat]);
    assert.deepEqual((await inspect("verify",flat)).map(o => [o.page,o.text]),expected.map(o => [o.page,o.text]));
  });
  await t.test("different sequence numbers cannot steal the same stream operation", async () => {
    const plan = JSON.parse(await readFile(`${outputPath}.native-tag-plan.json`,"utf8"));
    const first = plan.pages[0].assignments[0].operators[0], second = plan.pages[0].assignments[1].operators[0];
    second.streamOrigin = first.streamOrigin; second.opIndexInStream = first.opIndexInStream;
    const bad = path.join(dir,"duplicate-plan.json"), target = path.join(dir,"duplicate.pdf"); await writeFile(bad,JSON.stringify(plan));
    await assert.rejects(run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",bad,"--tags",tagsPath,"--output",target]),/multiple owners/);
    await assert.rejects(access(target),{code:"ENOENT"});
  });
  await t.test("stale stream identity fails before a candidate is saved", async () => {
    const plan = JSON.parse(await readFile(`${outputPath}.native-tag-plan.json`, "utf8"));
    plan.pages[0].assignments[0].operators[0].opIndexInStream += 1000;
    const bad = path.join(dir,"bad-plan.json"), target = path.join(dir,"rejected.pdf"); await writeFile(bad,JSON.stringify(plan));
    await assert.rejects(run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",bad,"--tags",tagsPath,"--output",target]),/No source text operator/);
    await assert.rejects(access(target), {code:"ENOENT"});
  });
  await t.test("cyclic Forms fail within bounded traversal", async () => {
    const cycle = path.join(dir,"cycle.pdf"); await run(["-cp",jar,probe,"create-cycle",cycle,font]);
    await assert.rejects(run(["-cp",cp,"NativeContentStreamParser","--pdf",cycle]),/Cyclic or excessive Form XObject traversal/);
  });
});
