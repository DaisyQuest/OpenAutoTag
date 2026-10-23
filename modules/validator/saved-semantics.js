// Compare identities, never match unrelated content by similar text.
import { canonicalText, inspectSourceOwnership, savedTextIndex, textWithAuthoredReplacements, authoredReplacementIndex, exactOverprintText } from "./source-ownership.js";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function emittedIdentifier(node) {
  if (node.type === "TH" && node.headerId) return node.headerId;
  if (node.type === "Aside") return `note-${node.id.replace(/[^A-Za-z0-9_.-]+/g, "-") || "unknown"}`;
  return `oat:${node.id}`;
}
export function compareSavedSemantics({ inspection, tagging, reference, sourceInspection, sourceOwnership }) {
  if (!inspection?.sourceHash || !Array.isArray(inspection.structure)) throw new Error("Saved semantic inspection is required");
  if (Boolean(tagging) === Boolean(reference)) throw new Error("Supply tagging intent or a reference inspection, exclusively");
  const checks = [], add = (code, target, expected, actual) => checks.push({ code, target, status: equal(expected, actual) ? "pass" : "fail", expected: expected ?? null, actual: actual ?? null });
  let ownershipStatus = "not_provided";
  add("SAVED_CONTENT_INSPECTED", "document", true, Array.isArray(inspection.markedContent));
  const content = new Map();
  for (const item of inspection.markedContent || []) {
    if (content.has(item.contentRef)) add("DUPLICATE_CONTENT_EVIDENCE", item.contentRef, false, true);
    content.set(item.contentRef, item);
  }
  const byRef = new Map(inspection.structure.map(n => [n.objectRef, n]));
  const textIndex = savedTextIndex(inspection);
  if (Array.isArray(inspection.textRuns)) for (const run of inspection.textRuns) if (run.glyphs.length && run.owners.length > 1)
    add("EXCLUSIVE_PAINT_OWNER", `page:${run.pageNumber}:glyphs:${run.glyphStart}-${run.glyphEnd}`, 1, run.owners.length);
  const identifiers = new Map();
  for (const n of inspection.structure) if (n.identifier) {
    if (identifiers.has(n.identifier)) add("DUPLICATE_IDENTIFIER", n.identifier, false, true);
    identifiers.set(n.identifier, n);
  }
  for (const issue of inspection.issues || []) add("STRUCTURE_INTEGRITY", issue, false, true);
  for (const node of inspection.structure) for (const ref of node.contentRefs) if (!ref.startsWith("obj:"))
    add("SAVED_SEQUENCE_EXISTS", `${node.objectRef}:${ref}`, 1, content.get(ref)?.sequenceCount || 0);
  if (reference) {
    if (!Array.isArray(reference.structure) || !reference.sourceHash) throw new Error("Reference semantic inspection is required");
    // This mode is for preserved-object changes; a rewrite needs emitted IDs.
    add("STRUCTURE_MEMBERSHIP", "document", reference.structure.map(n => n.objectRef).sort(), [...byRef.keys()].sort());
    for (const n of reference.structure) {
      const saved = byRef.get(n.objectRef);
      for (const key of ["role", "parentRef", "children", "contentRefs", "headers", "scope", "rowSpan", "columnSpan", "listNumbering", "actualText", "actualTextPresent", "alt"])
        add(`SAVED_${key.toUpperCase()}`, n.objectRef, n[key], saved?.[key]);
    }
    add("CONTENT_ORDER", "document", reference.contentOrder, inspection.contentOrder);
    add("REFERENCE_CONTENT_INSPECTED", "document", true, Array.isArray(reference.markedContent));
    for (const item of reference.markedContent || []) add("SAVED_CONTENT_EVIDENCE", item.contentRef, item, content.get(item.contentRef));
    add("SAVED_TEXT_RUNS", "document", reference.textRuns, inspection.textRuns);
  } else {
    const nodes = [], expectedIds = new Set();
    const walk = (n, parent, depth) => {
      if (depth > 128 || nodes.length >= 100000) throw new Error("Intent traversal limit exceeded");
      const id = emittedIdentifier(n);
      if (expectedIds.has(id)) throw new Error(`Duplicate intended structure ID: ${id}`);
      expectedIds.add(id); nodes.push({ n, parent, id });
      for (const child of n.children || []) walk(child, id, depth + 1);
    };
    walk(tagging.root, null, 0);
    const ownership = inspectSourceOwnership({ inspection, source: sourceInspection, ownership: sourceOwnership, intendedNodes: nodes, add });
    if (sourceOwnership) ownershipStatus = ownership.sourceVerified ? "verified" : "rejected";
    const replacements = authoredReplacementIndex(sourceInspection, inspection, ownership.sourceVerified, add, expectedIds);
    for (const { n, parent, id } of nodes) {
      const saved = identifiers.get(id);
      add("EMITTED_NODE", id, true, Boolean(saved));
      if (!saved) continue;
      const role = ({ Aside: "Note" })[n.type] || n.type;
      add("SAVED_ROLE", id, role, saved.role);
      if (parent) add("SAVED_PARENT", id, parent, byRef.get(saved.parentRef)?.identifier);
      add("CHILD_ORDER", id, (n.children || []).map(emittedIdentifier), saved.children.map(ref => byRef.get(ref)?.identifier).filter(v => expectedIds.has(v)));
      if (["TH", "TD"].includes(n.type)) {
        add("TABLE_HEADERS", id, [...(n.tableAttrs?.Headers || [])].sort(), [...saved.headers].sort());
        if (n.scope || n.tableAttrs?.Scope) add("TABLE_SCOPE", id, n.scope || n.tableAttrs.Scope, saved.scope);
        add("ROW_SPAN", id, n.rowSpan || 1, saved.rowSpan);
        add("COLUMN_SPAN", id, n.columnSpan || 1, saved.columnSpan);
      }
      if (n.listNumbering) add("LIST_NUMBERING", id, n.listNumbering, saved.listNumbering);
      // Unexpected replacement/alternate text can override valid child semantics.
      // Check absence too, rather than only verifying properties requested by intent.
      add("ACTUAL_TEXT", id, n.actualText || "", saved.actualText || "");
      // An empty replacement suppresses otherwise valid text; absence is different.
      if (saved.actualTextPresent && !saved.actualText) add("EMPTY_ACTUAL_TEXT", id, false, true);
      add("ALTERNATE_TEXT", id, n.alt || "", saved.alt || "");
      if ((n.sourceNodeIds?.length || n.type === "Lbl") && (n.actualText || n.label || "").trim()) {
        const seen = new Set();
        const graphical = ["Figure", "Formula", "Form"].includes(n.type);
        const hasContent = (element) => {
          if (!element || seen.has(element.objectRef)) return false;
          seen.add(element.objectRef);
          return element.contentRefs.some(ref => {
            if (ref.startsWith("obj:")) return graphical;
            const evidence = content.get(ref);
            return evidence?.sequenceCount === 1 && (evidence.meaningfulGlyphCount > 0 || graphical && evidence.graphicsCount > 0);
          }) || element.children.some(ref => hasContent(byRef.get(ref)));
        };
        add("CONTENT_ATTACHED", id, true, hasContent(saved));
        if (!graphical) {
          add("SAVED_TEXT_INSPECTED", id, true, Array.isArray(inspection.textRuns));
          const runs = textIndex.collect(saved), expected = canonicalText(n.actualText || n.label);
          let raw = textWithAuthoredReplacements(runs, replacements, n.actualText || n.label);
          if (canonicalText(raw) !== expected && ownership.sourceVerified && n.actualText && n.actualText === saved.actualText) {
            const overprint = exactOverprintText(runs);
            if (overprint && canonicalText(overprint.text) === expected) {
              add("OVERPRINT_REPLACEMENT_PROVEN", id, true, true); raw = overprint.text;
            }
          }
          add("CONTENT_TEXT_COMPLETE", id, canonicalText(n.actualText || n.label), canonicalText(raw));
        }
      }
    }
  }
  const failed = checks.filter(c => c.status === "fail").length;
  return { schemaVersion: "1.0.0", candidateHash: inspection.sourceHash, referenceHash: reference?.sourceHash || null,
    ownershipStatus,
    scope: reference ? "preserved-structure" : "emitted-tagging-intent", disposition: failed ? "rejected" : "automated_pass",
    summary: { passed: checks.length - failed, failed }, checks,
    limitations: ["Checks saved structure against intent; intent still requires independent semantic review.", "Source occurrence ownership is qualified only when ownershipStatus is verified and the report carries source and ownership hashes.", "Text comparison normalizes Unicode compatibility forms and whitespace; layout, clipping, visibility, word-boundary interpretation and reader behavior require separate verification."] };
}
