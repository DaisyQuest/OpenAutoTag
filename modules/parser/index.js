import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import layoutSchema from "../../contracts/layout.schema.json" with { type: "json" };
import {
  DEFAULT_RECOGNITION_PROFILES,
  DEFAULT_RENDER_VARIANTS,
  runOcrPipeline
} from "./ocr-pipeline.js";
import {
  annotatePagesWithLanguage,
  detectDocumentLanguageFromPages,
  parseRequestedOcrLanguages,
  resolveOcrLanguages
} from "./language-detection.js";

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);

function createDocumentId(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return `layout:${base}`;
}

export function createPdfDocumentLoadOptions(data) {
  return {
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: VerbosityLevel.ERRORS
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRotationDegrees(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  return Math.round(normalized / 90) * 90 % 360;
}

function getTextRotation(transform = []) {
  const [a = 1, b = 0] = transform;
  return normalizeRotationDegrees(Math.atan2(b, a) * 180 / Math.PI);
}

function getWritingMode(rotation) {
  return rotation === 90 || rotation === 270 ? "vertical" : "horizontal";
}

function axisAlignedTextBbox(pageHeight, item, fontSize) {
  const [a = fontSize, b = 0, c = 0, d = fontSize, e = 0, f = 0] = item.transform || [];
  const width = item.width || 0;
  const height = item.height || fontSize;
  const inlineScale = Math.hypot(a, b) || fontSize || 1;
  const blockScale = Math.hypot(c, d) || fontSize || 1;
  const inline = [a / inlineScale, b / inlineScale];
  const block = [c / blockScale, d / blockScale];
  const corners = [
    [e, f],
    [e + inline[0] * width, f + inline[1] * width],
    [e + block[0] * height, f + block[1] * height],
    [e + inline[0] * width + block[0] * height, f + inline[1] * width + block[1] * height]
  ];
  const left = Math.min(...corners.map(([x]) => x));
  const right = Math.max(...corners.map(([x]) => x));
  const bottom = Math.min(...corners.map(([, y]) => y));
  const top = Math.max(...corners.map(([, y]) => y));

  return [left, pageHeight - top, right - left, top - bottom];
}

function toSegment(pageHeight, item) {
  const fontSize = Math.max(item.height || 0, Math.abs(item.transform[0] || 0), Math.abs(item.transform[1] || 0), Math.abs(item.transform[2] || 0), Math.abs(item.transform[3] || 0), 1);
  const rotation = getTextRotation(item.transform);
  const bbox = axisAlignedTextBbox(pageHeight, item, fontSize);

  return {
    text: item.str,
    bbox,
    fontSize,
    fontName: item.fontName || "unknown",
    writingMode: getWritingMode(rotation),
    textRotation: rotation,
    hasEOL: Boolean(item.hasEOL)
  };
}

function splitNumericSegment(segment) {
  const text = String(segment.text || "");
  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/);

  if (segment.writingMode !== "horizontal" || tokens.length < 2 || !tokens.every(isCompactNumericToken)) {
    return [segment];
  }

  const leadingWhitespace = text.match(/^\s*/)?.[0].length || 0;
  const usableLength = Math.max(trimmed.length, 1);
  const widthPerChar = segment.bbox[2] / usableLength;
  let searchOffset = 0;

  return tokens.map((token, index) => {
    const tokenOffset = trimmed.indexOf(token, searchOffset);
    searchOffset = tokenOffset + token.length;
    const xOffset = Math.max(0, tokenOffset + leadingWhitespace) * widthPerChar;

    return {
      ...segment,
      text: token,
      bbox: [
        segment.bbox[0] + xOffset,
        segment.bbox[1],
        Math.max(token.length * widthPerChar, 1),
        segment.bbox[3]
      ],
      forceBlockBoundaryAfter: index < tokens.length - 1,
      hasEOL: index === tokens.length - 1 ? segment.hasEOL : false
    };
  });
}

function overlapsVertically(left, right) {
  const leftTop = left.bbox[1];
  const leftBottom = leftTop + left.bbox[3];
  const rightTop = right.bbox[1];
  const rightBottom = rightTop + right.bbox[3];
  return Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
}

function isSameLine(previous, next) {
  if ((previous.writingMode || "horizontal") !== (next.writingMode || "horizontal")) {
    return false;
  }

  if (previous.writingMode === "vertical") {
    const previousCenter = previous.bbox[0] + previous.bbox[2] / 2;
    const nextCenter = next.bbox[0] + next.bbox[2] / 2;
    const baselineTolerance = Math.max(2, Math.min(previous.fontSize, next.fontSize) * 0.45);
    const horizontalOverlap =
      Math.min(previous.bbox[0] + previous.bbox[2], next.bbox[0] + next.bbox[2]) -
      Math.max(previous.bbox[0], next.bbox[0]);
    const minWidth = Math.min(previous.bbox[2], next.bbox[2]);
    const gap = next.bbox[1] - (previous.bbox[1] + previous.bbox[3]);
    return (
      Math.abs(previousCenter - nextCenter) <= baselineTolerance &&
      horizontalOverlap >= minWidth * 0.35 &&
      gap <= Math.max(2, Math.min(previous.fontSize, next.fontSize) * 0.5)
    );
  }

  const previousCenter = previous.bbox[1] + previous.bbox[3] / 2;
  const nextCenter = next.bbox[1] + next.bbox[3] / 2;
  const baselineTolerance = Math.max(2, Math.min(previous.fontSize, next.fontSize) * 0.45);
  const verticalOverlap = overlapsVertically(previous, next);
  const minHeight = Math.min(previous.bbox[3], next.bbox[3]);

  return Math.abs(previousCenter - nextCenter) <= baselineTolerance && verticalOverlap >= minHeight * 0.35;
}

function isLargeHorizontalGap(previous, next) {
  if (previous.writingMode === "vertical" || next.writingMode === "vertical") {
    return false;
  }

  const previousRight = previous.bbox[0] + previous.bbox[2];
  const gap = next.bbox[0] - previousRight;

  if (isCompactNumericToken(previous.text) && isCompactNumericToken(next.text)) {
    return gap >= Math.max(3, Math.min(previous.fontSize, next.fontSize) * 0.55);
  }

  return gap > Math.max(24, previous.fontSize * 2.5);
}

function isCompactNumericToken(text) {
  return /^-?(?:[$£€¥])?(?:\d+(?:[.,]\d+)*|\d*\.\d+)(?:%)?$|^n\/a$/i.test(String(text || "").trim());
}

function needsWhitespace(previousSegment, nextSegment) {
  if ((previousSegment.writingMode || "horizontal") !== (nextSegment.writingMode || "horizontal")) {
    return false;
  }

  const previousText = previousSegment.text;
  const nextText = nextSegment.text;

  if (!previousText || !nextText) {
    return false;
  }

  if (/\s$/.test(previousText) || /^\s/.test(nextText)) {
    return false;
  }

  if (previousText.endsWith("-")) {
    return false;
  }

  if (/^[,.;:!?)]/.test(nextText) || /[(]$/.test(previousText)) {
    return false;
  }

  const previousRight = previousSegment.bbox[0] + previousSegment.bbox[2];
  const gap = nextSegment.bbox[0] - previousRight;
  return gap > Math.max(1.5, previousSegment.fontSize * 0.18);
}

function mergeLineSegments(pageNumber, lineNumber, segments) {
  const orderedSegments = [...segments].sort((left, right) => left.bbox[0] - right.bbox[0]);
  const left = Math.min(...orderedSegments.map((segment) => segment.bbox[0]));
  const top = Math.min(...orderedSegments.map((segment) => segment.bbox[1]));
  const right = Math.max(...orderedSegments.map((segment) => segment.bbox[0] + segment.bbox[2]));
  const bottom = Math.max(...orderedSegments.map((segment) => segment.bbox[1] + segment.bbox[3]));

  let text = "";
  for (const [index, segment] of orderedSegments.entries()) {
    if (index > 0 && needsWhitespace(orderedSegments[index - 1], segment)) {
      text += " ";
    }
    text += segment.text;
  }

  const fontSize = Math.max(...orderedSegments.map((segment) => segment.fontSize));
  const writingModeCounts = new Map();
  const rotationCounts = new Map();
  for (const segment of orderedSegments) {
    const writingMode = segment.writingMode || "horizontal";
    writingModeCounts.set(writingMode, (writingModeCounts.get(writingMode) || 0) + 1);
    const textRotation = Number.isFinite(segment.textRotation) ? segment.textRotation : 0;
    rotationCounts.set(textRotation, (rotationCounts.get(textRotation) || 0) + 1);
  }
  const writingMode = [...writingModeCounts.entries()].sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1])[0]?.[0] || "horizontal";
  const textRotation = [...rotationCounts.entries()].sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1])[0]?.[0] || 0;
  const fontNameCounts = new Map();
  for (const segment of orderedSegments) {
    fontNameCounts.set(segment.fontName, (fontNameCounts.get(segment.fontName) || 0) + 1);
  }
  const fontName = [...fontNameCounts.entries()].sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1])[0][0];

  return {
    id: `p${pageNumber}-b${lineNumber}`,
    text: text.trim(),
    bbox: [left, top, right - left, bottom - top],
    fontSize,
    fontName,
    writingMode,
    textRotation
  };
}

