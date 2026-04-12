import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePdf } from "../../parser/index.js";
import { inspectPdfLowLevel } from "../../../scripts/inspect-pdf-low-level.js";
import { createSsnSamplePdf } from "../../../test/fixtures/create-ssn-sample-pdf.js";
import {
  buildRedactionPlan,
  findSsnMatchesInText,
  maskSsnMatch,
  redactSsnArtifacts
} from "../index.js";

test("redactor detects formatted and plain SSNs while masking report output", () => {
  const matches = findSsnMatchesInText("Primary 123-45-6789 Backup 987654321 Tax ID 12-3456789");

  assert.equal(matches.length, 2);
  assert.equal(matches[0].maskedText, "***-**-6789");
  assert.equal(matches[1].maskedText, "***-**-4321");
  assert.equal(maskSsnMatch("987654321"), "***-**-4321");
});

test("redactor builds a safe redaction plan from parser layout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "redactor-plan-test-"));
  const pdfPath = path.join(tempDir, "ssn-sample.pdf");

  await createSsnSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath);
  const plan = buildRedactionPlan(layout);

  assert.equal(plan.matches.length, 2);
  assert.equal(plan.pagesRedacted, 1);
  assert.equal(plan.matches.every((match) => !/123-45-6789|987654321/.test(match.maskedText)), true);
  assert.equal(plan.matches.every((match) => Array.isArray(match.bbox) && match.bbox.length === 4), true);
});

test("redactor produces a raster-redacted PDF and a masked report", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "redactor-output-test-"));
  const pdfPath = path.join(tempDir, "ssn-sample.pdf");
  const layoutPath = path.join(tempDir, "layout.json");
  const outputPath = path.join(tempDir, "redacted.pdf");

  await createSsnSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath);
  await writeFile(layoutPath, JSON.stringify(layout, null, 2));

  const report = await redactSsnArtifacts({ pdfPath, layoutPath, outputPath });
  const outputBytes = await readFile(outputPath);
  const inspection = await inspectPdfLowLevel({ pdfPath: outputPath });

  await access(outputPath);
  assert.equal(report.summary.redactedMatches, 2);
  assert.equal(report.summary.pagesRedacted, 1);
  assert.equal(report.summary.outputMode, "raster-redaction");
  assert.equal(JSON.stringify(report).includes("123-45-6789"), false);
  assert.equal(JSON.stringify(report).includes("987654321"), false);
  assert.equal(outputBytes.toString("latin1").includes("123-45-6789"), false);
  assert.equal(outputBytes.toString("latin1").includes("987654321"), false);
  assert.ok(inspection.pages[0].resources.imageXObjectCount >= 1);
  assert.equal(inspection.pages[0].operators.hasTextOperators, false);
});
