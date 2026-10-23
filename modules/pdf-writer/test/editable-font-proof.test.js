import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument, PDFName } from 'pdf-lib';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { qualifyEditableFonts } from '../editable-font-proof.js';
import { resolveJavaTool, buildJavaExecEnv } from '../../../scripts/java-runtime.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('editable font proof exercises new Unicode text without modifying the source', async t => {
  const dir = process.env.EDITABLE_FONT_EVIDENCE_DIR || await mkdtemp(path.join(os.tmpdir(), 'editable-font-'));
  await mkdir(dir, { recursive: true });
  if (!process.env.EDITABLE_FONT_EVIDENCE_DIR) t.after(() => rm(dir, { recursive: true, force: true }));
  const bundledJavaHome = path.resolve('modules/validator/vendor/java');
  const java = await resolveJavaTool('java', 'PIPELINE_JAVA_PATH', { bundledJavaHome });
  await promisify(execFile)(java, ['-XX:TieredStopAtLevel=1', '-cp', path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),
    path.resolve('modules/pdf-writer/test/fixtures/EditableFontFixture.java'), dir, path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf')],
  { env: await buildJavaExecEnv({ bundledJavaHome }), windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const evidence = []; let serial = 0;
  async function options(mode, values = ['Łódź café € 2026']) {
    const sourcePdf = path.join(dir, `${mode}.pdf`), bytes = await readFile(sourcePdf);
    // Encryption is rejected before target resolution; pdf-lib cannot decrypt this fixture.
    const pdf = mode === 'encrypted' ? null : await PDFDocument.load(bytes);
    const fieldRef = pdf ? pdf.context.enumerateIndirectObjects().find(([, o]) => o.get?.(PDFName.of('T'))?.decodeText?.() === 'sample')[0].toString() : '1 0 R';
    const request = { schemaVersion: '1.0.0', sourceHash: sha(bytes), samples: values.map(value => ({ fieldRef, value })) };
    const samplesPath = path.join(dir, `samples-${++serial}.json`), outputDir = path.join(dir, `probe-${serial}`);
    await writeFile(samplesPath, JSON.stringify(request)); return { sourcePdf, samplesPath, outputDir, request };
  }
  async function run(mode, values) {
    const opts = await options(mode, values), before = await readFile(opts.sourcePdf), report = await qualifyEditableFonts(opts);
    assert.deepEqual(await readFile(opts.sourcePdf), before, 'source PDF remains byte-identical');
    assert.equal(report.sourceHash, sha(before)); assert.equal(report.samplesHash, sha(await readFile(opts.samplesPath)));
    assert.deepEqual(JSON.parse(await readFile(path.join(opts.outputDir, 'proof.json'))), report);
    evidence.push({ mode, ...opts, report }); return { ...opts, report };
  }
  for (const mode of ['unicode', 'simple', 'inherited', 'multiwidget', 'multiline', 'comb', 'autosize']) await t.test(`${mode} qualifies supported new text`, async () => {
    const values = mode === 'simple' ? ['José café € 987', 'office fifty 123'] : mode === 'autosize' ? ['Łódź café € 2026'] : ['Łódź café € 2026', 'office fifty 123'];
    const { report, outputDir, sourcePdf } = await run(mode, values);
    assert.equal(report.status, 'verified', JSON.stringify(report));
    for (const sample of report.samples) {
      assert.equal(sample.widgets.length, mode === 'multiwidget' ? 2 : 1);
      assert.ok(sample.widgets.every(w => w.characters.every(c => c.status === 'verified')));
      const bytes = await readFile(path.join(outputDir, sample.probeFile)); assert.equal(sample.probeHash, sha(bytes));
      const original = await PDFDocument.load(await readFile(sourcePdf)), saved = await PDFDocument.load(bytes);
      const linkAppearancePresence = doc => doc.getPages().flatMap(p => {
        const a = p.node.Annots(); return a ? a.asArray().map(ref => doc.context.lookup(ref)).filter(o => o.get(PDFName.of('Subtype'))?.toString() === '/Link').map(o => o.has(PDFName.of('AP'))) : [];
      });
      assert.deepEqual(linkAppearancePresence(saved), linkAppearancePresence(original), 'rendering must not add unrelated link appearances to saved QA copies');
      const pdf = await getDocument({ data: new Uint8Array(bytes), verbosity: VerbosityLevel.ERRORS, useSystemFonts: false }).promise;
      try {
        let seen = 0;
        for (let p = 1; p <= pdf.numPages; p++) for (const annotation of await (await pdf.getPage(p)).getAnnotations()) {
          if (annotation.fieldName === 'sample') { assert.equal(annotation.fieldValue, sample.value); seen++; }
          if (annotation.fieldName === 'untouched') assert.equal(annotation.fieldValue, 'Keep this value');
        }
        assert.equal(seen, sample.widgets.length);
      } finally { await pdf.destroy(); }
    }
  });
  await t.test('unsupported supplementary characters are reported by code point, without a saved stale appearance', async () => {
    const { report, outputDir } = await run('unicode', ['New 🚀 value']);
    assert.equal(report.status, 'review_required');
    assert.ok(report.samples[0].widgets[0].characters.some(c => c.codePoint === 0x1f680 && c.status === 'unsupported'));
    assert.ok(!(await readdir(outputDir)).some(f => f.endsWith('.pdf')));
  });
  await t.test('WinAnsi cannot be certified for a new character merely present in the font program', async () => {
    const { report } = await run('simple', ['Ł']);
    assert.equal(report.status, 'review_required'); assert.equal(report.samples[0].widgets[0].characters[0].status, 'unsupported');
  });
  await t.test('autosize still requires actual glyph clipping verification', async () => {
    const { report } = await run('autosize', ['office fifty 123']);
    assert.equal(report.status, 'review_required'); assert.match(report.samples[0].reason, /clipped/);
  });
  for (const mode of ['readonly', 'password', 'rich', 'file', 'maxlen', 'hidden', 'noview', 'zero-rect', 'no-page', 'actions', 'widget-actions',
    'calculate', 'need-appearances', 'xfa', 'unembedded', 'missing-resource', 'conflict', 'clipped', 'subset', 'wrong-unicode', 'wrong-gid', 'checkbox', 'signed', 'encrypted']) await t.test(`${mode} cannot produce a false positive`, async () => {
    const { report, outputDir } = await run(mode, ['A café']); assert.equal(report.status, 'review_required', JSON.stringify(report));
    assert.ok(report.samples[0].reason.length); assert.ok(!(await readdir(outputDir)).some(f => f.endsWith('.pdf')));
    if (mode === 'wrong-unicode') assert.ok(report.samples[0].widgets[0].characters.some(c => /round-trip/.test(c.reason)));
    if (mode === 'wrong-gid') assert.ok(report.samples[0].widgets[0].characters.some(c => /disagrees/.test(c.reason)));
    if (mode === 'encrypted') assert.match(report.samples[0].reason, /Encrypted/);
    if (mode === 'signed') assert.match(report.samples[0].reason, /Signed/);
  });
  for (const value of ['line\nbreak', 'tab\tvalue', 'bidi\u202evalue', 'line\u2028break']) await t.test(`layout-dependent control ${JSON.stringify(value)} is explicit`, async () => {
    const { report } = await run('unicode', [value]); assert.equal(report.status, 'review_required'); assert.match(report.samples[0].reason, /layout review/);
  });
  await t.test('mixed requests preserve successful evidence and identify the failing sample', async () => {
    const { report, outputDir } = await run('unicode', ['café', '🚀']);
    assert.equal(report.status, 'review_required'); assert.deepEqual(report.samples.map(s => s.status), ['verified', 'review_required']);
    assert.deepEqual((await readdir(outputDir)).filter(f => f.endsWith('.pdf')), ['sample-1.pdf']);
  });
  const invalid = [
    ['stale hash', r => { r.sourceHash = '0'.repeat(64); }, /stale/],
    ['empty sample', r => { r.samples[0].value = ''; }, /Invalid editable/],
    ['surrogate', r => { r.samples[0].value = '\ud800'; }, /surrogate/],
    ['duplicate', r => { r.samples.push(r.samples[0]); }, /Duplicate/],
    ['too many', r => { r.samples = Array(17).fill(r.samples[0]); }, /Invalid editable/],
    ['too long', r => { r.samples[0].value = 'A'.repeat(257); }, /Invalid editable/],
    ['malformed ref', r => { r.samples[0].fieldRef = 'sample'; }, /Invalid editable/],
    ['unknown property', r => { r.overwrite = true; }, /Invalid editable/]
  ];
  for (const [name, mutate, pattern] of invalid) await t.test(`invalid ${name} request fails before output creation`, async () => {
    const opts = await options('unicode'); mutate(opts.request); await writeFile(opts.samplesPath, JSON.stringify(opts.request));
    await assert.rejects(qualifyEditableFonts(opts), pattern); await assert.rejects(readdir(opts.outputDir), { code: 'ENOENT' });
  });
  await t.test('missing target cannot qualify a different similarly named field', async () => {
    const opts = await options('unicode'); opts.request.samples[0].fieldRef = '999999 0 R'; await writeFile(opts.samplesPath, JSON.stringify(opts.request));
    const report = await qualifyEditableFonts(opts); assert.equal(report.status, 'review_required'); assert.match(report.samples[0].reason, /resolve uniquely/);
  });
  await t.test('existing output directories are never reused', async () => {
    const opts = await options('unicode'); await mkdir(opts.outputDir); await writeFile(path.join(opts.outputDir, 'sentinel'), 'keep');
    await assert.rejects(qualifyEditableFonts(opts), { code: 'EEXIST' }); assert.equal(await readFile(path.join(opts.outputDir, 'sentinel'), 'utf8'), 'keep');
  });
  for (const kind of ['parent-cycle', 'child-cycle', 'shared-child']) await t.test(`${kind} is bounded before PDFBox field traversal`, async () => {
    const opts = await options('unicode'), pdf = await PDFDocument.load(await readFile(opts.sourcePdf));
    const [reference, field] = pdf.context.enumerateIndirectObjects().find(([, o]) => o.get?.(PDFName.of('T'))?.decodeText?.() === 'sample');
    if (kind === 'parent-cycle') field.set(PDFName.of('Parent'), reference);
    else if (kind === 'child-cycle') field.set(PDFName.of('Kids'), pdf.context.obj([reference]));
    else pdf.catalog.lookup(PDFName.of('AcroForm')).lookup(PDFName.of('Fields')).push(reference);
    opts.sourcePdf = path.join(dir, `${kind}.pdf`); const bytes = await pdf.save(); await writeFile(opts.sourcePdf, bytes);
    opts.request.sourceHash = sha(bytes); await writeFile(opts.samplesPath, JSON.stringify(opts.request));
    const report = await qualifyEditableFonts(opts); assert.equal(report.status, 'review_required'); assert.match(report.samples[0].reason, /Cyclic/);
  });
  await t.test('aggregate UTF-8 text bound is enforced before creating output', async () => {
    const opts = await options('unicode'); opts.request.samples = Array.from({ length: 16 }, (_, i) => ({ fieldRef: opts.request.samples[0].fieldRef, value: '界'.repeat(250) + i }));
    await writeFile(opts.samplesPath, JSON.stringify(opts.request)); await assert.rejects(qualifyEditableFonts(opts), /text size limit/);
    await assert.rejects(readdir(opts.outputDir), { code: 'ENOENT' });
  });
  await t.test('CLI emits UTF-8 JSON for supported text and a failing exit for unsupported text', async () => {
    const good = await options('unicode', ['Łódź café €']);
    const call = opts => promisify(execFile)(process.execPath, ['modules/pdf-writer/editable-font-proof.js', '--pdf', opts.sourcePdf, '--samples', opts.samplesPath, '--output-dir', opts.outputDir], { windowsHide: true });
    assert.equal(JSON.parse((await call(good)).stdout).samples[0].value, 'Łódź café €');
    const bad = await options('unicode', ['🚀']);
    await assert.rejects(call(bad), error => error.code === 1 && JSON.parse(error.stdout).status === 'review_required');
  });
  await t.test('CLI rejects unknown switches and missing arguments', async () => {
    await assert.rejects(promisify(execFile)(process.execPath, ['modules/pdf-writer/editable-font-proof.js', '--overwrite', 'true']), /Invalid editable font proof arguments/);
    await assert.rejects(qualifyEditableFonts(), /Required/);
  });
  await writeFile(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
});