export function groupTextItemsToBlocks(pageNumber, pageHeight, items) {
  const segments = items
    .filter((item) => "str" in item && item.str && item.str.trim())
    .map((item) => toSegment(pageHeight, item))
    .flatMap(splitNumericSegment)
    .sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);

  const lines = [];
  let currentLine = [];

  for (const segment of segments) {
    const previous = currentLine.at(-1);
    const shouldStartNewLine =
      !previous ||
      previous.hasEOL ||
      previous.forceBlockBoundaryAfter ||
      !isSameLine(previous, segment) ||
      isLargeHorizontalGap(previous, segment) ||
      segment.bbox[0] < previous.bbox[0] - Math.max(previous.fontSize, segment.fontSize);

    if (shouldStartNewLine) {
      if (currentLine.length > 0) {
        lines.push(currentLine);
      }
      currentLine = [segment];
      continue;
    }

    currentLine.push(segment);
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines
    .map((line, index) => mergeLineSegments(pageNumber, index + 1, line))
    .filter((block) => block.text);
}

function sortBlocksByGeometry(blocks) {
  return [...blocks].sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
}

function reindexBlocks(pageNumber, blocks) {
  return sortBlocksByGeometry(blocks).map((block, index) => ({
    ...block,
    id: `p${pageNumber}-b${index + 1}`,
    text: normalizeText(block.text)
  }));
}

