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

test("layout analyzer marks Federal Register publication notice as an artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-fr-stamp-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:fr-stamp",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "s1", text: "This document is scheduled to be published in the", bbox: [220, 16, 175, 8], fontSize: 7.5, fontName: "Helvetica" },
            { id: "s2", text: "Federal Register on 2026-04-20 and available online at", bbox: [220, 27, 189, 8], fontSize: 7.5, fontName: "Helvetica" },
            { id: "s3", text: "https://www.federalregister.gov/d/2026-07663, and on", bbox: [220, 37, 201, 8], fontSize: 7.5, fontName: "Helvetica" },
            { id: "b1", text: "Billing Code: 4410-13", bbox: [72, 35, 108, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "b2", text: "DEPARTMENT OF JUSTICE", bbox: [72, 63, 159, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const stampBlocks = page.textBlocks.filter((block) => block.id.startsWith("s"));
  const bodyBlock = page.textBlocks.find((block) => block.id === "b1");

  assert.equal(stampBlocks.length, 3);
  assert.ok(stampBlocks.every((block) => block.isArtifact === true));
  assert.ok(stampBlocks.every((block) => block.artifactReason === "federal-register-publication-stamp"));
  assert.equal(bodyBlock.isArtifact, undefined);
});

test("layout analyzer normalizes sparse numeric multi-row headers into leaf column headers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-sparse-header-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  const row = (prefix, y, values) =>
    values.map(([text, x, width], index) => ({
      id: `${prefix}${index}`,
      text,
      bbox: [x, y, width, 11],
      fontSize: 10,
      fontName: "Helvetica"
    }));

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:sparse-header",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            {
              id: "caption-continuation",
              text: "implementation delay (in millions of dollars).",
              bbox: [79.2, 121.2, 200.4, 11],
              fontSize: 10,
              fontName: "Helvetica"
            },
            { id: "h1", text: "Status Quo", bbox: [164.5, 136.8, 48.6, 11], fontSize: 10, fontName: "Helvetica" },
            { id: "h2", text: "IFR", bbox: [324.2, 136.8, 17.1, 11], fontSize: 10, fontName: "Helvetica" },
            { id: "h3", text: "Cost Savings", bbox: [447.9, 136.8, 57.8, 11], fontSize: 10, fontName: "Helvetica" },
            {
              id: "h4",
              text: "Year Undiscounted Discounted Undiscounted Discounted Undiscounted Discounted",
              bbox: [80.4, 152.3, 457.4, 11],
              fontSize: 10,
              fontName: "Helvetica"
            },
            ...row("r1-", 167.8, [
              ["1", 91.8, 5.5],
              ["$16,949", 134.9, 35.8],
              ["$15,840", 206.9, 35.8],
              ["$0", 291.3, 11],
              ["$0", 363.3, 11],
              ["-$16,949", 421, 39.4],
              ["-$15,840", 493, 39.4]
            ]),
            ...row("r2-", 183.3, [
              ["2", 91.8, 5.5],
              ["$1,990", 137.6, 30.3],
              ["$1,738", 209.6, 30.3],
              ["$16,949", 278.9, 35.8],
              ["$14,804", 350.9, 35.8],
              ["$14,959", 422.9, 35.8],
              ["$13,066", 494.9, 35.7]
            ]),
            ...row("r3-", 198.8, [
              ["3", 91.8, 5.5],
              ["$1,990", 137.6, 30.3],
              ["$1,625", 209.6, 30.3],
              ["$1,990", 281.6, 30.3],
              ["$1,625", 353.6, 30.3],
              ["$0", 435.3, 11],
              ["$0", 507.3, 11]
            ])
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const headerBlocks = page.textBlocks.filter(
    (block) => block.tableId === "table:1:sparse-numeric:1" && block.tableRole === "header"
  );

  assert.equal(page.structureSignals.sparseNumericTableCount, 1);
  assert.deepEqual(
    headerBlocks.map((block) => block.text),
    [
      "Year",
      "Status Quo Undiscounted",
      "Status Quo Discounted",
      "IFR Undiscounted",
      "IFR Discounted",
      "Cost Savings Undiscounted",
      "Cost Savings Discounted"
    ]
  );
  assert.ok(headerBlocks.every((block, index) => block.synthetic === true && block.tableColumnIndex === index));
  assert.equal(page.textBlocks.some((block) => block.id === "h4"), false);
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

test("borderless table detection: 3 rows of 3 aligned columns with tight spacing detected via borderless path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-borderless-test-"));
  const inputPath = path.join(tempDir, "layout-borderless.json");

  // Use tight column spacing (gaps < 14px) so text-grid buildCandidateRows rejects
  // these rows (its gap filter requires gap >= max(14, fontSize*0.8) = 14).
  // Borderless detector has no such gap filter.
  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:borderless-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "r1c1", text: "Name", bbox: [72, 100, 115, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "r1c2", text: "Department", bbox: [192, 100, 115, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "r1c3", text: "Salary", bbox: [312, 100, 80, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "r2c1", text: "Alice", bbox: [72, 120, 115, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "r2c2", text: "Engineering", bbox: [192, 120, 115, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "r2c3", text: "$95,000", bbox: [312, 120, 80, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "r3c1", text: "Bob", bbox: [72, 140, 115, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "r3c2", text: "Marketing", bbox: [192, 140, 115, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "r3c3", text: "$78,000", bbox: [312, 140, 80, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];

  assert.equal(page.structureSignals.tableDetected, true);
  assert.equal(page.structureSignals.borderlessTableCount >= 1, true, `Expected borderless table count >= 1, got ${page.structureSignals.borderlessTableCount}`);

  const tableCells = page.textBlocks.filter((block) => block.blockType === "table-cell");
  assert.equal(tableCells.length >= 6, true, `Expected at least 6 table cells, got ${tableCells.length}`);

  // Verify detection method is borderless-alignment
  const borderlessCells = tableCells.filter((block) => block.tableDetectionMethod === "borderless-alignment");
  assert.equal(borderlessCells.length >= 6, true, `Expected borderless-alignment cells, got ${borderlessCells.length}`);
});

test("borderless table detection: correct tableRowIndex and tableColumnIndex assignment for 2 rows x 3 columns", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-borderless-idx-test-"));
  const inputPath = path.join(tempDir, "layout-borderless-idx.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:borderless-idx-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "h1", text: "Item", bbox: [72, 100, 80, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "h2", text: "Quantity", bbox: [200, 100, 70, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "h3", text: "Price", bbox: [350, 100, 50, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "d1", text: "Widget", bbox: [72, 120, 70, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "d2", text: "50", bbox: [200, 120, 30, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "d3", text: "$12.99", bbox: [350, 120, 55, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((block) => [block.id, block]));

  // Header row
  assert.equal(blockById.get("h1").tableRowIndex, 0);
  assert.equal(blockById.get("h1").tableColumnIndex, 0);
  assert.equal(blockById.get("h2").tableRowIndex, 0);
  assert.equal(blockById.get("h2").tableColumnIndex, 1);
  assert.equal(blockById.get("h3").tableRowIndex, 0);
  assert.equal(blockById.get("h3").tableColumnIndex, 2);

  // Data row
  assert.equal(blockById.get("d1").tableRowIndex, 1);
  assert.equal(blockById.get("d1").tableColumnIndex, 0);
  assert.equal(blockById.get("d2").tableRowIndex, 1);
  assert.equal(blockById.get("d2").tableColumnIndex, 1);
  assert.equal(blockById.get("d3").tableRowIndex, 1);
  assert.equal(blockById.get("d3").tableColumnIndex, 2);
});

test("borderless table detection: single data row with header above is detected as 2-row table", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-borderless-header-test-"));
  const inputPath = path.join(tempDir, "layout-borderless-header.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:borderless-header-sample",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "h1", text: "Category", bbox: [72, 80, 80, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "h2", text: "Value", bbox: [250, 80, 50, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "h3", text: "Status", bbox: [400, 80, 50, 12], fontSize: 12, fontName: "Helvetica-Bold" },
            { id: "d1", text: "Revenue", bbox: [72, 100, 70, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "d2", text: "$1.2M", bbox: [250, 100, 50, 12], fontSize: 12, fontName: "Helvetica" },
            { id: "d3", text: "Active", bbox: [400, 100, 50, 12], fontSize: 12, fontName: "Helvetica" }
          ]
        }
      ]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];

  assert.equal(page.structureSignals.tableDetected, true);

  const tableCells = page.textBlocks.filter((block) => block.blockType === "table-cell");
  assert.equal(tableCells.length, 6, `Expected 6 table cells (header + 1 data row), got ${tableCells.length}`);

  const blockById = new Map(page.textBlocks.map((block) => [block.id, block]));
  assert.equal(blockById.get("h1").tableRole, "header");
  assert.equal(blockById.get("h1").tableSection, "head");
  assert.equal(blockById.get("d1").tableRole, "cell");
  assert.equal(blockById.get("d1").tableSection, "body");
  assert.equal(blockById.get("d1").tableRowIndex, 1);
});

// Profile-plumbing regression. Originally the layout analyzer had
// hardcoded thresholds (0.16 column gap, 1.55/1.3/1.9 heading scores),
// and profiles that set e.g. columnGapThresholdPercent=0.12 were
// silently ignored — confirmed by A/B pipeline comparisons producing
// byte-identical output for default vs legal/scientific/cjk/forms-heavy
// profiles. This test pins that the env-var overrides actually change
// behavior.
test("layout analyzer respects LAYOUT_HEADING_SCORE_THRESHOLD env override", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-threshold-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  // Body blocks at 10pt set the baseline via median; the candidate
  // heading at 14pt yields a 1.4× score — below the default 1.55
  // heading threshold (so classified as paragraph), above a relaxed
  // 1.35 threshold (so classified as heading).
  const doc = {
    schemaVersion: "1.0.0",
    documentId: "layout:threshold",
    source: { filePath: "sample.pdf", pageCount: 1 },
    pages: [{
      pageNumber: 1,
      width: 612,
      height: 792,
      textBlocks: [
        { id: "p1", text: "First paragraph at baseline font.", bbox: [72, 40, 400, 12], fontSize: 10, fontName: "Helvetica" },
        { id: "p2", text: "Second paragraph at baseline font.", bbox: [72, 56, 400, 12], fontSize: 10, fontName: "Helvetica" },
        { id: "p3", text: "Third paragraph at baseline font.", bbox: [72, 72, 400, 12], fontSize: 10, fontName: "Helvetica" },
        { id: "p4", text: "Fourth paragraph at baseline font.", bbox: [72, 88, 400, 12], fontSize: 10, fontName: "Helvetica" },
        { id: "h1", text: "Medium subheading", bbox: [72, 110, 200, 14], fontSize: 14, fontName: "Helvetica" }
      ]
    }]
  };
  await writeFile(inputPath, JSON.stringify(doc));

  const originalHeading = process.env.LAYOUT_HEADING_SCORE_THRESHOLD;
  try {
    delete process.env.LAYOUT_HEADING_SCORE_THRESHOLD;
    const defaultOutput = await analyzeLayout(inputPath);
    const h1Default = defaultOutput.pages[0].textBlocks.find((b) => b.id === "h1");
    assert.equal(h1Default.blockType, "paragraph",
      "baseline: 1.4× score is below default 1.55 heading threshold");

    process.env.LAYOUT_HEADING_SCORE_THRESHOLD = "1.35";
    const relaxedOutput = await analyzeLayout(inputPath);
    const h1Relaxed = relaxedOutput.pages[0].textBlocks.find((b) => b.id === "h1");
    assert.equal(h1Relaxed.blockType, "heading",
      "with LAYOUT_HEADING_SCORE_THRESHOLD=1.35, 1.4× score is a heading");
  } finally {
    if (originalHeading == null) delete process.env.LAYOUT_HEADING_SCORE_THRESHOLD;
    else process.env.LAYOUT_HEADING_SCORE_THRESHOLD = originalHeading;
  }
});

test("layout analyzer detects header row when header font differs from data font (font-name distinctiveness)", async () => {
  // Simulates Autonics-style PDFs where headers use an obfuscated font like
  // g_d0_f1 while data rows use g_d0_f2 / g_d0_f9, with no "Bold" in the name.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-font-header-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:font-header",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 595,
        height: 842,
        textBlocks: [
          // Header row uses font g_d0_f1 (same size as data, no "Bold" in name)
          { id: "h1", text: "Parameter", bbox: [119, 181, 49, 10], fontSize: 10.0, fontName: "g_d0_f1" },
          { id: "h2", text: "Description", bbox: [194, 181, 55, 10], fontSize: 10.0, fontName: "g_d0_f1" },
          // Data rows use different fonts g_d0_f9 and g_d0_f2
          { id: "d1", text: "RAMU", bbox: [119, 195, 24, 9], fontSize: 9.5, fontName: "g_d0_f9" },
          { id: "d2", text: "Settings for Ramp-up change rate.", bbox: [194, 195, 145, 9], fontSize: 9.5, fontName: "g_d0_f2" },
          { id: "d3", text: "RAMD", bbox: [119, 211, 24, 9], fontSize: 9.5, fontName: "g_d0_f9" },
          { id: "d4", text: "Settings for Ramp-down change rate.", bbox: [194, 211, 157, 9], fontSize: 9.5, fontName: "g_d0_f2" },
          { id: "d5", text: "rUNT", bbox: [119, 226, 24, 9], fontSize: 9.5, fontName: "g_d0_f9" },
          { id: "d6", text: "Settings for Ramp time unit.", bbox: [194, 226, 117, 9], fontSize: 9.5, fontName: "g_d0_f2" }
        ]
      }]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((b) => [b.id, b]));

  assert.equal(page.structureSignals.tableDetected, true, "table should be detected");
  assert.equal(blockById.get("h1").tableRole, "header", "h1 should be header");
  assert.equal(blockById.get("h2").tableRole, "header", "h2 should be header");
  assert.equal(blockById.get("d1").tableRole, "cell", "d1 should be cell");
  assert.equal(page.structureSignals.tableHeaderRowCount, 1, "one header row");
});

