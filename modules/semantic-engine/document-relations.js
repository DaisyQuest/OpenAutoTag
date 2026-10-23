import { refineContinuations, contextOrderRelations } from "./semantic-quality.js";
import { numberedSectionLevel } from "./numbered-headings.js";
import { contextualFormLabel, compoundDateContexts } from "./form-context.js";
const labelKey = (value) => String(value || "").normalize("NFKC").replace(/^\s*[☐☑☒]\s*/, "")
  .replace(/\s*\(\s*explain\b[^)]*\)\s*[.:]?\s*$/i, "").replace(/[\s_.:]+$/, "").replace(/\)$/, "").replace(/\s+/g, " ").trim().toLowerCase();
// Conservative, evidence-carrying relationships; uncertain associations stay reviewable.
export function enrichDocumentRelations(nodes, pages) {
  const relations = [], reviewTasks = [], fields = new Map();
  const add = (type, from, to, evidence) => relations.push({ type, from, to, evidence });
  const ordered = [...nodes].sort((a, b) => a.pageNumber - b.pageNumber || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.id.localeCompare(b.id));
  const headingStyles = new Map();
  for (const node of ordered.filter((n) => /^H[1-6]$/.test(n.role))) {
    const numbered = numberedSectionLevel(node.text);
    if (numbered) {
      const level = numbered;
      node.role = `H${level}`; node.headingLevel = level;
      node.headingEvidence = "explicit-section-number-depth";
    }
    const key = `${node.fontName || ""}:${Math.round((node.fontSize || 0) * 2)}`;
    const prior = headingStyles.get(key);
    if (node.fontName && node.fontSize && prior && prior.role !== node.role && !numbered) {
      reviewTasks.push({ code: "HEADING_STYLE_LEVEL_CONFLICT", pageNumber: node.pageNumber, nodeId: node.id, relatedNodeId: prior.id });
    } else headingStyles.set(key, node);
  }
  for (const page of pages) {
    const pageNodes = nodes.filter(n => n.pageNumber === page.pageNumber);
    const dateContexts = compoundDateContexts(pageNodes, page.formFields || []);
    for (const widget of page.formFields || []) {
      const id = widget.fieldId || widget.fieldName || widget.id;
      if (!fields.has(id)) fields.set(id, { id, fieldType: widget.fieldType, widgets: [], labels: [] });
      const field = fields.get(id);
      field.widgets.push({ ...widget, pageNumber: page.pageNumber });
      const candidates = nodes.filter((n) => n.pageNumber === page.pageNumber && n.formFieldIds?.includes(widget.id) && n.role !== "Artifact" && !n.tableId);
      const tooltip = labelKey(widget.tooltip);
      const caption = widget.pushButton && widget.authoredCaptionSource === "widget-MK-CA" ? labelKey(widget.authoredCaption) : "";
      const authoredName = tooltip || caption;
      const nameSource = tooltip ? "authored-tooltip" : caption ? "authored-button-caption" : "unresolved";
      const pool = authoredName && Array.isArray(widget.bbox) ? nodes.filter((n) => n.pageNumber === page.pageNumber && n.role !== "Artifact" && !n.tableId &&
        n.bbox[1] + n.bbox[3] >= widget.bbox[1] - 48 && n.bbox[1] <= widget.bbox[1] + widget.bbox[3] + 12 &&
        Math.max(widget.bbox[0] - n.bbox[0] - n.bbox[2], n.bbox[0] - widget.bbox[0] - widget.bbox[2], 0) <= Math.max(48, (n.fontSize || 12) * 4)) : candidates;
      const exact = authoredName ? pool.filter((n) => labelKey(n.text) === authoredName) : [];
      let chosen = exact.length === 1 ? [exact[0]] : !authoredName && candidates.length === 1 ? [candidates[0]] : null;
      // A short colon-terminated label directly above one widget is an explicit prompt.
      // Do not borrow a section heading or a prompt shared by several widgets.
      if (!chosen && !authoredName && widget.bbox && candidates.length === 0) {
        const above = nodes.filter(n => n.pageNumber === page.pageNumber && n.role !== "Artifact" && !n.tableId &&
          n.text.trim().length <= 40 && /:\s*$/.test(n.text) && Math.abs(n.bbox[0] - widget.bbox[0]) <= 3 &&
          n.bbox[1] + n.bbox[3] <= widget.bbox[1] && widget.bbox[1] - n.bbox[1] - n.bbox[3] <= 18 &&
          !(page.formFields || []).some(w => w.id !== widget.id && w.bbox && Math.abs(w.bbox[0] - n.bbox[0]) <= 3 &&
            w.bbox[1] >= n.bbox[1] + n.bbox[3] && w.bbox[1] - n.bbox[1] - n.bbox[3] <= 18));
        if (above.length === 1) chosen = above;
      }
      // An authored name can match a wrapped label, but fragments must be adjacent and in the same column.
      if (!chosen && authoredName && pool.length <= 12) {
        const matches = [], sorted = [...pool].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
        for (let start = 0; start < sorted.length; start++) for (let size = 2; size <= 4 && start + size <= sorted.length; size++) {
          const group = sorted.slice(start, start + size);
          const adjacent = group.slice(1).every((n, i) => (n.columnHint ?? 0) === (group[i].columnHint ?? 0) &&
            (Math.abs(n.bbox[0] - group[i].bbox[0]) <= 3 ||
              (i === 0 && widget.checkBox && n.bbox[0] > group[i].bbox[0] && n.bbox[0] - group[i].bbox[0] <= 24)) && n.bbox[1] >= group[i].bbox[1] &&
            n.bbox[1] - group[i].bbox[1] - group[i].bbox[3] <= Math.max(6, group[i].fontSize || group[i].bbox[3]));
          if (adjacent && labelKey(group.map((n) => n.text.trim()).join(" ")) === authoredName) matches.push(group);
        }
        if (matches.length === 1) chosen = matches[0];
      }
      const dateContext = dateContexts.get(widget.id);
      const contextual = !chosen && !dateContext ? contextualFormLabel(widget, pageNodes, page.formFields || []) : null;
      if (contextual) chosen = contextual.labels;
      const saved = field.widgets.at(-1);
      if (widget.pushButton && widget.appearanceText?.trim() && widget.appearanceTextSource === "normal-widget-appearance") {
        saved.labelStatus = "associated-appearance";
        saved.accessibleNameSource = authoredName ? nameSource : "widget-appearance-proposal";
        saved.labelAssociation = { kind: "widget-appearance", evidence: "decoded-text-owned-by-widget-normal-appearance" };
        if (!authoredName) reviewTasks.push({ code: "FORM_ACCESSIBLE_NAME_REVIEW", pageNumber: page.pageNumber, widgetId: widget.id });
        // Stale /CA metadata must not silently certify a different painted caption.
        const captionKey = value => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
        if (caption && captionKey(widget.authoredCaption) !== captionKey(widget.appearanceText))
          reviewTasks.push({ code: "FORM_BUTTON_CAPTION_MISMATCH", pageNumber: page.pageNumber, widgetId: widget.id });
      } else if (chosen) {
        field.widgets.at(-1).labelStatus = "associated";
        field.widgets.at(-1).labelNodeIds = chosen.map((n) => n.id);
        field.widgets.at(-1).accessibleNameSource = authoredName ? nameSource : "unique-associated-label";
        if (contextual) saved.labelAssociation = contextual.association;
        for (const label of chosen) {
          // A section heading retains its section role even when it also labels a field.
          if (contextual?.association.kind !== "section-prompt") label.formFieldIds = [...new Set([...(label.formFieldIds || []), widget.id])];
          if (!field.labels.includes(label.id)) field.labels.push(label.id);
          add("labels", label.id, `widget:${widget.id}`, contextual?.association.evidence || (chosen.length > 1 ? `${tooltip ? "authored-tooltip" : "authored-button-caption"}-and-adjacent-label-fragments` : exact.length ? `${tooltip ? "authored-tooltip" : "authored-button-caption"}-and-proximity` : "unique-proximity-candidate"));
        }
        const instructions = contextual?.instructions || candidates.filter((n) => !chosen.includes(n) && /\b(required|select|enter|check|provide|choose)\b/i.test(n.text));
        field.widgets.at(-1).instructionNodeIds = instructions.map((n) => n.id);
        for (const instruction of instructions)
          add("describes", instruction.id, `widget:${widget.id}`, "field-associated-instruction");
      } else if (dateContext) {
        saved.labelStatus = "associated-context";
        saved.accessibleNameSource = "authored-tooltip";
        saved.contextNodeIds = dateContext.context.map(n => n.id);
        saved.labelAssociation = dateContext.association;
        for (const context of dateContext.context) add("describes", context.id, `widget:${widget.id}`, dateContext.association.evidence);
      } else {
        saved.labelStatus = authoredName ? "authored-name-visual-association-unresolved" : "accessible-name-review-required";
        saved.accessibleNameSource = nameSource;
        saved.contextNodeIds = pool.map(n => n.id);
        reviewTasks.push({ code: "FORM_LABEL_AMBIGUOUS", pageNumber: page.pageNumber, widgetId: widget.id, candidates: pool.map((n) => n.id) });
      }
      add("belongsToGroup", `widget:${widget.id}`, `field:${id}`, "authored-field-identity");
    }
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
    formNavigation: { proposedWidgetOrder: widgets.map((w) => w.id), unresolvedWidgetIds: widgets.filter((w) => !["associated", "associated-appearance", "associated-context"].includes(w.labelStatus)).map((w) => w.id),
      status: "requires-reader-test" } };
}
