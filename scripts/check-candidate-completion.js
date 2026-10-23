import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { inspectPdfLowLevel } from './inspect-pdf-low-level.js';
import { runJsonCommand } from './run-json-command.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function checkCandidateCompletion({ sourcePdf, candidatePdf, qualityReport, validationReport, savedSemantics, tagManifest, tagging, sourceOwnership, outputPath }) {
  if (Boolean(tagging) !== Boolean(sourceOwnership)) throw new Error('Native completion requires both tagging and source ownership');
  const paths = { sourcePdf, candidatePdf, qualityReport, validationReport, savedSemantics, tagManifest, ...(tagging ? { tagging, sourceOwnership } : {}) };
  const canonical = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  if (Object.values(paths).some(p => !p)) throw new Error('Missing completion input');
  if (outputPath && Object.values(paths).some(p => canonical(p) === canonical(outputPath))) throw new Error('Completion output must not overwrite an input');
  const buffers = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([role, file]) => [role, await readFile(file)])));
  const evidence = Object.entries(paths).map(([role, file]) => ({ role, path: path.resolve(file), sha256: hash(buffers[role]), size: buffers[role].length }));
  const source = await inspectPdfLowLevel({ pdfPath: sourcePdf, preservation: true });
  const candidate = await inspectPdfLowLevel({ pdfPath: candidatePdf, preservation: true });
  const nativePreservation = tagging ? await inspectPdfLowLevel({ pdfPath: candidatePdf, sourcePdfPath: sourcePdf }) : undefined;
  const validationReplay = await runJsonCommand(process.execPath, [path.resolve(import.meta.dirname, '../modules/validator/index.js'), '--pdf', path.resolve(candidatePdf), '--manifest', path.resolve(tagManifest)], { timeout: 300000 });
  const payload = { mode: tagging ? 'native' : 'preserved', source, candidate, evidence, nativePreservation, validationReplay, manifest: JSON.parse(buffers.tagManifest),
    prefixPreserved: buffers.candidatePdf.subarray(0, buffers.sourcePdf.length).equals(buffers.sourcePdf),
    ...Object.fromEntries(['qualityReport', 'validationReport', 'savedSemantics', 'tagging', 'sourceOwnership'].filter(k => buffers[k]).map(k =>
      [({ qualityReport: 'quality', validationReport: 'validation', savedSemantics: 'saved', sourceOwnership: 'ownership' })[k] || k, JSON.parse(buffers[k])])) };
  const temp = await mkdtemp(path.join(os.tmpdir(), 'candidate-completion-'));
  let report;
  try {
    const input = path.join(temp, 'input.json'); await writeFile(input, JSON.stringify(payload));
    report = await runJsonCommand(process.execPath, [path.resolve(import.meta.dirname, '../modules/validator/candidate-completion-cli.js'), input]);
  } finally { await rm(temp, { recursive: true, force: true }); }
  for (const item of evidence) if (hash(await readFile(item.path)) !== item.sha256) throw new Error(`Completion input changed during verification: ${item.role}`);
  if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}
async function main() {
  const keys = { '--source-pdf': 'sourcePdf', '--candidate-pdf': 'candidatePdf', '--quality-report': 'qualityReport', '--validation-report': 'validationReport', '--saved-semantics': 'savedSemantics', '--manifest': 'tagManifest', '--tags': 'tagging', '--ownership': 'sourceOwnership', '--output': 'outputPath' }, options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = keys[process.argv[i]];
    if (!key || !process.argv[i + 1] || options[key]) throw new Error('Invalid completion arguments');
    options[key] = process.argv[i + 1];
  }
  process.stdout.write(JSON.stringify(await checkCandidateCompletion(options), null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
