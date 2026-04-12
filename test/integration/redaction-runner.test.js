import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSsnSamplePdf } from "../fixtures/create-ssn-sample-pdf.js";
import { runRedactionPipeline } from "../../orchestrator/redaction-runner.js";

test("redaction runner processes an SSN redaction workload end-to-end", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "redaction-runner-test-"));
  const pdfPath = path.join(tempDir, "ssn-sample.pdf");
  const outputDir = path.join(tempDir, "output");

  await createSsnSamplePdf(pdfPath);
  const job = await runRedactionPipeline({ filePath: pdfPath, outputDir, jobId: "redaction-integration-test" });

  await access(job.artifacts.layout);
  await access(job.artifacts.redactedPdf);
  await access(job.artifacts.redactionReport);

  const report = JSON.parse(await readFile(job.artifacts.redactionReport, "utf8"));

  assert.equal(job.status, "completed");
  assert.equal(job.workload.id, "ssn-redaction");
  assert.equal(job.stageSummary.completedStages, job.stages.length);
  assert.equal(report.summary.redactedMatches, 2);
  assert.equal(report.matches.length, 2);
  assert.equal(report.matches.every((match) => match.maskedText.startsWith("***-**-")), true);
});
