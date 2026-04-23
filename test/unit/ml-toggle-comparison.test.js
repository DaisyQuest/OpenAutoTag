import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExperimentOptions, runMlToggleComparison } from "../../scripts/run-ml-toggle-comparison.js";

function minimalJob({ jobId, outputDir, status = "completed", artifacts = {}, options = {} }) {
  return {
    jobId,
    status,
    workload: {
      id: "accessibility-tagging",
      label: "Accessibility Tagging"
    },
    input: {
      filePath: path.join(outputDir, "input.pdf"),
      outputDir,
      options
    },
    artifacts,
    stages: [],
    stageSummary: {
      total: 0,
      completedStages: 0,
      failedStages: 0,
      skippedStages: 0,
      totalAttempts: 0,
      retryableFailures: 0
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function writeRunArtifacts(outputDir, { mlEnabled }) {
  await mkdir(outputDir, { recursive: true });
  const validationReport = path.join(outputDir, "validation.json");
  const tagDeltaReport = path.join(outputDir, "tag-delta.json");
  const writerReport = path.join(outputDir, "writer.json");
  const mlPredictions = path.join(outputDir, "ml.json");

  await writeFile(validationReport, JSON.stringify({
    isCompliant: true,
    summary: {
      failedRules: mlEnabled ? 0 : 1,
      failedChecks: mlEnabled ? 0 : 2
    },
    findings: mlEnabled ? [] : [{ code: "RULE_A" }]
  }));
  await writeFile(tagDeltaReport, JSON.stringify({
    delta: {
      totalTypedNodesDelta: mlEnabled ? 12 : 10,
      markedContentOperatorCountDelta: mlEnabled ? 20 : 18,
      tableAttributeNodeCountDelta: 0
    }
  }));
  await writeFile(writerReport, JSON.stringify({
    writerMode: "auto",
    nativeTaggingApplied: true
  }));

  const artifacts = { validationReport, tagDeltaReport, writerReport };
  if (mlEnabled) {
    await writeFile(mlPredictions, JSON.stringify({
      status: "not-configured",
      runtimePolicy: { mode: "shadow" },
      documentProfile: { oodDecision: "unknown" },
      tuning: { applied: false },
      predictions: []
    }));
    artifacts.mlPredictions = mlPredictions;
  }

  return artifacts;
}

test("ML toggle comparison runs with-ML first and writes granular summaries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ml-toggle-comparison-test-"));
  const inputDir = path.join(tempDir, "pdfs");
  const nestedDir = path.join(inputDir, "nested");
  const outputDir = path.join(tempDir, "out");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(path.join(inputDir, "alpha.pdf"), "%PDF-1.7\n");
  await writeFile(path.join(nestedDir, "beta.pdf"), "%PDF-1.7\n");
  await writeFile(path.join(inputDir, "ignore.txt"), "not a pdf");

  const calls = [];
  const report = await runMlToggleComparison({
    inputDir,
    outputDir,
    runPipelineImpl: async ({ outputDir: runOutputDir, jobId, options }) => {
      const mlEnabled = options?.mlClassifier?.enabled === true;
      calls.push({ jobId, mlEnabled });
      const artifacts = await writeRunArtifacts(runOutputDir, { mlEnabled });
      return minimalJob({ jobId, outputDir: runOutputDir, artifacts, options });
    }
  });

  assert.equal(report.totals.total, 2);
  assert.equal(report.totals.withMlCompleted, 2);
  assert.equal(report.totals.withoutMlCompleted, 2);
  assert.equal(report.totals.mlReducedFailedRules, 2);
  assert.deepEqual(calls.map((call) => call.mlEnabled), [true, false, true, false]);

  const summary = JSON.parse(await readFile(report.summaryPath, "utf8"));
  assert.equal(summary.experiment.name, "custom");
  assert.deepEqual(summary.displayRunOrder, ["ML-enhanced", "vanilla-noML"]);
  assert.equal(summary.documents[0].comparison.failedRulesDelta, -1);
  assert.equal(summary.documents[0].comparison.mlPredictionStatus, "not-configured");

  const html = await readFile(report.reportPath, "utf8");
  assert.match(html, /ML Enhanced vs Vanilla NoML Experiment/);
  assert.match(html, /alpha\.pdf/);
});

test("ML toggle comparison resolves a safe matrix-smoke experiment by default", () => {
  const options = resolveExperimentOptions(new Map());

  assert.equal(options.experimentName, "matrix-smoke");
  assert.equal(options.limit, 6);
  assert.equal(options.profileId, "default");
  assert.equal(options.inputDir, path.resolve("output", "ml-fine-tuned-corpus", "v2", "pdfs"));
  assert.equal(options.modelPath, path.resolve("output", "ml-pilot", "role-baseline-large-v4-matrix.json"));
  assert.equal(options.outputDir, path.resolve("output", "ml-experiments", "ml-vs-vanilla-matrix-smoke"));
});

test("ML toggle comparison accepts a custom PDF directory without a long command", () => {
  const options = resolveExperimentOptions(new Map([
    ["--input-dir", "C:\\PDFs\\real-docs"],
    ["--limit", "3"]
  ]));

  assert.equal(options.experimentName, "custom");
  assert.equal(options.limit, 3);
  assert.equal(options.inputDir, "C:\\PDFs\\real-docs");
  assert.equal(options.outputDir, path.resolve("output", "ml-experiments", "ml-vs-vanilla-custom"));
});
