import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyRepairReport, buildRepairTimeline, compareBeforeAfter } from "../lib/report-model.js";

test("classifyRepairReport with clean report returns healthScore=1 and riskLevel=clean", () => {
  const report = { issues: [] };
  const result = classifyRepairReport(report);

  assert.equal(result.healthScore, 1);
  assert.equal(result.riskLevel, "clean");
  assert.equal(result.repairEffectiveness, 1);
  assert.ok(result.humanSummary.includes("clean"));
});

test("classifyRepairReport with 3 errors and 2 repaired produces appropriate scoring", () => {
  const report = {
    issues: [
      { type: "xref", severity: "error", message: "Broken xref table", repaired: true },
      { type: "stream", severity: "error", message: "Corrupt stream length", repaired: true },
      { type: "font", severity: "error", message: "Missing font descriptor", repaired: false },
    ],
  };

  const result = classifyRepairReport(report);

  assert.ok(result.healthScore >= 0 && result.healthScore <= 1, `healthScore ${result.healthScore} out of range`);
  assert.ok(result.healthScore < 1, "healthScore should be less than 1 with unrepaired errors");
  assert.equal(result.repairEffectiveness, 2 / 3);
  assert.ok(["high", "critical"].includes(result.riskLevel), `riskLevel should be high or critical, got ${result.riskLevel}`);
  assert.ok(result.humanSummary.length > 0);
});

test("buildRepairTimeline orders errors before warnings before info", () => {
  const report = {
    issues: [
      { type: "info-a", severity: "info", message: "Minor note", repaired: false },
      { type: "err-a", severity: "error", message: "Broken xref", repaired: true },
      { type: "warn-a", severity: "warning", message: "Deprecated feature", repaired: false },
      { type: "err-b", severity: "error", message: "Bad stream", repaired: true },
      { type: "warn-b", severity: "warning", message: "Loose object", repaired: true },
    ],
  };

  const timeline = buildRepairTimeline(report);

  assert.equal(timeline.length, 5);
  assert.equal(timeline[0].severity, "error");
  assert.equal(timeline[1].severity, "error");
  assert.equal(timeline[2].severity, "warning");
  assert.equal(timeline[3].severity, "warning");
  assert.equal(timeline[4].severity, "info");

  // Verify step numbering
  assert.equal(timeline[0].step, 1);
  assert.equal(timeline[4].step, 5);
});

test("compareBeforeAfter produces inputSize, outputSize, and delta", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "repair-test-"));
  const inputPath = path.join(tempDir, "input.pdf");
  const outputPath = path.join(tempDir, "output.pdf");

  const inputContent = Buffer.alloc(1000, "A");
  const outputContent = Buffer.alloc(1200, "B");

  await writeFile(inputPath, inputContent);
  await writeFile(outputPath, outputContent);

  const result = await compareBeforeAfter(inputPath, outputPath);

  assert.equal(result.inputSize, 1000);
  assert.equal(result.outputSize, 1200);
  assert.equal(result.delta, 200);
  assert.equal(result.deltaPercent, 20);
});
