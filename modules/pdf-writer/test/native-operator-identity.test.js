import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeTaggedArtifacts, ensureJavaHelperCompiled } from "../index.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";
import { checkSavedSemantics } from "../../../scripts/check-saved-semantics.js";

test("lexical operator identities survive TD and both quote operators across content streams", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "source.pdf"), outputPath = path.join(dir, "candidate.pdf");
  const tagsPath = path.join(dir, "tags.json"), semanticPath = path.join(dir, "semantic.json");
  const operatorsPath = path.join(dir, "operators.json");
  const bundledJavaHome = path.resolve("modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const jar = path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  const probe = path.resolve("modules/pdf-writer/test/fixtures/NativeOperatorProbe.java");
  const env = await buildJavaExecEnv({ bundledJavaHome });
  const run = args => promisify(execFile)(java, args, { windowsHide: true, env, timeout: 60000 });
  const inspect = async pdf => (await run(["-cp", jar, probe, "inspect", pdf])).stdout.trim().split(/\r?\n/).map(line => {
    const [page, seq, index, op, text, owner] = line.split("\t");
    return { page: +page, seq: +seq, opIndexInStream: +index, op, text, owner };
  });
  await run(["-cp", jar, probe, "create", pdfPath, path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")]);
  await ensureJavaHelperCompiled();
  const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot: process.cwd() });
  await run(["-cp", `${buildDir}${path.delimiter}${jar}`, "NativeContentStreamParser", "--pdf", pdfPath, "--output", operatorsPath]);
  const parsed = JSON.parse(await readFile(operatorsPath, "utf8"));
  const expected = await inspect(pdfPath);
  const actual = parsed.pages.flatMap(page => page.operators.map(op => ({
    page: page.pageNumber, seq: op.seq, opIndexInStream: op.opIndexInStream, op: op.op, text: op.text, owner: "-"
  })));
  assert.equal(expected.length, 12);
  assert.deepEqual(actual, expected, "engine identities equal the independent lexical token walk");
  assert.deepEqual(parsed.pages[0].operators.map(op => op.y), [72, 96, 120, 144, 168, 192]);
  const nodes = expected.map(op => ({ id: `p${op.page}-s${op.seq}`, sourceBlockId: `b${op.page}-${op.seq}`,
    pageNumber: op.page, role: "P", text: op.text, bbox: [72, 60 + op.seq * 24, 220, 16], confidence: 1, readingOrder: op.seq }));
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "identity", source: { layoutDocumentId: "identity" }, nodes }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags", source: { semanticDocumentId: "identity" },
    root: { id: "root", type: "Document", children: nodes.map(n => ({ id: n.id, type: n.role, label: n.text, sourceNodeIds: [n.id], children: [] })) } }));
  await writeTaggedArtifacts({ pdfPath, outputPath, tagsPath, semanticPath, mode: "native" });
  const saved = await inspect(outputPath);
  assert.deepEqual(saved.map(op => [op.page, op.seq, op.op, op.text, op.owner]),
    expected.map(op => [op.page, op.seq, op.op, op.text, `oat:p${op.page}-s${op.seq}`]), "every saved text operation has its intended parent");
  assert.equal((await checkSavedSemantics({ pdfPath: outputPath, tagsPath })).summary.failed, 0);
  assert.match((await run(["-cp", jar, probe, "pixels", pdfPath, outputPath])).stdout, /All pages pixel-identical/);
});
