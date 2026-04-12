import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir, getRuntimeCacheDir } from "../../scripts/runtime-paths.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const buildDir = getRuntimeBuildDir("modules-parser-ocr", { repoRoot });
const defaultCachePath = getRuntimeCacheDir("tesseract", { repoRoot });
const javaSourcePath = path.join(moduleDir, "java", "PdfOcrRenderCli.java");
const javaClassPath = path.join(buildDir, "PdfOcrRenderCli.class");
const pdfboxJarCandidates = [
  path.join(moduleDir, "vendor", "pdfbox-app-3.0.7.jar"),
  path.join(moduleDir, "..", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar"),
  path.join(moduleDir, "..", "validator", "vendor", "pdfbox-app-3.0.7.jar")
];
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

export const DEFAULT_RENDER_VARIANTS = [
  {
    name: "gray-300",
    dpi: 300,
    imageType: "GRAY",
    preprocessing: "grayscale"
  },
  {
    name: "binary-300",
    dpi: 300,
    imageType: "BINARY",
    preprocessing: "binary"
  },
  {
    name: "gray-450",
    dpi: 450,
    imageType: "GRAY",
    preprocessing: "grayscale-hires"
  }
];

export const DEFAULT_RECOGNITION_PROFILES = [
  {
    name: "auto",
    pageSegMode: "AUTO"
  },
  {
    name: "sparse",
    pageSegMode: "SPARSE_TEXT"
  },
  {
    name: "single-block",
    pageSegMode: "SINGLE_BLOCK"
  }
];

function execCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function needsCompilation() {
  try {
    const [sourceStats, classStats] = await Promise.all([stat(javaSourcePath), stat(javaClassPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
  } catch {
    return true;
  }
}

async function resolvePdfboxJarPath() {
  for (const candidate of pdfboxJarCandidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("PDFBox runtime not found for OCR rendering.");
}

async function ensureJavaHelperCompiled() {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => !(await needsCompilation()),
    compile: async () => {
      const pdfboxJarPath = await resolvePdfboxJarPath();
      const javacCommand = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      await execCommand(
        javacCommand,
        [
          "-encoding",
          "UTF-8",
          "-cp",
          pdfboxJarPath,
          "-d",
          buildDir,
          javaSourcePath
        ],
        {
          env: await buildJavaExecEnv({ bundledJavaHome })
        }
      );
    }
  });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeComparableText(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function countWords(text) {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ").length : 0;
}

function countAlphaNumericCharacters(text) {
  return (normalizeText(text).match(/[A-Za-z0-9]/g) || []).length;
}

function calculateSuspiciousCharacterRatio(text) {
  const collapsed = normalizeText(text).replace(/\s+/g, "");
  if (!collapsed) {
    return 1;
  }

  const suspiciousCount = (collapsed.match(/[^A-Za-z0-9.,;:!?()'"%$&+\-\/]/g) || []).length;
  return suspiciousCount / collapsed.length;
}

function calculateRepeatedCharacterRatio(text) {
  const collapsed = normalizeText(text).replace(/\s+/g, "");
  if (!collapsed) {
    return 1;
  }

  const repeatedRuns = collapsed.match(/(.)\1{2,}/g) || [];
  const repeatedCharacterCount = repeatedRuns.reduce((total, run) => total + run.length, 0);
  return repeatedCharacterCount / collapsed.length;
}

function toBigramSet(text) {
  const normalized = normalizeComparableText(text).replace(/\s+/g, " ");
  if (!normalized) {
    return new Set();
  }

  if (normalized.length === 1) {
    return new Set([normalized]);
  }

  const bigrams = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    bigrams.add(normalized.slice(index, index + 2));
  }
  return bigrams;
}

function calculateTextSimilarity(left, right) {
  const leftSet = toBigramSet(left);
  const rightSet = toBigramSet(right);

  if (leftSet.size === 0 && rightSet.size === 0) {
    return 1;
  }

  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function serializeRenderVariants(renderVariants) {
  return renderVariants.map((variant) => `${variant.name}:${variant.dpi}:${variant.imageType}`).join(",");
}

function toPdfBbox(bbox, variant) {
  const widthScale = variant.pdfWidth / Math.max(variant.imageWidth || 1, 1);
  const heightScale = variant.pdfHeight / Math.max(variant.imageHeight || 1, 1);
  return [
    round((bbox?.x0 || 0) * widthScale),
    round((bbox?.y0 || 0) * heightScale),
    round(Math.max(0, ((bbox?.x1 || 0) - (bbox?.x0 || 0)) * widthScale)),
    round(Math.max(0, ((bbox?.y1 || 0) - (bbox?.y0 || 0)) * heightScale))
  ];
}

function estimateFontSize(line, bboxHeight, variant) {
  const heightScale = variant.pdfHeight / Math.max(variant.imageHeight || 1, 1);
  const rowHeight = Number(line?.rowAttributes?.rowHeight || 0);
  if (rowHeight > 0) {
    return round(Math.max(1, rowHeight * heightScale));
  }
  return round(Math.max(1, bboxHeight));
}

function calculateBboxOverlap(left, right) {
  const leftRight = left[0] + left[2];
  const leftBottom = left[1] + left[3];
  const rightRight = right[0] + right[2];
  const rightBottom = right[1] + right[3];
  const overlapWidth = Math.max(0, Math.min(leftRight, rightRight) - Math.max(left[0], right[0]));
  const overlapHeight = Math.max(0, Math.min(leftBottom, rightBottom) - Math.max(left[1], right[1]));
  const overlapArea = overlapWidth * overlapHeight;

  if (overlapArea === 0) {
    return 0;
  }

  const leftArea = left[2] * left[3];
  const rightArea = right[2] * right[3];
  return overlapArea / Math.max(leftArea + rightArea - overlapArea, 1);
}

function areLikelyDuplicateBlocks(left, right) {
  const leftText = normalizeComparableText(left.text);
  const rightText = normalizeComparableText(right.text);

  if (!leftText || !rightText || leftText !== rightText) {
    return false;
  }

  return calculateBboxOverlap(left.bbox, right.bbox) >= 0.55;
}

function dedupeTextBlocks(blocks) {
  const deduped = [];

  for (const block of blocks) {
    if (deduped.some((candidate) => areLikelyDuplicateBlocks(candidate, block))) {
      continue;
    }
    deduped.push(block);
  }

  return deduped;
}

function extractLineRecordsFromBlocks(blocks) {
  const lines = [];

  for (const block of blocks || []) {
    const paragraphs = Array.isArray(block?.paragraphs) && block.paragraphs.length > 0 ? block.paragraphs : [block];

    for (const paragraph of paragraphs) {
      const paragraphLines =
        Array.isArray(paragraph?.lines) && paragraph.lines.length > 0 ? paragraph.lines : [paragraph];

      for (const line of paragraphLines) {
        const text = normalizeText(line?.text || "");
        if (!text) {
          continue;
        }

        lines.push({
          text,
          confidence: Number.isFinite(line?.confidence)
            ? line.confidence
            : Number.isFinite(paragraph?.confidence)
              ? paragraph.confidence
              : Number.isFinite(block?.confidence)
                ? block.confidence
                : 0,
          bbox: line?.bbox || paragraph?.bbox || block?.bbox,
          rowAttributes: line?.rowAttributes || null
        });
      }
    }
  }

  return lines;
}

function normalizeRecognizedTextBlocks(data, variant, pageNumber, candidateName) {
  const lines = extractLineRecordsFromBlocks(data?.blocks);
  const blocks = lines.map((line, index) => {
    const bbox = toPdfBbox(line.bbox, variant);

    return {
      id: `p${pageNumber}-ocr-${index + 1}`,
      text: line.text,
      bbox,
      fontSize: estimateFontSize(line, bbox[3], variant),
      fontName: "ocr",
      textSource: "ocr",
      ocrConfidence: round(Number(line.confidence || 0)),
      ocrCandidate: candidateName,
      ocrVariant: variant.name
    };
  });

  return dedupeTextBlocks(blocks).filter((block) => block.text);
}

function scoreCandidate({
  averageConfidence,
  characterCount,
  wordCount,
  blockCount,
  alphaNumericRatio,
  suspiciousCharacterRatio,
  repeatedCharacterRatio
}) {
  if (characterCount === 0 || blockCount === 0) {
    return 0;
  }

  const confidenceScore = clamp(averageConfidence / 100, 0, 1);
  const characterScore = clamp(characterCount / 180, 0, 1);
  const wordScore = clamp(wordCount / 32, 0, 1);
  const blockScore = clamp(blockCount / 10, 0, 1);
  const alphaNumericScore = clamp(alphaNumericRatio, 0, 1);
  const suspiciousPenalty = clamp(suspiciousCharacterRatio, 0, 1);
  const repetitionPenalty = clamp(repeatedCharacterRatio, 0, 1);

  return round(
    clamp(
      confidenceScore * 0.42 +
        characterScore * 0.24 +
        wordScore * 0.12 +
        blockScore * 0.05 +
        alphaNumericScore * 0.17 -
        suspiciousPenalty * 0.12 -
        repetitionPenalty * 0.08,
      0,
      1
    )
  );
}

function summarizeCandidate(textBlocks, data, variant, profile) {
  const text = normalizeText(textBlocks.map((block) => block.text).join(" "));
  const characterCount = text.replace(/\s+/g, "").length;
  const wordCount = countWords(text);
  const blockCount = textBlocks.length;
  const confidences = textBlocks.map((block) => Number(block.ocrConfidence || 0)).filter((value) => Number.isFinite(value));
  const averageConfidence = round(
    blockCount > 0 ? average(confidences) : Number.isFinite(data?.confidence) ? Number(data.confidence) : 0
  );
  const alphaNumericRatio =
    characterCount > 0 ? countAlphaNumericCharacters(text) / Math.max(characterCount, 1) : 0;
  const suspiciousCharacterRatio = calculateSuspiciousCharacterRatio(text);
  const repeatedCharacterRatio = calculateRepeatedCharacterRatio(text);

  return {
    candidateName: `${variant.name}/${profile.name}`,
    variantName: variant.name,
    profileName: profile.name,
    preprocessing: variant.preprocessing || variant.imageType?.toLowerCase() || "unknown",
    dpi: variant.dpi,
    averageConfidence,
    pageConfidence: round(Number(data?.confidence || 0)),
    blockCount,
    wordCount,
    characterCount,
    alphaNumericRatio: round(alphaNumericRatio),
    suspiciousCharacterRatio: round(suspiciousCharacterRatio),
    repeatedCharacterRatio: round(repeatedCharacterRatio),
    score: scoreCandidate({
      averageConfidence,
      characterCount,
      wordCount,
      blockCount,
      alphaNumericRatio,
      suspiciousCharacterRatio,
      repeatedCharacterRatio
    }),
    consensusScore: 0,
    finalScore: 0,
    text,
    textBlocks
  };
}

function annotateCandidateConsensus(candidates) {
  return candidates.map((candidate, index) => {
    const peerScores = candidates
      .filter((_, peerIndex) => peerIndex !== index)
      .map((peer) => calculateTextSimilarity(candidate.text, peer.text));
    const consensusScore = round(peerScores.length > 0 ? average(peerScores) : 1);
    const finalScore = round(clamp(candidate.score * 0.82 + consensusScore * 0.18, 0, 1));

    return {
      ...candidate,
      consensusScore,
      finalScore
    };
  });
}

export function selectBestOcrCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    return (
      (right.finalScore || right.score) - (left.finalScore || left.score) ||
      right.score - left.score ||
      right.characterCount - left.characterCount ||
      right.wordCount - left.wordCount ||
      right.averageConfidence - left.averageConfidence
    );
  })[0] || null;
}

function slimCandidate(candidate) {
  return {
    candidateName: candidate.candidateName,
    variantName: candidate.variantName,
    profileName: candidate.profileName,
    preprocessing: candidate.preprocessing,
    dpi: candidate.dpi,
    averageConfidence: candidate.averageConfidence,
    pageConfidence: candidate.pageConfidence,
    blockCount: candidate.blockCount,
    wordCount: candidate.wordCount,
    characterCount: candidate.characterCount,
    alphaNumericRatio: candidate.alphaNumericRatio,
    suspiciousCharacterRatio: candidate.suspiciousCharacterRatio,
    repeatedCharacterRatio: candidate.repeatedCharacterRatio,
    score: candidate.score,
    consensusScore: candidate.consensusScore,
    finalScore: candidate.finalScore
  };
}

function normalizeVariantRecognitionResult(result) {
  if (Array.isArray(result)) {
    return {
      candidates: result,
      errors: []
    };
  }

  return {
    candidates: result?.candidates || [],
    errors: result?.errors || []
  };
}

export async function renderPageVariantsWithPdfBox({
  pdfPath,
  pages,
  outputDir,
  renderVariants = DEFAULT_RENDER_VARIANTS
}) {
  await ensureJavaHelperCompiled();
  const pdfboxJarPath = await resolvePdfboxJarPath();
  const pageNumbers = pages.map((page) => page.pageNumber).join(",");

  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const stdout = await execCommand(
    javaCommand,
    [
      "-cp",
      `${buildDir}${path.delimiter}${pdfboxJarPath}`,
      "PdfOcrRenderCli",
      "--pdf",
      path.resolve(pdfPath),
      "--output-dir",
      path.resolve(outputDir),
      "--pages",
      pageNumbers,
      "--variants",
      serializeRenderVariants(renderVariants)
    ],
    {
      env: await buildJavaExecEnv({ bundledJavaHome })
    }
  );

  return JSON.parse(stdout.trim());
}

export async function createTesseractRecognizer({
  languages,
  recognitionProfiles = DEFAULT_RECOGNITION_PROFILES,
  cachePath,
  maxAttempts = 2,
  workerOptions = {}
}) {
  const tesseractModule = await import("tesseract.js");
  const tesseract = tesseractModule.default || tesseractModule;
  const resolvedCachePath = path.resolve(cachePath || defaultCachePath);
  await mkdir(resolvedCachePath, { recursive: true });

  let worker = null;

  async function createWorker() {
    return tesseract.createWorker(languages.join("+"), tesseract.OEM.LSTM_ONLY, {
      cachePath: resolvedCachePath,
      ...workerOptions
    });
  }

  async function rebuildWorker() {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // ignore worker teardown failures during rebuild
      }
    }
    worker = await createWorker();
  }

  worker = await createWorker();

  async function recognizeProfile(variant, profile) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: tesseract.PSM[profile.pageSegMode] || tesseract.PSM.AUTO,
          preserve_interword_spaces: "1",
          user_defined_dpi: String(variant.dpi),
          ...(profile.parameters || {})
        });

        const { data } = await worker.recognize(
          variant.imagePath,
          {
            rotateAuto: true
          },
          {
            text: true,
            blocks: true
          }
        );

        const textBlocks = normalizeRecognizedTextBlocks(
          data,
          variant,
          variant.pageNumber,
          `${variant.name}/${profile.name}`
        );

        return {
          status: "completed",
          candidate: summarizeCandidate(textBlocks, data, variant, profile)
        };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await rebuildWorker();
        }
      }
    }

    return {
      status: "failed",
      error: {
        variantName: variant.name,
        profileName: profile.name,
        message: String(lastError?.message || lastError || "OCR recognition failed"),
        attempts: maxAttempts
      }
    };
  }

  return {
    async recognizeVariant(variant) {
      const candidates = [];
      const errors = [];

      for (const profile of recognitionProfiles) {
        const result = await recognizeProfile(variant, profile);
        if (result.status === "completed") {
          candidates.push(result.candidate);
          continue;
        }
        errors.push(result.error);
      }

      return {
        candidates,
        errors
      };
    },
    async close() {
      if (worker) {
        await worker.terminate();
      }
    }
  };
}

