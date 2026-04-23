import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MATRIX_FACTORS, generateFineTunedTestcases } from "../../machine-learning/generate-fine-tuned-testcases.js";

test("fine tuned testcase generator creates deterministic PDF corpus manifest", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fine-tuned-testcases-"));
  const result = await generateFineTunedTestcases({
    outputDir: tempDir,
    count: MATRIX_FACTORS.archetype.length,
    seed: 12345
  });

  assert.equal(result.count, MATRIX_FACTORS.archetype.length);
  assert.deepEqual(Object.keys(result.archetypeCounts).sort(), [...MATRIX_FACTORS.archetype].sort());

  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.generator.deterministic, true);
  assert.equal(manifest.generator.seed, 12345);
  assert.equal(manifest.generator.matrixFactorCount, Object.keys(MATRIX_FACTORS).length);
  assert.equal(manifest.cases.length, MATRIX_FACTORS.archetype.length);
  assert.equal(manifest.cases[0].expectedStructures[0].type, "table");
  assert.ok(manifest.matrixCoverage.pairCoverageSummary.possiblePairsTotal > 0);

  for (const testCase of manifest.cases) {
    const stats = await stat(testCase.pdfPath);
    assert.ok(stats.size > 1000, `${testCase.fileName} should be a non-empty PDF`);
    assert.ok(testCase.matrixFactors.archetype, "case should record matrix factors");
  }
});
