import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { computeMarkedContentFraction, ALREADY_TAGGED_THRESHOLD } from "../index.js";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";

const execFileP = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot });
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");
const fixturePdf = path.join(repoRoot, "Autonics-TK-manual.pdf");

test("computeMarkedContentFraction: empty document yields 0", () => {
  assert.equal(computeMarkedContentFraction({ pages: [] }), 0);
  assert.equal(computeMarkedContentFraction({}), 0);
  assert.equal(computeMarkedContentFraction(null), 0);
});

test("computeMarkedContentFraction: ignores whitespace-only operators", () => {
  const doc = {
    pages: [{
      operators: [
        { text: "   ", insideMarkedContent: true },
        { text: "\t\n", insideMarkedContent: false },
        { text: "Hello", insideMarkedContent: true }
      ]
    }]
  };
  assert.equal(computeMarkedContentFraction(doc), 1, "only Hello counts, and it's marked");
});

test("computeMarkedContentFraction: mixes tagged and untagged operators", () => {
  const doc = {
    pages: [{
      operators: [
        { text: "A", insideMarkedContent: true },
        { text: "B", insideMarkedContent: true },
        { text: "C", insideMarkedContent: false },
        { text: "D", insideMarkedContent: false }
      ]
    }]
  };
  assert.equal(computeMarkedContentFraction(doc), 0.5);
});

test("computeMarkedContentFraction: aggregates across pages", () => {
  const doc = {
    pages: [
      { operators: [{ text: "x", insideMarkedContent: true }] },
      { operators: [{ text: "y", insideMarkedContent: false }, { text: "z", insideMarkedContent: false }] }
    ]
  };
  assert.equal(computeMarkedContentFraction(doc).toFixed(3), (1 / 3).toFixed(3));
});

test("ALREADY_TAGGED_THRESHOLD is at 50% — majority marked-content triggers raster fallback", () => {
  assert.equal(ALREADY_TAGGED_THRESHOLD, 0.5);
});

test("Autonics-TK-manual.pdf: parser output crosses the already-tagged threshold (reporter's PDF)", async (t) => {
  if (!existsSync(fixturePdf)) {
    t.skip(`fixture PDF not present at ${fixturePdf}`);
    return;
  }
  // Compile + run the parser against the actual fixture and verify the
  // bail-out logic would trigger, so we never again ship a native rewrite
  // that produces an orphan-MCID structure tree on this document.
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => false,
    compile: async () => {
      const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      const sources = [
        path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamParser.java"),
        path.join(repoRoot, "modules", "pdf-writer", "java", "NativeTagMatcher.java"),
        path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamRewriter.java"),
        path.join(repoRoot, "modules", "pdf-writer", "java", "PassthroughMetadataCli.java")
      ];
      await execFileP(javac, ["-encoding", "UTF-8", "-cp", pdfboxJar, "-d", buildDir, ...sources], {
        env: await buildJavaExecEnv({ bundledJavaHome })
      });
    }
  });
  await mkdir(buildDir, { recursive: true });
  const outputPath = path.join(buildDir, "autonics-bailout-ops.json");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  await execFileP(
    java,
    ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
     "--pdf", fixturePdf, "--page", "0", "--output", outputPath],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );
  const doc = JSON.parse(await readFile(outputPath, "utf8"));
  const fraction = computeMarkedContentFraction(doc);
  assert.ok(
    fraction >= ALREADY_TAGGED_THRESHOLD,
    `expected Autonics-TK-manual.pdf to be detected as already-tagged; ` +
    `markedContent fraction is ${fraction.toFixed(3)} (threshold ${ALREADY_TAGGED_THRESHOLD})`
  );
});
