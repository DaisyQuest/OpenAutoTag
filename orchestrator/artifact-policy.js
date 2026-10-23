import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from "ajv/dist/2020.js";
import qualitySchema from "../contracts/quality-report.schema.json" with { type: "json" };
import completionSchema from "../contracts/candidate-completion.schema.json" with { type: "json" };
const validQuality = new Ajv2020().compile(qualitySchema);
const validCompletion = new Ajv2020().compile(completionSchema);
const requiredChecks = ['evidence_complete', 'ownership_inputs', 'saved_report_complete', 'saved_semantics', 'form_navigation',
  'ocr_review', 'source_coverage', 'raw_validation', 'preservation', 'inspection_integrity'];
function completeNativeProof(report) {
  const p = report.nativePreservation;
  if (!p || p.status !== 'verified' || p.unavailable.length || p.sourceHash !== report.sourceHash || p.candidateHash !== report.candidateHash || p.pageCount < 1 || p.pageCount > 500) return false;
  const widgets = p.checks.find(c => c.id === 'widget_inventory')?.source;
  if (!Array.isArray(widgets) || widgets.some(v => typeof v !== 'string') || new Set(widgets).size !== widgets.length) return false;
  const ids = ['page_count','navigation','widget_inventory','acroform','source_stable','candidate_stable', ...['OpenAction','AA','Names','PageMode','Threads'].map(k => `catalog:${k}`)];
  for (let i = 1; i <= p.pageCount; i++) ids.push(`geometry:${i}`, `annotations:${i}`, `pixels:${i}:VIEW`, `pixels:${i}:PRINT`);
  for (const ref of widgets) for (const key of ['page','annotationIndex','fieldName','nativeDigest','fieldStateHash','appearanceHash']) ids.push(`widget:${ref}:${key}`);
  return p.checks.length === ids.length && ids.every(id => p.checks.some(c => c.id === id && c.status === 'pass' && isDeepStrictEqual(c.source, c.candidate)));
}

export async function artifactDownloadPolicy(job, artifactName, reviewCandidate = false, servedBytes) {
  const file = job?.artifacts?.[artifactName];
  if (!file || path.extname(file).toLowerCase() !== ".pdf") return { allowed: true };
  const source = job.input?.stagedFilePath;
  const canonical = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (source && canonical(file) === canonical(source)) return { allowed: true };
  const gated = job.input?.options?.productionChecks || job.artifacts?.candidatePdf || job.artifacts?.qualityReport;
  if (!gated) return { allowed: true };
  if (job.status !== undefined && job.status !== 'completed') return { allowed: false, reason: 'Candidate processing has not completed successfully.' };
  if (!job.artifacts?.qualityReport) return { allowed: false, reason: "Candidate quality checks have not completed." };
  let report;
  try { report = JSON.parse(await readFile(job.artifacts.qualityReport, "utf8")); }
  catch { return { allowed: false, reason: "Candidate quality report is unavailable." }; }
  if (!validQuality(report) || report.disposition !== "review_required") return { allowed: false, reason: "Candidate failed quality checks or has an invalid quality report." };
  let completion;
  try { completion = JSON.parse(await readFile(job.artifacts.completionReport, 'utf8')); }
  catch { return { allowed: false, reason: 'Candidate completion evidence is unavailable.' }; }
  if (!validCompletion(completion) || completion.disposition !== 'review_required' || completion.coverage.status !== 'complete' ||
      !requiredChecks.every(id => completion.checks.some(c => c.id === id && c.status === 'pass')) ||
      completion.sourceHash !== report.sourceHash || completion.candidateHash !== report.candidateHash || completion.mode === 'native' && !completeNativeProof(completion))
    return { allowed: false, reason: 'Candidate has incomplete or failed accessibility evidence.' };
  const roles = ['sourcePdf', 'candidatePdf', 'qualityReport', 'validationReport', 'savedSemantics', 'tagManifest', ...(completion.mode === 'native' ? ['tagging', 'sourceOwnership'] : [])];
  if (completion.evidence.length !== roles.length || new Set(completion.evidence.map(e => e.role)).size !== roles.length ||
      !roles.every(role => completion.evidence.some(e => e.role === role)))
    return { allowed: false, reason: 'Candidate evidence inventory is incomplete.' };
  try {
    for (const entry of completion.evidence) {
      const expected = entry.role === 'sourcePdf' ? source : job.artifacts[entry.role];
      if (!expected || canonical(expected) !== canonical(entry.path) || entry.role === 'candidatePdf' && canonical(file) !== canonical(expected))
        return { allowed: false, reason: 'Candidate evidence does not match this job.' };
      const bytes = entry.role === 'candidatePdf' && servedBytes !== undefined ? servedBytes : await readFile(expected);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== entry.size || digest !== entry.sha256 ||
          entry.role === 'sourcePdf' && digest !== completion.sourceHash || entry.role === 'candidatePdf' && digest !== completion.candidateHash)
        return { allowed: false, reason: `Candidate evidence changed after inspection: ${entry.role}.` };
    }
  } catch { return { allowed: false, reason: 'Candidate supporting evidence is unavailable.' }; }
  if (!reviewCandidate) return { allowed: false, reason: "This is a review candidate. Request candidate=1 explicitly; it is not an accepted output." };
  const hash = createHash("sha256");
  if (servedBytes !== undefined) hash.update(servedBytes);
  else for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== report.candidateHash) return { allowed: false, reason: "Candidate changed after inspection." };
  return { allowed: true, disposition: "review_required" };
}
