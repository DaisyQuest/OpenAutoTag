import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSemanticDocument } from "../index.js";

test("semantic engine converts layout block types to semantic roles", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "semantic-test-"));
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
            { id: "b1", text: "Heading", bbox: [0, 0, 10, 10], fontSize: 24, blockType: "heading", headingLevel: 1 },
            { id: "b2", text: "- List item", bbox: [0, 20, 10, 10], fontSize: 12, blockType: "list-item" },
            { id: "b3", text: "Paragraph", bbox: [0, 40, 10, 10], fontSize: 12, blockType: "paragraph" }
          ]
        }
      ]
    }, null, 2)
  );

  const semantic = await buildSemanticDocument(inputPath);

  assert.deepEqual(semantic.nodes.map((node) => node.role), ["H1", "LI", "P"]);
});

test("semantic engine preserves artifact, table, and grouped list metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "semantic-advanced-test-"));
  const inputPath = path.join(tempDir, "layout.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "layout:advanced",
      source: { filePath: "sample.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            {
              id: "b1",
              text: "Quarterly Report",
              bbox: [72, 24, 220, 24],
              fontSize: 22,
              fontName: "Helvetica-Bold",
              blockType: "heading",
              headingLevel: 1,
              isHeader: true,
              regionKind: "header"
            },
            {
              id: "b2",
              text: "Revenue",
              bbox: [72, 100, 120, 12],
              fontSize: 11,
              fontName: "Helvetica",
              blockType: "table-cell",
              tableId: "tbl-1",
              tableRowIndex: 0,
              tableColumnIndex: 0,
              tableRole: "header",
              tableColumnSpan: 2,
              tableSource: "vector-grid"
            },
            {
              id: "b3",
              text: "$120",
              bbox: [220, 100, 120, 12],
              fontSize: 11,
              fontName: "Helvetica",
              blockType: "table-cell",
              tableId: "tbl-1",
              tableRowIndex: 0,
              tableColumnIndex: 1
            },
            {
              id: "b4",
              text: "- Follow up",
              bbox: [72, 150, 140, 12],
              fontSize: 12,
              fontName: "Helvetica",
              blockType: "list-item",
              listGroupId: "list-1",
              listLevel: 1
            },
            {
              id: "b5",
              text: "Page 1",
              bbox: [72, 740, 80, 10],
              fontSize: 9,
              fontName: "Helvetica",
              blockType: "paragraph",
              isFooter: true,
              regionKind: "footer"
            }
          ]
        }
      ]
    }, null, 2)
  );

  const semantic = await buildSemanticDocument(inputPath);
  const [header, tableCell, tableValue, listItem, footer] = semantic.nodes;

  assert.deepEqual(semantic.nodes.map((node) => node.role), ["Artifact", "TH", "TD", "LI", "Artifact"]);
  assert.equal(header.artifactType, "header");
  assert.equal(tableCell.tableId, "tbl-1");
  assert.equal(tableCell.tableRowIndex, 0);
  assert.equal(tableCell.tableColumnIndex, 0);
  assert.equal(tableCell.tableRole, "header");
  assert.equal(tableCell.role, "TH");
  assert.equal(tableCell.tableColumnSpan, 2);
  assert.equal(tableCell.tableSource, "vector-grid");
  assert.equal(listItem.listGroupId, "list-1");
  assert.equal(listItem.listItemIndex, 0);
  assert.equal(footer.artifactType, "footer");
});
