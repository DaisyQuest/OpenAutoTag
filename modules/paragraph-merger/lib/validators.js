/**
 * Post-merge validation passes for paragraph merger.
 *
 * Each validator takes (mergedDocument, originalDocument) and returns an array
 * of warning objects: { type, severity, nodeId, detail, suggestion }.
 *
 * Validators are composable — the pipeline decides how to act on warnings.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildNodeIndex(doc) {
  const map = new Map();
  for (const node of doc.nodes) {
    map.set(node.id, node);
  }
  return map;
}

function buildNodeOrderIndex(doc) {
  const map = new Map();
  for (let i = 0; i < doc.nodes.length; i++) {
    map.set(doc.nodes[i].id, i);
  }
  return map;
}

function mergedPNodes(doc) {
  return doc.nodes.filter((n) => n.role === "P" && n._mergedFrom && n._mergedFrom.length > 1);
}

// ---------------------------------------------------------------------------
// 1. validateColumnBoundaries
// ---------------------------------------------------------------------------
/**
 * For each merged P node, check if _mergedFrom nodes span multiple columnHints.
 * Cross-column merges are almost always wrong.
 */
export function validateColumnBoundaries(merged, original) {
  const warnings = [];
  const origIndex = buildNodeIndex(original);

  for (const node of mergedPNodes(merged)) {
    const columns = new Set();
    for (const id of node._mergedFrom) {
      const orig = origIndex.get(id);
      if (orig && orig.columnHint != null) {
        columns.add(orig.columnHint);
      }
    }
    if (columns.size > 1) {
      warnings.push({
        type: "cross-column merge",
        severity: "error",
        nodeId: node.id ?? node.paragraphGroupId,
        detail: `Merged node spans columns: ${[...columns].sort().join(", ")}`,
        suggestion: "split back at column boundary"
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// 2. validateParagraphLength
// ---------------------------------------------------------------------------
/**
 * Flag merged paragraphs that are suspiciously long or short.
 *  - > 2000 chars: warning
 *  - > 4000 chars: error
 *  - < 15 chars with _mergedFrom: warning (merged into something too short)
 */
export function validateParagraphLength(merged) {
  const warnings = [];

  for (const node of merged.nodes) {
    if (node.role !== "P") continue;
    const len = (node.text || "").length;
    const hasMerged = node._mergedFrom && node._mergedFrom.length > 1;

    if (len > 4000) {
      warnings.push({
        type: "excessive paragraph length",
        severity: "error",
        nodeId: node.id ?? node.paragraphGroupId,
        detail: `Paragraph is ${len} chars (> 4000)`,
        suggestion: "investigate merge — likely spans multiple logical paragraphs"
      });
    } else if (len > 2000) {
      warnings.push({
        type: "long paragraph",
        severity: "warning",
        nodeId: node.id ?? node.paragraphGroupId,
        detail: `Paragraph is ${len} chars (> 2000)`,
        suggestion: "review merge boundaries for missed breaks"
      });
    }

    if (hasMerged && len < 15) {
      warnings.push({
        type: "short merged paragraph",
        severity: "warning",
        nodeId: node.id ?? node.paragraphGroupId,
        detail: `Merged paragraph is only ${len} chars from ${node._mergedFrom.length} sources`,
        suggestion: "check if sources should remain separate"
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// 3. validateEmbeddedHeadings
// ---------------------------------------------------------------------------
/**
 * Check for headings that were re-classified as P and then merged into a paragraph.
 * Also detect ALL CAPS lines (>4 words) embedded mid-paragraph.
 */
export function validateEmbeddedHeadings(merged, original) {
  const warnings = [];
  const origIndex = buildNodeIndex(original);

  for (const node of mergedPNodes(merged)) {
    // Check if any _mergedFrom node was originally a heading
    for (const id of node._mergedFrom) {
      const orig = origIndex.get(id);
      if (orig && /^H[1-6]$/.test(orig.role)) {
        warnings.push({
          type: "embedded heading",
          severity: "warning",
          nodeId: node.id ?? node.paragraphGroupId,
          detail: `Original node "${id}" had role ${orig.role}, now merged into P`,
          suggestion: "split before heading text"
        });
      }
    }

    // Check for ALL CAPS lines (>4 words) mid-paragraph
    const text = node.text || "";
    const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 1) {
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const words = line.split(/\s+/);
        if (words.length > 4 && line === line.toUpperCase() && /[A-Z]/.test(line)) {
          warnings.push({
            type: "embedded heading",
            severity: "warning",
            nodeId: node.id ?? node.paragraphGroupId,
            detail: `ALL CAPS line mid-paragraph: "${line.substring(0, 60)}${line.length > 60 ? "..." : ""}"`,
            suggestion: "split before heading text"
          });
          break; // one warning per node for ALL CAPS
        }
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// 4. validateReadingOrderPreservation
// ---------------------------------------------------------------------------
/**
 * Check that _mergedFrom IDs appear in the same order as in the original document.
 * Inversions mean the merged text reads blocks out of sequence.
 */
export function validateReadingOrderPreservation(merged, original) {
  const warnings = [];
  const orderIndex = buildNodeOrderIndex(original);

  for (const node of mergedPNodes(merged)) {
    const positions = node._mergedFrom
      .map((id) => orderIndex.get(id))
      .filter((pos) => pos != null);

    for (let i = 1; i < positions.length; i++) {
      if (positions[i] < positions[i - 1]) {
        warnings.push({
          type: "reading order inversion",
          severity: "warning",
          nodeId: node.id ?? node.paragraphGroupId,
          detail: `_mergedFrom IDs are not in original document order (position ${positions[i - 1]} followed by ${positions[i]})`,
          suggestion: "reorder merged content or split into separate nodes"
        });
        break; // one warning per node
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// 5. validateConsistentSpacing
// ---------------------------------------------------------------------------
/**
 * For merged nodes, check that vertical gaps between original lines are consistent.
 * Large variance (stdev > 50% of mean) suggests merging across a visual break.
 */
export function validateConsistentSpacing(merged, original) {
  const warnings = [];
  const origIndex = buildNodeIndex(original);

  for (const node of mergedPNodes(merged)) {
    const origNodes = node._mergedFrom
      .map((id) => origIndex.get(id))
      .filter((n) => n && n.bbox && n.bbox.length >= 4);

    if (origNodes.length < 3) continue; // need at least 3 nodes for meaningful variance

    // Sort by vertical position
    const sorted = [...origNodes].sort((a, b) => a.bbox[1] - b.bbox[1]);

    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const prevBottom = sorted[i - 1].bbox[1] + sorted[i - 1].bbox[3];
      const currTop = sorted[i].bbox[1];
      const gap = currTop - prevBottom;
      if (gap >= 0) gaps.push(gap);
    }

    if (gaps.length < 2) continue;

    const mean = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
    if (mean === 0) continue;

    const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length;
    const stdev = Math.sqrt(variance);

    if (stdev > mean * 0.5) {
      warnings.push({
        type: "inconsistent spacing",
        severity: "warning",
        nodeId: node.id ?? node.paragraphGroupId,
        detail: `Vertical gap stdev (${stdev.toFixed(1)}) > 50% of mean (${mean.toFixed(1)}) across ${gaps.length} gaps`,
        suggestion: "possible merge across visual break — review gap threshold"
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// 6. runAllValidators
// ---------------------------------------------------------------------------
/**
 * Runs all 5 validators, deduplicates, sorts by severity (error first).
 * Returns { warnings, summary }.
 */
export function runAllValidators(merged, original) {
  const allWarnings = [
    ...validateColumnBoundaries(merged, original),
    ...validateParagraphLength(merged),
    ...validateEmbeddedHeadings(merged, original),
    ...validateReadingOrderPreservation(merged, original),
    ...validateConsistentSpacing(merged, original)
  ];

  // Deduplicate by (type + nodeId)
  const seen = new Set();
  const deduplicated = [];
  for (const w of allWarnings) {
    const key = `${w.type}::${w.nodeId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(w);
    }
  }

  // Sort: errors first, then warnings
  const severityOrder = { error: 0, warning: 1 };
  deduplicated.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

  const flaggedNodeIds = new Set(deduplicated.map((w) => w.nodeId));
  const totalPNodes = merged.nodes.filter((n) => n.role === "P").length;

  const summary = {
    errorCount: deduplicated.filter((w) => w.severity === "error").length,
    warningCount: deduplicated.filter((w) => w.severity === "warning").length,
    flaggedNodeCount: flaggedNodeIds.size,
    passedNodeCount: totalPNodes - flaggedNodeIds.size
  };

  return { warnings: deduplicated, summary };
}
