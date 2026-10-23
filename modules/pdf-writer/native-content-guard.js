export function requireNativeTextOperators(plan, semantic) {
  const intendedPages = new Set(semantic.nodes.filter(n =>
    !["Artifact", "Figure", "Form"].includes(n.role) && String(n.text || "").trim()).map(n => n.pageNumber));
  const pagePlans = new Map((plan.pages || []).map(p => [p.pageNumber, p]));
  const missing = [...intendedPages].filter(page => !(pagePlans.get(page)?.summary?.totalOperators > 0));
  if (missing.length) throw new Error(
    `Native text attachment unavailable on page(s) ${missing.join(", ")}: tagging intent contains text but the source has no text operators. A tagged OCR text layer is required; an empty structure tree is not a completed native tagging operation.`);
}
