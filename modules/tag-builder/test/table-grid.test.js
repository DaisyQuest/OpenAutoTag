import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { planTableGrid, mergeDeclaredCellFragments } from "../table-grid.js";
import { buildTagTree } from "../index.js";
const cell = (id, col, extra = {}) => ({ id, type: "TD", ...(col == null ? {} : { tableColumnIndex: col }), ...extra });
const rows = values => values.map((children, rowIndex) => ({ rowIndex, rowNode: { id: `row${rowIndex}`, children } }));
const positions = p => p.plans.map(r => r.placements.map(c => [c.cell.id, c.startColumn, c.columnSpan]));

test("declared merged rectangles survive unchanged and reserve future row positions", () => {
  const input = rows([[cell("a", 0, { rowSpan: 2 }), cell("unknown", null, { rowSpan: 2 })], [cell("later", 1)]]);
  const original = structuredClone(input), plan = planTableGrid(input);
  assert.deepEqual(input, original);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(positions(plan), [[["a", 0, 1], ["unknown", 2, 1]], [["later", 1, 1]]]);
  assert.deepEqual([...plan.plans[1].carryColumns], [0, 2]);
});

test("unpositioned cells cannot steal later explicit columns, and large valid hints are honored", () => {
  const p = planTableGrid(rows([[cell("implicit", null), cell("fixed", 0), cell("far", 8)]]));
  assert.deepEqual(positions(p), [[["implicit", 1, 1], ["fixed", 0, 1], ["far", 8, 1]]]);
  assert.equal(p.requiredColumnCount, 9);
});

for (const [name, input] of [
  ["column overlap", [[cell("a", 0, { columnSpan: 2 }), cell("b", 1)]]],
  ["duplicate coordinates", [[cell("a", 0), cell("b", 0)]]],
  ["rowspan carry", [[cell("a", 0, { rowSpan: 2 })], [cell("b", 0)]]],
  ["rectangle interior", [[cell("a", 1, { rowSpan: 3, columnSpan: 3 })], [], [cell("b", 2)]]]
]) test(`${name} preserves evidence and produces a bounded review instead of shifted data`, () => {
  const descriptors = rows(input), original = structuredClone(descriptors), p = planTableGrid(descriptors);
  assert.deepEqual(p.plans, []); assert.equal(p.issues[0].code, "OVERLAPPING_SPANS");
  assert.equal(p.issues[0].cellId, "b"); assert.equal(p.issues[0].conflictingCellId, "a");
  assert.deepEqual(descriptors, original);
});

for (const value of [0, -1, 1.5, "2", null, 1e12]) test(`invalid span ${JSON.stringify(value)} is not silently coerced`, () => {
  for (const property of ["rowSpan", "columnSpan"]) {
    const p = planTableGrid(rows([[cell("bad", 0, { [property]: value })]]));
    assert.equal(p.issues[0].code, "INVALID_SPAN");
  }
});

test("row gaps, invalid columns and bounded table size require review", () => {
  const gap = rows([[cell("a", 0, { rowSpan: 2 })], [cell("b", 1)]]); gap[1].rowIndex = 3;
  assert.equal(planTableGrid(gap).issues[0].code, "ROW_SPAN_GAP");
  for (const col of [-1, 0.5, "1", 1024, 1e12]) assert.equal(planTableGrid(rows([[cell("bad", col)]])).issues[0].code, "INVALID_COLUMN");
  for (const input of [rows(Array.from({ length: 4097 }, () => [])), rows([Array.from({ length: 10001 }, (_, i) => cell(`c${i}`, 0))]),
    rows(Array.from({ length: 1000 }, (_, i) => [cell(`c${i}`, 1023)])),
    rows(Array.from({ length: 1000 }, (_, i) => [cell(`c${i}`, 0, { columnSpan: 1024 })]))]) {
    assert.equal(planTableGrid(input).issues[0].code, "GRID_LIMIT");
  }
});

test("review diagnostics stop at 100 collisions", () => {
  const p = planTableGrid(rows([[cell("owner", 0), ...Array.from({ length: 200 }, (_, i) => cell(`c${i}`, 0))]]));
  assert.equal(p.issues.length, 100); assert.deepEqual(p.plans, []);
});

test("unsafe or contradictory row identities cannot be normalized away", () => {
  for (const value of [-1, "0", Number.MAX_SAFE_INTEGER + 1]) {
    const bad = rows([[cell("a", 0)]]); bad[0].rowIndex = value;
    assert.equal(planTableGrid(bad).issues[0].code, "INVALID_ROW");
  }
  for (const value of [-1, "0", 1]) assert.equal(planTableGrid(rows([[cell("a", 0, { tableRowIndex: value })]])).issues[0].code, "INVALID_ROW");
});

test("trailing spans retain their declared extent without modifying input", () => {
  const p = planTableGrid(rows([[cell("a", 0, { rowSpan: 3, columnSpan: 2 }), cell("b", 2)]]));
  assert.deepEqual(p.issues, []); assert.deepEqual(p.remainingCarry, [2, 2]); assert.equal(p.requiredColumnCount, 3);
});

