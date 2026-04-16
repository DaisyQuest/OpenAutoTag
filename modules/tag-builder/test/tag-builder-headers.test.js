import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTagTree } from "../index.js";

function makeNode(id, role, text, tableGroupId, rowIndex, colIndex, extra = {}) {
  return {
    id,
    pageNumber: 1,
    sourceBlockId: `b-${id}`,
    role,
    text,
    bbox: [colIndex * 20, rowIndex * 15, 18, 12],
    confidence: 0.95,
    readingOrder: 0,
    tableGroupId,
    tableRowIndex: rowIndex,
    tableColumnIndex: colIndex,
    ...extra
  };
}

async function buildFromNodes(nodes) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-header-test-"));
  const inputPath = path.join(tempDir, "semantic.json");
  const orderedNodeIds = nodes.map((n) => n.id);
  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i].readingOrder = i;
  }

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:header-test",
      source: { layoutDocumentId: "layout:header-test" },
      nodes,
      orderedNodeIds
    })
  );

  return buildTagTree(inputPath);
}

test("table with first row all TH creates THead with TH cells", async () => {
  const nodes = [
    makeNode("h1", "TH", "Name", "t1", 0, 0),
    makeNode("h2", "TH", "Age", "t1", 0, 1),
    makeNode("h3", "TH", "City", "t1", 0, 2),
    makeNode("d1", "TD", "Alice", "t1", 1, 0),
    makeNode("d2", "TD", "30", "t1", 1, 1),
    makeNode("d3", "TD", "NYC", "t1", 1, 2)
  ];

  const tagging = await buildFromNodes(nodes);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((c) => c.type), ["THead", "TBody"]);

  const thead = table.children[0];
  assert.equal(thead.children.length, 1);
  assert.equal(thead.children[0].type, "TR");
  assert.deepEqual(thead.children[0].children.map((c) => c.type), ["TH", "TH", "TH"]);
  assert.deepEqual(thead.children[0].children.map((c) => c.label), ["Name", "Age", "City"]);
});

test("table with first row 75% TH is promoted to full THead", async () => {
  const nodes = [
    makeNode("h1", "TH", "Name", "t1", 0, 0),
    makeNode("h2", "TH", "Age", "t1", 0, 1),
    makeNode("h3", "TH", "City", "t1", 0, 2),
    makeNode("h4", "TD", "Notes", "t1", 0, 3),
    makeNode("d1", "TD", "Alice", "t1", 1, 0),
    makeNode("d2", "TD", "30", "t1", 1, 1),
    makeNode("d3", "TD", "NYC", "t1", 1, 2),
    makeNode("d4", "TD", "none", "t1", 1, 3)
  ];

  const tagging = await buildFromNodes(nodes);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((c) => c.type), ["THead", "TBody"]);

  const thead = table.children[0];
  assert.equal(thead.children.length, 1);
  // The TD in THead should have been promoted to TH
  assert.deepEqual(thead.children[0].children.map((c) => c.type), ["TH", "TH", "TH", "TH"]);
  assert.equal(tagging.source.tableStructureRepairs, 1);
});

test("table with TH in column 0 of every row preserves row headers in TBody", async () => {
  const nodes = [
    makeNode("h1", "TH", "Model", "t1", 0, 0),
    makeNode("d1", "TD", "TK4N", "t1", 0, 1),
    makeNode("h2", "TH", "Power", "t1", 1, 0),
    makeNode("d2", "TD", "100-240 VAC", "t1", 1, 1),
    makeNode("h3", "TH", "Weight", "t1", 2, 0),
    makeNode("d3", "TD", "5 kg", "t1", 2, 1)
  ];

  const tagging = await buildFromNodes(nodes);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  // Row-header-only tables should NOT get a THead;
  // they should be body-only (flattened to TR children)
  assert.deepEqual(table.children.map((c) => c.type), ["TR", "TR", "TR"]);
  assert.deepEqual(table.children[0].children.map((c) => c.type), ["TH", "TD"]);
  assert.deepEqual(table.children[1].children.map((c) => c.type), ["TH", "TD"]);
  assert.deepEqual(table.children[2].children.map((c) => c.type), ["TH", "TD"]);
});

test("TD cell in THead is promoted to TH", async () => {
  // Build a table where a TD ends up in THead via explicit section metadata
  const nodes = [
    makeNode("h1", "TH", "Name", "t1", 0, 0, { tableSection: "head" }),
    makeNode("h2", "TD", "Value", "t1", 0, 1, { tableSection: "head" }),
    makeNode("d1", "TD", "Alice", "t1", 1, 0),
    makeNode("d2", "TD", "100", "t1", 1, 1)
  ];

  const tagging = await buildFromNodes(nodes);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((c) => c.type), ["THead", "TBody"]);

  const thead = table.children[0];
  // The TD should have been promoted to TH
  assert.deepEqual(thead.children[0].children.map((c) => c.type), ["TH", "TH"]);
  // The promoted cell should be marked
  const promotedCell = thead.children[0].children[1];
  assert.equal(promotedCell.promotedFromTD, true);
  assert.equal(tagging.source.tableStructureRepairs, 1);
});

test("empty cells are preserved in table structure", async () => {
  const nodes = [
    makeNode("h1", "TH", "Name", "t1", 0, 0),
    makeNode("h2", "TH", "Age", "t1", 0, 1),
    makeNode("d1", "TD", "Alice", "t1", 1, 0),
    makeNode("d2", "TD", "", "t1", 1, 1)
  ];

  const tagging = await buildFromNodes(nodes);
  const table = tagging.root.children[0];
  const tbody = table.children.find((c) => c.type === "TBody") || table.children[1];
  const bodyRow = tbody.children[0];

  // Empty cell should be preserved
  assert.equal(bodyRow.children.length, 2);
  assert.equal(bodyRow.children[1].type, "TD");
  assert.equal(bodyRow.children[1].label, "");
});

test("repeated header rows in TBody are marked with repeatedHeader flag", async () => {
  const nodes = [
    // Header row
    makeNode("h1", "TH", "Name", "t1", 0, 0, { tableSection: "head" }),
    makeNode("h2", "TH", "Value", "t1", 0, 1, { tableSection: "head" }),
    // Body row 1
    makeNode("d1", "TD", "Alpha", "t1", 1, 0),
    makeNode("d2", "TD", "100", "t1", 1, 1),
    // Repeated header (same structure and text as head)
    makeNode("r1", "TH", "Name", "t1", 2, 0),
    makeNode("r2", "TH", "Value", "t1", 2, 1),
    // Body row 2
    makeNode("d3", "TD", "Beta", "t1", 3, 0),
    makeNode("d4", "TD", "200", "t1", 3, 1)
  ];

  const tagging = await buildFromNodes(nodes);
  const table = tagging.root.children[0];
  const tbody = table.children.find((c) => c.type === "TBody");

  assert.ok(tbody, "TBody should exist");
  // The repeated header row should be marked
  const repeatedRow = tbody.children.find((row) => row.repeatedHeader === true);
  assert.ok(repeatedRow, "Should find a row with repeatedHeader flag");
  assert.equal(tagging.source.repeatedHeaderRows, 1);
});
