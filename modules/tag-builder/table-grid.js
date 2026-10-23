// Plan without mutating cells. Explicit rectangles are reserved before placing
// cells with no column hint, so a guessed position cannot displace declared data.
const MAX_ROWS = 4096, MAX_COLUMNS = 1024, MAX_CELLS = 10000;
const MAX_SLOTS = 65536, MAX_WORK = 5000000, MAX_ISSUES = 100;
const isCell = n => n?.type === "TH" || n?.type === "TD";
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

export function planTableGrid(rowDescriptors) {
  const issues = [], entries = [], grid = new Map();
  let work = 0, slots = 0, width = 0, height = rowDescriptors.length;
  const issue = (code, cell, message, other) => {
    if (issues.length < MAX_ISSUES) issues.push({ code, cellId: cell?.id || "table", message,
      ...(other ? { conflictingCellId: other.cell.id } : {}) });
  };
  const failed = () => ({ issues, plans: [], requiredColumnCount: 0, remainingCarry: [] });
  if (height > MAX_ROWS) { issue("GRID_LIMIT", null, "Table exceeds 4096 rows."); return failed(); }
  for (let ordinal = 0; ordinal < rowDescriptors.length; ordinal++) {
    const descriptor = rowDescriptors[ordinal];
    if (!integer(descriptor.rowIndex, 0, Number.MAX_SAFE_INTEGER)) {
      issue("INVALID_ROW", descriptor.rowNode, "Row identity must be a nonnegative safe integer.");
    }
    for (const cell of descriptor.rowNode.children || []) {
      if (!isCell(cell)) continue;
      if (entries.length >= MAX_CELLS) { issue("GRID_LIMIT", cell, "Table exceeds 10000 cells."); return failed(); }
      const rows = cell.rowSpan === undefined ? 1 : cell.rowSpan, columns = cell.columnSpan === undefined ? 1 : cell.columnSpan;
      const start = cell.tableColumnIndex;
      if (!integer(rows, 1, MAX_ROWS) || !integer(columns, 1, MAX_COLUMNS) || ordinal + rows > MAX_ROWS) {
        issue("INVALID_SPAN", cell, "Cell spans must be positive integers within the bounded grid."); continue;
      }
      if (start != null && (!integer(start, 0, MAX_COLUMNS - 1) || start + columns > MAX_COLUMNS)) {
        issue("INVALID_COLUMN", cell, "Declared column is outside the bounded grid."); continue;
      }
      if (cell.tableRowIndex != null && (!integer(cell.tableRowIndex, 0, Number.MAX_SAFE_INTEGER) || cell.tableRowIndex !== descriptor.rowIndex)) {
        issue("INVALID_ROW", cell, "Cell row identity disagrees with its containing row."); continue;
      }
      // RowSpan counts actual TR rows, not omitted numeric row identities.
      let gap = false;
      for (let offset = 1; offset < rows && ordinal + offset < rowDescriptors.length; offset++) {
        if (++work > MAX_WORK) { issue("GRID_LIMIT", cell, "Table planning exceeded its bounded work budget."); return failed(); }
        if (rowDescriptors[ordinal + offset].rowIndex !== descriptor.rowIndex + offset) gap = true;
      }
      if (gap) { issue("ROW_SPAN_GAP", cell, "RowSpan crosses missing or reordered declared rows."); continue; }
      entries.push({ cell, ordinal, rows, columnSpan: columns, startColumn: start ?? null });
      height = Math.max(height, ordinal + rows);
    }
  }
  if (issues.length) return failed();
  // Each slot stores the original cell, retaining the conflicting identities.
  const collision = (entry, start) => {
    for (let r = entry.ordinal; r < entry.ordinal + entry.rows; r++) {
      for (let c = start; c < start + entry.columnSpan; c++) {
        if (++work > MAX_WORK) throw new Error("GRID_WORK_LIMIT");
        const owner = grid.get(r)?.get(c);
        if (owner) return owner;
      }
    }
    return null;
  };
  const reserve = (entry, start) => {
    entry.startColumn = start;
    for (let r = entry.ordinal; r < entry.ordinal + entry.rows; r++) {
      if (!grid.has(r)) grid.set(r, new Map());
      for (let c = start; c < start + entry.columnSpan; c++) {
        if (++slots > MAX_SLOTS) throw new Error("GRID_SLOT_LIMIT");
        grid.get(r).set(c, entry);
      }
    }
    width = Math.max(width, start + entry.columnSpan);
  };
  try {
    for (const entry of entries) if (entry.startColumn != null) {
      const other = collision(entry, entry.startColumn);
      if (other) issue("OVERLAPPING_SPANS", entry.cell, "Declared cell rectangles overlap; no cell was shifted.", other);
      else reserve(entry, entry.startColumn);
      if (issues.length === MAX_ISSUES) return failed();
    }
    if (issues.length) return failed();
    const cursors = new Map();
    for (const entry of entries) {
      if (entry.startColumn != null) { cursors.set(entry.ordinal, entry.startColumn + entry.columnSpan); continue; }
      let start = cursors.get(entry.ordinal) || 0;
      while (start + entry.columnSpan <= MAX_COLUMNS && collision(entry, start)) start++;
      if (start + entry.columnSpan > MAX_COLUMNS) { issue("GRID_LIMIT", entry.cell, "No bounded position is available for an unpositioned cell."); return failed(); }
      reserve(entry, start); cursors.set(entry.ordinal, start + entry.columnSpan);
    }
  } catch (error) {
    if (!/^GRID_(WORK|SLOT)_LIMIT$/.test(error.message)) throw error;
    issue("GRID_LIMIT", null, "Table planning exceeded its bounded work budget."); return failed();
  }
  if (height * width > MAX_SLOTS) { issue("GRID_LIMIT", null, "Completed rectangular grid exceeds 65536 slots."); return failed(); }
  const plans = rowDescriptors.map((descriptor, ordinal) => ({ ...descriptor, carryColumns: new Set(), placements: [] }));
  for (const entry of entries) {
    plans[entry.ordinal].placements.push({ cell: entry.cell, startColumn: entry.startColumn, columnSpan: entry.columnSpan });
    for (let r = entry.ordinal + 1; r < Math.min(plans.length, entry.ordinal + entry.rows); r++) {
      for (let c = entry.startColumn; c < entry.startColumn + entry.columnSpan; c++) plans[r].carryColumns.add(c);
    }
  }
  const remainingCarry = [];
  for (const entry of entries) if (entry.ordinal + entry.rows > plans.length) {
    for (let c = entry.startColumn; c < entry.startColumn + entry.columnSpan; c++) remainingCarry[c] = entry.ordinal + entry.rows - plans.length;
  }
  return { issues, plans, requiredColumnCount: width, remainingCarry };
}

