export function requireNativeTextOperators(plan, semantic, tagging) {
  const ocrPages = new Set(), ocrSources = new Set();
  const walk = n => { for (const s of n?.ocrSegments || []) { ocrPages.add(s.pageNumber); ocrSources.add(`${s.pageNumber}:${s.sourceBlockId}`); } for (const c of n?.children || []) walk(c); };
  walk(tagging?.root);
  const intendedPages = new Set(semantic.nodes.filter(n =>
    !["Artifact", "Figure", "Form"].includes(n.role) && String(n.text || "").trim()).map(n => n.pageNumber));
  const pagePlans = new Map((plan.pages || []).map(p => [p.pageNumber, p]));
  const nativePages = new Set(semantic.nodes.filter(n => n.textProvenance !== "ocr" && n.text?.trim() && !["Artifact", "Figure", "Form"].includes(n.role)).map(n => n.pageNumber));
  const missing = [...intendedPages].filter(page => !(pagePlans.get(page)?.summary?.totalOperators > 0) && (nativePages.has(page) || !ocrPages.has(page)));
  if (missing.length) throw new Error(
    `Native text attachment unavailable on page(s) ${missing.join(", ")}: tagging intent contains text but the source has no text operators. A tagged OCR text layer is required; an empty structure tree is not a completed native tagging operation.`);
  for (const n of semantic.nodes) if (n.textProvenance === "ocr" && n.text?.trim() && !["Artifact", "Figure", "Form"].includes(n.role) &&
    (!n.ocrSegments?.length || n.ocrSegments.some(s => !ocrSources.has(`${n.pageNumber}:${s.sourceBlockId}`))))
    throw new Error(`OCR text requires a tagged OCR text layer with explicit line geometry: ${n.id}`);
}
