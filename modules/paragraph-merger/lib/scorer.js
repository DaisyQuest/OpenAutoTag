export function scoreMergeResult(original, merged, report) {
  const scores = {};

  scores.nodeReduction = original.nodes.length > 0
    ? (1 - merged.nodes.length / original.nodes.length)
    : 0;

  const mergedPNodes = merged.nodes.filter((n) => n.role === "P");
  let coherentCount = 0;
  for (const node of mergedPNodes) {
    const text = (node.text || "").trim();
    if (text.length < 10) continue;
    const endsClean = /[.!?;:)\]\u201D\u2019][\s]*$/.test(text);
    const startsClean = /^[A-Z\u00C0-\u00D6\d(\["\u201C\u2018]/.test(text);
    if (endsClean || startsClean) coherentCount++;
  }
  scores.paragraphCoherence = mergedPNodes.length > 0
    ? coherentCount / mergedPNodes.length
    : 1;

  // Detect multi-column layout: check if any page has nodes whose x-ranges
  // suggest two or more columns (significant horizontal gap between groups).
  const pageWidths = new Map();
  const pageCols = new Map();
  for (const node of original.nodes) {
    if (!node.bbox || node.bbox.length < 4) continue;
    const page = node.pageNumber ?? node.page ?? 0;
    const right = node.bbox[0] + node.bbox[2];
    const curMax = pageWidths.get(page) || 0;
    if (right > curMax) pageWidths.set(page, right);
  }
  // Simple heuristic: page is multi-column if >3 nodes exist whose x-centers
  // cluster into 2+ groups separated by >20% page width.
  for (const [page, pw] of pageWidths) {
    const centers = original.nodes
      .filter((n) => (n.pageNumber ?? n.page ?? 0) === page && n.bbox)
      .map((n) => n.bbox[0] + n.bbox[2] / 2)
      .sort((a, b) => a - b);
    let gapFound = false;
    for (let i = 1; i < centers.length; i++) {
      if (centers[i] - centers[i - 1] > pw * 0.2) { gapFound = true; break; }
    }
    pageCols.set(page, gapFound);
  }

  let overMergeSignals = 0;
  for (const node of mergedPNodes) {
    if (!node._mergedFrom || node._mergedFrom.length < 2) continue;
    const text = node.text || "";

    // Original checks
    if (/\n\s*\n/.test(text)) overMergeSignals++;
    const heights = new Set();
    for (const origId of node._mergedFrom) {
      const orig = original.nodes.find((n) => n.id === origId);
      if (orig?.bbox?.[3]) heights.add(Math.round(orig.bbox[3]));
    }
    if (heights.size > 2) overMergeSignals++;

    // NEW: unusually long paragraph (>800 chars) likely over-merged
    if (text.length > 800) overMergeSignals++;

    // NEW: crossed column boundary — merged bbox width > 90% page width in multi-column doc
    if (node.bbox && node.bbox.length >= 3) {
      const page = node.pageNumber ?? node.page ?? 0;
      const pw = pageWidths.get(page) || 0;
      if (pw > 0 && pageCols.get(page) && node.bbox[2] > pw * 0.9) {
        overMergeSignals++;
      }
    }

    // NEW: heading pattern mid-paragraph — ALL CAPS line (>3 words) appearing mid-text
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 2) {
      // Check inner lines (not first or last) for ALL CAPS heading pattern
      for (let li = 1; li < lines.length - 1; li++) {
        const line = lines[li];
        const words = line.split(/\s+/);
        if (words.length > 3 && line === line.toUpperCase() && /[A-Z]/.test(line)) {
          overMergeSignals++;
          break; // count at most once per node
        }
      }
    }
  }
  const mergedMultiLine = mergedPNodes.filter((n) => n._mergedFrom && n._mergedFrom.length > 1);
  scores.overMergeRate = mergedMultiLine.length > 0
    ? overMergeSignals / mergedMultiLine.length
    : 0;

  const origPNodes = original.nodes.filter((n) => n.role === "P");
  let underMergeSignals = 0;
  const sortedOrig = [...origPNodes].sort((a, b) =>
    (a.pageNumber - b.pageNumber) || ((a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0))
  );
  for (let i = 1; i < sortedOrig.length; i++) {
    const prev = sortedOrig[i - 1];
    const curr = sortedOrig[i];
    if (prev.pageNumber !== curr.pageNumber) continue;
    const gap = (curr.bbox?.[1] ?? 0) - ((prev.bbox?.[1] ?? 0) + (prev.bbox?.[3] ?? 0));
    const lineH = Math.max(prev.bbox?.[3] ?? 10, curr.bbox?.[3] ?? 10);
    const xShift = Math.abs((curr.bbox?.[0] ?? 0) - (prev.bbox?.[0] ?? 0));
    if (gap > 0 && gap < lineH * 2 && xShift < 15) {
      const prevInMerged = merged.nodes.find((n) => n.id === prev.id || n._mergedFrom?.includes(prev.id));
      const currInMerged = merged.nodes.find((n) => n.id === curr.id || n._mergedFrom?.includes(curr.id));
      if (prevInMerged && currInMerged && prevInMerged !== currInMerged) {
        underMergeSignals++;
      }
    }
  }
  const potentialMerges = report?.summary?.totalMerges + report?.summary?.totalSkips || 1;
  scores.underMergeRate = underMergeSignals / potentialMerges;

  scores.skipExplainability = 1;
  if (report?.summary?.totalSkips > 0) {
    let explained = 0;
    for (const page of report.pages || []) {
      for (const skip of page.skips || []) {
        if (skip.reasons && skip.reasons.length > 0 && skip.reasons[0] !== "all signals consistent") {
          explained++;
        }
      }
    }
    scores.skipExplainability = explained / report.summary.totalSkips;
  }

  scores.aggregate = (
    scores.nodeReduction * 0.15 +
    scores.paragraphCoherence * 0.25 +
    (1 - scores.overMergeRate) * 0.35 +
    (1 - scores.underMergeRate) * 0.15 +
    scores.skipExplainability * 0.10
  );

  return scores;
}
