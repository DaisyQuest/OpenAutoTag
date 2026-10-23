import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import inspectionSchema from '../../contracts/pdf-preservation-inspection.schema.json' with { type: 'json' };
import taggingSchema from '../../contracts/tagging.schema.json' with { type: 'json' };
import ownershipSchema from '../../contracts/source-ownership.schema.json' with { type: 'json' };
import savedSchema from '../../contracts/saved-semantics.schema.json' with { type: 'json' };
import qualitySchema from '../../contracts/quality-report.schema.json' with { type: 'json' };
import { compareSavedSemantics } from './saved-semantics.js';
import { completionCoverage } from './completion-coverage.js';
import { evaluatePreservation } from './quality-cli.js';

const ajv = new Ajv2020();
const valid = Object.fromEntries(Object.entries({ inspection: inspectionSchema, tagging: taggingSchema,
  ownership: ownershipSchema, saved: savedSchema, quality: qualitySchema }).map(([key, schema]) => [key, ajv.compile(schema)]));
const classicChecks = ['inspection', 'objectIdentity', 'navigation', 'pageContentAndResources', 'fields',
  'widgets', 'headingContent', 'links', 'observedStructure', 'requiredValidation'];
const hashPattern = /^[a-f0-9]{64}$/;

function completeValidation(report, candidateHash) {
  const counts = report?.rawSummary;
  return report?.status === 'completed' && report.pdfSha256 === candidateHash && report.isCompliant === true &&
    report.overall?.status === 'pass' && !report.engine?.executionError && report.engine?.name === 'veraPDF' &&
    typeof report.engine.version === 'string' && report.profileName === 'PDF/UA-1 validation profile' &&
    report.fontAudit?.status === 'ok' && report.fontAudit.errorCount === 0 && Array.isArray(report.fonts) &&
    counts && ['passedRules', 'passedChecks'].every(k => Number.isSafeInteger(counts[k]) && counts[k] > 0) &&
    counts.failedRules === 0 && counts.failedChecks === 0 && isDeepStrictEqual(report.summary, counts) &&
    [report.findings, report.rawFindings].every(items => Array.isArray(items) && items.every(f =>
      f && typeof f.code === 'string' && ['info', 'warning'].includes(f.severity)));
}

function nativePreserved(proof, source, candidate) {
  const required = ['page_count', 'navigation', 'widget_inventory', 'acroform', 'source_stable', 'candidate_stable',
    ...['OpenAction', 'AA', 'Names', 'PageMode', 'Threads'].map(k => `catalog:${k}`)];
  for (let i = 1; i <= source.pages.length; i++) required.push(`geometry:${i}`, `annotations:${i}`, `pixels:${i}:VIEW`, `pixels:${i}:PRINT`);
  for (const ref of Object.keys(source.widgets)) for (const k of ['page', 'annotationIndex', 'fieldName', 'nativeDigest', 'fieldStateHash', 'appearanceHash']) required.push(`widget:${ref}:${k}`);
  return proof?.policy === 'native-preservation-v1' && proof.status === 'verified' && proof.dpi === 120 &&
    proof.sourceHash === source.sourceHash && proof.candidateHash === candidate.sourceHash &&
    proof.pageCount === source.pages.length && Array.isArray(proof.unavailable) && !proof.unavailable.length &&
    Array.isArray(proof.checks) && proof.checks.length === required.length &&
    new Set(proof.checks.map(c => c.id)).size === required.length &&
    required.every(id => proof.checks.some(c => c.id === id && c.status === 'pass' && isDeepStrictEqual(c.source, c.candidate)));
}

/** Only complete machine evidence permits a review candidate. Human approval is
 * deliberately outside this decision and can never be inferred from a pass. */
