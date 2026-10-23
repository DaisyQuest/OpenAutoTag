import { PDFDocument, PDFDict, PDFArray, PDFName } from 'pdf-lib';

// A raster rebuild cannot retain interactive native controls. Inspect source
// objects as well as intent: older plans may omit widgets entirely. This read
// never loads AcroForm convenience objects or generates field appearances.
export async function requireWidgetFreeRasterSource(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  for (const page of document.getPages()) {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (annotations instanceof PDFArray) for (let i = 0; i < annotations.size(); i++) {
      const annotation = annotations.lookup(i);
      if (annotation instanceof PDFDict && annotation.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) {
        throw new Error('Raster output would flatten native form widgets; use native writer mode');
      }
    }
  }
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) {
      throw new Error('Raster output would flatten native form widgets; use native writer mode');
    }
  }
  // Direct widget dictionaries are legal in damaged inputs. Refuse a rebuild
  // when any field tree remains, even if it lacks an enumerable Widget object.
  const form = document.catalog.lookup(PDFName.of('AcroForm'));
  if (form instanceof PDFDict) {
    const fields = form.lookup(PDFName.of('Fields'));
    if (fields?.size?.() || form.has(PDFName.of('XFA'))) {
      throw new Error('Raster output would flatten native form fields; use native writer mode');
    }
  }
}
