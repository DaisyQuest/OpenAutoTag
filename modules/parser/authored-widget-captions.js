import { PDFDocument, PDFDict, PDFName, PDFString, PDFHexString } from "pdf-lib";

// Read only: /MK /CA is authored metadata, distinct from text painted by /AP.
// Match exact indirect references, never field names shared by several widgets.
// Callers must restrict these captions to PDF.js-confirmed push buttons: checkbox
// captions commonly contain font-specific marks such as "4", not field names.
export async function authoredWidgetCaptions(bytes) {
  const captions = new Map();
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    for (const [ref, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict) || object.lookup(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
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
    return { captions };
  } catch (error) {
    // A secondary metadata read must not break usable PDF.js extraction.
    return { captions: new Map(), error: `Authored button captions unavailable: ${error.message}` };
  }
}
