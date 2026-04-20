import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";

const execFileP = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot });
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

const fixturePdf = path.join(repoRoot, "Autonics-TK-manual.pdf");

async function compileNative() {
  const sources = [
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamParser.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeTagMatcher.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamRewriter.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "PassthroughMetadataCli.java")
  ];
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => false,
    compile: async () => {
      const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      await execFileP(javac, ["-encoding", "UTF-8", "-cp", pdfboxJar, "-d", buildDir, ...sources], {
        env: await buildJavaExecEnv({ bundledJavaHome })
      });
    }
  });
}

test("NativeContentStreamParser extracts real Unicode text from Type0/Identity-H subsets", async (t) => {
  if (!existsSync(fixturePdf)) {
    t.skip(`fixture PDF not present at ${fixturePdf}`);
    return;
  }

  await compileNative();
  await mkdir(buildDir, { recursive: true });
  const outputPath = path.join(buildDir, "smoke-operators.json");

  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  await execFileP(
    java,
    ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
     "--pdf", fixturePdf, "--page", "0", "--output", outputPath],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );

  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  assert.ok(Array.isArray(parsed.pages), "parser output has pages array");
  const page = parsed.pages[0];
  assert.ok(page.pageHeight > 0, "pageHeight is populated from the actual page, not hardcoded 792");
  assert.notStrictEqual(page.pageHeight, 792, "fixture is A4 (841.9), so pageHeight must not be the old hardcoded 792");

  const operators = page.operators;
  assert.ok(Array.isArray(operators) && operators.length > 0, "page yields operators");

  // Post-CID-decode validation: before the writeString override, Type0/Identity-H
  // text came back as raw 2-byte CID payload, which is mostly non-ASCII garbage.
  // Count how many operators have at least one readable ASCII letter — if the
  // decode pipeline is broken this count drops to ~0.
  const asciiLetters = /[A-Za-z]/;
  const readable = operators.filter((op) => asciiLetters.test(op.text || ""));
  assert.ok(
    readable.length > 0,
    `expected at least one operator with ASCII letters after ToUnicode decode; got ${readable.length}/${operators.length}`
  );

  // The fixture first page is "Product Introduction". If the decode is working
  // that phrase should appear in at least one operator's text.
  const found = operators.some((op) => (op.text || "").includes("Product Introduction"));
  assert.ok(found, "expected 'Product Introduction' somewhere in decoded page 1 text");

  // New fields from this pass are emitted:
  assert.ok(operators[0].streamOrigin !== undefined, "operators carry streamOrigin");
  assert.ok(typeof operators[0].insideMarkedContent === "boolean", "operators carry insideMarkedContent");
});
