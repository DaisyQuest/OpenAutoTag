// auto-selector.js — Document-adaptive version selector for paragraph-merger
// Analyzes a semantic document and picks the best merger strategy.
// Self-contained: no imports from other modules.

/**
 * Legal-filing detection patterns (case-insensitive).
 * We check the first ~50 nodes' text for these signals.
 */
const LEGAL_PATTERNS = [
  /\bNYSCEF\b/i,
  /\bCourt\s+of\b/i,
  /\bPetitioner\b/i,
  /\bRespondent\b/i,
  /\bPlaintiff\b/i,
  /\bDefendant\b/i,
  /\bIndex\s*No\.\s*\d/i,
  /\bCase\s*No\.\s*\d/i,
  /\bDocket\s*No\.\s*\d/i,
  /\bSUPREME\s+COURT\b/i,
  /\bMOTION\s+(TO|FOR)\b/i,
];

const LEGAL_PATTERN_THRESHOLD = 2; // need at least 2 matches to flag as legal

/**
 * Analyze a semantic document and return a feature vector.
 *
 * @param {{ nodes: Array<{ pageNumber: number, role: string, bbox: number[], text: string, confidence: number, columnHint: number, sourceBlockId: string }> }} semanticDocument
 * @returns {object} feature vector
 */
export function extractDocumentFeatures(semanticDocument) {
  const nodes = semanticDocument?.nodes ?? [];
  const totalNodes = nodes.length;

  // --- Pages ---
  const pageSet = new Set();
  for (const n of nodes) {
    if (n.pageNumber != null) pageSet.add(n.pageNumber);
  }
  const totalPages = Math.max(pageSet.size, 1);
  const nodesPerPage = totalNodes / totalPages;

  // --- Column detection ---
  let maxColumnHint = 0;
  for (const n of nodes) {
    const ch = Number(n.columnHint);
    if (Number.isFinite(ch) && ch > maxColumnHint) maxColumnHint = ch;
  }
  const hasMultipleColumns = maxColumnHint >= 1;

  // --- Role ratios ---
  let headingCount = 0;
  let paragraphCount = 0;
  let tableNodeCount = 0;
  let artifactCount = 0;

  for (const n of nodes) {
    const role = (n.role || "").toUpperCase();
    if (role === "H1" || role === "H2" || role === "H3" || role === "HEADING") headingCount++;
    if (role === "P" || role === "PARAGRAPH") paragraphCount++;
    if (role === "TH" || role === "TD" || role === "TABLE") tableNodeCount++;
    if (role === "ARTIFACT") artifactCount++;
  }

  const safe = Math.max(totalNodes, 1);
  const headingRatio = headingCount / safe;
  const paragraphRatio = paragraphCount / safe;
  const tableNodeRatio = tableNodeCount / safe;
  const artifactRatio = artifactCount / safe;

  // --- Text stats (paragraph nodes only) ---
  let totalTextChars = 0;
  let pTextLengthSum = 0;
  let pCount = 0;

  for (const n of nodes) {
    const txt = n.text || "";
    totalTextChars += txt.length;
    const role = (n.role || "").toUpperCase();
    if (role === "P" || role === "PARAGRAPH") {
      pTextLengthSum += txt.length;
      pCount++;
    }
  }

  const meanTextLength = pCount > 0 ? pTextLengthSum / pCount : 0;
  const textDensity = totalTextChars / totalPages;

  // --- Legal filing detection ---
  // Check up to the first 50 nodes for legal text patterns
  const sampleText = nodes
    .slice(0, 50)
    .map((n) => n.text || "")
    .join(" ");

  let legalHits = 0;
  for (const pat of LEGAL_PATTERNS) {
    if (pat.test(sampleText)) legalHits++;
  }
  const isLegalFiling = legalHits >= LEGAL_PATTERN_THRESHOLD;

  // --- Scanned / OCR detection ---
  // Low mean confidence suggests OCR output
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const n of nodes) {
    if (n.confidence != null && Number.isFinite(n.confidence)) {
      confidenceSum += n.confidence;
      confidenceCount++;
    }
  }
  const meanConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 1;
  const isScanned = meanConfidence < 0.75;

  // --- Form fields ---
  let hasFormFields = false;
  for (const n of nodes) {
    const role = (n.role || "").toUpperCase();
    const text = (n.text || "").toLowerCase();
    if (role === "FORM" || role === "WIDGET" || /acroform/i.test(n.sourceBlockId || "")) {
      hasFormFields = true;
      break;
    }
    // Also detect common form-field artifacts
    if (role === "ARTIFACT" && (text.includes("checkbox") || text.includes("radio") || text.includes("text field"))) {
      hasFormFields = true;
      break;
    }
  }

  return {
    totalNodes,
    totalPages,
    nodesPerPage,
    maxColumnHint,
    hasMultipleColumns,
    headingRatio,
    paragraphRatio,
    tableNodeRatio,
    artifactRatio,
    meanTextLength,
    isLegalFiling,
    isScanned,
    hasFormFields,
    textDensity,
    meanConfidence,
  };
}

/**
 * Check whether a version ID is in the available list.
 */
function isAvailable(versionId, availableVersions) {
  return availableVersions.includes(versionId);
}

