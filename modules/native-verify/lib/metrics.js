import { stat } from "node:fs/promises";

/**
 * Measure the file size of a PDF in bytes.
 * @param {string} pdfPath
 * @returns {Promise<number>}
 */
export async function measureFileSize(pdfPath) {
  const s = await stat(pdfPath);
  return s.size;
}

/**
 * Measure whether text in the PDF is selectable/extractable using pdfjs-dist.
 * Returns { selectable: boolean, extractedLength: number, extractedText: string }
 * @param {string} pdfPath
 * @returns {Promise<{selectable: boolean, extractedLength: number, extractedText: string}>}
 */
export async function measureTextSelectability(pdfPath) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ url: pdfPath, useSystemFonts: true }).promise;
  let fullText = "";

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str || "").join(" ");
    fullText += pageText + "\n";
  }

  const trimmed = fullText.trim();
  return {
    selectable: trimmed.length > 0,
    extractedLength: trimmed.length,
    extractedText: trimmed
  };
}

/**
 * Measure content preservation: ratio of native text operators preserved vs total expected.
 * @param {number} nativeTextOperators - operators found in native output
 * @param {number} totalExpectedOperators - total operators in original PDF
 * @returns {number} preservation score 0..1
 */
export function measureContentPreservation(nativeTextOperators, totalExpectedOperators) {
  if (totalExpectedOperators === 0) return 1.0;
  return Math.min(nativeTextOperators / totalExpectedOperators, 1.0);
}

/**
 * Count link annotations in a PDF using pdfjs-dist.
 * @param {string} pdfPath
 * @returns {Promise<number>}
 */
export async function measureLinkPreservation(pdfPath) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ url: pdfPath, useSystemFonts: true }).promise;
  let linkCount = 0;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      if (ann.subtype === "Link") {
        linkCount++;
      }
    }
  }

  return linkCount;
}

/**
 * Diff two tag trees for structure fidelity.
 * Returns a score from 0..1 measuring how similar they are.
 * @param {object|null} rasterTagTree - tag tree from raster mode (may be null)
 * @param {object|null} nativeTagTree - tag tree from native mode (may be null)
 * @returns {number}
 */
export function measureStructureFidelity(rasterTagTree, nativeTagTree) {
  if (!rasterTagTree && !nativeTagTree) return 1.0;
  if (!rasterTagTree || !nativeTagTree) return 0.0;

  const rasterRoles = flattenRoles(rasterTagTree);
  const nativeRoles = flattenRoles(nativeTagTree);

  if (rasterRoles.length === 0 && nativeRoles.length === 0) return 1.0;
  if (rasterRoles.length === 0 || nativeRoles.length === 0) return 0.0;

  // Compare role sequences using longest common subsequence ratio
  const lcsLen = lcsLength(rasterRoles, nativeRoles);
  const maxLen = Math.max(rasterRoles.length, nativeRoles.length);
  return lcsLen / maxLen;
}

/**
 * Compute file size ratio (native / raster). Lower is better for native.
 * @param {number} rasterSize
 * @param {number} nativeSize
 * @returns {number}
 */
export function measureFileSizeRatio(rasterSize, nativeSize) {
  if (rasterSize === 0) return nativeSize === 0 ? 1.0 : Infinity;
  return nativeSize / rasterSize;
}

// --- helpers ---

function flattenRoles(node) {
  const roles = [];
  if (node.type || node.role) {
    roles.push(node.type || node.role);
  }
  for (const child of node.children || []) {
    roles.push(...flattenRoles(child));
  }
  return roles;
}

function lcsLength(a, b) {
  const m = a.length;
  const n = b.length;
  // Space-optimized LCS
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n];
}
