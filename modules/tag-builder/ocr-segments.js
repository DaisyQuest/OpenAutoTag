const canonical = text => text.normalize("NFKC").replace(/\p{White_Space}/gu, "");

/** Retain each recognized line, even when semantic paragraphs have been merged.
 * Attach to the same deepest owner used for native text, after tree repairs. */
export function attachOcrSegments(root, semantic) {
  const ocrIds = new Set(semantic.nodes.filter(n => n.textProvenance === "ocr").map(n => n.id));
  const owners = new Map(), parents = new Map();
  function walk(n, parent) {
    parents.set(n, parent);
    for (const id of n.sourceNodeIds || []) {
      if (!ocrIds.has(id)) continue;
      const previous = owners.get(id);
      if (previous) {
        let ancestor = parent;
        while (ancestor && ancestor !== previous) ancestor = parents.get(ancestor);
        if (!ancestor) throw new Error(`Ambiguous OCR source owner: ${id}`);
      }
      owners.set(id, n);
    }
    for (const child of n.children || []) walk(child, n);
  }
  walk(root, null);
  const used = new Set();
  const append = (tag, entry) => (tag.ocrSegments ||= []).push(entry);
  for (const node of semantic.nodes) {
    if (node.textProvenance !== "ocr" || !node.text.trim() || ["Artifact", "Figure", "Form"].includes(node.role)) continue;
    // Legacy OCR without explicit geometry remains readable by the contract,
    // but the native writer cannot qualify or write it as a generated layer.
    if (!node.ocrSegments?.length) continue;
    if (semantic.source.coordinateSpace !== "crop-display-points") throw new Error("OCR requires explicit display coordinates");
    const tag = owners.get(node.id);
    if (!tag) throw new Error(`Missing OCR tag owner: ${node.id}`);
    if (canonical(node.text) !== canonical(node.ocrSegments.map(s => s.text).join("")))
      throw new Error(`OCR text changed without line geometry: ${node.id}`);
    const label = tag.type === "LBody" ? parents.get(tag)?.children?.find(n => n.type === "Lbl") : null;
    for (const [index, segment] of node.ocrSegments.entries()) {
      const key = `${node.pageNumber}:${segment.sourceBlockId}`;
      if (used.has(key)) throw new Error(`Duplicate OCR source line: ${key}`);
      used.add(key);
      const g = segment.geometry;
      if (g?.coordinateSpace !== "crop-display-points" || g.clipped || !g.quad?.every(Number.isFinite))
        throw new Error(`Unqualified OCR line geometry: ${key}`);
      const entry = { pageNumber: node.pageNumber, sourceBlockId: segment.sourceBlockId,
        ...(segment.recognition ? { recognition: structuredClone(segment.recognition) } : {}),
        text: segment.text, quad: [...g.quad], ...(segment.confidence != null ? { confidence: segment.confidence } : {}) };
      if (index === 0 && label) {
        const marker = label.actualText || label.label;
        if (!marker || !entry.text.startsWith(marker) || entry.text.length === marker.length)
          throw new Error(`OCR list marker does not match its original line: ${key}`);
        // Line recognition has no glyph boxes. The split preserves the full
        // line envelope; exact word/glyph placement is not claimed.
        const fraction = marker.length / entry.text.length, q = entry.quad;
        const top = [q[0]+(q[2]-q[0])*fraction, q[1]+(q[3]-q[1])*fraction];
        const bottom = [q[6]+(q[4]-q[6])*fraction, q[7]+(q[5]-q[7])*fraction];
        const recognition = (start, end) => entry.recognition ? { recognition: { ...entry.recognition, range: [start, end] } } : {};
        append(label, { ...entry, ...recognition(0, marker.length), text: marker, quad: [q[0],q[1],...top,...bottom,q[6],q[7]] });
        append(tag, { ...entry, ...recognition(marker.length, entry.text.length), text: entry.text.slice(marker.length), quad: [...top,q[2],q[3],q[4],q[5],...bottom] });
      } else append(tag, entry);
    }
  }
}
