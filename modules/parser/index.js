import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toSegment(pageHeight, item) {
  const fontSize = Math.max(item.height || 0, Math.abs(item.transform[0] || 0), Math.abs(item.transform[3] || 0), 1);
  const width = item.width || 0;
  const height = item.height || fontSize;
  const x = item.transform[4] || 0;
  const yTop = pageHeight - (item.transform[5] || 0) - height;

  return {
    text: item.str,
    bbox: [x, yTop, width, height],
    fontSize,
    fontName: item.fontName || "unknown",
    hasEOL: Boolean(item.hasEOL)
  };
}

function overlapsVertically(left, right) {
  const leftTop = left.bbox[1];
  const leftBottom = leftTop + left.bbox[3];
  const rightTop = right.bbox[1];
  const rightBottom = rightTop + right.bbox[3];
  return Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
}

function isSameLine(previous, next) {
  const previousCenter = previous.bbox[1] + previous.bbox[3] / 2;
  const nextCenter = next.bbox[1] + next.bbox[3] / 2;
  const baselineTolerance = Math.max(2, Math.min(previous.fontSize, next.fontSize) * 0.45);
  const verticalOverlap = overlapsVertically(previous, next);
  const minHeight = Math.min(previous.bbox[3], next.bbox[3]);

  return Math.abs(previousCenter - nextCenter) <= baselineTolerance && verticalOverlap >= minHeight * 0.35;
}

function isLargeHorizontalGap(previous, next) {
  const previousRight = previous.bbox[0] + previous.bbox[2];
  const gap = next.bbox[0] - previousRight;
  return gap > Math.max(24, previous.fontSize * 2.5);
}

function needsWhitespace(previousSegment, nextSegment) {
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
    fontName
  };
}

export function groupTextItemsToBlocks(pageNumber, pageHeight, items) {
  const segments = items
    .filter((item) => "str" in item && item.str && item.str.trim())
    .map((item) => toSegment(pageHeight, item))
    .sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);

  const lines = [];
  let currentLine = [];

  for (const segment of segments) {
    const previous = currentLine.at(-1);
    const shouldStartNewLine =
      !previous ||
      previous.hasEOL ||
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

  const summary = summarizePageText(page);
  return (
    summary.blockCount <= ocrOptions.sparseTextBlockThreshold ||
    summary.characterCount <= ocrOptions.sparseCharacterThreshold ||
    summary.coverageRatio <= ocrOptions.sparseCoverageThreshold
  );
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

  const shouldReplaceNativeText =
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
  const pdf = await getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false
  }).promise;

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
