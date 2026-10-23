import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeTaggedArtifacts } from "../../modules/pdf-writer/index.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../scripts/java-runtime.js";
import { checkSavedSemantics } from "../../scripts/check-saved-semantics.js";

for (const fontMode of ["embedded", "unembedded"]) test(`native tagging preserves operands, inline images and ${fontMode} source fonts`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-stream-syntax-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "source.pdf"), outputPath = path.join(dir, "candidate.pdf");
  const tagsPath = path.join(dir, "tags.json"), semanticPath = path.join(dir, "semantic.json");
  const bundledJavaHome = path.resolve("modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const jar = path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  const probe = path.resolve("modules/pdf-writer/test/fixtures/NativeStreamSyntaxProbe.java");
  const env = await buildJavaExecEnv({ bundledJavaHome });
  const run = args => promisify(execFile)(java, ["-cp", jar, probe, ...args], { windowsHide: true, env, timeout: 60000 });
  const text = "Preserve tiny spacing and inline images";
  await run([fontMode === "unembedded" ? "create-unembedded" : "create", pdfPath, path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")]);
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "syntax", source: { layoutDocumentId: "syntax" },
    nodes: [{ id: "text", sourceBlockId: "text", role: "P", text, pageNumber: 1, bbox: [72, 80, 300, 14], confidence: 1 }] }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags", source: { semanticDocumentId: "syntax" },
    root: { id: "root", type: "Document", children: [{ id: "text", type: "P", label: text, sourceNodeIds: ["text"], children: [] }] } }));
  await writeTaggedArtifacts({ pdfPath, outputPath, tagsPath, semanticPath, mode: "native" });
  const { stdout } = await run([pdfPath, outputPath]);
  assert.match(stdout, /All operands, inline-image bytes and 150 DPI pixels preserved/);
  assert.equal((await checkSavedSemantics({ pdfPath: outputPath, tagsPath })).summary.failed, 0);
});