/**
 * Pick the first available version from a ranked preference list.
 * Returns the version ID or null.
 */
function pickFirst(preferences, availableVersions) {
  for (const v of preferences) {
    if (isAvailable(v, availableVersions)) return v;
  }
  return null;
}

/**
 * Decision logic: select the best paragraph-merger version for a document.
 *
 * @param {object} features — output of extractDocumentFeatures
 * @param {string[]} availableVersions — e.g. ["v1-conservative", "v2-balanced", ...]
 * @returns {{ selectedVersionId: string, confidence: number, reasoning: string[] }}
 */
export function selectVersion(features, availableVersions) {
  const reasoning = [];

  // -----------------------------------------------------------------------
  // Rule 1 — Very short documents
  // -----------------------------------------------------------------------
  if (features.totalNodes < 20) {
    const pick = pickFirst(["v1-conservative", "v2-balanced"], availableVersions);
    if (pick) {
      reasoning.push(
        `Document has only ${features.totalNodes} nodes (< 20); too few to benefit from aggressive merging — false-merge risk is high.`,
      );
      return { selectedVersionId: pick, confidence: 0.9, reasoning };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 2 — Legal filing
  // -----------------------------------------------------------------------
  if (features.isLegalFiling) {
    const pick = pickFirst(["v7-refined", "v4-legal-tuned", "v6-hybrid"], availableVersions);
    if (pick) {
      reasoning.push(
        "Legal-filing text patterns detected (court headers, party names, case numbers).",
      );
      reasoning.push(
        "Legal documents have structured layouts, numbered paragraphs, and citations that require specialized merging.",
      );
      return { selectedVersionId: pick, confidence: 0.85, reasoning };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 3 — Multi-column with many nodes
  // -----------------------------------------------------------------------
  if (features.hasMultipleColumns && features.totalNodes >= 20) {
    const pick = pickFirst(["v8-precision", "v2-balanced", "v6-hybrid"], availableVersions);
    if (pick) {
      reasoning.push(
        `Multi-column layout detected (maxColumnHint=${features.maxColumnHint}) with ${features.totalNodes} nodes.`,
      );
      reasoning.push(
        "Cross-column merge risk is high; precision/balanced strategy reduces false merges across columns.",
      );
      return { selectedVersionId: pick, confidence: 0.8, reasoning };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 4 — High heading ratio (structured / syllabus-like)
  // -----------------------------------------------------------------------
  if (features.headingRatio > 0.15) {
    const pick = pickFirst(["v2-balanced", "v4-legal-tuned", "v1-conservative"], availableVersions);
    if (pick) {
      reasoning.push(
        `High heading ratio (${(features.headingRatio * 100).toFixed(1)}% > 15%); document is heavily structured.`,
      );
      reasoning.push(
        "Aggressive merging may incorrectly merge headings with body text; balanced strategy is safer.",
      );
      return { selectedVersionId: pick, confidence: 0.75, reasoning };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 5 — Scanned / low-confidence OCR
  // -----------------------------------------------------------------------
  if (features.isScanned || features.meanConfidence < 0.75) {
    const pick = pickFirst(["v6-hybrid", "v3-aggressive", "v2-balanced"], availableVersions);
    if (pick) {
      reasoning.push(
        `Low mean confidence (${features.meanConfidence.toFixed(2)}); document appears to be scanned/OCR output.`,
      );
      reasoning.push(
        "OCR text is often fragmented; aggressive merging compensates for over-split OCR blocks.",
      );
      return { selectedVersionId: pick, confidence: 0.7, reasoning };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 6 — Dense single-column text
  // -----------------------------------------------------------------------
  if (features.textDensity > 5000 && !features.hasMultipleColumns) {
    const pick = pickFirst(["v7-refined", "v6-hybrid", "v3-aggressive"], availableVersions);
    if (pick) {
      reasoning.push(
        `High text density (${Math.round(features.textDensity)} chars/page > 5000) in single-column layout.`,
      );
      reasoning.push(
        "Dense text benefits from aggressive reduction with heuristic guards to avoid over-merging.",
      );
      return { selectedVersionId: pick, confidence: 0.75, reasoning };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 7 — Default fallback
  // -----------------------------------------------------------------------
  const pick = pickFirst(
    ["v7-refined", "v2-balanced", "v6-hybrid", "v1-conservative"],
    availableVersions,
  );
  if (pick) {
    reasoning.push(
      "No strong document-specific signal detected; using general-purpose default strategy.",
    );
    return { selectedVersionId: pick, confidence: 0.6, reasoning };
  }

  // Absolute fallback — pick whatever is available
  reasoning.push(
    "No preferred version available; falling back to first available version.",
  );
  return {
    selectedVersionId: availableVersions[0] || "v2-balanced",
    confidence: 0.3,
    reasoning,
  };
}

/**
 * Top-level convenience: extract features then select version.
 *
 * @param {{ nodes: object[] }} semanticDocument
 * @param {string[]} availableVersions
 * @returns {{ features: object, selectedVersionId: string, confidence: number, reasoning: string[] }}
 */
export function autoSelectVersion(semanticDocument, availableVersions) {
  const features = extractDocumentFeatures(semanticDocument);
  const selection = selectVersion(features, availableVersions);
  return { features, ...selection };
}
