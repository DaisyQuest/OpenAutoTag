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

const fixtureDir = path.join(moduleDir, "fixtures", "2026_31163");
const fixturePdf = path.join(repoRoot, "test", "LRBTest", "2026_31163.pdf");
const semanticPath = path.join(fixtureDir, "semantic-ordered.json");
const tagsPath = path.join(fixtureDir, "tagging.json");

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
  await mkdir(buildDir, { recursive: true });
}

/**
 * Regression baseline for the native matcher, pinned to the LRBTest-2026-31163
 * corpus fixture. Measured 2026-04-18 after the CID decoding / per-page height
 * / nested-stream-NPE fixes. Match rate was 1.000 with 0 unmatched operators
 * across 5 pages. If a future change makes the matcher more permissive in a
 * way that starts producing false positives, that *also* counts as a regression
 * from this baseline — the operators count should stay stable.
 */
const EXPECTED = {
  totalPages: 5,
  operatorCount: 1121,
  matchedOperators: 1121,
  matchRate: 1.0,
  meanMatchRate: 1.0,
  pagesAboveThreshold: 5,
  maxUnmatchedOperators: 0,
  // Text-coverage floor: assignments should retain >= 90% of node text on
  // average. Too low means the matcher is leaving tag text on the floor;
  // much higher than the measured baseline (~0.995) would mean we changed
  // the semantics of textCoverage and need to re-pin.
  meanTextCoverageMin: 0.9,
  meanTextCoverageMax: 1.0
};

test("native matcher: LRBTest-2026-31163 corpus fixture regression baseline", async (t) => {
  if (!existsSync(fixturePdf)) {
    t.skip(`source PDF missing at ${fixturePdf}`);
    return;
  }
  if (!existsSync(semanticPath) || !existsSync(tagsPath)) {
    t.skip(`fixture JSONs missing in ${fixtureDir}`);
    return;
  }

  await compileNative();
  const operatorsPath = path.join(buildDir, "regression-operators.json");
  const tagPlanPath = path.join(buildDir, "regression-tag-plan.json");

  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  await execFileP(
    java,
    ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
     "--pdf", fixturePdf, "--output", operatorsPath],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );
  await execFileP(
    java,
    ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeTagMatcher",
     "--operators", operatorsPath, "--semantic", semanticPath, "--tags", tagsPath,
     "--output", tagPlanPath],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );

  const plan = JSON.parse(await readFile(tagPlanPath, "utf8"));
  const overall = plan.overall;

  assert.equal(overall.totalPages, EXPECTED.totalPages, "pages unchanged");
  assert.equal(overall.operatorCount, EXPECTED.operatorCount, "operator count pinned");
  assert.equal(overall.matchedOperators, EXPECTED.matchedOperators, "matched operator count pinned");
  assert.equal(Number(overall.matchRate), EXPECTED.matchRate, "corpus match rate pinned at 1.0");
  assert.equal(Number(overall.meanMatchRate), EXPECTED.meanMatchRate, "per-page mean match rate pinned");
  assert.equal(overall.pagesAboveThreshold, EXPECTED.pagesAboveThreshold, "all pages above threshold");
  assert.equal(overall.nativeViable, true, "nativeViable verdict is true");

  let totalAssignments = 0;
  let totalCoverage = 0;
  let totalUnmatched = 0;
  for (const page of plan.pages) {
    totalUnmatched += page.unmatchedOperators.length;
    for (const asgn of page.assignments) {
      totalAssignments++;
      totalCoverage += Number(asgn.textCoverage || 0);
    }
  }

  assert.ok(
    totalUnmatched <= EXPECTED.maxUnmatchedOperators,
    `expected <= ${EXPECTED.maxUnmatchedOperators} unmatched operators, got ${totalUnmatched}`
  );

  const meanCov = totalAssignments > 0 ? totalCoverage / totalAssignments : 0;
  assert.ok(
    meanCov >= EXPECTED.meanTextCoverageMin && meanCov <= EXPECTED.meanTextCoverageMax,
    `mean textCoverage ${meanCov.toFixed(3)} outside pinned range ` +
    `[${EXPECTED.meanTextCoverageMin}, ${EXPECTED.meanTextCoverageMax}]`
  );
});
