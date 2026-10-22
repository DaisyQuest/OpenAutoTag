const right = n => n.bbox[0] + n.bbox[2];
const bottom = n => n.bbox[1] + n.bbox[3];
const center = n => n.bbox[1] + n.bbox[3] / 2;
const usable = n => n.role !== "Artifact" && !n.tableId && n.bbox && !n.textRotation;
const words = text => String(text || "").normalize("NFKC").toLowerCase().match(/[a-z]+|\d+/g) || [];
const filler = new Set("a an the of in on to for and or is are be your you this that it if may also below select choose enter type please required format day month year yyyy date".split(" "));
const contentWords = text => [...new Set(words(text).filter(w => !filler.has(w)))];
const overlapX = (a, b) => Math.min(right(a), right(b)) > Math.max(a.bbox[0], b.bbox[0]);
const inlineLeft = (label, widget) => Math.abs(center(label) - center(widget)) <= 3 &&
  right(label) <= widget.bbox[0] + 1 && widget.bbox[0] - right(label) <= 18;

// Compound dates share sentence context, not a fabricated label for every part.
// Require three adjacent, separately named components and common authored context.
export function compoundDateContexts(nodes, widgets) {
  const result = new Map();
  const component = w => /\b(?:select|choose|enter|type)\s+(?:the\s+)?(day|month|year)\b/i.exec(w.tooltip || "")?.[1].toLowerCase();
  for (const day of widgets.filter(w => w.bbox && component(w) === "day")) {
    const row = widgets.filter(w => w.bbox && Math.abs(center(w) - center(day)) <= 3 &&
      Math.abs(w.bbox[0] - day.bbox[0]) <= 260);
    const parts = ["day", "month", "year"].map(c => row.filter(w => component(w) === c));
    if (parts.some(part => part.length !== 1)) continue;
    const group = parts.flat().sort((a, b) => a.bbox[0] - b.bbox[0]);
    if (group.some(w => !["Tx", "Ch"].includes(w.fieldType) || w.multiLine) ||
      group.slice(1).some((w, i) => w.bbox[0] < right(group[i]) - 1 || w.bbox[0] - right(group[i]) > 48)) continue;
    if (row.some(w => !group.includes(w) && w.bbox[0] < right(group.at(-1)) && right(w) > group[0].bbox[0])) continue;
    const common = contentWords(group[0].tooltip).filter(word => word.length >= 4 && group.every(w => contentWords(w.tooltip).includes(word)));
    if (!common.length) continue;
    const lead = nodes.filter(n => usable(n) && /[a-z]/i.test(n.text) && inlineLeft(n, group[0]));
    if (lead.length !== 1) continue;
    const context = nodes.filter(n => usable(n) && Math.abs(center(n) - center(day)) <= 3 &&
      n.bbox[0] >= lead[0].bbox[0] && right(n) <= right(group.at(-1)) &&
      !group.some(w => Math.min(right(w), right(n)) - Math.max(w.bbox[0], n.bbox[0]) > 1));
    if (!context.includes(lead[0]) || context.length < 2) continue;
    // Each gap must carry printed sentence context/separators, not just whitespace.
    if (group.slice(1).some((w, i) => !context.some(n => n.bbox[0] >= right(group[i]) - 1 && right(n) <= w.bbox[0] + 1))) continue;
    for (const w of group) result.set(w.id, {
      context, association: { kind: "compound-date", evidence: "authored-date-components-and-shared-inline-prompt",
        component: component(w), groupWidgetIds: group.map(w => w.id) }
    });
  }
  return result;
}

export function contextualFormLabel(widget, nodes, widgets) {
  if (!widget.bbox || !widget.tooltip?.trim() || widget.pushButton || widget.checkBox || widget.radioButton) return null;
  const tooltipWords = contentWords(widget.tooltip);
  const prompts = nodes.filter(n => usable(n) && n.text.length <= 48 && words(n.text).length <= 6 &&
    contentWords(n.text).length && contentWords(n.text).every(w => tooltipWords.includes(w)) && inlineLeft(n, widget) &&
    widgets.filter(w => w.bbox && inlineLeft(n, w)).length === 1);
  if (prompts.length === 1) return { labels: prompts, instructions: [],
    association: { kind: "expanded-tooltip", evidence: "unique-inline-prompt-contained-in-authored-tooltip" } };

  if (widget.fieldType !== "Tx" || !widget.multiLine || tooltipWords.length < 4) return null;
  const headings = nodes.filter(n => usable(n) && /^H[1-6]$/.test(n.role) && n.text.length <= 80 &&
    Math.abs(n.bbox[0] - widget.bbox[0]) <= 4 && bottom(n) <= widget.bbox[1] && widget.bbox[1] - bottom(n) <= 72);
  const matches = [];
  for (const heading of headings) {
    const instructions = nodes.filter(n => usable(n) && n !== heading && n.bbox[1] >= bottom(heading) && bottom(n) <= widget.bbox[1] && overlapX(n, widget))
      .sort((a, b) => a.bbox[1] - b.bbox[1]);
    if (!instructions.length || instructions.length > 4 || instructions.some(n => n.role !== "P" || Math.abs(n.bbox[0] - widget.bbox[0]) > 4 || right(n) > right(widget) + 4)) continue;
    const chain = [heading, ...instructions];
    if (chain.slice(1).some((n, i) => n.bbox[1] - bottom(chain[i]) > 12) || widget.bbox[1] - bottom(chain.at(-1)) > 18) continue;
    if (widgets.some(w => w.id !== widget.id && w.bbox && overlapX(w, widget) && bottom(w) > heading.bbox[1] && w.bbox[1] < bottom(widget))) continue;
    const instructionWords = contentWords(instructions.map(n => n.text).join(" "));
    if (tooltipWords.filter(w => instructionWords.includes(w)).length / tooltipWords.length < 0.8) continue;
    matches.push({ labels: [heading], instructions,
      association: { kind: "section-prompt", evidence: "single-multiline-field-and-tooltip-matched-section-instructions" } });
  }
  return matches.length === 1 ? matches[0] : null;
}