function summarizePageText(page) {
  const characterCount = page.textBlocks.reduce((total, block) => total + block.text.replace(/\s+/g, "").length, 0);
  const coverageArea = page.textBlocks.reduce((total, block) => total + block.bbox[2] * block.bbox[3], 0);
  return {
    blockCount: page.textBlocks.length,
    characterCount,
    coverageRatio: coverageArea / Math.max(page.width * page.height, 1)
  };
}

function resolveOcrMode(mode) {
  switch (String(mode || "auto").toLowerCase()) {
    case "off":
    case "disabled":
      return "off";
    case "force":
      return "force";
    case "required":
      return "required";
    default:
      return "auto";
  }
}

function normalizeOcrOptions(options = {}, languageDetection = null) {
  const mode = resolveOcrMode(options.mode || process.env.PARSER_OCR_MODE || "auto");
  const explicitLanguages = parseRequestedOcrLanguages(options.languages || process.env.PARSER_OCR_LANGS || "");
  const languageResolution = resolveOcrLanguages({
    explicitLanguages,
    languageDetection
  });

  return {
    mode,
    required: mode === "required" || options.required === true,
    languages: languageResolution.languages,
    languageStrategy: languageResolution.strategy,
    languageHint: languageResolution.languageHint,
    sparseTextBlockThreshold: Number.isFinite(options.sparseTextBlockThreshold)
      ? options.sparseTextBlockThreshold
      : 1,
    sparseCharacterThreshold: Number.isFinite(options.sparseCharacterThreshold)
      ? options.sparseCharacterThreshold
      : 24,
    sparseCoverageThreshold: Number.isFinite(options.sparseCoverageThreshold)
      ? options.sparseCoverageThreshold
      : 0.002,
    minAcceptedOcrScore: Number.isFinite(options.minAcceptedOcrScore) ? options.minAcceptedOcrScore : 0.4,
    minCharacterGain: Number.isFinite(options.minCharacterGain) ? options.minCharacterGain : 24,
    characterGainMultiplier: Number.isFinite(options.characterGainMultiplier)
      ? options.characterGainMultiplier
      : 1.5,
    maxAttempts: Number.isFinite(options.maxAttempts)
      ? options.maxAttempts
      : Number.isFinite(Number(process.env.PARSER_OCR_MAX_ATTEMPTS))
        ? Number(process.env.PARSER_OCR_MAX_ATTEMPTS)
        : 2,
    renderVariants: options.renderVariants || DEFAULT_RENDER_VARIANTS,
    recognitionProfiles: options.recognitionProfiles || DEFAULT_RECOGNITION_PROFILES,
    renderPageVariants: options.renderPageVariants,
    createRecognizer: options.createRecognizer,
    cachePath: options.cachePath,
    tempRoot: options.tempRoot || process.env.PARSER_OCR_TEMP_ROOT
  };
}

