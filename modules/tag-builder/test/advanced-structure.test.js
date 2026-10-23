import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTagTree } from "../index.js";
const n = (id, role, extra = {}) => ({ id, role, text: `1. ${id}`, sourceBlockId: id, pageNumber: 1, bbox: [72,100,100,12], confidence: 1, ...extra });
async function build(t, nodes, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "advanced-tags-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "semantic.json");
  await writeFile(file, JSON.stringify({ schemaVersion: "1.0.0", documentId: "test", source: { layoutDocumentId: "test" }, nodes, orderedNodeIds: nodes.map((n) => n.id) }));
  return buildTagTree(file, options);
}
const all = (node) => [node, ...(node.children || []).flatMap(all)];

test("interrupted table groups have collision-free fragment IDs and retain every cell", async t => {
  const cell=(id,group,row)=>n(id,"TD",{text:`${id} 123`,tableId:group,tableRowIndex:row,tableColumnIndex:0});
  const nodes=[cell("a","measurements",0),cell("b","measurements",1),n("heading","H1"),
    cell("c","measurements",1),n("break","P"),cell("d","measurements",2),
    n("next","H1"),cell("reserved","measurements:fragment:2",0)];
  const result=await build(t,nodes), flat=all(result.root);
  assert.equal(new Set(flat.map(n=>n.id)).size,flat.length);
  assert.deepEqual(flat.flatMap(n=>n.sourceNodeIds||[]).sort(),nodes.map(n=>n.id).sort());
  assert.deepEqual(flat.filter(n=>n.type==="Table").map(n=>n.id),[
    "tag:table:measurements","tag:table:measurements:fragment:3",
    "tag:table:measurements:fragment:4","tag:table:measurements:fragment:2"]);
  assert.deepEqual(await build(t,nodes),result,"fragment allocation is deterministic");
});

