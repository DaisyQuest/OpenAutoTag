import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSpanishSamplePdf } from "../fixtures/create-spanish-sample-pdf.js";
import { runPipeline } from "../../orchestrator/pipeline-runner.js";
import { inspectPdfLowLevel } from "../../scripts/inspect-pdf-low-level.js";

test("pipeline preserves Spanish language detection through writing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "spanish-pipeline-test-"));
  const pdfPath = path.join(tempDir, "spanish.pdf");
  const outputDir = path.join(tempDir, "output");

  await createSpanishSamplePdf(pdfPath);
  const job = await runPipeline({ filePath: pdfPath, outputDir, jobId: "spanish-pipeline" });

  const [layout, semanticOrdered, writerReport] = await Promise.all([
    readFile(job.artifacts.layout, "utf8").then((content) => JSON.parse(content)),
    readFile(job.artifacts.semanticOrdered, "utf8").then((content) => JSON.parse(content)),
    readFile(job.artifacts.writerReport, "utf8").then((content) => JSON.parse(content))
  ]);
  const inspection = await inspectPdfLowLevel({ pdfPath: job.artifacts.taggedPdf });

  assert.equal(job.status, "completed");
  assert.equal(layout.source.language, "es-ES");
  assert.ok(layout.source.languageConfidence >= 0.7);
  assert.equal(layout.pages[0].language, "es-ES");
  assert.equal(layout.source.ocr.languageStrategy, "detected-spanish");
  assert.deepEqual(layout.source.ocr.languages, ["spa", "eng"]);
  assert.equal(semanticOrdered.source.language, "es-ES");
  assert.equal(writerReport.language, "es-ES");
  assert.equal(inspection.catalog.language, "es-ES");
});