test("layout analyzer detects header row when header is 5% larger (10pt over 9.5pt baseline)", async () => {
  // Autonics-style PDFs: header rows at 10pt, body rows at 9.5pt, same font family.
  // Old threshold 1.08 rejected this (10/9.5=1.053 < 1.08); new 1.03 accepts it.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-fontsize-header-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:fontsize-header",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 595,
        height: 842,
        textBlocks: [
          // Header at 10pt
          { id: "h1", text: "Display", bbox: [105, 393, 49, 10], fontSize: 10.0, fontName: "Helvetica" },
          { id: "h2", text: "Parameter Description", bbox: [215, 393, 107, 10], fontSize: 10.0, fontName: "Helvetica" },
          // Data at 9.5pt (same font family — no "Bold", no size jump > 8%)
          { id: "d1", text: "L-SV", bbox: [105, 407, 24, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d2", text: "Set value low-limit", bbox: [215, 407, 96, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d3", text: "H-SV", bbox: [105, 422, 24, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d4", text: "Set value high-limit", bbox: [215, 422, 99, 9], fontSize: 9.5, fontName: "Helvetica" }
        ]
      }]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((b) => [b.id, b]));

  assert.equal(page.structureSignals.tableDetected, true, "table should be detected");
  assert.equal(blockById.get("h1").tableRole, "header", "h1 should be header");
  assert.equal(blockById.get("h2").tableRole, "header", "h2 should be header");
  assert.equal(page.structureSignals.tableHeaderRowCount, 1, "one header row");
});