test("both merged-value repairs keep replacement text inside synthetic cell Spans", async t => {
  for (const spanning of [false, true]) {
    const table = { tableId: "prices", tableSection: "head", tableRowIndex: 0 };
    const result = await build(t, [
      n("item", "TH", { ...table, text: "Item", tableColumnIndex: 0 }),
      n("cost", "TH", { ...table, text: "Cost", tableColumnIndex: 1 }),
      n("value", "TD", { ...table, tableSection: "body", tableRowIndex: 1, tableColumnIndex: 0, text: "Total savings $20 million", ...(spanning ? { tableColumnSpan: 2 } : {}) })
    ]);
    const cells = all(result.root).filter(n => n.type === "TD");
    assert.deepEqual(cells.map(c => c.label), ["Total savings", "$20 million"]);
    assert.equal(result.source.mergedTableTextCellRepair[spanning ? "insertedCellCount" : "filledPlaceholderCount"], 1);
    for (const cell of cells) {
      assert.equal(cell.actualText, undefined); assert.equal(cell.children[0].type, "Span");
      assert.equal(cell.children[0].actualText, cell.label);
    }
    assert.deepEqual(all(result.root).flatMap(n => n.sourceNodeIds || []).sort(), ["cost", "item", "value"]);
  }
});
test("nested lists are children of the preceding LBody and resume at the root level", async (t) => {
  const result = await build(t, [n("a", "LI", { listLevel: 1, listGroupId: "g" }), n("b", "LI", { listLevel: 2, listGroupId: "g" }), n("c", "LI", { listLevel: 1, listGroupId: "g" })]);
  const list = result.root.children[0]; assert.equal(list.children.length, 2);
  const body = list.children[0].children.find((c) => c.type === "LBody");
  assert.equal(body.children[0].type, "L"); assert.equal(body.children[0].children[0].type, "LI");
  await assert.rejects(build(t, [n("bad", "LI", { listLevel: 3 })]), /Ambiguous nested list/);
});
test("distinct list groups remain distinct and H4-H6 survive an explicit hierarchy", async (t) => {
  const result = await build(t, [1,2,3,4,5,6].map((level) => n(`h${level}`, `H${level}`, { headingLevel: level }))
    .concat([n("a", "LI", { listGroupId: "one" }), n("b", "LI", { listGroupId: "two" })]));
  assert.deepEqual(all(result.root).filter((n) => /^H[1-6]$/.test(n.type)).map((n) => n.type), ["H1","H2","H3","H4","H5","H6"]);
  assert.equal(all(result.root).filter((n) => n.type === "L").length, 2);
});
test("spanning data cells reference all covered column headers and IDs differ across tables", async (t) => {
  const nodes = [];
  for (const table of ["one", "two"]) {
    nodes.push(n(`${table}-a`, "TH", { tableGroupId: table, tableRowIndex: 0, tableColumnIndex: 0, tableSection: "head", text: "First column" }),
      n(`${table}-b`, "TH", { tableGroupId: table, tableRowIndex: 0, tableColumnIndex: 1, tableSection: "head", text: "Second column" }),
      n(`${table}-c`, "TD", { tableGroupId: table, tableRowIndex: 1, tableColumnIndex: 0, tableColumnSpan: 2, text: "1234" }));
  }
  const result = await build(t, nodes, { enableTableHeaders: true }); const flat = all(result.root);
  const heads = flat.filter((n) => n.type === "TH"); assert.equal(new Set(heads.map((n) => n.headerId)).size, 4);
  for (const cell of flat.filter((n) => n.type === "TD")) assert.equal(cell.tableAttrs.Headers.length, 2);
});
test("multi-level headers link to preceding groups and exclude future repeated rows", async (t) => {
  const cell = (id, role, row, col, extra = {}) => n(id, role, { tableGroupId: "table", tableRowIndex: row, tableColumnIndex: col,
    text: id === "repeat" ? "Length" : id === "length" ? "Length" : id, ...extra });
  const result = await build(t, [cell("group", "TH", 0, 0, { tableSection: "head", tableColumnSpan: 2 }),
    cell("length", "TH", 1, 0, { tableSection: "head" }), cell("width", "TH", 1, 1, { tableSection: "head" }),
    cell("early", "TD", 2, 0, { tableColumnSpan: 2 }), cell("repeat", "TH", 3, 0, { scope: "Column" }),
    cell("late", "TD", 4, 0)], { enableTableHeaders: true });
  const flat = all(result.root), leaf = (id) => flat.find((p) => p.id === `tag:${id}`);
  assert.deepEqual(leaf("length").tableAttrs.Headers, [leaf("group").headerId]);
  assert.ok(!leaf("early").tableAttrs.Headers.includes(leaf("repeat").headerId));
  assert.ok(leaf("late").tableAttrs.Headers.includes(leaf("repeat").headerId));
  assert.ok(!leaf("late").tableAttrs.Headers.includes(leaf("length").headerId));
});

test("table replacement text is isolated in content Spans with one source owner", async t => {
  const result = await build(t, [n("head", "TH", { tableGroupId: "t", tableRowIndex: 0, tableColumnIndex: 0, scope: "Column", text: "Heading" }),
    n("value", "TD", { tableGroupId: "t", tableRowIndex: 1, tableColumnIndex: 0, text: "Value" })]);
  const flat = all(result.root);
  for (const cell of flat.filter(n => ["TH", "TD"].includes(n.type))) {
    assert.equal(cell.actualText, undefined); assert.deepEqual(cell.sourceNodeIds, []);
    assert.equal(cell.children.length, 1); assert.equal(cell.children[0].type, "Span");
    assert.equal(cell.children[0].actualText, cell.label);
    assert.equal(cell.children[0].sourceNodeIds.length, 1);
  }
  assert.deepEqual(flat.flatMap(n => n.sourceNodeIds || []).sort(), ["head", "value"]);
  assert.equal(flat.find(n => n.type === "TH").scope, "Column");
  assert.deepEqual(flat.find(n => n.type === "TD").tableAttrs.Headers, [flat.find(n => n.type === "TH").headerId]);
});