export function tableGridReview(tableId, issues) {
  return { algorithm: "declared-grid-v1", status: "review_required", tableId, issues };
}

// Several native text blocks may describe successive lines in one declared
// cell. Retain each content Span; never concatenate or repartition source glyphs.
export function mergeDeclaredCellFragments(rowDescriptors, sourceNodes) {
  const merges = [];
  if (rowDescriptors.length > MAX_ROWS) return merges;
  let inspected = 0;
  for (const { rowNode } of rowDescriptors) {
    const groups = new Map(), removed = new Set();
    for (const cell of rowNode.children || []) {
      if (!isCell(cell)) continue;
      if (++inspected > MAX_CELLS) return merges;
      if (!integer(cell.tableColumnIndex, 0, MAX_COLUMNS - 1) || !integer(cell.rowSpan === undefined ? 1 : cell.rowSpan, 1, MAX_ROWS) || !integer(cell.columnSpan === undefined ? 1 : cell.columnSpan, 1, MAX_COLUMNS)) continue;
      const key = JSON.stringify([cell.type, cell.tableColumnIndex, cell.rowSpan ?? 1, cell.columnSpan ?? 1, cell.scope || "", cell.tableSection || ""]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cell);
    }
    for (const cells of groups.values()) {
      if (cells.length < 2) continue;
      const sources = cells.map(c => c.children?.length === 1 && c.children[0].type === "Span" && c.children[0].sourceNodeIds?.length === 1 && !c.sourceNodeIds?.length ? sourceNodes.get(c.children[0].sourceNodeIds[0]) : null);
      if (sources.some(s => !s || s.textProvenance !== "native" || (s.textRotation || 0) !== 0 || !Array.isArray(s.bbox) || s.bbox.length !== 4 || !s.bbox.every(Number.isFinite) || s.bbox[2] <= 0 || s.bbox[3] <= 0)) continue;
      if (new Set(sources.map(s => s.id)).size !== sources.length || sources.some(s => s.pageNumber !== sources[0].pageNumber)) continue;
      let aligned = true;
      for (let i = 1; i < sources.length; i++) {
        const [x,y,w,h] = sources[i-1].bbox, [xx,yy,ww,hh] = sources[i].bbox;
        const overlap = Math.min(x+w,xx+ww)-Math.max(x,xx), gap = yy-y-h;
        if (overlap < Math.min(w,ww)*0.5 || gap < -0.01 || gap > Math.max(h,hh)*1.5) aligned = false;
      }
      if (!aligned) continue;
      const first = cells[0];
      first.mergedCellIds = cells.map(c => c.id);
      first.label = cells.map(c => c.label || "").join(" ");
      for (const cell of cells.slice(1)) { first.children.push(...cell.children); removed.add(cell); }
      merges.push({ cellId: first.id, sourceCellIds: first.mergedCellIds, pageNumber: sources[0].pageNumber,
        reason: "Matching declared cell rectangle and role with aligned, nonoverlapping native text lines." });
    }
    if (removed.size) rowNode.children = rowNode.children.filter(c => !removed.has(c));
  }
  return merges;
}