function shouldRunOcrForPage(page, ocrOptions) {
  if (ocrOptions.mode === "off") {
    return false;
  }

  if (ocrOptions.mode === "force" || ocrOptions.mode === "required") {
    return true;
  }

  // Hybrid trigger: if the page embeds a "bad source OCR" font, re-OCR
  // the page even if the text layer is dense. The existing text layer
  // is unreliable and our Tesseract output is meaningfully better
  // (observed on NY civil court scans: "_Cou_nty_of K_ing_s" → "County
  // of Kings"). See docs/hybrid-ocr-mode.md.
  //
  // Opt-in via OAT_HYBRID_OCR=1. Default OFF because hybrid output
  // can interact with the OCR-strip pass in ways that leave stripped
  // MCIDs orphaned (blank struct leaves) on a small number of docs
  // until we add a second-pass leaf cleanup. When enabled on a source
  // PDF with garbled OCR, the resulting tag tree contains clean
  // paragraph text rather than OCR gibberish.
  if (process.env.OAT_HYBRID_OCR === "1" && detectBadSourceOcr(page)) {
    page._hybridCandidate = true;
    return true;
  }

  const summary = summarizePageText(page);
  return (
    summary.blockCount <= ocrOptions.sparseTextBlockThreshold ||
    summary.characterCount <= ocrOptions.sparseCharacterThreshold ||
    summary.coverageRatio <= ocrOptions.sparseCoverageThreshold
  );
}

/**
 * Detects whether a page's existing text layer is a low-quality OCR
 * overlay that should be re-OCR'd via Tesseract. Heuristics:
 *   1. Font-name producer signal: HiddenHorzOCR, HiddenVertOCR, OCR-A,
 *      OCR-B, Invisible*Text — these name patterns uniquely identify
 *      scanned-PDF OCR layers shipped by Adobe Acrobat, ABBYY, etc.
 *   2. Token-shape garbage: if ≥30% of non-trivial tokens on the page
 *      have shape like `_Cou_nty_`, `1111...`, single-char-runs, or
 *      >50% non-alphanumeric chars, the OCR is unreliable.
 * Either signal flips the page into hybrid mode.
 */
function detectBadSourceOcr(page) {
  if (!page) return false;
  const OCR_FONT_PATTERN = /hidden\s*(horz|vert)?\s*ocr|\bocr[-_ ]?[ab]\b|invisible.*text/i;
  const blocks = page.textBlocks || [];
  // Signal 1: the page contains a block whose font name matches a
  // known OCR-overlay producer pattern.
  for (const block of blocks) {
    const fontName = String(block.fontName || "");
    if (OCR_FONT_PATTERN.test(fontName)) return true;
  }
  // Signal 2: presence of HIGH-CONFIDENCE scan-artifact tokens. These
  // shapes are virtually never produced by native text authoring —
  // they're specific to legacy OCR engines failing on stylized fonts
  // or horizontal rules. A single occurrence is enough to flag.
  for (const block of blocks) {
    const text = String(block.text || "");
    // Long runs of identical chars (horizontal rule OCR'd as "1" or "_").
    if (/(.)\1{15,}/.test(text)) return true;
    // Multiple consecutive underscore-prefixed short tokens
    // ("_Cou_nty_of K_ing_s") — seal/letterhead OCR failure.
    if (/(_[a-zA-Z]{1,3}){3,}/.test(text)) return true;
  }
  if (blocks.length < 3) return false;
  // Signal 3: a large share of the page's tokens have garbage shape.
  let garbage = 0;
  let total = 0;
  for (const block of blocks) {
    const tokens = String(block.text || "").split(/\s+/).filter(t => t.length >= 2);
    for (const token of tokens) {
      total++;
      if (isGarbageToken(token)) garbage++;
    }
  }
  if (total === 0) return false;
  return garbage / total >= 0.3;
}

