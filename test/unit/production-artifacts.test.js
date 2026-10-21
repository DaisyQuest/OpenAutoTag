import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { artifactDownloadPolicy } from "../../orchestrator/artifact-policy.js";
import { stageInputFile } from "../../orchestrator/workload-runner.js";
import { createAccessibilityPreparationStages } from "../../orchestrator/accessibility-stage-plan.js";
import { createAppServer } from "../../orchestrator/server.js";
const reportFor = (bytes, disposition = "review_required") => ({ schemaVersion: "1.0.0", policy: "preservation-v1", disposition,
  sourceHash: null, candidateHash: createHash("sha256").update(bytes).digest("hex"), checks: [], findings: [], limitations: [] });

test("download gating binds review consent to the inspected bytes and fails closed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "artifact-policy-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const pdf = path.join(dir, "candidate.pdf"), reportPath = path.join(dir, "quality.json"); await writeFile(pdf, "pdf bytes");
  const job = { input: { options: { productionChecks: true } }, artifacts: { candidatePdf: pdf } };
  assert.equal((await artifactDownloadPolicy(job, "candidatePdf", true)).allowed, false);
  job.artifacts.qualityReport = reportPath;
  for (const disposition of ["error", "rejected", "review_required"]) {
    await writeFile(reportPath, JSON.stringify(reportFor("pdf bytes", disposition)));
    assert.equal((await artifactDownloadPolicy(job, "candidatePdf", true)).allowed, disposition === "review_required");
    assert.equal((await artifactDownloadPolicy(job, "candidatePdf")).allowed, false);
  }
  await writeFile(pdf, "changed"); assert.equal((await artifactDownloadPolicy(job, "candidatePdf", true)).allowed, false);
  assert.equal((await artifactDownloadPolicy(job, "candidatePdf", true, Buffer.from("pdf bytes"))).allowed, true);
  assert.equal((await artifactDownloadPolicy(job, "candidatePdf", true, Buffer.from("different served bytes"))).allowed, false);
  job.input.stagedFilePath = pdf; assert.equal((await artifactDownloadPolicy(job, "candidatePdf")).allowed, true);
  assert.equal((await artifactDownloadPolicy({ artifacts: { pdf } }, "pdf")).allowed, true);
});

test("HTTP artifact route requires explicit candidate retrieval and rejects stale or malformed reports", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "artifact-http-"));
  const pdf = path.join(dir, "candidate.pdf"), qualityReport = path.join(dir, "quality.json");
  await writeFile(pdf, "candidate bytes"); await writeFile(qualityReport, JSON.stringify(reportFor("candidate bytes")));
  const job = { input: { options: { productionChecks: true } }, artifacts: { candidatePdf: pdf, alias: pdf, qualityReport } };
  const server = createAppServer({ queue: { get: () => job }, uploadRoot: path.join(dir, "uploads") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/jobs/test/artifacts/`;
  assert.equal((await fetch(`${url}candidatePdf`)).status, 409);
  const allowed = await fetch(`${url}candidatePdf?candidate=1`); assert.equal(allowed.status, 200); assert.equal(await allowed.text(), "candidate bytes");
  assert.equal((await fetch(`${url}alias`)).status, 409);
  await writeFile(pdf, "modified"); assert.equal((await fetch(`${url}candidatePdf?candidate=1`)).status, 409);
  await writeFile(qualityReport, JSON.stringify({ disposition: "review_required", candidateHash: createHash("sha256").update("modified").digest("hex") }));
  assert.equal((await fetch(`${url}candidatePdf?candidate=1`)).status, 409);
});

test("staging copies bytes without creating a mutable alias to the original", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage-isolation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.pdf"), output = path.join(dir, "out"); await mkdir(output); await writeFile(source, "original");
  const staged = await stageInputFile(source, output); await writeFile(staged, "mutated");
  assert.equal(await readFile(source, "utf8"), "original");
});

test("orchestration refuses geometry fallback when explicit relationships conflict", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "constraint-stage-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const semantic = path.join(dir, "semantic.json");
  await writeFile(semantic, JSON.stringify({ schemaVersion: "1.0.0", documentId: "test", source: { layoutDocumentId: "test" },
    nodes: ["a","b"].map((id) => ({ id, sourceBlockId: id, role: "P", text: id, bbox: [72,100,100,12], pageNumber: 1, confidence: 1 })),
    relations: [{ type: "precedes", from: "a", to: "b", evidence: "authored" }, { type: "precedes", from: "b", to: "a", evidence: "authored" }] }));
  const stage = createAccessibilityPreparationStages({ filePath: "unused.pdf", resolvedOutputDir: dir, artifacts: { semantic } }).find((s) => s.key === "readingOrder");
  await assert.rejects(stage.run(), (error) => /cycle/.test(error.message) && error.retryable === false);
});
