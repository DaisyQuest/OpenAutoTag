import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSemanticDocument } from "../index.js";

function makeLayout(pages, docId = "layout:test") {
  return {
    schemaVersion: "1.0.0",
    documentId: docId,
    source: { filePath: "test.pdf", pageCount: pages.length },
    pages
  };
}

function makeCell(id, x, y, text, extras = {}) {
  return {
    id,
    text,
    bbox: [x, y, 100, 12],
    fontSize: 11,
    fontName: "Helvetica",
    blockType: "table-cell",
    ...extras
  };
}

test("table continues across pages when column anchors match", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "table-cont-"));
  const inputPath = path.join(tempDir, "layout.json");

  // Page 1: cells have explicit tableId (as layout analyzer would produce)
  // Page 2: cells at matching x-positions but no explicit tableId
  const layout = makeLayout([
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b1", 72, 700, "Name", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 0 }),
        makeCell("b2", 300, 700, "Value", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 1 })
      ]
    },
    {
      pageNumber: 2,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b3", 72, 100, "Alice", { tableRowIndex: 1, tableColumnIndex: 0 }),
        makeCell("b4", 300, 100, "42", { tableRowIndex: 1, tableColumnIndex: 1 })
      ]
    }
  ]);

  await writeFile(inputPath, JSON.stringify(layout, null, 2));
  const semantic = await buildSemanticDocument(inputPath);

  const tableIds = semantic.nodes.map((n) => n.tableId).filter(Boolean);
  const uniqueIds = [...new Set(tableIds)];
  // All four cells should share the same tableId
  assert.equal(uniqueIds.length, 1, `Expected 1 unique tableId, got: ${uniqueIds}`);
  assert.equal(semantic.nodes[0].tableId, semantic.nodes[2].tableId);
});

test("table does NOT continue across pages when column anchors do not match", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "table-nocont-"));
  const inputPath = path.join(tempDir, "layout.json");

  const layout = makeLayout([
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b1", 72, 700, "Col A", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 0 }),
        makeCell("b2", 300, 700, "Col B", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 1 })
      ]
    },
    {
      pageNumber: 2,
      width: 612,
      height: 792,
      textBlocks: [
        // Completely different x-positions - should NOT match
        makeCell("b3", 400, 100, "Other", { tableRowIndex: 0, tableColumnIndex: 0 }),
        makeCell("b4", 550, 100, "Data", { tableRowIndex: 0, tableColumnIndex: 1 })
      ]
    }
  ]);

  await writeFile(inputPath, JSON.stringify(layout, null, 2));
  const semantic = await buildSemanticDocument(inputPath);

  const page1Ids = semantic.nodes.filter((n) => n.pageNumber === 1).map((n) => n.tableId);
  const page2Ids = semantic.nodes.filter((n) => n.pageNumber === 2).map((n) => n.tableId);

  // Page 1 and Page 2 should have different tableIds
  assert.notEqual(page1Ids[0], page2Ids[0], "Tables with non-matching columns should get different tableIds");
});

test("table with header on page 1 continues on page 2 with correct row indices", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "table-header-"));
  const inputPath = path.join(tempDir, "layout.json");

  const layout = makeLayout([
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b1", 72, 200, "Name", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 0, tableRole: "header" }),
        makeCell("b2", 300, 200, "Score", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 1, tableRole: "header" }),
        makeCell("b3", 72, 220, "Alice", { tableId: "tbl-1", tableRowIndex: 1, tableColumnIndex: 0 }),
        makeCell("b4", 300, 220, "95", { tableId: "tbl-1", tableRowIndex: 1, tableColumnIndex: 1 }),
        makeCell("b5", 72, 240, "Bob", { tableId: "tbl-1", tableRowIndex: 2, tableColumnIndex: 0 }),
        makeCell("b6", 300, 240, "87", { tableId: "tbl-1", tableRowIndex: 2, tableColumnIndex: 1 })
      ]
    },
    {
      pageNumber: 2,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b7", 72, 100, "Charlie", { tableRowIndex: 3, tableColumnIndex: 0 }),
        makeCell("b8", 300, 100, "92", { tableRowIndex: 3, tableColumnIndex: 1 }),
        makeCell("b9", 72, 120, "Diana", { tableRowIndex: 4, tableColumnIndex: 0 }),
        makeCell("b10", 300, 120, "88", { tableRowIndex: 4, tableColumnIndex: 1 })
      ]
    }
  ]);

  await writeFile(inputPath, JSON.stringify(layout, null, 2));
  const semantic = await buildSemanticDocument(inputPath);

  const tableNodes = semantic.nodes.filter((n) => n.tableId);
  const uniqueTableIds = new Set(tableNodes.map((n) => n.tableId));

  // All cells should share the same tableId
  assert.equal(uniqueTableIds.size, 1, `Expected 1 table, got ${uniqueTableIds.size}: ${[...uniqueTableIds]}`);

  // Row indices should be preserved across pages
  const page2Nodes = tableNodes.filter((n) => n.pageNumber === 2);
  assert.equal(page2Nodes[0].tableRowIndex, 3);
  assert.equal(page2Nodes[1].tableRowIndex, 3);
  assert.equal(page2Nodes[2].tableRowIndex, 4);
  assert.equal(page2Nodes[3].tableRowIndex, 4);
});

