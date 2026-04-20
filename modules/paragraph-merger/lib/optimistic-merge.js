/**
 * Optimistic paragraph merger: assumes consecutive P-lines on the same page
 * at similar x-alignment belong to one paragraph unless a BREAK signal says
 * otherwise. This inverts the cautious approach (which asks "should we merge?"
 * for every pair) into "we merge by default; where should we split?"
 *
 * Break signals (any one triggers a paragraph boundary):
 *   1. Vertical gap > threshold × line height (visual paragraph break)
 *   2. First-line indent: current line is indented >15px relative to the
 *      running left margin of the current group (new paragraph indent)
 *   3. Outdent after indent: previous line was indented but current returns
 *      to the baseline left margin (block-quote or list ended)
 *   4. Font height change > 30% (heading or caption)
 *   5. Current line starts with a list/numbering marker (1. / a) / (i) / • / -)
 *   6. Different column (columnHint changes)
 *
 * After the optimistic merge, validation passes flag suspicious results:
 *   - Paragraphs > 3000 chars (may have missed a break)
 *   - Paragraphs spanning > 80% page width in a multi-column layout
 *   - ALL CAPS lines embedded mid-paragraph (likely a missed heading)
 */

const LIST_MARKER_PATTERN = /^\s*(?:\d{1,3}[.)]\s|[a-z][.)]\s|\([ivxlcdm]+\)\s|[\u2022\u2023\u25E6\u2043•\-–—]\s)/i;

function getTop(node) { return node.bbox?.[1] ?? 0; }
function getLeft(node) { return node.bbox?.[0] ?? 0; }
function getHeight(node) { return node.bbox?.[3] ?? 0; }
function getWidth(node) { return node.bbox?.[2] ?? 0; }
function getBottom(node) { return getTop(node) + getHeight(node); }
// Row-snap tolerance: blocks on the same visual line may have small
// fractional Y differences from font baseline/descent variance. Bucket
// with floor so same-row variance falls into one bucket (Math.round
// can still split same-row blocks across buckets at the .5 mark).
const ROW_BUCKET_PX = 6;
function getRow(node) { return Math.floor(getTop(node) / ROW_BUCKET_PX); }

function isBreakSignal(prev, curr, groupLeftMargin, config) {
  const reasons = [];

  const lineHeight = Math.max(getHeight(prev), getHeight(curr), 1);
  const gap = getTop(curr) - getBottom(prev);

  if (gap > lineHeight * config.breakGapMultiplier) {
    reasons.push(`gap=${gap.toFixed(0)}px > ${(lineHeight * config.breakGapMultiplier).toFixed(0)}px`);
  }

  if (gap < -lineHeight * 0.5) {
    reasons.push(`overlap=${(-gap).toFixed(0)}px (different visual region)`);
  }

  const currLeft = getLeft(curr);
  const indent = currLeft - groupLeftMargin;
  if (indent > config.indentThreshold) {
    reasons.push(`first-line indent=${indent.toFixed(0)}px (new paragraph)`);
  }

  const prevLeft = getLeft(prev);
  const outdent = prevLeft - currLeft;
  if (outdent > config.indentThreshold && prevLeft > groupLeftMargin + config.indentThreshold) {
    reasons.push(`outdent=${outdent.toFixed(0)}px after indented block`);
  }

  const prevH = getHeight(prev);
  const currH = getHeight(curr);
  if (prevH > 0 && currH > 0) {
    const ratio = Math.abs(prevH - currH) / Math.max(prevH, currH);
    if (ratio > config.heightChangeThreshold) {
      reasons.push(`height change=${(ratio * 100).toFixed(0)}% (font size shift)`);
    }
  }

  if (LIST_MARKER_PATTERN.test(curr.text || "")) {
    reasons.push(`list marker detected: "${(curr.text || "").slice(0, 20).trim()}"`);
  }

  const prevCol = prev.columnHint ?? 0;
  const currCol = curr.columnHint ?? 0;
  if (prevCol !== currCol) {
    reasons.push(`column change: ${prevCol} → ${currCol}`);
  }

  return { isBreak: reasons.length > 0, reasons };
}

function validateMergedParagraph(node, allNodes) {
  const warnings = [];
  const text = node.text || "";

  if (text.length > 3000) {
    warnings.push({ type: "very-long", detail: `${text.length} chars — may have missed a break` });
  }

  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 2) {
    for (let i = 1; i < lines.length - 1; i++) {
      const words = lines[i].split(/\s+/);
      if (words.length > 3 && lines[i] === lines[i].toUpperCase() && /[A-Z]/.test(lines[i])) {
        warnings.push({ type: "embedded-heading", detail: `"${lines[i].slice(0, 60)}" looks like a heading` });
        break;
      }
    }
  }

  return warnings;
}