test("layout analyzer detects header with single-letter and Unicode-symbol column labels", async () => {
  // Autonics-style multi-column headers that use single Latin letters (e.g. 'A','B')
  // and Unicode temperature symbols like '(℃)' and '(℉)' as column labels.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-unicode-header-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:unicode-header",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 595,
        height: 842,
        textBlocks: [
          // Header row contains single-char and Unicode-symbol labels
          { id: "h1", text: "Display", bbox: [105, 181, 60, 10], fontSize: 10.0, fontName: "Helvetica" },
          { id: "h2", text: "(℃)", bbox: [215, 181, 24, 10], fontSize: 10.0, fontName: "Helvetica" },
          { id: "h3", text: "(℉)", bbox: [315, 181, 24, 10], fontSize: 10.0, fontName: "Helvetica" },
          // Data rows at 9.5pt
          { id: "d1", text: "1", bbox: [105, 195, 10, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d2", text: "-200 to 1350", bbox: [215, 195, 80, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d3", text: "-328 to 2462", bbox: [315, 195, 80, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d4", text: "0.1", bbox: [105, 210, 14, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d5", text: "-199.9 to 999.9", bbox: [215, 210, 90, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d6", text: "-199.9 to 999.9", bbox: [315, 210, 90, 9], fontSize: 9.5, fontName: "Helvetica" }
        ]
      }]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((b) => [b.id, b]));

  assert.equal(page.structureSignals.tableDetected, true, "table should be detected");
  assert.equal(blockById.get("h1").tableRole, "header", "Display should be header");
  assert.equal(blockById.get("h2").tableRole, "header", "(℃) should be header");
  assert.equal(blockById.get("h3").tableRole, "header", "(℉) should be header");
  assert.equal(page.structureSignals.tableHeaderRowCount, 1, "one header row");
});

test("layout analyzer detects narrow 2-column table whose anchor span is smaller than page.width*0.14", async () => {
  // Reproduces the Autonics page 67 'Parameter | Description' table:
  // anchors at x=119 and x=194 → anchor-span = 75px, but page.width*0.14 ≈ 83px.
  // The visual row span (right - left) is 219px, which clears the gate once we
  // use Math.max(anchor_span, visual_row_span) for horizontalSpan.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-narrow-table-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:narrow-table",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 595,
        height: 842,
        textBlocks: [
          // Header row: anchor span 194-119=75px < page.width*0.14≈83px
          // but visual span 194+55-119=130px clears the gate
          { id: "h1", text: "Parameter", bbox: [119, 181, 49, 10], fontSize: 10.0, fontName: "Helvetica-Bold" },
          { id: "h2", text: "Description", bbox: [194, 181, 55, 10], fontSize: 10.0, fontName: "Helvetica-Bold" },
          { id: "d1", text: "RAMU", bbox: [119, 195, 24, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d2", text: "Set the ramp-up rate.", bbox: [194, 195, 90, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d3", text: "RAMD", bbox: [119, 211, 24, 9], fontSize: 9.5, fontName: "Helvetica" },
          { id: "d4", text: "Set the ramp-down rate.", bbox: [194, 211, 100, 9], fontSize: 9.5, fontName: "Helvetica" }
        ]
      }]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((b) => [b.id, b]));

  assert.equal(page.structureSignals.tableDetected, true, "narrow table should be detected");
  assert.equal(blockById.get("h1").blockType, "table-cell", "h1 should be table-cell");
  assert.equal(blockById.get("h1").tableRole, "header", "h1 should be header");
  assert.equal(blockById.get("d1").blockType, "table-cell", "d1 should be table-cell");
  assert.equal(page.structureSignals.tableHeaderRowCount, 1, "one header row");
});

