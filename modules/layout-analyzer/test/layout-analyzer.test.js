import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeLayout } from "../index.js";

test("layout analyzer classifies headings and lists deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "b1", text: "Executive Summary", bbox: [72, 40, 200, 20], fontSize: 24, fontName: "Helvetica-Bold" },
            { id: "b2", text: "This is a paragraph.", bbox: [72, 90, 200, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "b3", text: "- Item one", bbox: [72, 110, 100, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const [heading, paragraph, listItem] = output.pages[0].textBlocks;

  assert.equal(heading.blockType, "heading");
  assert.equal(paragraph.blockType, "paragraph");
  assert.equal(listItem.blockType, "list-item");
  assert.equal(listItem.listStyle, "unordered");
});

test("layout analyzer detects a coherent table band without misclassifying the page as multi-column", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-table-test-"));
  const inputPath = path.join(tempDir, "layout-table.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:table-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "t1", text: "Description", bbox: [72, 60, 110, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "t2", text: "Amount", bbox: [320, 60, 60, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "t3", text: "Apples", bbox: [72, 84, 90, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "t4", text: "$10", bbox: [320, 84, 40, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "p1", text: "Additional note.", bbox: [72, 150, 140, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];

  assert.equal(page.columns, 1);
  assert.equal(page.structureSignals.columnCount, 1);
  assert.equal(page.structureSignals.tableDetected, true);
  assert.equal(page.structureSignals.tableCount, 1);
  assert.equal(page.textBlocks[0].blockType, "table-cell");
  assert.equal(page.textBlocks[0].tableId, "table:1:1");
  assert.equal(page.textBlocks[0].tableRole, "header");
  assert.equal(page.textBlocks[0].tableRowIndex, 0);
  assert.equal(page.textBlocks[1].blockType, "table-cell");
  assert.equal(page.textBlocks[1].tableColumnIndex, 1);
  assert.equal(page.textBlocks[2].tableSection, "body");
  assert.equal(page.textBlocks[4].blockType, "paragraph");
  assert.equal(page.textBlocks[4].columnHint, 0);
});

test("layout analyzer separates distinct tables and preserves header metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-multi-table-test-"));
  const inputPath = path.join(tempDir, "layout-multi-table.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:multi-table-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "a1", text: "Part", bbox: [72, 60, 90, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "a2", text: "Count", bbox: [220, 60, 70, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "a3", text: "Violins", bbox: [72, 84, 90, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "a4", text: "12", bbox: [220, 84, 40, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "b1", text: "Venue", bbox: [72, 220, 90, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "b2", text: "City", bbox: [220, 220, 70, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "b3", text: "Palace", bbox: [72, 244, 90, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "b4", text: "Albany", bbox: [220, 244, 70, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];

  assert.equal(page.structureSignals.tableCount, 2);
  assert.equal(page.textBlocks[0].tableId, "table:1:1");
  assert.equal(page.textBlocks[4].tableId, "table:1:2");
  assert.equal(page.textBlocks[0].tableRole, "header");
  assert.equal(page.textBlocks[4].tableRole, "header");
  assert.equal(page.textBlocks[7].tableSection, "body");
});

test("layout analyzer avoids false-positive tables for aligned label-value rows without a header band", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-non-table-test-"));
  const inputPath = path.join(tempDir, "layout-non-table.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:label-value-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "l1", text: "Name", bbox: [72, 72, 60, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "l2", text: "Albany Symphony", bbox: [220, 72, 140, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "l3", text: "Conductor", bbox: [72, 96, 70, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "l4", text: "David Alan Miller", bbox: [220, 96, 140, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "p1", text: "Program note paragraph.", bbox: [72, 150, 180, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];

  assert.equal(page.structureSignals.tableDetected, false);
  assert.equal(page.textBlocks[0].blockType, "paragraph");
  assert.equal(page.textBlocks[1].blockType, "paragraph");
  assert.equal(page.structureSignals.tableCount, 0);
});

