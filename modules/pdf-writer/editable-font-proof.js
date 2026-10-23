import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import samplesSchema from '../../contracts/editable-font-samples.schema.json' with { type: 'json' };
import proofSchema from '../../contracts/editable-font-proof.schema.json' with { type: 'json' };
import { ensureJavaHelperCompiled } from './index.js';
import { buildJavaExecEnv, resolveJavaTool } from '../../scripts/java-runtime.js';
import { getRuntimeBuildDir } from '../../scripts/runtime-paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bundledJavaHome = path.join(root, 'modules/validator/vendor/java');
const ajv = new Ajv2020({ allErrors: true });
const validateSamples = ajv.compile(samplesSchema), validateProof = ajv.compile(proofSchema);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Exercises exact proposed values in separate QA copies; never edits the source. */
export async function qualifyEditableFonts({ sourcePdf, samplesPath, outputDir } = {}) {
  if (!sourcePdf || !samplesPath || !outputDir) throw new Error('Required: --pdf, --samples and --output-dir');
  const source = path.resolve(sourcePdf), samplesFile = path.resolve(samplesPath), target = path.resolve(outputDir);
  if ((await stat(source)).size > 64 * 1024 * 1024 || (await stat(samplesFile)).size > 64 * 1024) throw new Error('Editable font input size limit exceeded');
  const sourceBytes = await readFile(source), requestBytes = await readFile(samplesFile);
  if (sourceBytes.length > 64 * 1024 * 1024 || requestBytes.length > 64 * 1024) throw new Error('Editable font input size limit exceeded');
  const sourceHash = sha(sourceBytes), samplesHash = sha(requestBytes), request = JSON.parse(requestBytes);
  if (!validateSamples(request)) throw new Error(`Invalid editable font samples: ${JSON.stringify(validateSamples.errors)}`);
  if (request.sourceHash !== sourceHash) throw new Error('Editable font samples have a stale source hash');
  if (sourceBytes.length * request.samples.length > 128 * 1024 * 1024) throw new Error('Projected probe size limit exceeded');
  const pairs = new Set(); let total = 0;
  for (const { fieldRef, value } of request.samples) {
    if (!value.isWellFormed()) throw new Error('Sample contains unpaired UTF-16 surrogate');
    const key = JSON.stringify([fieldRef, value]);
    if (pairs.has(key)) throw new Error('Duplicate editable font sample');
    pairs.add(key); total += Buffer.byteLength(value, 'utf8');
  }
  if (total > 8192) throw new Error('Editable sample text size limit exceeded');
  await ensureJavaHelperCompiled();
  const java = await resolveJavaTool('java', 'PIPELINE_JAVA_PATH', { bundledJavaHome });
  // Exclusive directory creation prevents accidental reuse/overwrite, including source aliases.
  await mkdir(target);
  const input = path.join(target, 'samples.tsv');
  await writeFile(input, request.samples.map(s => `${s.fieldRef}\t${Buffer.from(s.value).toString('base64')}`).join('\n'), { flag: 'wx' });
  const { stdout } = await promisify(execFile)(java, ['-XX:TieredStopAtLevel=1', '-Xmx512m', '-cp',
    [getRuntimeBuildDir('modules-pdf-writer', { repoRoot: root }), path.join(root, 'modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar')].join(path.delimiter),
    'EditableFontProof', source, target, input, sourceHash],
  { env: await buildJavaExecEnv({ bundledJavaHome }), windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  if (sha(await readFile(source)) !== sourceHash || sha(await readFile(samplesFile)) !== samplesHash) throw new Error('Input changed during editable font qualification');
  const report = { schemaVersion: '1.0.0', engine: 'PDFBox 3.0.8', sourceHash, samplesHash, ...JSON.parse(stdout) };
  if (!validateProof(report)) throw new Error(`Invalid editable font proof: ${JSON.stringify(validateProof.errors)}`);
  if (JSON.stringify(report.samples.map(({ fieldRef, value }) => ({ fieldRef, value }))) !== JSON.stringify(request.samples.map(({ fieldRef, value }) => ({ fieldRef, value })))) throw new Error('Proof does not match the requested samples');
  if ((report.status === 'verified') !== report.samples.every(s => s.status === 'verified')) throw new Error('Inconsistent aggregate qualification');
  for (const sample of report.samples) if (sample.status === 'verified' && sha(await readFile(path.join(target, sample.probeFile))) !== sample.probeHash) throw new Error('Probe changed during qualification');
  await writeFile(path.join(target, 'proof.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--pdf', '--samples', '--output-dir'].includes(process.argv[i]) || !process.argv[i + 1] || args.has(process.argv[i])) throw new Error('Invalid editable font proof arguments');
    args.set(process.argv[i], process.argv[i + 1]);
  }
  const report = await qualifyEditableFonts({ sourcePdf: args.get('--pdf'), samplesPath: args.get('--samples'), outputDir: args.get('--output-dir') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'verified') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