export async function runOcrPipeline({
  pdfPath,
  pages,
  languages,
  renderVariants = DEFAULT_RENDER_VARIANTS,
  recognitionProfiles = DEFAULT_RECOGNITION_PROFILES,
  renderPageVariants = renderPageVariantsWithPdfBox,
  createRecognizer = createTesseractRecognizer,
  cachePath,
  maxAttempts,
  tempRoot
}) {
  if (!pages || pages.length === 0) {
    return {
      status: "skipped",
      pages: [],
      attemptedPages: 0,
      appliedPages: 0
    };
  }

  const workingDirectory = await mkdtemp(path.join(tempRoot || os.tmpdir(), "parser-ocr-"));
  let recognizer = null;

  try {
    const rendered = await renderPageVariants({
      pdfPath,
      pages,
      outputDir: workingDirectory,
      renderVariants
    });

    recognizer = await createRecognizer({
      languages,
      recognitionProfiles,
      cachePath,
      maxAttempts
    });

    const pageResults = [];

    for (const renderedPage of rendered.pages || []) {
      const pageCandidates = [];
      const pageErrors = [];

      for (const variant of renderedPage.variants || []) {
        const normalizedVariant = {
          ...variant,
          pageNumber: renderedPage.pageNumber,
          pdfWidth: renderedPage.pdfWidth,
          pdfHeight: renderedPage.pdfHeight
        };
        const result = normalizeVariantRecognitionResult(await recognizer.recognizeVariant(normalizedVariant));
        pageCandidates.push(...result.candidates);
        pageErrors.push(...result.errors);
      }

      const scoredCandidates = annotateCandidateConsensus(pageCandidates);
      const selectedCandidate = selectBestOcrCandidate(scoredCandidates);
      pageResults.push({
        pageNumber: renderedPage.pageNumber,
        selectedCandidate: selectedCandidate ? slimCandidate(selectedCandidate) : null,
        candidates: scoredCandidates.map(slimCandidate),
        candidateCount: scoredCandidates.length,
        errors: pageErrors,
        textBlocks: selectedCandidate?.textBlocks || []
      });
    }

    return {
      status: "completed",
      attemptedPages: pageResults.length,
      appliedPages: pageResults.filter((page) => page.textBlocks.length > 0).length,
      pages: pageResults
    };
  } finally {
    if (recognizer) {
      await recognizer.close();
    }
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