test("cross-page continuation can be disabled via tableContinuationAcrossPages option", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "table-disabled-"));
  const inputPath = path.join(tempDir, "layout.json");

  const layout = makeLayout([
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b1", 72, 700, "Name", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 0 }),
        makeCell("b2", 300, 700, "Value", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 1 })
      ]
    },
    {
      pageNumber: 2,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b3", 72, 100, "Alice", { tableRowIndex: 1, tableColumnIndex: 0 }),
        makeCell("b4", 300, 100, "42", { tableRowIndex: 1, tableColumnIndex: 1 })
      ]
    }
  ]);

  await writeFile(inputPath, JSON.stringify(layout, null, 2));
  const semantic = await buildSemanticDocument(inputPath, { tableContinuationAcrossPages: false });

  const page1Ids = semantic.nodes.filter((n) => n.pageNumber === 1).map((n) => n.tableId);
  const page2Ids = semantic.nodes.filter((n) => n.pageNumber === 2).map((n) => n.tableId);

  // With continuation disabled, tables should be separate
  assert.notEqual(page1Ids[0], page2Ids[0], "Tables should be separate when continuation is disabled");
});

test("repeated header row on page 2 is detected", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "table-repheader-"));
  const inputPath = path.join(tempDir, "layout.json");

  const layout = makeLayout([
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      textBlocks: [
        makeCell("b1", 72, 200, "Name", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 0, tableRole: "header" }),
        makeCell("b2", 300, 200, "Score", { tableId: "tbl-1", tableRowIndex: 0, tableColumnIndex: 1, tableRole: "header" }),
        makeCell("b3", 72, 220, "Alice", { tableId: "tbl-1", tableRowIndex: 1, tableColumnIndex: 0 }),
        makeCell("b4", 300, 220, "95", { tableId: "tbl-1", tableRowIndex: 1, tableColumnIndex: 1 })
      ]
    },
    {
      pageNumber: 2,
      width: 612,
      height: 792,
      textBlocks: [
        // Repeated header row
        makeCell("b5", 72, 100, "Name", { tableRowIndex: 2, tableColumnIndex: 0, tableRole: "header" }),
        makeCell("b6", 300, 100, "Score", { tableRowIndex: 2, tableColumnIndex: 1, tableRole: "header" }),
        makeCell("b7", 72, 120, "Bob", { tableRowIndex: 3, tableColumnIndex: 0 }),
        makeCell("b8", 300, 120, "87", { tableRowIndex: 3, tableColumnIndex: 1 })
      ]
    }
  ]);

  await writeFile(inputPath, JSON.stringify(layout, null, 2));
  const semantic = await buildSemanticDocument(inputPath);

  const tableNodes = semantic.nodes.filter((n) => n.tableId);
  const uniqueTableIds = new Set(tableNodes.map((n) => n.tableId));

  // All should be the same table
  assert.equal(uniqueTableIds.size, 1, `Expected 1 table, got ${[...uniqueTableIds]}`);

  // The repeated header cells on page 2 should be marked
  const page2Headers = tableNodes.filter((n) => n.pageNumber === 2 && n.repeatedHeader);
  assert.equal(page2Headers.length, 2, "Both repeated header cells should be marked");
  assert.equal(page2Headers[0].tableSection, "THead");
  assert.equal(page2Headers[1].tableSection, "THead");
});
