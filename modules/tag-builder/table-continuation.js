// Track row identity per page without merging rows when local numbering restarts.
// Metadata is emitted only for multi-page tables, preserving legacy single-page IDs.
export function appendTableCell(state, cell, pageNumber, sourceRowIndex) {
  const records = state.rowRecords ||= [];
  if (state.pageNumber !== undefined && pageNumber < state.pageNumber)
    throw new Error("Table page order requires review");
  if (state.pageNumber !== pageNumber) {
    state.rowOffset = 0;
    if (records.length) {
      if (!Number.isSafeInteger(sourceRowIndex) || sourceRowIndex < 0)
        throw new Error("Cross-page table row identity requires review");
      const last = Math.max(...records.map(r => r.row.tableRowIndex));
      if (!Number.isSafeInteger(last) || last < 0)
        throw new Error("Cross-page table row identity requires review");
      if (sourceRowIndex <= last) state.rowOffset = last + 1 - sourceRowIndex;
      if (!state.multiPage) for (const r of records) {
        r.row.tableRowOrigin = r.origin;
        for (const c of r.row.children) c.tableRowOrigin = r.origin;
      }
      state.multiPage = true;
    }
    state.pageNumber = pageNumber;
  }
  const rowIndex = state.rowOffset ? sourceRowIndex + state.rowOffset : sourceRowIndex;
  if (state.multiPage && (!Number.isSafeInteger(rowIndex) || rowIndex < 0))
    throw new Error("Cross-page table row identity exceeds safe range");
  const key = JSON.stringify([pageNumber, sourceRowIndex]);
  let row = state.rows.get(key);
  if (!row) {
    if (records.length >= 4096) throw new Error("Table exceeds 4096 rows");
    if (state.multiPage && records.some(r => r.row.tableRowIndex >= rowIndex))
      throw new Error("Cross-page table rows are out of order; requires review");
    row = { id: `${state.node.id}:row:${rowIndex}`, type: "TR", tableRowIndex: rowIndex, children: [] };
    const origin = {pageNumber, rowIndex: sourceRowIndex};
    records.push({row, origin}); state.rows.set(key, row); state.node.children.push(row);
    if (state.multiPage) row.tableRowOrigin = origin;
  }
  cell.tableRowIndex = rowIndex;
  if (state.multiPage) cell.tableRowOrigin = row.tableRowOrigin;
  row.children.push(cell);
}

// Only a leading header band and trailing footer band can be section wrappers.
// Later headers/footer occurrences remain in the body in their original order.
export function partitionTableSections(entries) {
  let headEnd = 0, footStart = entries.length;
  while (headEnd < entries.length && entries[headEnd].assignedSectionKey === "head") headEnd++;
  while (footStart > headEnd && entries[footStart-1].assignedSectionKey === "foot") footStart--;
  for (let i = headEnd; i < footStart; i++) {
    const e = entries[i];
    if (e.assignedSectionKey !== "body") e.rowNode.tableSectionOrigin = e.assignedSectionKey;
    e.assignedSectionKey = "body";
  }
  return {headRows: entries.slice(0,headEnd), bodyRows: entries.slice(headEnd,footStart), footRows: entries.slice(footStart)};
}

// Pattern matching records relationships between retained occurrences; it does
// not authorize converting source text to artifacts or merging TH identities.
export function markRepeatedTableHeaders(rows) {
  const heads = rows.filter(r => r.sectionNode?.type === "THead");
  const body = rows.filter(r => r.sectionNode?.type === "TBody");
  if (!heads.length || body.length < heads.length) return 0;
  const cells = r => r.rowNode.children.filter(c => c.type === "TH" || c.type === "TD");
  const original = heads.map(cells);
  if (!original.some(row => row.some(c => c.type === "TH"))) return 0;
  const signature = c => JSON.stringify([c.type,c.tableColumnIndex,c.rowSpan || 1,c.columnSpan || 1,
    String(c.label || "").trim(),c.type === "TH" ? c.scope || "Column" : ""]);
  const expected = original.map(row => row.map(signature));
  const matches = []; let work = 0;
  for (let offset = 0; offset <= body.length-heads.length; offset++) {
    const candidate = [];
    let matched = true;
    for (let i = 0; i < heads.length && matched; i++) {
      if (++work > 5000000) throw new Error("Repeated header matching exceeds bounded work limit");
      const row = cells(body[offset+i]); candidate.push(row);
      if (row.length !== expected[i].length) { matched = false; break; }
      for (let c = 0; c < row.length; c++) {
        if (++work > 5000000) throw new Error("Repeated header matching exceeds bounded work limit");
        if (signature(row[c]) !== expected[i][c]) { matched = false; break; }
      }
      // A repeated multirow band must occur together on one page when known.
      if (body[offset+i].rowNode.tableRowOrigin?.pageNumber !== body[offset].rowNode.tableRowOrigin?.pageNumber) matched = false;
    }
    if (matched) { matches.push({offset,candidate}); offset += heads.length-1; }
  }
  for (const {offset,candidate} of matches) for (let i = 0; i < heads.length; i++) {
    const row = body[offset+i].rowNode; row.repeatedHeader = true; row.tableSectionOrigin = "head";
    for (let c = 0; c < candidate[i].length; c++) if (candidate[i][c].type === "TH")
      candidate[i][c].repeatedHeaderOf = original[i][c].id;
  }
  return matches.length*heads.length;
}
