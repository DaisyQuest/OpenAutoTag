/**
 * Text-structure paragraph merger: determines the page's body-text left margin,
 * then merges all consecutive P-lines sitting on that margin into paragraphs.
 * Breaks ONLY on:
 *   1. First-line indent (line starts further right than the established margin)
 *   2. Large gap (> gapBreakMultiplier × median line spacing on this page)
 *   3. Column change (columnHint differs)
 *   4. Role isn't P
 *
 * Validation passes afterward flag suspicious merges for human review.
 *
 * Target: 80-95% reduction on typical single-column documents.
 */

function getTop(n) { return n.bbox?.[1] ?? 0; }
function getLeft(n) { return n.bbox?.[0] ?? 0; }
function getHeight(n) { return n.bbox?.[3] ?? 0; }
function getBottom(n) { return getTop(n) + getHeight(n); }
function getWidth(n) { return n.bbox?.[2] ?? 0; }

function detectBodyMargin(pNodes) {
  const leftCounts = new Map();
  for (const n of pNodes) {
    const x = Math.round(getLeft(n));
    leftCounts.set(x, (leftCounts.get(x) || 0) + 1);
  }
  if (leftCounts.size === 0) return 0;
  const sorted = [...leftCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
}

function computeMedianLineSpacing(sorted) {
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = getTop(sorted[i]) - getBottom(sorted[i - 1]);
    if (gap > 0 && gap < 200) gaps.push(gap);
  }
  if (gaps.length === 0) return 20;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function isAtMargin(node, margin, tolerance) {
  return Math.abs(getLeft(node) - margin) <= tolerance;
}

function textEndsIncomplete(text) {
  const trimmed = (text || "").trimEnd();
  if (trimmed.length === 0) return false;
  const lastChar = trimmed[trimmed.length - 1];
  if (/[,;\-\u2014\u2013]/.test(lastChar)) return true;
  if (/[a-z]$/.test(trimmed)) return true;
  const words = trimmed.split(/\s+/);
  const lastWord = (words[words.length - 1] || "").toLowerCase();
  return ["the", "a", "an", "of", "in", "to", "for", "and", "or", "but", "that",
    "which", "who", "with", "by", "from", "as", "at", "on", "is", "was", "be",
    "are", "were", "not", "this", "its", "their", "his", "her"].includes(lastWord);
}

const DEFAULT_CONFIG = {
  marginTolerance: 8,
  gapBreakMultiplier: 2.2,
  indentMinPixels: 20
};

export function textStructureMerge(semanticDocument, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const pageGroups = new Map();
  for (const node of semanticDocument.nodes) {
    const arr = pageGroups.get(node.pageNumber) || [];
    arr.push(node);
    pageGroups.set(node.pageNumber, arr);
  }

  const allNodes = [];
  const pageReports = [];
  let totalAbsorbed = 0;
  let totalBreaks = 0;

  for (const pageNumber of [...pageGroups.keys()].sort((a, b) => a - b)) {
    const pageNodes = pageGroups.get(pageNumber);
    const pNodes = pageNodes.filter((n) => n.role === "P");
    const nonPNodes = pageNodes.filter((n) => n.role !== "P");

    if (pNodes.length < 2) {
      allNodes.push(...pageNodes);
      pageReports.push({ pageNumber, linesIn: pNodes.length, parasOut: pNodes.length, breaks: [], warnings: [] });
      continue;
    }

    const sorted = [...pNodes].sort((a, b) => getTop(a) - getTop(b) || getLeft(a) - getLeft(b));
    const bodyMargin = detectBodyMargin(sorted);
    const medianSpacing = computeMedianLineSpacing(sorted);
    const gapThreshold = medianSpacing * cfg.gapBreakMultiplier;

    const groups = [];
    let current = [sorted[0]];
    const breaks = [];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const breakReasons = [];

      const gap = getTop(curr) - getBottom(prev);
      if (gap > gapThreshold) {
        breakReasons.push(`gap=${gap.toFixed(0)}px > threshold=${gapThreshold.toFixed(0)}px (${cfg.gapBreakMultiplier}× median=${medianSpacing.toFixed(0)}px)`);
      }

      const prevCol = prev.columnHint ?? -1;
      const currCol = curr.columnHint ?? -1;
      if (prevCol !== currCol && prevCol >= 0 && currCol >= 0) {
        breakReasons.push(`column ${prevCol} → ${currCol}`);
      }

      const currIndent = getLeft(curr) - bodyMargin;
      const prevAtMargin = isAtMargin(prev, bodyMargin, cfg.marginTolerance);
      if (currIndent > cfg.indentMinPixels && prevAtMargin) {
        if (!textEndsIncomplete(prev.text)) {
          breakReasons.push(`indent=${currIndent.toFixed(0)}px from margin=${bodyMargin}, prev line complete`);
        }
      }

      if (breakReasons.length > 0) {
        groups.push(current);
        breaks.push({ between: [prev.id, curr.id], reasons: breakReasons });
        current = [curr];
        totalBreaks++;
      } else {
        current.push(curr);
      }
    }
    groups.push(current);

    const warnings = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      if (group.length === 1) {
        group[0].paragraphGroupId = `pg-${pageNumber}-${gi}`;
        allNodes.push(group[0]);
        continue;
      }

      const merged = {
        ...group[0],
        text: group.map((n) => (n.text || "").trim()).join(" "),
        bbox: [
          Math.min(...group.map(getLeft)),
          Math.min(...group.map(getTop)),
          Math.max(...group.map((n) => getLeft(n) + getWidth(n))) - Math.min(...group.map(getLeft)),
          Math.max(...group.map(getBottom)) - Math.min(...group.map(getTop))
        ],
        _mergedFrom: group.map((n) => n.id),
        paragraphGroupId: `pg-${pageNumber}-${gi}`
      };

      if (merged.text.length > 3000) {
        warnings.push({ group: merged.paragraphGroupId, lines: group.length, issue: `very long: ${merged.text.length} chars` });
      }

      allNodes.push(merged);
      totalAbsorbed += group.length - 1;
    }

    allNodes.push(...nonPNodes);
    pageReports.push({
      pageNumber,
      linesIn: pNodes.length,
      parasOut: groups.length,
      bodyMargin,
      medianSpacing: Math.round(medianSpacing),
      gapThreshold: Math.round(gapThreshold),
      breaks,
      warnings
    });
  }

  const totalPLines = semanticDocument.nodes.filter((n) => n.role === "P").length;
  const totalParas = allNodes.filter((n) => n.role === "P").length;
  const output = { ...semanticDocument, nodes: allNodes };

  const report = {
    strategy: "text-structure-merge",
    config: cfg,
    pages: pageReports,
    summary: {
      totalLinesIn: semanticDocument.nodes.length,
      totalParagraphLinesIn: totalPLines,
      totalParagraphsOut: totalParas,
      totalNodesOut: allNodes.length,
      totalAbsorbed,
      totalBreaks,
      pLineReductionPercent: totalPLines > 0 ? ((totalAbsorbed / totalPLines) * 100).toFixed(1) : "0.0",
      overallReductionPercent: semanticDocument.nodes.length > 0
        ? (((semanticDocument.nodes.length - allNodes.length) / semanticDocument.nodes.length) * 100).toFixed(1)
        : "0.0"
    }
  };

  return { document: output, report };
}