function isGarbageToken(token) {
  // Runs of identical chars ("1111", "____").
  if (/^(.)\1{3,}$/.test(token)) return true;
  // >50% non-alphanumeric.
  const nonAlnum = token.replace(/[a-zA-Z0-9]/g, "").length;
  if (nonAlnum / token.length > 0.5) return true;
  // Underscore insertions like "_Cou_nty_of".
  if (/(_[a-zA-Z]{1,3}){2,}/.test(token)) return true;
  return false;
}

function buildSelectedPageResult(page, nativeSummary, ocrResult, ocrOptions) {
  const selectedCandidate = ocrResult.selectedCandidate;
  const ocrCharacterCount = ocrResult.textBlocks.reduce(
    (total, block) => total + block.text.replace(/\s+/g, "").length,
    0
  );
  const selectedScore = selectedCandidate?.finalScore ?? selectedCandidate?.score ?? 0;
  const errors = ocrResult.errors || [];

  if (!selectedCandidate || ocrResult.textBlocks.length === 0) {
    return {
      ...page,
      ocr: {
        status: errors.length > 0 ? "failed" : "no-text-detected",
        trigger: nativeSummary,
        candidates: ocrResult.candidates,
        errors
      }
    };
  }

  if (selectedScore < ocrOptions.minAcceptedOcrScore) {
    return {
      ...page,
      ocr: {
        status: "ignored-low-confidence",
        trigger: nativeSummary,
        selectedCandidate,
        candidates: ocrResult.candidates,
        errors
      }
    };
  }

  // Hybrid-mode override: if the page was flagged as having a
  // bad source OCR layer, ALWAYS adopt the Tesseract output even if
  // it produces fewer total characters. The native layer is garbage
  // (e.g. HiddenHorzOCR renders "_Cou_nty_of K_ing_s") — Tesseract's
  // cleaner text is the desired accessible layer.
  const forceReplaceViaHybrid = page._hybridCandidate === true;
  const shouldReplaceNativeText = forceReplaceViaHybrid ||
    nativeSummary.blockCount === 0 ||
    nativeSummary.characterCount === 0 ||
    (ocrCharacterCount >= nativeSummary.characterCount + ocrOptions.minCharacterGain &&
      ocrCharacterCount >= nativeSummary.characterCount * ocrOptions.characterGainMultiplier);

  if (!shouldReplaceNativeText) {
    return {
      ...page,
      ocr: {
        status: "retained-native-text",
        trigger: nativeSummary,
        selectedCandidate,
        candidates: ocrResult.candidates,
        errors
      }
    };
  }

  return {
    ...page,
    textBlocks: reindexBlocks(page.pageNumber, ocrResult.textBlocks),
    // Public flag: downstream consumers (semantic engine, tag-builder)
    // use this to inject /ActualText on struct leaves built from hybrid
    // pages — the content stream still has the garbled source OCR text
    // ops for rendering, but AT should read Tesseract's clean text.
    hybrid: forceReplaceViaHybrid ? true : undefined,
    ocr: {
      status: "applied",
      mergeStrategy: nativeSummary.blockCount === 0 ? "replace-empty-page" : "replace-sparse-page",
      trigger: nativeSummary,
      selectedCandidate,
      candidates: ocrResult.candidates,
      errors
    }
  };
}

function summarizeDocumentOcr(pages, ocrOptions, status, errorMessage = "") {
  const attemptedPages = pages.filter((page) => page.ocr?.status && page.ocr.status !== "not-attempted").length;
  const appliedPages = pages.filter((page) => page.ocr?.status === "applied").length;
  const failedPages = pages.filter((page) => page.ocr?.status === "failed").length;
  const partialPages = pages.filter(
    (page) => (page.ocr?.errors?.length || 0) > 0 && page.ocr?.status && page.ocr.status !== "failed"
  ).length;

  return {
    mode: ocrOptions.mode,
    status,
    languages: ocrOptions.languages,
    languageStrategy: ocrOptions.languageStrategy,
    languageHint: ocrOptions.languageHint,
    attemptedPages,
    appliedPages,
    failedPages,
    partialPages,
    skippedPages: pages.length - attemptedPages,
    ...(errorMessage ? { error: errorMessage } : {})
  };
}