test("orphan adoption: wide merged column-header block above table is tagged as spanning header", async () => {
  // Reproduces the 'irregulartable-badheaders.pdf' pattern where all 7 column
  // labels were merged by the parser into a single wide text block that exceeds
  // the text.length and width filters of buildCandidateRows.  The adoption pass
  // (Pass B) must tag it as a col0/span7 header row prepended before the data.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-orphan-merged-header-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:orphan-merged-header",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          // Merged column-header row: 7 labels in one wide block (exceeds 64-char / 68%-width filters)
          { id: "hdr", text: "Year Undiscounted Discounted Undiscounted Discounted Undiscounted Discounted",
            bbox: [80, 152, 457, 11], fontSize: 12, fontName: "Helvetica" },
          // Data rows – 7 narrow columns
          { id: "d1c0", text: "1",        bbox: [92,  168, 6,  11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c1", text: "$16,949",  bbox: [135, 168, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c2", text: "$15,840",  bbox: [207, 168, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c3", text: "$0",       bbox: [291, 168, 11, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c4", text: "$0",       bbox: [363, 168, 11, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c5", text: "-$16,949", bbox: [421, 168, 39, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c6", text: "-$15,840", bbox: [493, 168, 39, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c0", text: "2",        bbox: [92,  184, 6,  11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c1", text: "$1,990",   bbox: [135, 184, 30, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c2", text: "$1,738",   bbox: [207, 184, 30, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c3", text: "$16,949",  bbox: [291, 184, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c4", text: "$14,804",  bbox: [363, 184, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c5", text: "$14,959",  bbox: [421, 184, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c6", text: "$13,066",  bbox: [493, 184, 36, 11], fontSize: 12, fontName: "Helvetica" }
        ]
      }]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((b) => [b.id, b]));

  assert.equal(page.structureSignals.tableDetected, true, "table should be detected");

  const hdr = blockById.get("hdr");
  assert.equal(hdr.blockType, "table-cell", "merged header block should become table-cell");
  assert.equal(hdr.tableRole, "header", "merged header should have role=header");
  assert.equal(hdr.tableColumnIndex, 0, "merged header should start at column 0");
  assert.equal(hdr.tableColumnSpan, 7, "merged header should span all 7 columns");
  assert.equal(hdr.tableRowIndex, 0, "merged header row should be row 0");

  // Data rows must be shifted up by 1 (one pre-header row inserted)
  assert.equal(blockById.get("d1c0").tableRowIndex, 1, "first data row should be row 1");
  assert.equal(blockById.get("d2c0").tableRowIndex, 2, "second data row should be row 2");
  assert.equal(page.structureSignals.tableHeaderRowCount, 1, "should count 1 header row");
});

test("orphan adoption: spanner header cells above table are tagged with correct column spans", async () => {
  // Reproduces the 'Status Quo / IFR / Cost Savings' pattern where each spanner
  // header is centred over 2 data columns but does not left-align with any
  // individual column anchor so it is rejected by areRowsCompatible.
  // Pass B must tag: Status Quo → col1/span2, IFR → col3/span2, Cost Savings → col5/span2.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-orphan-spanner-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:orphan-spanner",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          // Spanner row (y=137): cells centred over pairs of data columns
          { id: "sq",  text: "Status Quo",   bbox: [164, 137, 49, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "ifr", text: "IFR",          bbox: [324, 137, 17, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "cs",  text: "Cost Savings", bbox: [448, 137, 58, 11], fontSize: 12, fontName: "Helvetica" },
          // Data rows (col0=Year, col1-2=SQ, col3-4=IFR, col5-6=CS)
          { id: "d1c0", text: "1",        bbox: [92,  168, 6,  11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c1", text: "$16,949",  bbox: [135, 168, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c2", text: "$15,840",  bbox: [207, 168, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c3", text: "$0",       bbox: [291, 168, 11, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c4", text: "$0",       bbox: [363, 168, 11, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c5", text: "-$16,949", bbox: [421, 168, 39, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c6", text: "-$15,840", bbox: [493, 168, 39, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c0", text: "2",        bbox: [92,  184, 6,  11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c1", text: "$1,990",   bbox: [135, 184, 30, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c2", text: "$1,738",   bbox: [207, 184, 30, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c3", text: "$16,949",  bbox: [291, 184, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c4", text: "$14,804",  bbox: [363, 184, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c5", text: "$14,959",  bbox: [421, 184, 36, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c6", text: "$13,066",  bbox: [493, 184, 36, 11], fontSize: 12, fontName: "Helvetica" }
        ]
      }]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((b) => [b.id, b]));

  assert.equal(page.structureSignals.tableDetected, true, "table should be detected");

  const sqBlock = blockById.get("sq");
  assert.equal(sqBlock.blockType, "table-cell", "Status Quo should be table-cell");
  assert.equal(sqBlock.tableRole, "header", "Status Quo should be header");
  assert.equal(sqBlock.tableColumnIndex, 1, "Status Quo should start at column 1");
  assert.equal(sqBlock.tableColumnSpan, 2, "Status Quo should span 2 columns");

  const ifrBlock = blockById.get("ifr");
  assert.equal(ifrBlock.blockType, "table-cell", "IFR should be table-cell");
  assert.equal(ifrBlock.tableRole, "header", "IFR should be header");
  assert.equal(ifrBlock.tableColumnIndex, 3, "IFR should start at column 3");
  assert.equal(ifrBlock.tableColumnSpan, 2, "IFR should span 2 columns");

  const csBlock = blockById.get("cs");
  assert.equal(csBlock.blockType, "table-cell", "Cost Savings should be table-cell");
  assert.equal(csBlock.tableRole, "header", "Cost Savings should be header");
  assert.equal(csBlock.tableColumnIndex, 5, "Cost Savings should start at column 5");
  assert.equal(csBlock.tableColumnSpan, 2, "Cost Savings should span 2 columns");

  // Existing data rows must be shifted by 1 (one spanner row inserted)
  assert.equal(blockById.get("d1c0").tableRowIndex, 1, "first data row should shift to row 1");
  assert.equal(page.structureSignals.tableHeaderRowCount, 1, "should count 1 header row");
});

test("orphan adoption: same-row header cell offset from column anchor is adopted (Pass A)", async () => {
  // Reproduces the 'Metric' cell pattern: the leftmost column header appears at
  // x=140 while the data cells in that column start at x=79-95 (anchor ≈ 85).
  // The gap (55 px) exceeds the normal tolerance (≈41 px), so assignItemsToAnchors
  // misses it.  Pass A of adoptOrphanTableBlocks must adopt it as col0/header.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "layout-orphan-passA-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:orphan-passA",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          // Header row: col0 label is indented 55 px right of the data column anchor
          { id: "h0", text: "Metric",          bbox: [140, 526, 29, 11], fontSize: 12, fontName: "Helvetica-Bold" },
          { id: "h1", text: "All Entities",    bbox: [263, 526, 50, 11], fontSize: 12, fontName: "Helvetica-Bold" },
          { id: "h2", text: "Small Entities",  bbox: [358, 526, 62, 11], fontSize: 12, fontName: "Helvetica-Bold" },
          { id: "h3", text: "Small Entity Share", bbox: [448, 526, 83, 11], fontSize: 12, fontName: "Helvetica-Bold" },
          // Data rows – col0 data cells left-align at x≈80-95 (anchor ≈ 85)
          { id: "d1c0", text: "Original 10-year total costs",     bbox: [95, 546, 120, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c1", text: "$24,688 million",                  bbox: [253, 546, 70, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c2", text: "$13,095 million",                  bbox: [354, 546, 70, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d1c3", text: "53.0%",                            bbox: [448, 546, 28, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c0", text: "10-year PV savings",               bbox: [80, 562, 241, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c1", text: "$1,472 million",                   bbox: [253, 562, 65, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c2", text: "N/A",                              bbox: [354, 562, 28, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d2c3", text: "53.0%",                            bbox: [448, 562, 28, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d3c0", text: "Annualized savings",               bbox: [79, 578, 151, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d3c1", text: "$395 million",                     bbox: [253, 578, 57, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d3c2", text: "$210 million",                     bbox: [354, 578, 57, 11], fontSize: 12, fontName: "Helvetica" },
          { id: "d3c3", text: "53.0%",                            bbox: [448, 578, 28, 11], fontSize: 12, fontName: "Helvetica" }
        ]
      }]
    }, null, 2)
  );

  const output = await analyzeLayout(inputPath);
  const page = output.pages[0];
  const blockById = new Map(page.textBlocks.map((b) => [b.id, b]));

  assert.equal(page.structureSignals.tableDetected, true, "table should be detected");

  const metricBlock = blockById.get("h0");
  assert.equal(metricBlock.blockType, "table-cell", "Metric should be table-cell");
  assert.equal(metricBlock.tableRole, "header", "Metric should be header");
  assert.equal(metricBlock.tableColumnIndex, 0, "Metric should be in column 0");

  // Other header cells are detected normally
  assert.equal(blockById.get("h1").tableRole, "header", "All Entities should be header");
  assert.equal(blockById.get("h1").tableColumnIndex, 1, "All Entities should be column 1");

  // Data rows must not be re-indexed (no above-table orphans; Pass A only adds a missing cell)
  assert.equal(blockById.get("d1c0").tableRowIndex, 1, "first data row should be row 1");
  assert.equal(page.structureSignals.tableHeaderRowCount, 1, "one header row");
});