export function evaluateCandidateCompletion(input) {
  const { mode, source, candidate, tagging, ownership, saved, quality, validation, validationReplay, manifest, nativePreservation, evidence, prefixPreserved } = input;
  if (!['native', 'preserved'].includes(mode) || !valid.inspection(source) || !valid.inspection(candidate)) throw new Error('Invalid completion inspection inputs');
  if (!Array.isArray(evidence) || evidence.some(e => !hashPattern.test(e.sha256))) throw new Error('Invalid completion evidence hashes');
  const byRole = new Map(evidence.map(e => [e.role, e]));
  const checks = [];
  const add = (id, pass) => checks.push({ id, status: pass ? 'pass' : 'fail' });
  const roles = ['sourcePdf', 'candidatePdf', 'qualityReport', 'validationReport', 'savedSemantics', 'tagManifest', ...(mode === 'native' ? ['tagging', 'sourceOwnership'] : [])];
  add('evidence_complete', byRole.size === evidence.length && evidence.length === roles.length && roles.every(r => byRole.has(r)) &&
    byRole.get('sourcePdf')?.sha256 === source.sourceHash && byRole.get('candidatePdf')?.sha256 === candidate.sourceHash);
  const inputsValid = mode === 'preserved' || valid.tagging(tagging) && valid.ownership(ownership);
  add('ownership_inputs', inputsValid && (mode === 'native' ? ownership.sourceHash === source.sourceHash && ownership.intentHash === byRole.get('tagging')?.sha256 : prefixPreserved === true));
  let expected;
  if (inputsValid) {
    expected = compareSavedSemantics(mode === 'native' ? { inspection: candidate, sourceInspection: source, sourceOwnership: ownership, tagging } : { inspection: candidate, reference: source });
    if (mode === 'native') Object.assign(expected, { intentHash: byRole.get('tagging')?.sha256, sourceHash: source.sourceHash, ownershipHash: byRole.get('sourceOwnership')?.sha256 });
  }
  add('saved_report_complete', valid.saved(saved) && expected && isDeepStrictEqual(saved, expected));
  add('saved_semantics', expected?.disposition === 'automated_pass' && expected.summary.passed > 0 && expected.summary.failed === 0 && (mode === 'preserved' || expected.ownershipStatus === 'verified'));
  const widgets = Object.values(candidate.widgets);
  add('form_navigation', mode === 'native' ? !widgets.length || expected?.formNavigation?.status === 'structure_verified' :
    widgets.every(w => w.owners.length === 1 && candidate.pages[w.page - 1]?.tabOrder === 'S'));
  add('ocr_review', !expected?.ocrReview || ['none', 'recorded'].includes(expected.ocrReview.status));
  const coverage = completionCoverage({ source, ownership: inputsValid ? ownership : undefined, mode });
  add('source_coverage', coverage.status === 'complete');
  add('raw_validation', completeValidation(validation, candidate.sourceHash) && isDeepStrictEqual(validation, validationReplay) &&
    manifest?.nativeTaggingApplied === true && valid.tagging(manifest.tagging) && (mode === 'preserved' || isDeepStrictEqual(manifest.tagging, tagging)));
  const freshQuality = evaluatePreservation({ source, candidate, validation: validationReplay, identityPreserved: prefixPreserved });
  const qualifiedQuality = valid.quality(quality) && quality.sourceHash === source.sourceHash && quality.candidateHash === candidate.sourceHash && quality.disposition === 'review_required' &&
    new Set(quality.checks.map(c => c.id)).size === quality.checks.length && quality.checks.every(c => c.status === 'pass' || mode === 'native' && c.id === 'objectIdentity' && c.status === 'unknown') &&
    (mode === 'native' ? ['inspection', 'objectIdentity', 'requiredValidation'] : classicChecks).every(id => quality.checks.some(c => c.id === id));
  add('preservation', qualifiedQuality && freshQuality.checks.every(c => quality.checks.some(q => q.id === c.id && q.status === c.status)) &&
    (mode === 'preserved' || nativePreserved(nativePreservation, source, candidate)));
  add('inspection_integrity', !candidate.issues.length && candidate.navigation && !candidate.navigation.issues.length);
  return { schemaVersion: '1.0.0', policy: 'candidate-completion-v1', mode,
    disposition: checks.every(c => c.status === 'pass') ? 'review_required' : 'unqualified', humanReviewRequired: true,
    sourceHash: source.sourceHash, candidateHash: candidate.sourceHash, checks, coverage, evidence,
    ...(nativePreservation ? { nativePreservation } : {}),
    limitations: ['Machine evidence does not certify semantic accuracy or full accessibility. Human semantic, visual, assistive-technology and interactive-form review remains required.',
      'Coverage counts inspected source text and image occurrences. Vector meaning, clipping and authored artifact correctness require human review.'] };
}