async function applyOcrEnhancement(pdfPath, pages, ocrOptions) {
  const candidatePages = pages.filter((page) => shouldRunOcrForPage(page, ocrOptions));

  if (candidatePages.length === 0) {
    const skippedPages = pages.map((page) => ({
      ...page,
      ocr: {
        status: "not-attempted"
      }
    }));

    return {
      pages: skippedPages,
      summary: summarizeDocumentOcr(skippedPages, ocrOptions, "skipped")
    };
  }

  try {
    const ocrResults = await runOcrPipeline({
      pdfPath,
      pages: candidatePages,
      languages: ocrOptions.languages,
      renderVariants: ocrOptions.renderVariants,
      recognitionProfiles: ocrOptions.recognitionProfiles,
      renderPageVariants: ocrOptions.renderPageVariants,
      createRecognizer: ocrOptions.createRecognizer,
      cachePath: ocrOptions.cachePath,
      maxAttempts: ocrOptions.maxAttempts,
      tempRoot: ocrOptions.tempRoot
    });
    const ocrPagesByNumber = new Map(ocrResults.pages.map((page) => [page.pageNumber, page]));

    const enhancedPages = pages.map((page) => {
      const nativeSummary = summarizePageText(page);
      const ocrResult = ocrPagesByNumber.get(page.pageNumber);

      if (!ocrResult) {
        return {
          ...page,
          ocr: {
            status: "not-attempted"
          }
        };
      }

      return buildSelectedPageResult(page, nativeSummary, ocrResult, ocrOptions);
    });

    return {
      pages: enhancedPages,
      summary: summarizeDocumentOcr(enhancedPages, ocrOptions, "completed")
    };
  } catch (error) {
    if (ocrOptions.required) {
      throw error;
    }

    const failedPages = pages.map((page) =>
      shouldRunOcrForPage(page, ocrOptions)
        ? {
            ...page,
            ocr: {
              status: "failed",
              error: error.message,
              trigger: summarizePageText(page)
            }
          }
        : {
            ...page,
            ocr: {
              status: "not-attempted"
            }
          }
    );

    return {
      pages: failedPages,
      summary: summarizeDocumentOcr(failedPages, ocrOptions, "failed", error.message)
    };
  }
}

export async function parsePdf(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const data = new Uint8Array(await readFile(absolutePath));
  const pdf = await getDocument(createPdfDocumentLoadOptions(data)).promise;

  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const [, , width, height] = page.view;
    const textBlocks = reindexBlocks(pageNumber, groupTextItemsToBlocks(pageNumber, height, textContent.items));

    pages.push({
      pageNumber,
      width,
      height,
      textBlocks
    });
  }

  const nativeLanguageDetection = detectDocumentLanguageFromPages(pages);
  const ocrOptions = normalizeOcrOptions(options.ocr, nativeLanguageDetection);
  const ocrResult = await applyOcrEnhancement(absolutePath, pages, ocrOptions);
  const annotatedPages = annotatePagesWithLanguage(ocrResult.pages);
  const documentLanguageDetection = detectDocumentLanguageFromPages(annotatedPages);

  const layoutDocument = {
    schemaVersion: "1.0.0",
    documentId: createDocumentId(absolutePath),
    source: {
      filePath: absolutePath,
      pageCount: pdf.numPages,
      language: documentLanguageDetection.language,
      languageConfidence: documentLanguageDetection.confidence,
      languageScores: documentLanguageDetection.scores,
      ocr: ocrResult.summary
    },
    pages: annotatedPages
  };

  if (documentLanguageDetection.evidence) {
    layoutDocument.source.languageEvidence = documentLanguageDetection.evidence;
  }

  if (!validateLayout(layoutDocument)) {
    throw new Error(`Parser output failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  return layoutDocument;
}

async function main() {
  const inputPath = process.argv[2];

  if (!inputPath) {
    throw new Error("Usage: node modules/parser/index.js <input.pdf>");
  }

  const result = await parsePdf(inputPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
