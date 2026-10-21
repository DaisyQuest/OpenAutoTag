const CONNECTORS = new Set(["a", "an", "the", "in", "of", "for", "to", "and", "or", "with",
  "on", "at", "by", "from", "de", "del", "en", "para", "y", "con", "por"]);
const isHeading = (node) => /^H[1-6]$/.test(node.role || "");
const fontKey = (node) => String(node.fontName || "").replace(/^[A-Z]{6}\+/, "").toLowerCase();
const horizontal = (node) => (node.writingMode || "horizontal") === "horizontal" &&
  Math.abs((node.textRotation || 0) % 360) < 1;

function continuesText(previous, next) {
  const word = String(previous.text || "").trim().match(/([\p{L}\p{M}]+)$/u)?.[1]?.toLowerCase();
  return CONNECTORS.has(word) || /^\p{Ll}/u.test(String(next.text || "").trim());
}

function compatible(previous, next, pageNodes) {
  if (!isHeading(previous) || previous.role !== next.role || previous.pageNumber !== next.pageNumber ||
    !horizontal(previous) || !horizontal(next) || previous.formFieldIds?.length || next.formFieldIds?.length ||
    !fontKey(previous) || fontKey(previous) !== fontKey(next) || !continuesText(previous, next)) return false;
  if (!Number.isFinite(previous.fontSize) || !Number.isFinite(next.fontSize) ||
    Math.abs(previous.fontSize - next.fontSize) > Math.max(previous.fontSize, next.fontSize) * 0.05 ||
    (previous.columnHint != null && next.columnHint != null && previous.columnHint !== next.columnHint)) return false;
  const [x, y, w, h] = previous.bbox;
  const [nx, ny, nw, nh] = next.bbox;
  const size = Math.max(previous.fontSize, next.fontSize);
  const gap = ny - (y + h);
  const aligned = Math.abs(x - nx) <= Math.max(4, size * 0.3) ||
    Math.abs(x + w / 2 - (nx + nw / 2)) <= Math.max(6, size * 0.5);
  if (!aligned || ny <= y || gap < -size * 0.25 || gap > size * 0.6 || h > size * 1.5 || nh > size * 1.5) return false;
  const left = Math.min(x, nx), right = Math.max(x + w, nx + nw);
  return !pageNodes.some((node) => node.id !== previous.id && node.id !== next.id &&
    node.pageNumber === previous.pageNumber && node.role !== "Artifact" && node.bbox[1] > y && node.bbox[1] < ny &&
    Math.min(right, node.bbox[0] + node.bbox[2]) - Math.max(left, node.bbox[0]) > 1);
}

/** Join only typographically and linguistically supported heading continuations. */
export function mergeHeadingContinuations(nodes) {
  const groups = new Map();
  const absorbed = new Set();
  let active = [];
  let pageNumber = null;
  for (const heading of [...nodes].filter(isHeading).sort((a, b) =>
    a.pageNumber - b.pageNumber || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])) {
    if (pageNumber !== heading.pageNumber) active = [];
    pageNumber = heading.pageNumber;
    active = active.filter((group) => {
      const last = group.at(-1);
      return last.bbox[1] + last.bbox[3] + Math.max(last.fontSize || 0, heading.fontSize || 0) * 0.6 >= heading.bbox[1];
    });
    const candidates = active.filter((group) => compatible(group.at(-1), heading, nodes));
    if (candidates.length === 1) {
      candidates[0].push(heading);
      absorbed.add(heading.id);
    } else {
      const group = [heading];
      groups.set(heading.id, group);
      active.push(group);
    }
  }
  let mergedGroups = 0;
  const result = nodes.filter((node) => !absorbed.has(node.id)).map((node) => {
    const lines = groups.get(node.id);
    if (!lines || lines.length < 2) return node;
    mergedGroups++;
    const left = Math.min(...lines.map((n) => n.bbox[0]));
    const top = Math.min(...lines.map((n) => n.bbox[1]));
    return { ...node,
      text: lines.map((n) => n.text.trim()).join(" "),
      ...(lines.some(n => typeof n.rawText === "string") ? { rawText: lines.map(n => n.rawText ?? n.text).join("\n") } : {}),
      ...(lines.some(n => typeof n.comparisonText === "string") ? { comparisonText: lines.map(n => n.text.trim()).join(" ").normalize("NFKC").replace(/\s+/g," ") } : {}),
      bbox: [left, top,
        Math.max(...lines.map((n) => n.bbox[0] + n.bbox[2])) - left,
        Math.max(...lines.map((n) => n.bbox[1] + n.bbox[3])) - top],
      confidence: Math.min(...lines.map((n) => n.confidence)),
      sourceBlockIds: [...new Set(lines.flatMap((n) => n.sourceBlockIds || [n.sourceBlockId]))],
      headingLineCount: lines.reduce((count, n) => count + (n.headingLineCount || 1), 0)
    };
  });
  return { nodes: result, summary: { mergedGroups, absorbedLines: absorbed.size } };
}
