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
 * Default scoring weights matching the profile schema defaults.
 */
const DEFAULT_WEIGHTS = {
  veraPdfFindings: 0.4,
  fontEmbedCoverage: 0.2,
  readingOrderInversions: 0.25,
  ocrConfidence: 0.15
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
    ocrConfidence: (v) => v / 100
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
