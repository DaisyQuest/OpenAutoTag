// Walks every page of a pdfjs-dist document and accumulates per-font usage
// data. We rely on the operator list + text content to discover which font
// objects are referenced, then resolve the resolved Font objects out of
// page.commonObjs / page.objs.
//
// The resulting "raw font" record carries everything the analyzer needs to
// produce a contract-compliant fontEntry: the underlying Font instance from
// pdfjs (which exposes embedded data, ToUnicode tables, encoding info, etc.)
// plus the per-page glyph usage, sample text, and form-DA flag.

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

function ensureFontRecord(fonts, fontId) {
  let record = fonts.get(fontId);
  if (!record) {
    record = {
      fontId,
      pageSet: new Set(),
      glyphCount: 0,
      glyphIds: new Set(),
      sampleParts: [],
      sampleLength: 0,
      inFormDA: false,
      pdfFont: null
    };
    fonts.set(fontId, record);
  }
  return record;
}

function appendSample(record, text) {
  if (!text || record.sampleLength >= 120) {
    return;
  }
  const remaining = 120 - record.sampleLength;
  const slice = text.length > remaining ? text.slice(0, remaining) : text;
  record.sampleParts.push(slice);
  record.sampleLength += slice.length;
}

function safeGet(commonObjs, key) {
  try {
    return commonObjs.get(key);
  } catch {
    return null;
  }
}

function safeHas(commonObjs, key) {
  try {
    return commonObjs.has(key);
  } catch {
    return false;
  }
}

async function resolveFontFromObjs(page, fontId) {
  if (!fontId) {
    return null;
  }

  // pdfjs places fonts on commonObjs after they are loaded by the operator
  // executor. Operator lists embed the font id without the "g_d0_" / page
  // prefix, while textContent items include the full id.
  const commonObjs = page.commonObjs;
  const objs = page.objs;
  if (commonObjs && safeHas(commonObjs, fontId)) {
    return safeGet(commonObjs, fontId);
  }
  if (objs && safeHas(objs, fontId)) {
    return safeGet(objs, fontId);
  }
  return null;
}

function recordGlyphsFromTextItem(record, item, pdfFont) {
  // pdfjs's TextItem objects do not include the raw glyph codes — we only
  // have the decoded string. We still want a stable glyphCount for the
  // contract, so estimate using the unicode characters and (when available)
  // the Font.charsToGlyphs mapping. Fallback: codepoint count.
  const text = typeof item.str === "string" ? item.str : "";
  if (!text) {
    return;
  }

  if (pdfFont && typeof pdfFont.charsToGlyphs === "function") {
    try {
      const glyphs = pdfFont.charsToGlyphs(text);
      for (const glyph of glyphs) {
        if (!glyph) continue;
        const operatorListId = glyph.operatorListId;
        const charCode = typeof glyph.charCode === "number" ? glyph.charCode : null;
        const fontChar = typeof glyph.fontChar === "string" ? glyph.fontChar : null;
        const id = (typeof operatorListId === "number" && operatorListId)
          || (charCode !== null ? charCode : null)
          || (fontChar ? fontChar.charCodeAt(0) : null);
        if (typeof id === "number") {
          record.glyphIds.add(id);
        }
        record.glyphCount += 1;
      }
      return;
    } catch {
      // fall through
    }
  }

  for (const codePoint of text) {
    record.glyphIds.add(codePoint.codePointAt(0));
    record.glyphCount += 1;
  }
}

async function walkOperatorList(page, fonts) {
  // The operator list reveals every Tf (set font) operator with its loader
  // identifier. We use it to attribute pages to fonts that may not show up in
  // textContent (e.g. ones used only for invisible glyphs or form fields).
  let opList;
  try {
    opList = await page.getOperatorList();
  } catch {
    return;
  }

  const setFontOp = OPS?.setFont ?? 39;
  const fnArray = opList.fnArray || [];
  const argsArray = opList.argsArray || [];
  for (let index = 0; index < fnArray.length; index += 1) {
    if (fnArray[index] !== setFontOp) {
      continue;
    }
    const args = argsArray[index];
    const fontId = args && args[0];
    if (typeof fontId === "string") {
      ensureFontRecord(fonts, fontId).pageSet.add(page.pageNumber);
    }
  }
}

async function attachPdfFonts(page, fonts) {
  for (const record of fonts.values()) {
    if (record.pdfFont) {
      continue;
    }
    const pdfFont = await resolveFontFromObjs(page, record.fontId);
    if (pdfFont) {
      record.pdfFont = pdfFont;
    }
  }
}

async function processPage(page, fonts) {
  const pageNumber = page.pageNumber;
  // textContent includes a `styles` map keyed by font id and per-item
  // fontName. We also pull in the operator list for full coverage.
  const [textContent] = await Promise.all([
    page.getTextContent(),
    walkOperatorList(page, fonts)
  ]);

  await attachPdfFonts(page, fonts);

  for (const item of textContent.items || []) {
    const fontId = item.fontName;
    if (!fontId) continue;
    const record = ensureFontRecord(fonts, fontId);
    record.pageSet.add(pageNumber);
    if (!record.pdfFont) {
      record.pdfFont = await resolveFontFromObjs(page, fontId);
    }
    recordGlyphsFromTextItem(record, item, record.pdfFont);
    appendSample(record, item.str || "");
  }
}

async function inspectAcroFormDA(pdf, fonts) {
  // pdfjs surfaces form field metadata via getFieldObjects(). When a field
  // has a default appearance string referencing a font name, we mark the
  // matching record's inFormDA flag.
  let fieldObjects;
  try {
    fieldObjects = await pdf.getFieldObjects();
  } catch {
    return;
  }
  if (!fieldObjects) {
    return;
  }

  const referencedFontNames = new Set();
  for (const fields of Object.values(fieldObjects)) {
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      const da = field?.defaultAppearanceData?.fontName || field?.fontName;
      if (typeof da === "string" && da.length > 0) {
        referencedFontNames.add(da);
      }
    }
  }

  if (referencedFontNames.size === 0) {
    return;
  }

  for (const record of fonts.values()) {
    const baseName = record.pdfFont?.name || record.pdfFont?.loadedName || "";
    for (const candidate of referencedFontNames) {
      if (baseName === candidate || baseName.endsWith(`+${candidate}`)) {
        record.inFormDA = true;
        break;
      }
    }
  }
}

export async function extractFontUsage(pdf) {
  const fonts = new Map();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    try {
      await processPage(page, fonts);
    } finally {
      // Always release page resources to avoid leaking pdfjs handles.
      try { page.cleanup(); } catch { /* ignore */ }
    }
  }

  await inspectAcroFormDA(pdf, fonts);

  // Drop fonts that were referenced but never resolved to a Font object —
  // they are typically aliases pdfjs created for unused resource entries.
  // Convert glyph id sets to sorted arrays and resolve sample text now.
  const result = [];
  for (const record of fonts.values()) {
    result.push({
      fontId: record.fontId,
      pdfFont: record.pdfFont,
      pages: [...record.pageSet].sort((left, right) => left - right),
      glyphCount: record.glyphCount,
      glyphIds: [...record.glyphIds].sort((left, right) => left - right),
      sampleText: record.sampleParts.join("").slice(0, 120),
      inFormDA: record.inFormDA
    });
  }

  return result;
}
