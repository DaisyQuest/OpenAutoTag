// Bounded semantic refinements. Content identities and text are never discarded.
const heading = (n) => /^H[1-6]$/.test(n.role);
const clean = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim();
const column = (a, b) => (a.columnHint ?? 0) === (b.columnHint ?? 0);
const typeMatch = (a, b) => a.fontName && a.fontName === b.fontName && Number.isFinite(a.fontSize) &&
  Math.abs(a.fontSize - b.fontSize) <= 0.5 && a.direction === b.direction;
const eligible = (n) => !n.tableId && !n.formFieldIds?.length && !n.artifactType && !n.footnote && !n.footnoteGroupId && !n.semanticRole && !n.labelValuePairId;

export function refineHeadingMembership(nodes, pages) {
  const tasks = [], pageById = new Map(pages.map((p) => [p.pageNumber, p]));
  const repeats = new Map();
  for (const n of nodes.filter(heading)) {
    const text = clean(n.text), page = pageById.get(n.pageNumber);
    // A short colon/hash label attached to a widget is stronger evidence than typography.
    if (n.formFieldIds?.length && text.length <= 60 && /[:#]\s*$/.test(text) && !/^\d+(?:\.\d+)*[.)]?\s/.test(text)) {
      n.role = "P"; delete n.headingLevel; n.headingEvidence = "short-widget-label";
      continue;
    }
    if (page && text && n.bbox[1] < page.height * 0.08) {
      const group = repeats.get(text) || []; group.push(n); repeats.set(text, group);
    }
    if (text.split(/\s+/).length > 18 && /[.!?]$/.test(text))
      tasks.push({ code: "HEADING_SENTENCE_REVIEW", pageNumber: n.pageNumber, nodeId: n.id });
  }
  for (const group of repeats.values()) if (new Set(group.map((n) => n.pageNumber)).size >= 3)
    for (const n of group) tasks.push({ code: "HEADING_REPEATED_MARGIN_REVIEW", pageNumber: n.pageNumber, nodeId: n.id });
  return tasks;
}

export function listOrdinal(text) {
  const match = /^\s*(\d{1,6}|[A-Za-z]|[ivxlcdmIVXLCDM]{2,8})[.)]\s+/.exec(text || "");
  if (!match) return null;
  const token = match[1], roman = /^(?:M{0,3})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;
  if (/^\d+$/.test(token)) return { style: "decimal", value: Number(token) };
  if ((token.length > 1 || /^[ivx]$/i.test(token)) && roman.test(token)) {
    const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    const v = [...token.toUpperCase()].map((c) => values[c]);
    return { style: token === token.toUpperCase() ? "roman-upper" : "roman-lower",
      value: v.reduce((sum, n, i) => sum + (n < (v[i + 1] || 0) ? -n : n), 0) };
  }
  return { style: token === token.toUpperCase() ? "alpha-upper" : "alpha-lower", value: token.toLowerCase().charCodeAt(0) - 96 };
}

