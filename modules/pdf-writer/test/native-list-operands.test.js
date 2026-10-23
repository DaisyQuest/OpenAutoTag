import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeTaggedArtifacts, ensureJavaHelperCompiled } from "../index.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";
import { checkSavedSemantics } from "../../../scripts/check-saved-semantics.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";

test("standalone and array list markers own glyphs without empty body references or changed spacing", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-list-operands-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "source.pdf"), outputPath = path.join(dir, "candidate.pdf");
  const tagsPath = path.join(dir, "tags.json"), semanticPath = path.join(dir, "semantic.json");
  const bundledJavaHome = path.resolve("modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const jar = path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  const probe = path.resolve("modules/pdf-writer/test/fixtures/NativeOperatorProbe.java");
  const env = await buildJavaExecEnv({ bundledJavaHome });
  const run = (file, args) => promisify(execFile)(java, ["-cp", jar, file, ...args], { windowsHide: true, env, timeout: 60000 });
  await run(probe, ["create-lists", pdfPath, path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")]);
  const markers = ["1.", "iv.", "2.", "3."], bodies = ["First", "Second", "Third", "Fourth"];
  const nodes = markers.map((marker, i) => ({ id: `item${i}`, sourceBlockId: `b${i}`, pageNumber: 1, role: "LI",
    text: `${marker} ${bodies[i]}`, bbox: [70, 60 + i * 30, 220, 16], confidence: 1 }));
  const leaf = (id, type, text, ids) => ({ id, type, label: text, actualText: text, sourceNodeIds: ids, children: [] });
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "list", source: { layoutDocumentId: "list" }, nodes }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags", source: { semanticDocumentId: "list" },
    root: { id: "root", type: "Document", children: [{ id: "list", type: "L", children: nodes.map((n, i) => ({ id: n.id, type: "LI", children: [
      leaf(`label${i}`, "Lbl", markers[i], []), leaf(`body${i}`, "LBody", bodies[i], [n.id]) ] })) }] } }));
  await writeTaggedArtifacts({ pdfPath, outputPath, tagsPath, semanticPath, mode: "native" });
  const saved = (await run(probe, ["inspect", outputPath])).stdout.trim().split(/\r?\n/).map(line => line.split("\t"));
  assert.deepEqual(saved.map(row => [row[4], row[5]]), markers.flatMap((marker, i) => [[marker, `oat:label${i}`], [` ${bodies[i]}`, `oat:body${i}`]]));
  assert.equal((await checkSavedSemantics({ pdfPath: outputPath, tagsPath })).summary.failed, 0);
  assert.match((await run(path.resolve("modules/pdf-writer/test/fixtures/ListSplitProbe.java"), [pdfPath, outputPath])).stdout, /Glyph positions and 150 DPI pixels unchanged/);
  const source = JSON.parse(await readFile(`${outputPath}.native-operators.json`, "utf8"));
  assert.equal(source.pages[0].operatorCount, 6);
});

test("glyph boundaries are proven from source bytes and complete ToUnicode sequences", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-glyph-boundaries-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await ensureJavaHelperCompiled();
  const bundledJavaHome = path.resolve("modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome });
  const jar = path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot: process.cwd() });
  const cp = `${dir}${path.delimiter}${buildDir}${path.delimiter}${jar}`;
  const run = (tool, args) => promisify(execFile)(tool, args, { windowsHide: true, env, timeout: 60000 });
  await run(javac, ["-encoding", "UTF-8", "-cp", cp, "-d", dir, path.resolve("modules/pdf-writer/test/fixtures/NativeGlyphBoundaryProbe.java")]);
  assert.match((await run(java, ["-cp", cp, "NativeGlyphBoundaryProbe", path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")])).stdout,
    /Multibyte codes, ligatures, combining sequences, adjustments, source immutability and rejection bounds verified/);
});
