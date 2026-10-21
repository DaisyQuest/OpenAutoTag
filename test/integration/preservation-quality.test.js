import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { createListFormFixture } from "../../modules/pdf-writer/test/fixtures/list-form-fixture.js";
import { checkPdfPreservation } from "../../scripts/check-pdf-preservation.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../scripts/java-runtime.js";
import { createTaggingOutputStages } from "../../orchestrator/accessibility-stage-plan.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validation = { status: "completed", isCompliant: true, overall: { status: "pass" }, findings: [], fontAudit: { status: "ok" } };

test("required saved-PDF baseline detects incremental mutations and checker failures", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "preservation-quality-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await createListFormFixture(dir), validationReport = path.join(dir, "validation.json");
  await writeFile(validationReport, JSON.stringify(validation));
  const saveValidation = async (pdf, changes = {}) => writeFile(validationReport, JSON.stringify({ ...validation,
    pdfSha256: createHash("sha256").update(await readFile(pdf)).digest("hex"), ...changes }));
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome: path.join(root, "modules/validator/vendor/java") });
  const env = await buildJavaExecEnv({ bundledJavaHome: path.join(root, "modules/validator/vendor/java") });
  for (const [mode, expected] of [["unchanged", null], ["drop-field", "FIELD_CHANGED"], ["change-value", "FIELD_CHANGED"],
    ["lose-heading", "HEADING_CONTENT_LOST"], ["page-geometry", "PAGE_CONTENT_CHANGED"]]) {
    const candidatePdf = path.join(dir, `${mode}.pdf`), outputPath = path.join(dir, `${mode}.json`);
    await exec(java, ["-cp", path.join(root, "modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),
      path.join(root, "test/fixtures/java/PreservationMutation.java"), fixture.pdfPath, candidatePdf, mode], { env, windowsHide: true });
    await saveValidation(candidatePdf);
    const report = await checkPdfPreservation({ sourcePdf: fixture.pdfPath, candidatePdf, validationReport, outputPath });
    assert.equal(report.disposition, expected ? "rejected" : "review_required", mode);
    assert.equal(report.checks.find((c) => c.id === "objectIdentity").status, "pass");
    assert.ok(expected ? report.findings.some((f) => f.code === expected) : report.findings.length === 0, mode);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), report);
  }

  // The integrated stage retains its report but fails the workload on a regression.
  const artifacts = { taggedPdf: path.join(dir, "drop-field.pdf"), validationReport };
  await saveValidation(artifacts.taggedPdf);
  const stage = createTaggingOutputStages({ filePath: fixture.pdfPath, resolvedOutputDir: dir, artifacts, preservationCheck: true }).at(-1);
  await assert.rejects(stage.run(), /Preservation check rejected/);
  assert.equal(JSON.parse(await readFile(artifacts.qualityReport, "utf8")).disposition, "rejected");
  artifacts.taggedPdf = path.join(dir, "unchanged.pdf");
  // A report for a different saved candidate must not be reused.
  await assert.rejects(stage.run(), /Preservation check error/);
  await saveValidation(artifacts.taggedPdf);
  assert.equal((await stage.run()).disposition, "review_required");
  await saveValidation(artifacts.taggedPdf, { fontAudit: { status: "error" } });
  await assert.rejects(stage.run(), /Preservation check error/);

  // Full rewrites have no qualified object-identity mapping and must not look like a passed comparison.
  const rewritten = await PDFDocument.load(await readFile(fixture.pdfPath));
  rewritten.setTitle("Rewrite");
  const candidatePdf = path.join(dir, "rewrite.pdf"); await writeFile(candidatePdf, await rewritten.save());
  await saveValidation(candidatePdf);
  const report = await checkPdfPreservation({ sourcePdf: fixture.pdfPath, candidatePdf, validationReport, outputPath: path.join(dir, "rewrite.json") });
  assert.equal(report.disposition, "review_required");
  assert.ok(report.findings.some((f) => f.code === "IDENTITY_MAPPING_REQUIRED"));
  assert.ok(!report.checks.some((c) => c.id === "fields"));

  await assert.rejects(checkPdfPreservation({ sourcePdf: fixture.pdfPath, candidatePdf, validationReport, outputPath: fixture.pdfPath }), /overwrite an input/);
  await assert.rejects(checkPdfPreservation({}), /Required:/);
  const invalidPdf = path.join(dir, "invalid.pdf"); await writeFile(invalidPdf, "not a PDF");
  const invalid = await checkPdfPreservation({ sourcePdf: fixture.pdfPath, candidatePdf: invalidPdf, validationReport, outputPath: path.join(dir, "invalid.json") });
  assert.equal(invalid.disposition, "error");
  assert.ok(invalid.findings.some((f) => f.code === "INSPECTION_UNAVAILABLE"));
});

test("quality stage is opt-in and requires validation", () => {
  const options = { filePath: "source.pdf", resolvedOutputDir: "output", artifacts: {} };
  assert.ok(!createTaggingOutputStages(options).some((s) => s.key === "preservationQuality"));
  assert.throws(() => createTaggingOutputStages({ ...options, preservationCheck: true, includeValidator: false }), /requires the validator/);
});