export function refineContinuations(nodes, pages) {
  const relations = [], heights = new Map(pages.map((p) => [p.pageNumber, p.height]));
  const ordered = [...nodes].sort((a, b) => a.pageNumber - b.pageNumber || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.id.localeCompare(b.id));
  // Keep the previous content in each column; unrelated columns cannot interrupt or join it.
  const last = new Map();
  for (const n of ordered) {
    if (n.role === "Artifact") continue;
    const key = n.columnHint ?? 0, prior = last.get(key);
    if (prior && eligible(prior) && eligible(n) && column(prior, n)) {
      const boundary = n.pageNumber === prior.pageNumber + 1 && prior.bbox[1] >= (heights.get(prior.pageNumber) || Infinity) * 0.7 &&
        n.bbox[1] < (heights.get(n.pageNumber) || 0) * 0.3;
      const style = typeMatch(prior, n), aligned = Math.abs(n.bbox[0] - prior.bbox[0]) <= 3;
      const a = listOrdinal(prior.text), b = listOrdinal(n.text);
      if (boundary && prior.role === "LI" && n.role === "LI" && prior.listGroupId && n.listGroupId && aligned &&
          (!prior.fontName || !n.fontName || style) && (prior.listLevel || 1) === (n.listLevel || 1) && a && b && a.style === b.style && b.value === a.value + 1) {
        const original = n.listGroupId;
        for (const peer of nodes) if (peer.pageNumber === n.pageNumber && peer.listGroupId === original) peer.listGroupId = prior.listGroupId;
        relations.push({ type: "continues", from: prior.id, to: n.id, evidence: "consecutive-marker-aligned-page-boundary" });
      }
      // Only an unfinished, typographically matching sentence with a lower-case continuation qualifies.
      const sentence = style && /[\p{L},;]$/u.test(clean(prior.text)) && /^\p{Ll}/u.test(clean(n.text));
      if (n.role === "P" && sentence && ((boundary && aligned) || (prior.role === "LI" && n.pageNumber === prior.pageNumber &&
          n.bbox[1] >= prior.bbox[1] + prior.bbox[3] && n.bbox[1] - prior.bbox[1] - prior.bbox[3] <= prior.fontSize * 1.5 &&
          n.bbox[0] - prior.bbox[0] >= prior.fontSize * 0.5 && n.bbox[0] - prior.bbox[0] <= prior.fontSize * 3))) {
        if (prior.role === "P" && boundary) {
          n.paragraphGroupId = prior.paragraphGroupId ||= `paragraph:${prior.id}`;
          n.continuesFrom = prior.id;
        } else if (prior.role === "LI") {
          n.role = "LI"; n.listGroupId = prior.listGroupId; n.listLevel = prior.listLevel || 1;
          n.listItemIndex = prior.listItemIndex; n.listContinuationOf = prior.listContinuationOf || prior.id;
        }
        if (n.paragraphGroupId || n.listContinuationOf)
          relations.push({ type: "continues", from: prior.id, to: n.id, evidence: "unfinished-sentence-typography-and-boundary" });
      }
    }
    last.set(key, n);
  }
  return relations;
}

export function contextOrderRelations(nodes) {
  const relations = [], byId = new Map(nodes.map((n) => [n.id, n]));
  // References are semantic identities supplied by the layout/semantic contract, never guessed by nearest distance.
  for (const n of nodes) {
    for (const [key, reverse, evidence] of [["captionForId", true, "explicit-caption-anchor"], ["footnoteReferenceId", true, "explicit-footnote-reference"], ["asideAnchorId", true, "explicit-aside-anchor"]]) {
      const target = byId.get(n[key]);
      if (target && target !== n && target.pageNumber <= n.pageNumber)
        relations.push({ type: "precedes", from: reverse ? target.id : n.id, to: n.id, evidence });
    }
    // A heading crossing two or more identified columns precedes the content below its band.
    if (!heading(n)) continue;
    const below = nodes.filter((p) => p.pageNumber === n.pageNumber && p.role !== "Artifact" && p !== n &&
      p.bbox[1] >= n.bbox[1] + n.bbox[3] && p.bbox[0] >= n.bbox[0] - 3 && p.bbox[0] + p.bbox[2] <= n.bbox[0] + n.bbox[2] + 3);
    if (new Set(below.map((p) => p.columnHint ?? 0)).size < 2) continue;
    for (const p of nodes.filter((p) => p.pageNumber === n.pageNumber && p.role !== "Artifact" && !p.footnoteGroupId && p !== n &&
        p.bbox[1] + p.bbox[3] <= n.bbox[1] && p.bbox[0] >= n.bbox[0] - 3 && p.bbox[0] + p.bbox[2] <= n.bbox[0] + n.bbox[2] + 3))
      relations.push({ type: "precedes", from: p.id, to: n.id, evidence: "content-above-spanning-heading-band" });
    for (const p of below) relations.push({ type: "precedes", from: n.id, to: p.id, evidence: "heading-spans-content-columns" });
  }
  return relations;
}
