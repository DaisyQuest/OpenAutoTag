import { createHash } from "node:crypto";

export function buildReviewPlan({ candidateHash, findings = [], validation, semantic, inspection } = {}) {
  candidateHash ??= null;
  const array = (v) => Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  const tasks = [], seen = new Set();
  const add = (code, target, evidence, action) => {
    const key = `${candidateHash}:${code}:${target}`;
    if (seen.has(key)) return; seen.add(key);
    tasks.push({ id: createHash("sha256").update(key).digest("hex").slice(0, 24), candidateHash,
      status: "open", code, target, evidence, action });
  };
  for (const f of array(findings)) add(String(f.code || "UNKNOWN_FINDING"), String(f.location || "document"), String(f.description || "No description supplied"), "Inspect the saved candidate and resolve or document this finding.");
  for (const f of array(validation?.findings)) {
    const contexts = array(f.checks).map((c) => c.context).filter((v) => typeof v === "string" && v);
    for (const context of contexts.length ? contexts : [f.fontKey || f.fontName || "document"]) {
      add(String(f.code || "UNKNOWN_FINDING"), String(context), String(f.description || f.message || f.code || "No description supplied"),
        /FONT|UNICODE|7_21/.test(f.code) ? "Verify the original font program, encoding and glyph mapping; compare rendering and extracted text before applying a resource change." : "Review this exact object and its semantic context; rerun validation after repair.");
    }
  }
  for (const task of array(semantic?.semanticReviewTasks)) add(String(task.code || "SEMANTIC_REVIEW"), String(task.widgetId || task.nodeId || "document"), JSON.stringify(task), "Resolve the ambiguous label or hierarchy using the page and authored metadata.");
  for (const issue of Array.isArray(inspection?.issues) ? inspection.issues : []) {
    if (typeof issue === "string") add("STRUCTURE_REVIEW", issue, issue, "Inspect the referenced structure object and its forward and reverse ownership relationships.");
  }
  add("READER_QUALIFICATION_REQUIRED", "document", "Automated checks cannot establish all reading and interaction behavior.", "Record reader/version, heading/list/table navigation, label announcements, tab order and fill/save/reopen results for this candidate hash.");
  const fontPlan = array(validation?.fonts).map((font) => ({ fontKey: String(font.fontKey || "unknown"), name: String(font.name || "unknown"),
    decision: font.embedded && font.hasToUnicode && font.toUnicodeCoverage === 1 ? "preserve" : "review",
    locations: font.locations || [], evidence: { embedded: font.embedded, hasToUnicode: font.hasToUnicode, coverage: font.toUnicodeCoverage },
    requiredProof: ["exact font program and permitted embedding", "code-to-glyph-to-Unicode mapping", "unchanged rendering", "new form values render correctly"] }));
  return { reviewTasks: tasks, fontRepairPlan: fontPlan };
}
