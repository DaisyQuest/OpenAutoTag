import { readFile } from "node:fs/promises";

/**
 * Reads a JSON file, returning null if it doesn't exist or is invalid.
 */
async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Counts reading-order inversions in a semantic-ordered JSON document.
 * An inversion occurs when two adjacent nodes on the same page share
 * approximately the same y-coordinate (same visual line) but the later
 * node has a smaller left-x than the earlier node (i.e., it should have
 * come first in left-to-right reading order).
 *
 * @param {string} semanticOrderedPath - Path to 04-semantic-ordered.json
 * @returns {Promise<number|null>} inversion count, or null if unavailable
 */
export async function readingOrderInversionCount(semanticOrderedPath) {
  const doc = await readJsonSafe(semanticOrderedPath);
  if (!doc || !Array.isArray(doc.nodes) || doc.nodes.length === 0) {
    return null;
  }

  const EPSILON_Y = 6;
  let inversions = 0;

  // Group nodes by page
  const byPage = new Map();
  for (const node of doc.nodes) {
    if (!node.bbox || node.bbox.length < 4) continue;
    const page = node.pageNumber ?? node.page ?? 0;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(node);
  }

  for (const [, nodes] of byPage) {
    // Nodes are in reading order already (orderedNodeIds or array order)
    for (let i = 0; i < nodes.length - 1; i++) {
      const current = nodes[i];
      const next = nodes[i + 1];

      const currentY = current.bbox[1];
      const nextY = next.bbox[1];

      // Same visual line: y coordinates within epsilon
      if (Math.abs(currentY - nextY) <= EPSILON_Y) {
        const currentX = current.bbox[0];
        const nextX = next.bbox[0];
        // Inversion: next block starts to the left of current block
        if (nextX < currentX) {
          inversions++;
        }
      }
    }
  }

  return inversions;
}

/**
 * Computes font-embed coverage from the writer report.
 * Returns the fraction of fonts that are embedded with adequate toUnicode coverage.
 *
 * The writer report may contain a `fonts` array with objects having
 * `embedded` (boolean) and `toUnicodeCoverage` (number 0-1) fields.
 * If no fonts array exists, returns null.
 *
 * @param {string} writerReportPath - Path to 06-writer-report.json
 * @returns {Promise<number|null>} coverage fraction 0-1, or null if unavailable
 */
export async function fontEmbedScore(writerReportPath) {
  const report = await readJsonSafe(writerReportPath);
  if (!report) return null;

  const fonts = report.fonts || report.fontAudit?.fonts;
  if (!Array.isArray(fonts) || fonts.length === 0) return null;

  let qualifying = 0;
  for (const font of fonts) {
    const embedded = font.embedded === true;
    const coverage = typeof font.toUnicodeCoverage === "number" ? font.toUnicodeCoverage : 1;
    if (embedded && coverage >= 0.99) {
      qualifying++;
    }
  }

  return qualifying / fonts.length;
}

/**
 * Counts error-severity findings from a validation report (veraPDF output).
 *
 * @param {string} validationReportPath - Path to 07-validation-report.json
 * @returns {Promise<number|null>} count of error findings, or null if unavailable
 */
export async function veraPdfScore(validationReportPath) {
  const report = await readJsonSafe(validationReportPath);
  if (!report) return null;

  const findings = report.findings;
  if (!Array.isArray(findings)) return null;

  return findings.filter((f) => f.severity === "error").length;
}

/**
 * Computes average OCR confidence across all pages from layout JSON.
 * Only considers text blocks that have ocrConfidence set (textSource === "ocr").
 *
 * @param {string} layoutPath - Path to 01-layout.json
 * @returns {Promise<number|null>} average confidence 0-100, or null if no OCR blocks
 */
export async function ocrScore(layoutPath) {
  const layout = await readJsonSafe(layoutPath);
  if (!layout || !Array.isArray(layout.pages)) return null;

  const confidences = [];
  for (const page of layout.pages) {
    const blocks = page.textBlocks || [];
    for (const block of blocks) {
      if (typeof block.ocrConfidence === "number") {
        confidences.push(block.ocrConfidence);
      }
    }
  }

  if (confidences.length === 0) return null;

  const sum = confidences.reduce((a, b) => a + b, 0);
  return sum / confidences.length;
}

/**
 * Computes paragraph quality from a semantic-ordered JSON document.
 * Evaluates:
 * - meanParagraphLength: very short (<20) or very long (>2000) chars penalized
 * - paragraphCountPerPage: very high (>30/page) suggests under-merging
 * - consistencyScore: lower variance in paragraph length = better
 *
 * @param {string} semanticPath - Path to semantic-ordered JSON
 * @returns {Promise<number|null>} 0-1 score, or null if unavailable
 */
