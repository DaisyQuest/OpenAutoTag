import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { inspectPdfLowLevel } from '../../scripts/inspect-pdf-low-level.js';
import { resolveJavaTool, buildJavaExecEnv } from '../../scripts/java-runtime.js';
const key = PDFName.of;

test('native preservation protects current pixels, editable form resources and inactive field properties', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-preservation-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.pdf'), bundledJavaHome = path.resolve('modules/validator/vendor/java');
  const java = await resolveJavaTool('java', 'PIPELINE_JAVA_PATH', { bundledJavaHome });
  await promisify(execFile)(java, ['-cp', path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'), path.resolve('modules/pdf-writer/test/fixtures/NativeWidgetFixture.java'),
    'create', source, path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf')], { env: await buildJavaExecEnv({ bundledJavaHome }), windowsHide: true });
  const bytes = await readFile(source), proof = await inspectPdfLowLevel({ pdfPath: source, sourcePdfPath: source });
  assert.equal(proof.status, 'verified'); assert.ok(Array.isArray(proof.checks.find(c => c.id === 'widget_inventory').source));
  assert.equal(proof.checks.filter(c => c.id.startsWith('pixels:')).length, 4);
  const fields = d => d.catalog.lookup(key('AcroForm')).lookup(key('Fields'));
  const field = (d, name) => { const list = fields(d); return Array.from({ length: list.size() }, (_, i) => list.lookup(i)).find(f => f.lookup(key('T')).decodeText() === name); };
  const font = d => { const fonts = d.catalog.lookup(key('AcroForm')).lookup(key('DR')).lookup(key('Font')); return fonts.lookup(fonts.keys()[0]); };
  const variants = [
    ['value', d => field(d, 'name').set(key('V'), PDFString.of('Changed without repainting')), 'acroform'],
    ['default-value', d => field(d, 'name').set(key('DV'), PDFString.of('Changed default')), 'acroform'],
    ['field-action', d => field(d, 'name').set(key('AA'), d.context.obj({ K: { S: 'JavaScript', JS: PDFString.of('void 0;') } })), 'acroform'],
    ['export', d => field(d, 'state').set(key('Opt'), d.context.obj([[PDFString.of('wrong-export'),PDFString.of('CA')],PDFString.of('NY')])), 'acroform'],
    ['unicode', d => font(d).delete(key('ToUnicode')), 'acroform'],
    ['cid-map', d => { const child = font(d).lookup(key('DescendantFonts')).lookup(0); child.set(key('CIDToGIDMap'), d.context.register(d.context.flateStream(Buffer.alloc(131072)))); }, 'acroform'],
    ['paint', d => d.getPage(0).drawRectangle({ x: 20, y: 20, width: 30, height: 30 }), 'pixels:1:VIEW'],
    ['geometry', d => d.getPage(0).setSize(600, 790), 'geometry:1']
  ];
  for (const [name, edit, expected] of variants) await t.test(name, async () => {
    const d = await PDFDocument.load(bytes); edit(d); const candidate = path.join(dir, name + '.pdf');
    await writeFile(candidate, await d.save({ updateFieldAppearances: false }));
    const result = await inspectPdfLowLevel({ pdfPath: candidate, sourcePdfPath: source });
    assert.equal(result.status, 'rejected'); assert.ok(result.checks.some(c => c.id === expected && c.status === 'fail'), JSON.stringify(result.unavailable));
    if (['value','default-value','field-action','export','unicode'].includes(name)) assert.ok(result.checks.filter(c => c.id.startsWith('pixels:')).every(c => c.status === 'pass'), 'inactive changes must be caught even when pixels match');
  });
  for (const type of ['optional-content','xfa','render-limit']) await t.test(type, async () => {
    const d = await PDFDocument.load(bytes);
    if (type === 'optional-content') d.catalog.set(key('OCProperties'), d.context.obj({ OCGs: [], D: {} }));
    if (type === 'xfa') d.catalog.lookup(key('AcroForm')).set(key('XFA'), d.context.register(d.context.flateStream('<xfa/>')));
    if (type === 'render-limit') d.getPage(0).setSize(10000,10000);
    const file = path.join(dir, type + '.pdf'); await writeFile(file, await d.save({ updateFieldAppearances: false }));
    const result = await inspectPdfLowLevel({ pdfPath: file, sourcePdfPath: file });
    assert.equal(result.status, 'incomplete'); assert.ok(result.unavailable.length);
  });
  assert.deepEqual(await readFile(source), bytes);
});