const DEFAULT_CONFIG = {
  breakGapMultiplier: 2.5,
  indentThreshold: 15,
  heightChangeThreshold: 0.3
};

export function optimisticMerge(semanticDocument, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const pageGroups = new Map();
  for (const node of semanticDocument.nodes) {
    const pg = node.pageNumber;
    const arr = pageGroups.get(pg) || [];
    arr.push(node);
    pageGroups.set(pg, arr);
  }

  const allMergedNodes = [];
  const pageReports = [];
  let totalGroupsCreated = 0;
  let totalLinesAbsorbed = 0;
  let totalBreaks = 0;

  for (const pageNumber of [...pageGroups.keys()].sort((a, b) => a - b)) {
    const pageNodes = pageGroups.get(pageNumber);
    const pNodes = pageNodes.filter((n) => n.role === "P");
    const nonPNodes = pageNodes.filter((n) => n.role !== "P");

    if (pNodes.length === 0) {
      allMergedNodes.push(...nonPNodes);
      pageReports.push({ pageNumber, linesIn: 0, groupsOut: 0, breaks: [], validationWarnings: [] });
      continue;
    }

    const sorted = [...pNodes].sort((a, b) => getRow(a) - getRow(b) || getLeft(a) - getLeft(b));

    const groups = [];
    let currentGroup = [sorted[0]];
    let groupLeftMargin = getLeft(sorted[0]);
    const breaks = [];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const signal = isBreakSignal(prev, curr, groupLeftMargin, cfg);

      if (signal.isBreak) {
        groups.push(currentGroup);
        breaks.push({
          between: [prev.id, curr.id],
          reasons: signal.reasons
        });
        currentGroup = [curr];
        groupLeftMargin = getLeft(curr);
        totalBreaks++;
      } else {
        currentGroup.push(curr);
        groupLeftMargin = Math.min(groupLeftMargin, getLeft(curr));
      }
    }
    groups.push(currentGroup);

    const validationWarnings = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      if (group.length === 1) {
        group[0].paragraphGroupId = `pg-${pageNumber}-${gi}`;
        allMergedNodes.push(group[0]);
        totalGroupsCreated++;
        continue;
      }

      const merged = {
        ...group[0],
        text: group.map((n) => n.text || "").join(" ").trim(),
        bbox: [
          Math.min(...group.map(getLeft)),
          Math.min(...group.map(getTop)),
          Math.max(...group.map((n) => getLeft(n) + getWidth(n))) - Math.min(...group.map(getLeft)),
          Math.max(...group.map(getBottom)) - Math.min(...group.map(getTop))
        ],
        _mergedFrom: group.map((n) => n.id),
        paragraphGroupId: `pg-${pageNumber}-${gi}`
      };

      const warnings = validateMergedParagraph(merged, semanticDocument.nodes);
      if (warnings.length > 0) {
        validationWarnings.push({ groupId: merged.paragraphGroupId, lines: group.length, warnings });
      }

      allMergedNodes.push(merged);
      totalGroupsCreated++;
      totalLinesAbsorbed += group.length - 1;
    }

    allMergedNodes.push(...nonPNodes);

    pageReports.push({
      pageNumber,
      linesIn: pNodes.length,
      groupsOut: groups.length,
      breaks,
      validationWarnings
    });
  }

  const totalLinesIn = semanticDocument.nodes.filter((n) => n.role === "P").length;
  const reductionPercent = totalLinesIn > 0
    ? ((totalLinesAbsorbed / totalLinesIn) * 100).toFixed(1)
    : "0.0";

  const output = { ...semanticDocument, nodes: allMergedNodes };

  const report = {
    strategy: "optimistic-merge",
    config: cfg,
    pages: pageReports,
    summary: {
      totalLinesIn: semanticDocument.nodes.length,
      totalParagraphLinesIn: totalLinesIn,
      totalNodesOut: allMergedNodes.length,
      totalGroupsCreated,
      totalLinesAbsorbed,
      totalBreaks,
      reductionPercent,
      validationWarningCount: pageReports.reduce((s, p) => s + p.validationWarnings.length, 0)
    }
  };

  return { document: output, report };
}
