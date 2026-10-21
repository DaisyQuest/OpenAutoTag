import { refineContinuations, contextOrderRelations } from "./semantic-quality.js";
const labelKey = (value) => String(value || "").normalize("NFKC").replace(/^\s*[☐☑☒]\s*/, "")
  .replace(/\s*\(\s*explain\b[^)]*\)\s*[.:]?\s*$/i, "").replace(/[\s_.:]+$/, "").replace(/\)$/, "").replace(/\s+/g, " ").trim().toLowerCase();
// Conservative, evidence-carrying relationships; uncertain associations stay reviewable.
export function enrichDocumentRelations(nodes, pages) {
  const relations = [], reviewTasks = [], fields = new Map();
  const add = (type, from, to, evidence) => relations.push({ type, from, to, evidence });
  const ordered = [...nodes].sort((a, b) => a.pageNumber - b.pageNumber || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.id.localeCompare(b.id));
  const headingStyles = new Map();
  for (const node of ordered.filter((n) => /^H[1-6]$/.test(n.role))) {
    const numbered = /^\s*(\d+(?:\.\d+){1,5})[.)]?\s+\S/.exec(node.text || "");
    if (numbered) {
      const level = numbered[1].split(".").length;
      node.role = `H${level}`; node.headingLevel = level;
      node.headingEvidence = "explicit-section-number-depth";
    }
    const key = `${node.fontName || ""}:${Math.round((node.fontSize || 0) * 2)}`;
    const prior = headingStyles.get(key);
    if (node.fontName && node.fontSize && prior && prior.role !== node.role && !numbered) {
      reviewTasks.push({ code: "HEADING_STYLE_LEVEL_CONFLICT", pageNumber: node.pageNumber, nodeId: node.id, relatedNodeId: prior.id });
    } else headingStyles.set(key, node);
  }
  for (const page of pages) for (const widget of page.formFields || []) {
    const id = widget.fieldId || widget.fieldName || widget.id;
    if (!fields.has(id)) fields.set(id, { id, fieldType: widget.fieldType, widgets: [], labels: [] });
    const field = fields.get(id);
    field.widgets.push({ ...widget, pageNumber: page.pageNumber });
    const candidates = nodes.filter((n) => n.pageNumber === page.pageNumber && n.formFieldIds?.includes(widget.id) && n.role !== "Artifact" && !n.tableId);
    const tooltip = labelKey(widget.tooltip);
    const pool = tooltip && Array.isArray(widget.bbox) ? nodes.filter((n) => n.pageNumber === page.pageNumber && n.role !== "Artifact" && !n.tableId &&
      n.bbox[1] + n.bbox[3] >= widget.bbox[1] - 48 && n.bbox[1] <= widget.bbox[1] + widget.bbox[3] + 12 &&
      Math.max(widget.bbox[0] - n.bbox[0] - n.bbox[2], n.bbox[0] - widget.bbox[0] - widget.bbox[2], 0) <= Math.max(48, (n.fontSize || 12) * 4)) : candidates;
    const exact = tooltip ? pool.filter((n) => labelKey(n.text) === tooltip) : [];
    let chosen = exact.length === 1 ? [exact[0]] : !tooltip && candidates.length === 1 ? [candidates[0]] : null;
    // A short colon-terminated label directly above one widget is an explicit prompt.
    // Do not borrow a section heading or a prompt shared by several widgets.
    if (!chosen && !tooltip && widget.bbox && candidates.length === 0) {
      const above = nodes.filter(n => n.pageNumber === page.pageNumber && n.role !== "Artifact" && !n.tableId &&
        n.text.trim().length <= 40 && /:\s*$/.test(n.text) && Math.abs(n.bbox[0] - widget.bbox[0]) <= 3 &&
        n.bbox[1] + n.bbox[3] <= widget.bbox[1] && widget.bbox[1] - n.bbox[1] - n.bbox[3] <= 18 &&
        !(page.formFields || []).some(w => w.id !== widget.id && w.bbox && Math.abs(w.bbox[0] - n.bbox[0]) <= 3 &&
          w.bbox[1] >= n.bbox[1] + n.bbox[3] && w.bbox[1] - n.bbox[1] - n.bbox[3] <= 18));
      if (above.length === 1) chosen = above;
    }
    // A tooltip can match a wrapped label, but each fragment must be adjacent and in the same column.
    if (!chosen && tooltip && pool.length <= 12) {
      const matches = [], sorted = [...pool].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
      for (let start = 0; start < sorted.length; start++) for (let size = 2; size <= 4 && start + size <= sorted.length; size++) {
        const group = sorted.slice(start, start + size);
        const adjacent = group.slice(1).every((n, i) => (n.columnHint ?? 0) === (group[i].columnHint ?? 0) &&
          (Math.abs(n.bbox[0] - group[i].bbox[0]) <= 3 ||
            (i === 0 && widget.checkBox && n.bbox[0] > group[i].bbox[0] && n.bbox[0] - group[i].bbox[0] <= 24)) && n.bbox[1] >= group[i].bbox[1] &&
          n.bbox[1] - group[i].bbox[1] - group[i].bbox[3] <= Math.max(6, group[i].fontSize || group[i].bbox[3]));
        if (adjacent && labelKey(group.map((n) => n.text.trim()).join(" ")) === tooltip) matches.push(group);
      }
      if (matches.length === 1) chosen = matches[0];
    }
    if (chosen) {
      field.widgets.at(-1).labelStatus = "associated";
      field.widgets.at(-1).labelNodeIds = chosen.map((n) => n.id);
      field.widgets.at(-1).accessibleNameSource = exact.length || chosen.length > 1 ? "authored-tooltip" : "unique-associated-label";
      for (const label of chosen) {
        label.formFieldIds = [...new Set([...(label.formFieldIds || []), widget.id])];
        if (!field.labels.includes(label.id)) field.labels.push(label.id);
        add("labels", label.id, `widget:${widget.id}`, chosen.length > 1 ? "authored-tooltip-and-adjacent-label-fragments" : exact.length ? "authored-tooltip-and-proximity" : "unique-proximity-candidate");
      }
      const instructions = candidates.filter((n) => !chosen.includes(n) && /\b(required|select|enter|check|provide|choose)\b/i.test(n.text));
      field.widgets.at(-1).instructionNodeIds = instructions.map((n) => n.id);
      for (const instruction of instructions)
        add("describes", instruction.id, `widget:${widget.id}`, "field-associated-instruction");
    } else {
      const saved = field.widgets.at(-1);
      saved.labelStatus = tooltip ? "authored-name-visual-association-unresolved" : "accessible-name-review-required";
      saved.accessibleNameSource = tooltip ? "authored-tooltip" : "unresolved";
      saved.contextNodeIds = pool.map(n => n.id);
      reviewTasks.push({ code: "FORM_LABEL_AMBIGUOUS", pageNumber: page.pageNumber, widgetId: widget.id, candidates: pool.map((n) => n.id) });
    }
    add("belongsToGroup", `widget:${widget.id}`, `field:${id}`, "authored-field-identity");
  }
  relations.push(...refineContinuations(nodes, pages), ...contextOrderRelations(nodes));
  for (const n of nodes) for (const key of ["captionForId", "footnoteReferenceId", "asideAnchorId"])
    if (n[key] && !nodes.some((p) => p.id === n[key])) reviewTasks.push({ code: "READING_ANCHOR_UNRESOLVED", pageNumber: n.pageNumber, nodeId: n.id });
  let previous = null;
  for (const node of ordered) {
    if (node.role === "Artifact") continue;
    if (previous?.role.match(/^H[1-6]$/) && previous.pageNumber === node.pageNumber && previous.columnHint === node.columnHint) {
      add("precedes", previous.id, node.id, "heading-before-following-section-content");
    }
    previous = node;
  }
  const widgets = [...fields.values()].flatMap((f) => f.widgets);
  widgets.sort((a, b) => a.pageNumber - b.pageNumber || (a.bbox?.[1] || 0) - (b.bbox?.[1] || 0) || (a.bbox?.[0] || 0) - (b.bbox?.[0] || 0) || a.id.localeCompare(b.id));
  return { relations, formRelationships: [...fields.values()], semanticReviewTasks: reviewTasks,
    formNavigation: { proposedWidgetOrder: widgets.map((w) => w.id), unresolvedWidgetIds: widgets.filter((w) => !w.labelNodeIds?.length).map((w) => w.id),
      status: "requires-reader-test" } };
}
