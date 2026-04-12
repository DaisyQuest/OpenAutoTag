import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assignReadingOrder } from "../index.js";

test("reading-order respects columns before right-column content", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "order-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:sample",
      source: { layoutDocumentId: "layout:sample" },
      nodes: [
        { id: "a", pageNumber: 1, sourceBlockId: "b1", role: "P", text: "left 1", bbox: [72, 100, 10, 10], columnHint: 0, confidence: 0.9 },
        { id: "b", pageNumber: 1, sourceBlockId: "b2", role: "P", text: "right 1", bbox: [330, 20, 10, 10], columnHint: 1, confidence: 0.9 },
        { id: "c", pageNumber: 1, sourceBlockId: "b3", role: "P", text: "left 2", bbox: [72, 200, 10, 10], columnHint: 0, confidence: 0.9 }
      ]
    }, null, 2)
  );

  const ordered = await assignReadingOrder(inputPath);

  assert.deepEqual(ordered.orderedNodeIds, ["a", "c", "b"]);
  assert.equal(ordered.nodes.find((node) => node.id === "b").readingOrder, 2);
});

test("reading-order keeps headers first, tables row-major, and footers last", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "order-advanced-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:advanced",
      source: { layoutDocumentId: "layout:advanced" },
      nodes: [
        {
          id: "header",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "Artifact",
          artifactType: "header",
          text: "Quarterly Report",
          bbox: [72, 12, 220, 20],
          confidence: 0.99
        },
        {
          id: "list-1",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "LI",
          text: "First bullet",
          bbox: [72, 70, 140, 12],
          listGroupId: "list-a",
          listItemIndex: 0,
          confidence: 0.94
        },
        {
          id: "list-2",
          pageNumber: 1,
          sourceBlockId: "b3",
          role: "LI",
          text: "Second bullet",
          bbox: [72, 88, 140, 12],
          listGroupId: "list-a",
          listItemIndex: 1,
          confidence: 0.94
        },
        {
          id: "table-1",
          pageNumber: 1,
          sourceBlockId: "b4",
          role: "TH",
          text: "Revenue",
          bbox: [72, 120, 120, 12],
          tableId: "tbl-1",
          tableRowIndex: 0,
          tableColumnIndex: 0,
          columnHint: 0,
          confidence: 0.96
        },
        {
          id: "table-2",
          pageNumber: 1,
          sourceBlockId: "b5",
          role: "TH",
          text: "$120",
          bbox: [220, 120, 120, 12],
          tableId: "tbl-1",
          tableRowIndex: 0,
          tableColumnIndex: 1,
          columnHint: 0,
          confidence: 0.96
        },
        {
          id: "table-3",
          pageNumber: 1,
          sourceBlockId: "b6",
          role: "TD",
          text: "Costs",
          bbox: [72, 140, 120, 12],
          tableId: "tbl-1",
          tableRowIndex: 1,
          tableColumnIndex: 0,
          columnHint: 0,
          confidence: 0.96
        },
        {
          id: "table-4",
          pageNumber: 1,
          sourceBlockId: "b7",
          role: "TD",
          text: "$90",
          bbox: [220, 140, 120, 12],
          tableId: "tbl-1",
          tableRowIndex: 1,
          tableColumnIndex: 1,
          columnHint: 0,
          confidence: 0.96
        },
        {
          id: "right",
          pageNumber: 1,
          sourceBlockId: "b8",
          role: "P",
          text: "Right column note",
          bbox: [330, 74, 140, 12],
          columnHint: 1,
          confidence: 0.9
        },
        {
          id: "footer",
          pageNumber: 1,
          sourceBlockId: "b9",
          role: "Artifact",
          artifactType: "footer",
          text: "Page 1",
          bbox: [72, 740, 80, 10],
          confidence: 0.99
        }
      ]
    }, null, 2)
  );

  const ordered = await assignReadingOrder(inputPath);

  assert.deepEqual(ordered.orderedNodeIds, [
    "header",
    "list-1",
    "list-2",
    "table-1",
    "table-2",
    "table-3",
    "table-4",
    "right",
    "footer"
  ]);
  assert.equal(ordered.nodes.find((node) => node.id === "table-4").readingOrder, 6);
  assert.equal(ordered.nodes.find((node) => node.id === "footer").readingOrder, 8);
});
