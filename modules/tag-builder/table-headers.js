import { planTableGrid, tableGridReview } from "./table-grid.js";

// Resolve the original, unassociated grid. Generated Headers are not fed back
// into later searches: doing so would import opposite-axis labels or old groups.
// Columns precede rows; each directional list is nearest (specific) first.
export function assignTableHeaders(table, rows) {
  if (table.tableGridReview) return;
  const plan = planTableGrid(rows);
  if (plan.issues.length) {
    table.tableGridReview = tableGridReview(table.id, plan.issues);
    return;
  }
  const grid = [], entries = [];
  let ordinal = 0, headerNumber = 0;
  for (const row of plan.plans) {
    for (const placement of row.placements) {
      const cell = placement.cell, rs = cell.rowSpan || 1;
      const explicit = ["Row", "Column", "Both"].includes(cell.scope);
      const inHead = row.sectionNode?.type === "THead" || cell.tableSection === "head";
      const entry = { cell, row: ordinal, rowIdentity: row.rowIndex, col: placement.startColumn, rs, cs: placement.columnSpan,
        scope: explicit ? cell.scope : inHead ? "Column" : "Row",
        scopeSource: explicit ? "explicit" : inHead ? "thead" : "body-default", order: entries.length };
      if (cell.type === "TH") entry.headerId = `${table.id}:H_r${row.rowIndex}c${entry.col}_${headerNumber++}`;
      entries.push(entry);
      for (let r = ordinal; r < ordinal + rs; r++) {
        grid[r] ||= [];
        for (let c = entry.col; c < entry.col + entry.cs; c++) grid[r][c] = entry;
      }
    }
    ordinal++;
  }
  let work = 0;
  const search = (entry, direction) => {
    const vertical = direction === "Column", found = new Map();
    const start = vertical ? entry.row : entry.col;
    const laneStart = vertical ? entry.col : entry.row;
    const laneEnd = laneStart + (vertical ? entry.cs : entry.rs);
    for (let lane = laneStart; lane < laneEnd; lane++) {
      let seenHeader = false;
      for (let pos = start - 1; pos >= 0; pos--) {
        if (++work > 5000000) throw new Error("Table header association exceeds bounded work limit");
        const other = vertical ? grid[pos]?.[lane] : grid[lane]?.[pos];
        if (!other || other === entry) continue;
        if (other.cell.type === "TH") {
          // Section normalization may have moved later repeated header rows
          // ahead of earlier body rows. Never import a declared future header.
          if (vertical && other.rowIdentity >= entry.rowIdentity) continue;
          // A header for the other axis neither contributes nor ends the search.
          if (other.scope !== direction && other.scope !== "Both") continue;
          seenHeader = true;
          if (!found.has(other)) found.set(other, start - pos);
        // A TH after data starts a new header band, not a child of an older band.
        } else if (seenHeader || entry.cell.type === "TH") break;
      }
    }
    return [...found].sort((a,b) => a[1]-b[1] || a[0].order-b[0].order).map(([e]) => e.headerId);
  };
  // Prepare all results first, so resource-limit rejection never partially edits.
  const results = entries.map(entry => ({ entry, columnHeaders: search(entry,"Column"), rowHeaders: search(entry,"Row") }));
  for (const {entry, columnHeaders, rowHeaders} of results) {
    const {cell, rs, cs} = entry, attrs = { O: "Table" };
    if (cs > 1) attrs.ColSpan = cs;
    if (rs > 1) attrs.RowSpan = rs;
    const headers = [...new Set([...columnHeaders,...rowHeaders])];
    if (headers.length) attrs.Headers = headers;
    if (cell.type === "TH") { cell.headerId = entry.headerId; cell.scope = entry.scope; }
    else { delete cell.headerId; delete cell.scope; }
    if (Object.keys(attrs).length > 1) cell.tableAttrs = attrs;
    else delete cell.tableAttrs;
    cell.tableHeaderEvidence = { algorithm: "directional-grid-v1", columnHeaders, rowHeaders,
      ...(cell.type === "TH" ? {scopeSource: entry.scopeSource} : {}) };
  }
}
