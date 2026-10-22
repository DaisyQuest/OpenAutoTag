// Compare identities, never match unrelated content by similar text.
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function emittedIdentifier(node) {
  if (node.type === "TH" && node.headerId) return node.headerId;
  if (node.type === "Aside") return `note-${node.id.replace(/[^A-Za-z0-9_.-]+/g, "-") || "unknown"}`;
  return `oat:${node.id}`;
}
export function compareSavedSemantics({ inspection, tagging, reference }) {
  if (!inspection?.sourceHash || !Array.isArray(inspection.structure)) throw new Error("Saved semantic inspection is required");
  if (Boolean(tagging) === Boolean(reference)) throw new Error("Supply tagging intent or a reference inspection, exclusively");
  const checks = [], add = (code, target, expected, actual) => checks.push({ code, target, status: equal(expected, actual) ? "pass" : "fail", expected: expected ?? null, actual: actual ?? null });
  const byRef = new Map(inspection.structure.map(n => [n.objectRef, n]));
  const identifiers = new Map();
  for (const n of inspection.structure) if (n.identifier) {
    if (identifiers.has(n.identifier)) add("DUPLICATE_IDENTIFIER", n.identifier, false, true);
    identifiers.set(n.identifier, n);
  }
  for (const issue of inspection.issues || []) add("STRUCTURE_INTEGRITY", issue, false, true);
  if (reference) {
    if (!Array.isArray(reference.structure) || !reference.sourceHash) throw new Error("Reference semantic inspection is required");
    // This mode is for preserved-object changes; a rewrite needs emitted IDs.
    add("STRUCTURE_MEMBERSHIP", "document", reference.structure.map(n => n.objectRef).sort(), [...byRef.keys()].sort());
    for (const n of reference.structure) {
      const saved = byRef.get(n.objectRef);
      for (const key of ["role", "parentRef", "children", "contentRefs", "headers", "scope", "rowSpan", "columnSpan", "listNumbering", "actualText", "alt"])
        add(`SAVED_${key.toUpperCase()}`, n.objectRef, n[key], saved?.[key]);
    }
    add("CONTENT_ORDER", "document", reference.contentOrder, inspection.contentOrder);
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
      add("ALTERNATE_TEXT", id, n.alt || "", saved.alt || "");
      if ((n.sourceNodeIds?.length || n.type === "Lbl") && (n.actualText || n.label || "").trim()) {
        const seen = new Set();
        const hasContent = (element) => {
          if (!element || seen.has(element.objectRef)) return false;
          seen.add(element.objectRef);
          return element.contentRefs.length > 0 || element.children.some(ref => hasContent(byRef.get(ref)));
        };
        add("CONTENT_ATTACHED", id, true, hasContent(saved));
      }
    }
  }
  const failed = checks.filter(c => c.status === "fail").length;
  return { schemaVersion: "1.0.0", candidateHash: inspection.sourceHash, referenceHash: reference?.sourceHash || null,
    scope: reference ? "preserved-structure" : "emitted-tagging-intent", disposition: failed ? "rejected" : "automated_pass",
    summary: { passed: checks.length - failed, failed }, checks,
    limitations: ["Checks saved structure against intent; intent still requires independent semantic review.", "Content references do not establish rendered visibility or observed screen-reader behavior."] };
}