function fragmentFixture() {
  const sources = new Map([0,1,2].map(i => [`s${i}`, { id: `s${i}`, pageNumber: 1, textProvenance: "native", bbox: [72, 100+i*15, 120-i*10, 12] }]));
  const input = rows([[0,1,2].map(i => cell(`c${i}`, 0, { type: "TH", rowSpan: 2, columnSpan: 2, label: `line ${i}`,
    children: [{ id: `span${i}`, type: "Span", sourceNodeIds: [`s${i}`], actualText: `line ${i}`, children: [] }] }))]);
  return { sources, input };
}
test("successive native lines in the same declared cell retain individual source Spans", () => {
  const { sources, input } = fragmentFixture(), original = structuredClone([...sources]);
  const result = mergeDeclaredCellFragments(input, sources), merged = input[0].rowNode.children[0];
  assert.equal(result.length, 1); assert.deepEqual(result[0].sourceCellIds, ["c0","c1","c2"]);
  assert.equal(input[0].rowNode.children.length, 1); assert.equal(merged.rowSpan, 2); assert.equal(merged.columnSpan, 2);
  assert.deepEqual(merged.children.map(n => [n.id,n.sourceNodeIds[0],n.actualText]), [["span0","s0","line 0"],["span1","s1","line 1"],["span2","s2","line 2"]]);
  assert.deepEqual([...sources], original); assert.deepEqual(planTableGrid(input).issues, []);
});
for (const mode of ["page","role","scope","span","ocr","overlapping-paint","separate-columns","large-gap","reversed-order","rotation","missing-source"]) test(`cell fragment repair declines ${mode}`, () => {
  const { sources, input } = fragmentFixture(); input[0].rowNode.children.length = 2;
  const b = sources.get("s1"), other = input[0].rowNode.children[1];
  if (mode === "page") b.pageNumber = 2;
  if (mode === "role") other.type = "TD";
  if (mode === "scope") other.scope = "Row";
  if (mode === "span") other.rowSpan = 3;
  if (mode === "ocr") b.textProvenance = "ocr";
  if (mode === "overlapping-paint") b.bbox[1] = 105;
  if (mode === "separate-columns") b.bbox[0] = 400;
  if (mode === "large-gap") b.bbox[1] = 200;
  if (mode === "reversed-order") b.bbox[1] = 80;
  if (mode === "rotation") b.textRotation = 90;
  if (mode === "missing-source") sources.delete("s1");
  const before = structuredClone(input); assert.deepEqual(mergeDeclaredCellFragments(input, sources), []); assert.deepEqual(input, before);
  assert.equal(planTableGrid(input).issues[0].code, "OVERLAPPING_SPANS");
});

test("builder exposes original conflicting cells without normalization, header inference or text splitting", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "table-grid-review-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const nodes = [
    { id: "a", role: "TH", text: "Item", tableRowIndex: 0, tableColumnIndex: 0, tableColumnSpan: 2 },
    { id: "b", role: "TD", text: "Savings $20 million", tableRowIndex: 0, tableColumnIndex: 1 }
  ].map(n => ({ sourceBlockId: n.id, pageNumber: 1, bbox: [72, 100, 100, 12], confidence: 1, tableId: "conflict", ...n }));
  const file = path.join(dir, "semantic.json");
  await writeFile(file, JSON.stringify({ schemaVersion: "1.0.0", documentId: "grid", source: { layoutDocumentId: "grid" }, nodes, orderedNodeIds: nodes.map(n => n.id) }));
  const result = await buildTagTree(file), table = result.root.children[0];
  assert.equal(table.tableGridReview.status, "review_required");
  assert.equal(result.source.tableRegularityCorrection.reviews.length, 1);
  assert.equal(result.source.tableRegularityCorrection.shiftedCellCount, 0);
  assert.equal(result.source.mergedTableTextCellRepair.splitCellCount, 0);
  const all = n => [n, ...n.children.flatMap(all)], cells = all(table).filter(n => ["TH", "TD"].includes(n.type));
  assert.deepEqual(cells.map(c => [c.id, c.tableColumnIndex, c.columnSpan || 1, c.label]), [["tag:a", 0, 2, "Item"], ["tag:b", 1, 1, "Savings $20 million"]]);
  assert.ok(cells.every(c => !c.headerId && !c.tableAttrs));
  assert.deepEqual(all(table).flatMap(n => n.sourceNodeIds || []).sort(), ["a", "b"]);
});

test("a header-only trailing span adds rows under the table, never inside another row", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "header-span-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "semantic.json");
  const nodes = [0,1].map(i => ({ id:`h${i}`,sourceBlockId:`h${i}`,pageNumber:1,role:"TH",text:`Header ${i}`,bbox:[72+i*100,100,80,12],confidence:1,tableId:"headers",tableRowIndex:0,tableColumnIndex:i,...(i===0?{tableRowSpan:2}:{}) }));
  await writeFile(file,JSON.stringify({schemaVersion:"1.0.0",documentId:"headers",source:{layoutDocumentId:"headers"},nodes}));
  const result = await buildTagTree(file), flat = n => [n,...n.children.flatMap(flat)], tree = flat(result.root);
  const tableRows = tree.filter(n => n.type === "TR"); assert.equal(tableRows.length,2);
  assert.ok(tableRows.every(r => r.children.every(c => ["TH","TD"].includes(c.type))));
  assert.equal(tableRows[1].children.length,1); assert.equal(tableRows[1].children[0].tableColumnIndex,1);
});
