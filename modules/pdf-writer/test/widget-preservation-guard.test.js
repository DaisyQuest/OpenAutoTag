import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { requireWidgetFreeRasterSource } from '../widget-preservation-guard.js';

for (const scenario of ['empty', 'empty-form', 'link', 'widget', 'direct-widget', 'orphan-widget', 'fields', 'xfa']) {
  test(`raster source guard: ${scenario}`, async () => {
    const doc = await PDFDocument.create(), page = doc.addPage(), key = PDFName.of;
    if (['widget', 'direct-widget', 'orphan-widget', 'link'].includes(scenario)) {
      const annotation = doc.context.obj({ Type: 'Annot', Subtype: scenario === 'link' ? 'Link' : 'Widget', Rect: [0, 0, 20, 20] });
      const ref = scenario === 'direct-widget' ? annotation : doc.context.register(annotation);
      if (scenario !== 'orphan-widget') page.node.set(key('Annots'), doc.context.obj([ref]));
    }
    if (scenario === 'fields' || scenario === 'empty-form') doc.catalog.set(key('AcroForm'), doc.context.obj({ Fields: scenario === 'fields' ? [doc.context.register(doc.context.obj({ FT: 'Tx' }))] : [] }));
    if (scenario === 'xfa') doc.catalog.set(key('AcroForm'), doc.context.obj({ XFA: [] }));
    const bytes = await doc.save({ updateFieldAppearances: false });
    if (['empty', 'empty-form', 'link'].includes(scenario)) await requireWidgetFreeRasterSource(bytes);
    else await assert.rejects(requireWidgetFreeRasterSource(bytes), /Raster output would flatten native form/);
  });
}
