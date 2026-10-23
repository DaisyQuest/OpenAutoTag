import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidateCompletion } from '../candidate-completion.js';
import { evaluatePreservation } from '../quality-cli.js';
import { compareSavedSemantics } from '../saved-semantics.js';
const hash = 'a'.repeat(64), ref = 'page:1:stream:page:mcid:0';
function fixture(mode = 'preserved') {
  const source = { schemaVersion: '1.0.0', scope: 'preserved-objects-v1', sourceHash: hash, fields: {}, widgets: {}, headings: [], issues: [], limitations: [],
    navigation: { pageLabels: { present: false, treeHash: hash, ranges: [], labels: ['1'] }, outlines: { present: false, count: 0, propertiesHash: hash, graphHash: hash, items: [] }, namedDestinationsHash: hash, issues: [] },
    pages: [{ geometry: [0,0,612,792,0,0,612,792,0,1], contentHash: hash, resourcesHash: hash, annotationsHash: hash, tabOrder: 'S' }],
    structure: [{ objectRef: '1 0 R', parentRef: 'root', identifier: 'oat:root', role: 'Document', page: 1, children: [], contentRefs: [ref], headers: [], scope: '', listNumbering: '', rowSpan: 1, columnSpan: 1, actualText: '', actualTextPresent: false, alt: '' }],
    contentOrder: [ref], markedContent: [{ contentRef: ref, sequenceCount: 1, glyphCount: 1, meaningfulGlyphCount: 1, unknownGlyphCount: 0, graphicsCount: 0 }], imageRuns: [],
    textRuns: [{ pageNumber: 1, streamOrigin: 'page', operatorIndex: 0, glyphStart: 0, glyphEnd: 1, owners: [ref], artifact: false, fontName: 'Fixture', glyphs: [[65,'A']], positions: [[0,0,1,0,1,1,0,1]] }] };
  const candidate = structuredClone(source), tagging = { schemaVersion: '1.0.0', documentId: 'fixture', source: { semanticDocumentId: 'fixture' }, root: { id: 'root', type: 'Document', label: 'A', sourceNodeIds: ['a'], children: [] } };
  const validation = { status: 'completed', pdfSha256: hash, isCompliant: true, overall: { status: 'pass' }, profileName: 'PDF/UA-1 validation profile', fonts: [], findings: [], rawFindings: [], fontAudit: { status: 'ok', errorCount: 0 }, engine: { name: 'veraPDF', version: 'fixture' },
    summary: { passedRules: 1, failedRules: 0, passedChecks: 1, failedChecks: 0 }, rawSummary: { passedRules: 1, failedRules: 0, passedChecks: 1, failedChecks: 0 } };
  const input = { mode, source, candidate, tagging, manifest: { nativeTaggingApplied: true, tagging }, validation, validationReplay: structuredClone(validation), prefixPreserved: mode === 'preserved' };
  input.evidence = ['sourcePdf','candidatePdf','qualityReport','validationReport','savedSemantics','tagManifest', ...(mode === 'native' ? ['tagging','sourceOwnership'] : [])].map(role => ({ role, path: '/fixture/' + role, sha256: hash, size: 1 }));
  input.quality = evaluatePreservation({ source, candidate, validation, identityPreserved: input.prefixPreserved });
  if (mode === 'native') {
    input.ownership = { schemaVersion: '1.0.0', sourceHash: hash, intentHash: hash, ranges: [{ pageNumber: 1, streamOrigin: 'page', operatorIndex: 0, glyphStart: 0, glyphEnd: 1, tagNodeId: 'root' }] };
    input.saved = { ...compareSavedSemantics({ inspection: candidate, sourceInspection: source, sourceOwnership: input.ownership, tagging }), sourceHash: hash, intentHash: hash, ownershipHash: hash };
    const ids = ['page_count','navigation','widget_inventory','acroform','source_stable','candidate_stable', ...['OpenAction','AA','Names','PageMode','Threads'].map(k => 'catalog:' + k), 'geometry:1','annotations:1','pixels:1:VIEW','pixels:1:PRINT'];
    input.nativePreservation = { policy: 'native-preservation-v1', status: 'verified', sourceHash: hash, candidateHash: hash, dpi: 120, pageCount: 1, unavailable: [], checks: ids.map(id => ({ id, status: 'pass', source: hash, candidate: hash })) };
  } else input.saved = compareSavedSemantics({ inspection: candidate, reference: source });
  return input;
}
const failed = input => evaluateCandidateCompletion(input).checks.filter(c => c.status === 'fail').map(c => c.id);
test('complete preserved and native machine evidence still requires human review', () => {
  for (const mode of ['preserved','native']) {
    const input = fixture(mode), report = evaluateCandidateCompletion(input);
    assert.deepEqual(failed(input), []); assert.equal(report.disposition, 'review_required'); assert.equal(report.humanReviewRequired, true);
  }
});
test('partial, duplicate, stale and failed preservation reports cannot qualify', () => {
  for (const edit of [i => i.quality.checks = [], i => i.quality.checks.push(i.quality.checks[0]), i => i.quality.candidateHash = 'b'.repeat(64), i => i.quality.sourceHash = null,
    i => i.quality.checks[0].status = 'unknown', i => i.quality.disposition = 'rejected', i => i.prefixPreserved = false]) {
    const i = fixture(); edit(i); assert.ok(failed(i).length);
  }
});
test('trimmed or altered saved reports fail even when their remaining summary says pass', () => {
  for (const edit of [i => { i.saved.checks.pop(); i.saved.summary.passed--; }, i => i.saved.checks[0].actual = 'invented', i => i.saved.disposition = 'rejected']) {
    const i = fixture(); edit(i); assert.ok(failed(i).includes('saved_report_complete'));
  }
});
test('raw validation requires complete positive counts, font audit and independent replay', () => {
  for (const edit of [v => v.rawSummary.passedChecks = 0, v => v.rawSummary.failedChecks = 1, v => v.rawSummary.passedRules = 1.5,
    v => v.fontAudit.errorCount = 1, v => v.fontAudit.status = 'skipped', v => v.profileName = 'PDF/A', v => v.engine.executionError = 'timeout',
    v => v.rawFindings.push({ code: 'raw-error', severity: 'error' }), v => delete v.rawFindings, v => v.pdfSha256 = 'b'.repeat(64)]) {
    const i = fixture(); edit(i.validation); assert.ok(failed(i).includes('raw_validation'));
  }
  const i = fixture(); i.validationReplay.summary.passedChecks++; assert.ok(failed(i).includes('raw_validation'));
  const j = fixture(); j.manifest.nativeTaggingApplied = false; assert.ok(failed(j).includes('raw_validation'));
});
test('coverage detects orphan source text independently of a passing saved structure comparison', () => {
  const i = fixture(); for (const d of [i.source,i.candidate]) { d.textRuns[0].owners = []; d.structure[0].contentRefs = []; d.contentOrder = []; d.markedContent = []; }
  i.saved = compareSavedSemantics({ inspection: i.candidate, reference: i.source }); assert.equal(i.saved.disposition, 'automated_pass'); assert.ok(failed(i).includes('source_coverage'));
});
test('evidence inventory requires every role once and exact source/candidate hashes', () => {
  for (const edit of [i => i.evidence.pop(), i => i.evidence.push(i.evidence[0]), i => i.evidence[0].sha256 = 'b'.repeat(64), i => i.evidence[0].role = 'unexpected']) {
    const i = fixture(); edit(i); assert.ok(failed(i).includes('evidence_complete'));
  }
  assert.throws(() => evaluateCandidateCompletion({}), /Invalid completion inspection/);
  const i = fixture(); i.evidence[0].sha256 = ''; assert.throws(() => evaluateCandidateCompletion(i), /evidence hashes/);
});
test('native preservation cannot waive missing, failed, stale or unsupported evidence', () => {
  for (const edit of [i => delete i.nativePreservation, i => i.nativePreservation.status = 'incomplete', i => i.nativePreservation.checks.pop(), i => i.nativePreservation.checks[0].candidate = 'changed',
    i => i.nativePreservation.checks[0].status = 'fail', i => i.nativePreservation.sourceHash = 'b'.repeat(64), i => i.nativePreservation.unavailable.push('XFA'), i => i.nativePreservation.dpi = 72]) {
    const i = fixture('native'); edit(i); assert.ok(failed(i).includes('preservation'));
  }
});
test('native ranges, saved ownership and tagging intent must agree', () => {
  for (const edit of [i => i.ownership.ranges = [], i => i.ownership.intentHash = 'b'.repeat(64), i => delete i.ownership, i => i.tagging.root.label = 'different']) {
    const i = fixture('native'); edit(i); assert.ok(failed(i).length);
  }
});
