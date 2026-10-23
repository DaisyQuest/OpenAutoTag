import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createTaggingOutputStages } from '../../orchestrator/accessibility-stage-plan.js';
import { artifactDownloadPolicy } from '../../orchestrator/artifact-policy.js';
import { checkCandidateCompletion } from '../../scripts/check-candidate-completion.js';
import { resolveJavaTool, buildJavaExecEnv } from '../../scripts/java-runtime.js';

test('production gate qualifies complete native and preserved evidence and rejects silent source omission', async t => {
  const dir = process.env.COMPLETION_EVIDENCE_DIR || await mkdtemp(path.join(os.tmpdir(), 'completion-'));
  await mkdir(dir, { recursive: true }); if (!process.env.COMPLETION_EVIDENCE_DIR) t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePdf = path.join(dir, 'source.pdf'), semantic = path.join(dir, 'semantic.json');
  const bundledJavaHome = path.resolve('modules/validator/vendor/java'), java = await resolveJavaTool('java', 'PIPELINE_JAVA_PATH', { bundledJavaHome });
  await promisify(execFile)(java, ['-cp', path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'), path.resolve('test/fixtures/java/CompletionFixture.java'), sourcePdf,
    path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf')], { env: await buildJavaExecEnv({ bundledJavaHome }), windowsHide: true });
  const original = await readFile(sourcePdf);
  const document = { schemaVersion: '1.0.0', documentId: 'completion', source: { layoutDocumentId: 'completion' }, nodes:
    ['First paragraph for accessibility review.', 'Second paragraph must remain available.'].map((text, i) => ({ id: `n${i}`, sourceBlockId: `b${i}`, pageNumber: 1, role: 'P', text, bbox: [72,58 + i * 60,400,18], confidence: 1, readingOrder: i })) };
  await writeFile(semantic, JSON.stringify(document));
  async function pipeline(name, input, semanticPath, mode) {
    const output = path.join(dir, name); await mkdir(output, { recursive: true });
    const artifacts = { semanticOrdered: semanticPath };
    const stages = createTaggingOutputStages({ filePath: input, resolvedOutputDir: output, artifacts, productionChecks: true, writerArgs: () => ['--mode', mode] });
    return { artifacts, stages, job: { input: { stagedFilePath: input, options: { productionChecks: true } }, artifacts } };
  }
  async function runStages(run) { for (const stage of run.stages) { const result = await stage.run(); Object.assign(run.artifacts, result.artifacts); } }
  const native = await pipeline('native', sourcePdf, semantic, 'native'); await runStages(native);
  const report = JSON.parse(await readFile(native.artifacts.completionReport));
  assert.equal(report.disposition, 'review_required'); assert.equal(report.nativePreservation.status, 'verified'); assert.equal(report.coverage.unassignedGlyphs, 0);
  assert.equal(native.artifacts.taggedPdf, undefined); assert.equal((await artifactDownloadPolicy(native.job, 'candidatePdf', true)).allowed, true);
  assert.equal((await artifactDownloadPolicy(native.job, 'candidatePdf')).allowed, false);
  const preserved = await pipeline('preserved', native.artifacts.candidatePdf, semantic, 'passthrough'); await runStages(preserved);
  assert.equal(JSON.parse(await readFile(preserved.artifacts.completionReport)).mode, 'preserved');
  assert.equal((await artifactDownloadPolicy(preserved.job, 'candidatePdf', true)).allowed, true);
  await t.test('independent replay rejects a trimmed validation report and a trimmed saved report', async () => {
    const a = native.artifacts;
    const options = { sourcePdf, candidatePdf: a.candidatePdf, qualityReport: a.qualityReport, validationReport: a.validationReport, savedSemantics: a.savedSemantics, tagManifest: a.tagManifest, tagging: a.tagging, sourceOwnership: a.sourceOwnership };
    for (const [file, edit, expected] of [[a.validationReport, r => { r.rawSummary.passedChecks--; r.summary.passedChecks--; }, 'raw_validation'],
      [a.savedSemantics, r => { r.checks.pop(); r.summary.passed--; }, 'saved_report_complete']]) {
      const bytes = await readFile(file), changed = JSON.parse(bytes); edit(changed); await writeFile(file, JSON.stringify(changed));
      const failed = await checkCandidateCompletion(options); assert.equal(failed.disposition, 'unqualified'); assert.ok(failed.checks.some(c => c.id === expected && c.status === 'fail'));
      await writeFile(file, bytes);
    }
    await assert.rejects(checkCandidateCompletion({ ...options, outputPath: sourcePdf }), /overwrite an input/);
    await assert.rejects(checkCandidateCompletion({ ...options, sourceOwnership: undefined }), /both tagging/);
  });
  const partialPath = path.join(dir, 'partial-semantic.json'); await writeFile(partialPath, JSON.stringify({ ...document, nodes: document.nodes.slice(0,1) }));
  const omitted = await pipeline('omitted', sourcePdf, partialPath, 'native');
  await assert.rejects(runStages(omitted), /Candidate evidence is incomplete/);
  const incomplete = JSON.parse(await readFile(omitted.artifacts.completionReport));
  assert.ok(incomplete.coverage.unassignedGlyphs > 0); assert.equal(incomplete.disposition, 'unqualified');
  assert.equal((await artifactDownloadPolicy(omitted.job, 'candidatePdf', true)).allowed, false);
  await t.test('a failed retry invalidates its previous completion artifact', async () => {
    const artifacts = { ...native.artifacts, taggedPdf: path.join(dir, 'missing.pdf') };
    const output = path.join(dir, 'failed-retry'); await mkdir(output, { recursive: true });
    const stage = createTaggingOutputStages({ filePath: sourcePdf, resolvedOutputDir: output, artifacts, productionChecks: true }).find(s => s.key === 'preservationQuality');
    await assert.rejects(stage.run()); assert.equal(artifacts.completionReport, undefined);
    assert.equal((await artifactDownloadPolicy({ ...native.job, artifacts }, 'candidatePdf', true)).allowed, false);
  });
  assert.deepEqual(await readFile(sourcePdf), original);
});
