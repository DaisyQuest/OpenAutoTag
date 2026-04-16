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

  let overMergeSignals = 0;
  for (const node of mergedPNodes) {
    if (!node._mergedFrom || node._mergedFrom.length < 2) continue;
    const text = node.text || "";
    if (/\n\s*\n/.test(text)) overMergeSignals++;
    const heights = new Set();
    for (const origId of node._mergedFrom) {
      const orig = original.nodes.find((n) => n.id === origId);
      if (orig?.bbox?.[3]) heights.add(Math.round(orig.bbox[3]));
    }
    if (heights.size > 2) overMergeSignals++;
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
    scores.nodeReduction * 0.2 +
    scores.paragraphCoherence * 0.3 +
    (1 - scores.overMergeRate) * 0.25 +
    (1 - scores.underMergeRate) * 0.15 +
    scores.skipExplainability * 0.1
  );

  return scores;
}
