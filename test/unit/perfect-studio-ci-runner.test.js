import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeValidationContract,
  runPerfectStudioCorpus
} from "../../orchestrator/perfect-studio-ci-runner.js";

test("normalizes validator reports into the perfect studio compliance contract", () => {
  const passing = normalizeValidationContract({
    isCompliant: true,
    overall: { status: "pass" },
    findings: [],
    engine: { name: "veraPDF" },
    summary: { failedRules: 0 }
  });
  assert.equal(passing.compliance.pdfUA, true);
  assert.equal(passing.compliance.wcagAA, true);
  assert.equal(passing.errors.length, 0);

  const failing = normalizeValidationContract({
    isCompliant: false,
    overall: { status: "fail" },
    findings: [
      { severity: "warning", code: "ADVISORY", message: "warning only" },
      { severity: "error", code: "MISSING_ALT", description: "Figure needs alternate text", pageNumber: 2 }
    ]
  });
  assert.equal(failing.compliance.pdfUA, false);
  assert.equal(failing.compliance.wcagAA, false);
  assert.deepEqual(failing.errors, [{
    code: "MISSING_ALT",
    message: "Figure needs alternate text",
    source: "validator",
    page: 2
  }]);
});

test("fails empty corpora by default and allows them when explicitly enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perfect-studio-corpus-"));
  const corpusDir = path.join(tempDir, "corpus");
  const outputDir = path.join(tempDir, "out");
  await mkdir(corpusDir);

  const defaultSummary = await runPerfectStudioCorpus({
    corpusDir,
    outputDir,
    pipeline: async () => {
      throw new Error("pipeline should not run for empty corpora");
    }
  });

  assert.equal(defaultSummary.status, "fail");
  assert.equal(defaultSummary.total, 0);
  assert.equal(defaultSummary.passed, 0);
  assert.equal(defaultSummary.failed, 0);
  assert.equal(defaultSummary.reason, "empty-corpus");

  const allowedSummary = await runPerfectStudioCorpus({
    corpusDir,
    outputDir: path.join(tempDir, "out-allowed"),
    allowEmptyCorpus: true,
    pipeline: async () => {
      throw new Error("pipeline should not run for empty corpora");
    }
  });

  assert.equal(allowedSummary.status, "pass");
  assert.equal(allowedSummary.total, 0);
  assert.equal(allowedSummary.results.length, 0);
});

test("rejects malformed validation reports when they miss the normalized schema", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perfect-studio-corpus-"));
  const corpusDir = path.join(tempDir, "corpus");
  const outputDir = path.join(tempDir, "out");
  const schemaPath = path.join(tempDir, "normalized-compliance.schema.json");
  await mkdir(corpusDir);
  await writeFile(path.join(corpusDir, "sample.pdf"), "%PDF-1.7\n");
  await writeFile(schemaPath, `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["errors", "compliance", "engine", "summary"],
    properties: {
      errors: { type: "array" },
      compliance: {
        type: "object",
        required: ["pdfUA", "wcagAA"],
        properties: {
          pdfUA: { type: "boolean" },
          wcagAA: { type: "boolean" }
        }
      },
      engine: { type: "object" },
      summary: { type: "object" }
    }
  }, null, 2)}\n`);

  const summary = await runPerfectStudioCorpus({
    corpusDir,
    outputDir,
    validationContractSchemaPath: schemaPath,
    pipeline: async ({ filePath, outputDir: jobOutputDir, jobId }) => {
      await mkdir(jobOutputDir, { recursive: true });
      const validationReport = path.join(jobOutputDir, "07-validation-report.json");
      await writeFile(validationReport, `${JSON.stringify({
        isCompliant: true,
        overall: { status: "pass" },
        findings: [],
        engine: { name: "veraPDF" }
      })}\n`);
      return { artifacts: { validationReport } };
    }
  });

  assert.equal(summary.status, "fail");
  assert.equal(summary.results[0].status, "error");
  assert.equal(summary.results[0].contract.errors[0].code, "VALIDATION_REPORT_INVALID");
});

test("keeps noncompliant validation reports as ordinary failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perfect-studio-corpus-"));
  const corpusDir = path.join(tempDir, "corpus");
  const outputDir = path.join(tempDir, "out");
  const schemaPath = path.join(tempDir, "normalized-compliance.schema.json");
  await mkdir(corpusDir);
  await writeFile(path.join(corpusDir, "a.pdf"), "%PDF-1.7\n");
  await writeFile(path.join(corpusDir, "b.pdf"), "%PDF-1.7\n");
  await writeFile(schemaPath, `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["errors", "compliance"],
    properties: {
      errors: { type: "array" },
      compliance: {
        type: "object",
        required: ["pdfUA", "wcagAA"],
        properties: {
          pdfUA: { type: "boolean" },
          wcagAA: { type: "boolean" }
        }
      },
      engine: { type: ["object", "null"] },
      summary: { type: ["object", "null"] }
    }
  }, null, 2)}\n`);

  const seen = [];
  const summary = await runPerfectStudioCorpus({
    corpusDir,
    outputDir,
    validationContractSchemaPath: schemaPath,
    pipeline: async ({ filePath, outputDir: jobOutputDir }) => {
      seen.push(path.basename(filePath));
      await mkdir(jobOutputDir, { recursive: true });
      const validationReport = path.join(jobOutputDir, "07-validation-report.json");
      const fail = filePath.endsWith("b.pdf");
      await writeFile(validationReport, `${JSON.stringify({
        isCompliant: !fail,
        overall: { status: fail ? "fail" : "pass" },
        findings: fail ? [{ severity: "error", code: "REGRESSION", message: "broken" }] : [],
        engine: { name: "veraPDF" },
        summary: { failedRules: fail ? 1 : 0 }
      })}\n`);
      return { artifacts: { validationReport } };
    }
  });

  assert.deepEqual(seen, ["a.pdf", "b.pdf"]);
  assert.equal(summary.status, "fail");
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].status, "pass");
  assert.equal(summary.results[1].status, "fail");
  assert.equal(summary.results[1].contract.errors[0].code, "REGRESSION");

  const persisted = JSON.parse(await readFile(summary.summaryPath, "utf8"));
  assert.equal(persisted.total, 2);
  assert.equal(persisted.results[1].pdf, "b.pdf");
});

test("cli exits after writing a corpus summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perfect-studio-cli-"));
  const corpusDir = path.join(tempDir, "corpus");
  const outputDir = path.join(tempDir, "out");
  await mkdir(corpusDir);

  const child = spawn(process.execPath, [
    path.resolve("orchestrator/perfect-studio-ci-runner.js"),
    "--corpus",
    corpusDir,
    "--output-dir",
    outputDir,
    "--allow-empty-corpus"
  ], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);

  const summary = JSON.parse(stdout);
  assert.equal(summary.status, "pass");
  assert.equal(summary.total, 0);
  assert.match(summary.summaryPath, /perfect-studio-validation-summary\.json$/);
});
