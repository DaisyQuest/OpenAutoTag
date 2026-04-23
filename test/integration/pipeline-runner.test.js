import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";
import { runPipeline } from "../../orchestrator/pipeline-runner.js";

test("pipeline runner processes a sample PDF end-to-end", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const outputDir = path.join(tempDir, "output");

  await createSamplePdf(pdfPath);
  const job = await runPipeline({ filePath: pdfPath, outputDir, jobId: "integration-test" });

  await access(job.artifacts.taggedPdf);
  await access(job.artifacts.validationReport);
  await access(job.artifacts.tagDeltaReport);
  await access(job.artifacts.sourceTextMap);
  await access(job.artifacts.tableStructureMap);

  const validationReport = JSON.parse(await readFile(job.artifacts.validationReport, "utf8"));
  const tagDeltaReport = JSON.parse(await readFile(job.artifacts.tagDeltaReport, "utf8"));
  const sourceTextMap = JSON.parse(await readFile(job.artifacts.sourceTextMap, "utf8"));
  const tableStructureMap = JSON.parse(await readFile(job.artifacts.tableStructureMap, "utf8"));
  assert.equal(job.status, "completed");
  assert.equal(job.stageSummary.total, job.stages.length);
  assert.equal(job.stageSummary.completedStages, job.stages.length);
  assert.equal(job.stageSummary.failedStages, 0);
  assert.equal(job.stageSummary.skippedStages, 0);
  assert.ok(job.stages.every((stage) => stage.status === "completed"));
  assert.ok(job.stages.every((stage) => Array.isArray(stage.attempts) && stage.attempts.length >= 1));
  assert.equal(job.stages.find((stage) => stage.key === "sourceTextMap").artifacts.sourceTextMap, job.artifacts.sourceTextMap);
  assert.equal(job.stages.find((stage) => stage.key === "tableStructureMap").artifacts.tableStructureMap, job.artifacts.tableStructureMap);
  assert.equal(job.stages.find((stage) => stage.key === "pdfWriter").artifacts.taggedPdf, job.artifacts.taggedPdf);
  assert.equal(job.stages.find((stage) => stage.key === "tagDeltaReport").artifacts.tagDeltaReport, job.artifacts.tagDeltaReport);
  assert.equal(sourceTextMap.summary.matchedBlocks, 5);
  assert.equal(sourceTextMap.summary.unmatchedBlocks, 0);
  assert.equal(tableStructureMap.summary.detectedTables, 0);
  assert.equal(tagDeltaReport.status, "completed");
  assert.equal(tagDeltaReport.delta.structTreeAdded, true);
  assert.ok(tagDeltaReport.delta.totalTypedNodesDelta > 0);
  assert.ok(tagDeltaReport.delta.markedContentOperatorCountDelta > 0);
  assert.equal(validationReport.status, "completed");
  assert.equal(validationReport.isCompliant, true);
  assert.equal(validationReport.engine.name, "veraPDF");
  assert.equal(validationReport.profileName, "PDF/UA-1 validation profile");
  assert.equal(validationReport.findings.length, 0);
  assert.equal(validationReport.summary.failedRules, 0);
  assert.equal(validationReport.summary.failedChecks, 0);
  assert.equal(validationReport.rawSummary.failedRules, 2);
  assert.equal(
    validationReport.findings.some((finding) => finding.code === "VERAPDF_7_21_4_2_2"),
    false
  );
  assert.equal(validationReport.metadataDiagnostics?.infoMatchesXmp, true);
  assert.equal(validationReport.metadataDiagnostics?.dcTitleDetected, true);
  assert.equal(validationReport.metadataDiagnostics?.pdfUaIdentificationDetected, true);
  assert.equal(validationReport.metadataDiagnostics?.suspectedVeraPdfMetadataMismatch, true);
  assert.equal(validationReport.metadataDiagnostics?.correctedByValidator, true);
});

test("pipeline runner retries transient stage failures before succeeding", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-retry-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const outputDir = path.join(tempDir, "output");

  await createSamplePdf(pdfPath);

  const job = await runPipeline({
    filePath: pdfPath,
    outputDir,
    jobId: "retry-test",
    stageRunner: async ({ stage, attempt, run }) => {
      if (stage.key === "semantic" && attempt === 1) {
        const error = new Error("temporary semantic failure");
        error.retryable = true;
        throw error;
      }

      return run();
    }
  });

  const semanticStage = job.stages.find((stage) => stage.key === "semantic");

  assert.equal(job.status, "completed");
  assert.equal(job.stageSummary.completedStages, job.stages.length);
  assert.equal(job.stageSummary.retryableFailures, 1);
  assert.equal(semanticStage.attempts.length, 2);
  assert.equal(semanticStage.attempts[0].status, "failed");
  assert.equal(semanticStage.attempts[1].status, "completed");
});

test("pipeline runner can emit ML prediction evidence behind the default-off toggle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-ml-toggle-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const outputDir = path.join(tempDir, "output");

  await createSamplePdf(pdfPath);
  const job = await runPipeline({
    filePath: pdfPath,
    outputDir,
    jobId: "ml-toggle-test",
    options: {
      mlClassifier: {
        enabled: true,
        mode: "shadow"
      }
    }
  });

  await access(job.artifacts.mlPredictions);
  await access(job.artifacts.semanticMlTuned);

  const mlPredictions = JSON.parse(await readFile(job.artifacts.mlPredictions, "utf8"));
  const tunedSemantic = JSON.parse(await readFile(job.artifacts.semanticMlTuned, "utf8"));

  assert.equal(job.status, "completed");
  assert.equal(job.stages.some((stage) => stage.key === "mlClassifier"), true);
  assert.equal(mlPredictions.runtimePolicy.mode, "shadow");
  assert.equal(mlPredictions.shadowMode.enabled, true);
  assert.equal(tunedSemantic.mlTuning.enabled, true);
  assert.equal(tunedSemantic.mlTuning.applied, false);
});

test("pipeline runner preserves earlier artifacts and reports a failed stage cleanly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-failure-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const outputDir = path.join(tempDir, "output");

  await createSamplePdf(pdfPath);

  const job = await runPipeline({
    filePath: pdfPath,
    outputDir,
    jobId: "failure-test",
    stageRunner: async ({ stage, run }) => {
      if (stage.key === "pdfWriter") {
        const error = new Error("writer stage unavailable");
        error.retryable = false;
        throw error;
      }

      return run();
    }
  });

  const writerStage = job.stages.find((stage) => stage.key === "pdfWriter");
  const validatorStage = job.stages.find((stage) => stage.key === "validator");

  assert.equal(job.status, "failed");
  assert.equal(job.failureStage.key, "pdfWriter");
  assert.match(job.error, /Stage pdfWriter failed after/);
  assert.equal(job.artifacts.layout, path.resolve(path.join(outputDir, "01-layout.json")));
  assert.equal(job.artifacts.tagging, path.resolve(path.join(outputDir, "05-tagging.json")));
  assert.equal(job.artifacts.taggedPdf, undefined);
  assert.equal(job.artifacts.tagDeltaReport, undefined);
  assert.equal(job.artifacts.validationReport, undefined);
  assert.equal(writerStage.status, "failed");
  assert.equal(writerStage.attempts.length, 1);
  assert.equal(validatorStage.status, "skipped");
  assert.match(validatorStage.skippedReason, /pdfWriter failed/);
  assert.equal(job.stageSummary.failedStages, 1);
  assert.equal(job.stageSummary.skippedStages, 2);
});
