import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSsnSamplePdf } from "../fixtures/create-ssn-sample-pdf.js";
import { inspectPdfLowLevel } from "../../scripts/inspect-pdf-low-level.js";
import { runTagAndRedactPipeline } from "../../orchestrator/tag-redaction-runner.js";

test("tag-and-redact runner removes SSNs from visible and accessibility content", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-redaction-runner-test-"));
  const pdfPath = path.join(tempDir, "ssn-sample.pdf");
  const outputDir = path.join(tempDir, "output");

  await createSsnSamplePdf(pdfPath);
  const job = await runTagAndRedactPipeline({
    filePath: pdfPath,
    outputDir,
    jobId: "tag-redaction-integration-test"
  });

  await access(job.artifacts.taggedPdf);
  await access(job.artifacts.tagManifest);
  await access(job.artifacts.validationReport);
  await access(job.artifacts.tagDeltaReport);
  await access(job.artifacts.redactionReport);
  await access(job.artifacts.semanticRedacted);

  const report = JSON.parse(await readFile(job.artifacts.redactionReport, "utf8"));
  const tagDeltaReport = JSON.parse(await readFile(job.artifacts.tagDeltaReport, "utf8"));
  const manifestText = await readFile(job.artifacts.tagManifest, "utf8");
  const taggedPdfBytes = await readFile(job.artifacts.taggedPdf);
  const inspection = await inspectPdfLowLevel({ pdfPath: job.artifacts.taggedPdf });

  assert.equal(job.status, "completed");
  assert.equal(job.workload.id, "tag-and-ssn-redact");
  assert.equal(report.summary.redactedMatches, 2);
  assert.equal(tagDeltaReport.status, "completed");
  assert.equal(tagDeltaReport.delta.structTreeAdded, true);
  assert.ok(tagDeltaReport.delta.totalTypedNodesDelta > 0);
  assert.equal(report.accessibilityTreeRedacted, true);
  assert.equal(report.summary.outputMode, "tagged-raster-redaction");
  assert.equal(manifestText.includes("123-45-6789"), false);
  assert.equal(manifestText.includes("987654321"), false);
  assert.equal(manifestText.includes("***-**-6789"), true);
  assert.equal(manifestText.includes("***-**-4321"), true);
  assert.equal(taggedPdfBytes.toString("latin1").includes("123-45-6789"), false);
  assert.equal(taggedPdfBytes.toString("latin1").includes("987654321"), false);
  assert.equal(inspection.catalog.hasStructTreeRoot, true);
  assert.equal(
    inspection.pages.some((page) => page.operators.textSamples.some((sample) => sample.text.includes("123-45-6789"))),
    false
  );
  // With Type0/CID overlay fonts, masked SSN text is CID-encoded in the
  // content stream. Verify the manifest contains the masked text instead.
  assert.equal(manifestText.includes("***-**-6789"), true);
});