export async function paragraphQualityScore(semanticPath) {
  const doc = await readJsonSafe(semanticPath);
  if (!doc || !Array.isArray(doc.nodes) || doc.nodes.length === 0) return null;

  const paragraphs = doc.nodes.filter(
    (n) => (n.role === "P" || n.type === "P") && n.text
  );
  if (paragraphs.length === 0) return null;

  const lengths = paragraphs.map((p) => (p.text || "").length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;

  // --- meanParagraphLength score (0-1) ---
  // Ideal range: 20-2000 chars. Outside that, penalise linearly.
  let lengthScore;
  if (mean >= 20 && mean <= 2000) {
    // Sweet spot: 80-500 gets 1.0, outside that tapers
    if (mean >= 80 && mean <= 500) {
      lengthScore = 1.0;
    } else if (mean < 80) {
      lengthScore = 0.5 + 0.5 * ((mean - 20) / 60);
    } else {
      lengthScore = 0.5 + 0.5 * ((2000 - mean) / 1500);
    }
  } else if (mean < 20) {
    lengthScore = Math.max(0, mean / 20 * 0.3);
  } else {
    lengthScore = Math.max(0, 0.5 * (1 - (mean - 2000) / 2000));
  }

  // --- paragraphCountPerPage score (0-1) ---
  const pages = new Set();
  for (const p of paragraphs) {
    pages.add(p.pageNumber ?? p.page ?? 0);
  }
  const perPage = paragraphs.length / Math.max(pages.size, 1);
  let perPageScore;
  if (perPage <= 30) {
    perPageScore = 1.0;
  } else {
    // Linearly penalise above 30, hitting 0 at 100+
    perPageScore = Math.max(0, 1 - (perPage - 30) / 70);
  }

  // --- consistencyScore (0-1) based on coefficient of variation ---
  let consistencyScore = 1.0;
  if (mean > 0 && lengths.length > 1) {
    const variance =
      lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length;
    const stddev = Math.sqrt(variance);
    const cv = stddev / mean; // coefficient of variation
    // cv=0 is perfect, cv>=2 is very inconsistent
    consistencyScore = Math.max(0, 1 - cv / 2);
  }

  // Weighted combination
  const score =
    lengthScore * 0.45 +
    perPageScore * 0.35 +
    consistencyScore * 0.2;

  return Math.max(0, Math.min(1, score));
}

/**
 * Computes a native-tagging quality score from operator parser JSON output.
 * Evaluates: operatorCount, operatorsPerPage, fontDiversity, textCoverage.
 * Returns 0-1 where higher = more native-tagging-friendly.
 *
 * @param {string} operatorJsonPath - Path to operator parser output JSON
 * @returns {Promise<number|null>} 0-1 score, or null if unavailable
 */
export async function nativeQualityScore(operatorJsonPath) {
  const data = await readJsonSafe(operatorJsonPath);
  if (!data) return null;

  const operators = data.operators || [];
  const pageCount = data.pageCount || data.pages?.length || 1;

  if (operators.length === 0) return null;

  const operatorCount = operators.length;
  const operatorsPerPage = operatorCount / pageCount;

  // Font diversity: count unique font names referenced in text-showing operators
  const fontNames = new Set();
  for (const op of operators) {
    if (op.font || op.fontName) {
      fontNames.add(op.font || op.fontName);
    }
  }
  const fontDiversity = fontNames.size;

  // Text coverage: fraction of operators that are text-showing
  const textOps = operators.filter(
    (op) => op.type === "text" || op.category === "text" || /^(Tj|TJ|'|")$/.test(op.operator || "")
  );
  const textCoverage = textOps.length / operatorCount;

  // --- Scoring components ---

  // operatorsPerPage score: ideal 50-500, less than 10 is suspicious, >2000 is complex
  let opsPerPageScore;
  if (operatorsPerPage >= 50 && operatorsPerPage <= 500) {
    opsPerPageScore = 1.0;
  } else if (operatorsPerPage < 50) {
    opsPerPageScore = Math.max(0, operatorsPerPage / 50);
  } else {
    opsPerPageScore = Math.max(0, 1 - (operatorsPerPage - 500) / 1500);
  }

  // fontDiversity score: 1-10 fonts is ideal, 0 is bad, >20 is complex
  let fontScore;
  if (fontDiversity >= 1 && fontDiversity <= 10) {
    fontScore = 1.0;
  } else if (fontDiversity === 0) {
    fontScore = 0.2;
  } else {
    fontScore = Math.max(0.3, 1 - (fontDiversity - 10) / 30);
  }

  // textCoverage score: higher text fraction = more native-friendly
  // Ideal: 0.2-0.8 (documents with some graphics and text)
  let textScore;
  if (textCoverage >= 0.15 && textCoverage <= 0.85) {
    textScore = 1.0;
  } else if (textCoverage < 0.15) {
    textScore = Math.max(0, textCoverage / 0.15);
  } else {
    textScore = 0.8; // mostly text is still good
  }

  // Weighted combination
  const score =
    opsPerPageScore * 0.35 +
    fontScore * 0.25 +
    textScore * 0.40;

  return Math.max(0, Math.min(1, score));
}

/**
 * Default scoring weights matching the profile schema defaults.
 */
const DEFAULT_WEIGHTS = {
  veraPdfFindings: 0.4,
  fontEmbedCoverage: 0.2,
  readingOrderInversions: 0.15,
  ocrConfidence: 0.15,
  paragraphQuality: 0.1
};

/**
 * Computes a weighted aggregate score from individual metric values.
 * Each metric is normalized to 0-1 where 1 is best:
 * - veraPdfFindings: 1 / (1 + count)  (fewer findings = better)
 * - fontEmbedCoverage: direct fraction
 * - readingOrderInversions: 1 / (1 + count) (fewer inversions = better)
 * - ocrConfidence: value / 100 (confidence is 0-100)
 *
 * Only metrics that are non-null contribute; weights are re-normalized.
 */
export function computeAggregateScore(metrics, weights = DEFAULT_WEIGHTS) {
  const normalizers = {
    veraPdfFindings: (v) => 1 / (1 + v),
    fontEmbedCoverage: (v) => v,
    readingOrderInversions: (v) => 1 / (1 + v),
    ocrConfidence: (v) => v / 100,
    paragraphQuality: (v) => v
  };

  let totalWeight = 0;
  let weightedSum = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const value = metrics[key];
    if (value === null || value === undefined) continue;

    const normalizer = normalizers[key];
    if (!normalizer) continue;

    const normalized = normalizer(value);
    weightedSum += normalized * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  return weightedSum / totalWeight;
}