test("layout analyzer fuses ruled-table diagnostics into table spans and header metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-vector-table-test-"));
  const inputPath = path.join(tempDir, "layout.json");
  const tableStructurePath = path.join(tempDir, "table-structure.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:vector-table-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "m1", text: "Revenue Summary", bbox: [145, 89, 135, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "h1", text: "Region", bbox: [88, 113, 50, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "h2", text: "Amount", bbox: [240, 113, 55, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "c1", text: "North", bbox: [88, 137, 46, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "c2", text: "$120", bbox: [240, 137, 32, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "p1", text: "Paragraph below the table.", bbox: [72, 190, 180, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  await writeFile(
    tableStructurePath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      status: "completed",
      pdfPath: "sample.pdf",
      layoutPath: inputPath,
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          vectorSummary: {
            strokedSegmentCount: 7,
            horizontalSegmentCount: 4,
            verticalSegmentCount: 3
          },
          tables: [
            {
              id: "vector-table:1:1",
              source: "vector-grid",
              bbox: [72, 72, 288, 72],
              rowCount: 3,
              columnCount: 2,
              confidence: 0.94,
              assignedBlockIds: ["m1", "h1", "h2", "c1", "c2"],
              mergeSignals: [
                {
                  kind: "colspan",
                  rowIndex: 0,
                  columnIndex: 0,
                  reason: "Missing interior vertical divider segment within ruled grid."
                }
              ],
              cells: [
                {
                  rowIndex: 0,
                  columnIndex: 0,
                  rowSpan: 1,
                  columnSpan: 2,
                  bbox: [72, 72, 288, 24],
                  assignedBlockIds: ["m1"]
                },
                {
                  rowIndex: 1,
                  columnIndex: 0,
                  rowSpan: 1,
                  columnSpan: 1,
                  bbox: [72, 96, 148, 24],
                  assignedBlockIds: ["h1"]
                },
                {
                  rowIndex: 1,
                  columnIndex: 1,
                  rowSpan: 1,
                  columnSpan: 1,
                  bbox: [220, 96, 140, 24],
                  assignedBlockIds: ["h2"]
                },
                {
                  rowIndex: 2,
                  columnIndex: 0,
                  rowSpan: 1,
                  columnSpan: 1,
                  bbox: [72, 120, 148, 24],
                  assignedBlockIds: ["c1"]
                },
                {
                  rowIndex: 2,
                  columnIndex: 1,
                  rowSpan: 1,
                  columnSpan: 1,
                  bbox: [220, 120, 140, 24],
                  assignedBlockIds: ["c2"]
                }
              ]
            }
          ]
        }
      ],
      summary: {
        detectedTables: 1,
        pagesWithTables: 1,
        totalMergeSignals: 1
      }
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath, { tableStructurePath });
  const page = output.pages[0];
  const [mergedHeader, columnHeader, amountHeader, north, amount, paragraph] = page.textBlocks;

  assert.equal(page.structureSignals.vectorTableCount, 1);
  assert.equal(page.structureSignals.tableMergeSignalCount, 1);
  assert.equal(mergedHeader.blockType, "table-cell");
  assert.equal(mergedHeader.tableId, "vector-table:1:1");
  assert.equal(mergedHeader.tableRole, "header");
  assert.equal(mergedHeader.tableColumnSpan, 2);
  assert.equal(columnHeader.tableSection, "head");
  assert.equal(amountHeader.tableRole, "header");
  assert.equal(north.tableSection, "body");
  assert.equal(amount.tableColumnIndex, 1);
  assert.equal(paragraph.blockType, "paragraph");
});

test("layout analyzer records ordered list metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-ordered-list-test-"));
  const inputPath = path.join(tempDir, "layout-ordered-list.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:ordered-list-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "l1", text: "1. First step", bbox: [72, 72, 140, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "l2", text: "2. Second step", bbox: [72, 94, 150, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "p1", text: "Regular paragraph.", bbox: [72, 140, 180, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const [first, second, paragraph] = output.pages[0].textBlocks;

  assert.equal(first.blockType, "list-item");
  assert.equal(first.listStyle, "ordered");
  assert.equal(first.listItemNumber, 1);
  assert.equal(second.listStyle, "ordered");
  assert.equal(second.listItemNumber, 2);
  assert.equal(paragraph.blockType, "paragraph");
  assert.equal(output.pages[0].structureSignals.orderedListItemCount, 2);
});
