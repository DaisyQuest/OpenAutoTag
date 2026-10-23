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
  sourceHash: createHash('sha256').update('source bytes').digest('hex'), candidateHash: createHash("sha256").update(bytes).digest("hex"), checks: [], findings: [], limitations: [] });

// These fixtures exercise delivery policy, not the independent PDF checker.
async function bindCompletion(job, dir, mode = 'preserved') {
  job.input.stagedFilePath ||= path.join(dir, 'source.pdf');
  await writeFile(job.input.stagedFilePath, 'source bytes');
  for (const role of ['validationReport','savedSemantics','tagManifest', ...(mode === 'native' ? ['tagging','sourceOwnership'] : [])]) {
    job.artifacts[role] ||= path.join(dir, role + '.json'); await writeFile(job.artifacts[role], '{}');
  }
  const quality = JSON.parse(await readFile(job.artifacts.qualityReport));
  const evidence = [];
  for (const role of ['sourcePdf','candidatePdf','qualityReport','validationReport','savedSemantics','tagManifest', ...(mode === 'native' ? ['tagging','sourceOwnership'] : [])]) {
    const file = role === 'sourcePdf' ? job.input.stagedFilePath : job.artifacts[role], bytes = await readFile(file);
    evidence.push({ role, path: file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  }
  const report = { schemaVersion: '1.0.0', policy: 'candidate-completion-v1', mode, disposition: 'review_required', humanReviewRequired: true,
    sourceHash: quality.sourceHash, candidateHash: quality.candidateHash,
    checks: ['evidence_complete','ownership_inputs','saved_report_complete','saved_semantics','form_navigation','ocr_review','source_coverage','raw_validation','preservation','inspection_integrity'].map(id => ({ id, status: 'pass' })),
    coverage: { status: 'complete', ...Object.fromEntries(['totalGlyphs','taggedGlyphs','authoredArtifactGlyphs','unassignedWhitespace','unassignedGlyphs','unknownGlyphs','totalImages','taggedImages','authoredArtifactImages','unassignedImages'].map(k => [k,0])) }, evidence, limitations: ['Human review required.'] };
  if (mode === 'native') report.nativePreservation = { schemaVersion: '1.0.0', policy: 'native-preservation-v1', sourceHash: quality.sourceHash, candidateHash: quality.candidateHash, status: 'verified', dpi: 120, pageCount: 1, unavailable: [], limitations: [],
    checks: ['page_count','navigation','widget_inventory','acroform','source_stable','candidate_stable', ...['OpenAction','AA','Names','PageMode','Threads'].map(k => 'catalog:' + k), 'geometry:1','annotations:1','pixels:1:VIEW','pixels:1:PRINT'].map(id => ({ id, status: 'pass', source: id === 'widget_inventory' ? [] : 'fixture', candidate: id === 'widget_inventory' ? [] : 'fixture' })) };
  job.artifacts.completionReport = path.join(dir, 'completion.json'); await writeFile(job.artifacts.completionReport, JSON.stringify(report));
  return report;
}

test("download gating binds review consent to the inspected bytes and fails closed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "artifact-policy-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const pdf = path.join(dir, "candidate.pdf"), reportPath = path.join(dir, "quality.json"); await writeFile(pdf, "pdf bytes");
  const job = { input: { options: { productionChecks: true } }, artifacts: { candidatePdf: pdf } };
  assert.equal((await artifactDownloadPolicy(job, "candidatePdf", true)).allowed, false);
  job.artifacts.qualityReport = reportPath;
  for (const disposition of ["error", "rejected", "review_required"]) {
    await writeFile(reportPath, JSON.stringify(reportFor("pdf bytes", disposition)));
    await bindCompletion(job, dir);
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
  await bindCompletion(job, dir);
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

test('downloads reject changed or missing supporting files, partial evidence, and reports from another job', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-support-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const candidatePdf = path.join(dir, 'candidate.pdf'), qualityReport = path.join(dir, 'quality.json');
  await writeFile(candidatePdf, 'candidate bytes'); await writeFile(qualityReport, JSON.stringify(reportFor('candidate bytes')));
  const job = { input: { options: { productionChecks: true } }, artifacts: { candidatePdf, qualityReport } };
  const report = await bindCompletion(job, dir, 'native');
  for (const status of ['queued','running','failed','cancelled']) {
    job.status = status; assert.equal((await artifactDownloadPolicy(job, 'candidatePdf', true)).allowed, false);
  }
  job.status = 'completed'; assert.equal((await artifactDownloadPolicy(job, 'candidatePdf', true)).allowed, true);
  for (const entry of report.evidence.filter(e => e.role !== 'candidatePdf')) {
    const original = await readFile(entry.path); await writeFile(entry.path, Buffer.concat([original, Buffer.from(' ')]));
    assert.equal((await artifactDownloadPolicy(job, 'candidatePdf', true)).allowed, false, entry.role);
    await rm(entry.path); assert.equal((await artifactDownloadPolicy(job, 'candidatePdf', true)).allowed, false, entry.role);
    await writeFile(entry.path, original);
  }
  for (const edit of [r => r.checks.pop(), r => r.checks[0] = r.checks[1], r => r.checks[0].status = 'fail', r => r.disposition = 'unqualified',
    r => r.evidence.pop(), r => r.evidence[0] = r.evidence[1], r => r.coverage.status = 'incomplete', r => r.humanReviewRequired = false,
    r => r.evidence[0].path = candidatePdf, r => delete r.nativePreservation, r => r.nativePreservation.checks.pop(),
    r => r.nativePreservation.unavailable.push('XFA'), r => r.nativePreservation.checks[0].candidate = 'changed']) {
    const changed = structuredClone(report); edit(changed); await writeFile(job.artifacts.completionReport, JSON.stringify(changed));
    assert.equal((await artifactDownloadPolicy(job, 'candidatePdf', true)).allowed, false);
  }
  await rm(job.artifacts.completionReport); assert.equal((await artifactDownloadPolicy(job, 'candidatePdf', true)).allowed, false);
  await writeFile(job.artifacts.completionReport, JSON.stringify(report));
  job.input.stagedFilePath = path.join(dir, 'different.pdf'); await writeFile(job.input.stagedFilePath, 'source bytes');
  assert.equal((await artifactDownloadPolicy(job, 'candidatePdf', true)).allowed, false);
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
