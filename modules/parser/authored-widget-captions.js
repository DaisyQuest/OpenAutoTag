import { PDFDocument, PDFDict, PDFName, PDFString, PDFHexString } from "pdf-lib";

// Read only: /MK /CA is authored metadata, distinct from text painted by /AP.
// Match exact indirect references, never field names shared by several widgets.
// Callers must restrict these captions to PDF.js-confirmed push buttons: checkbox
// captions commonly contain font-specific marks such as "4", not field names.
export async function authoredWidgetCaptions(bytes) {
  const captions = new Map(), fields = new Map(), nameErrors = [];
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    const references = new Map(document.context.enumerateIndirectObjects().map(([ref, object]) => [object, ref.toString()]));
    for (const [ref, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict) || object.lookup(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
      const widgetId = `${ref.objectNumber}R${ref.generationNumber || ""}`;
      try { const field = widgetFieldMetadata(object, references); if (field) fields.set(widgetId, field); }
      catch { nameErrors.push(widgetId); }
      const mk = object.lookup(PDFName.of("MK"));
      if (!(mk instanceof PDFDict)) continue;
      const ca = mk.lookup(PDFName.of("CA"));
      if (!(ca instanceof PDFString || ca instanceof PDFHexString)) continue;
      const decoded = ca.decodeText();
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(decoded)) continue;
      const caption = decoded.replace(/\s+/g, " ").trim();
      if (!caption || caption.length > 160) continue;
      // PDF.js Ref.toString() includes the generation only when nonzero.
      captions.set(`${ref.objectNumber}R${ref.generationNumber || ""}`, caption);
    }
    return { captions, fields, nameErrors };
  } catch (error) {
    // A secondary metadata read must not break usable PDF.js extraction.
    return { captions: new Map(), fields: new Map(), nameErrors: [], error: `Authored button captions unavailable: ${error.message}` };
  }
}

// A separate widget gets its field metadata from its terminal parent. TU is
// not inherited from arbitrary nonterminal ancestors of a named field.
export function widgetFieldMetadata(widget, references) {
  const seen = new Set();let node = widget, tooltip, tooltipOwnerRef, tooltipSource;
  while (node) {
    if (!(node instanceof PDFDict) || seen.size >= 128 || seen.has(node)) throw new Error('Invalid widget field ancestry');
    seen.add(node);
    const tu = node.lookup(PDFName.of('TU'));
    if (tu !== undefined) {
      if (!(tu instanceof PDFString || tu instanceof PDFHexString)) throw new Error('Invalid field tooltip');
      const text = tu.decodeText();
      if (text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text)) throw new Error('Invalid field tooltip text');
      if (!tooltip && text.trim()) { tooltip = text;tooltipOwnerRef = references.get(node);tooltipSource = node === widget ? 'widget-TU' : 'field-TU'; }
    }
    if (node.has(PDFName.of('T')) || node.has(PDFName.of('FT'))) {
      const fieldRef = references.get(node);
      if (!fieldRef) throw new Error('Field has no indirect identity');
      return { fieldRef, ...(tooltip ? { tooltip, tooltipOwnerRef, tooltipSource } : {}) };
    }
    node = node.lookup(PDFName.of('Parent'));
  }
  return tooltip ? { tooltip, tooltipOwnerRef, tooltipSource } : undefined;
}
