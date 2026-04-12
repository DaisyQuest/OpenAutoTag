import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTagTree } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldmasterPath = path.join(__dirname, "goldmasters", "table-regularity.expected.json");
const goldmasterCases = JSON.parse(await readFile(goldmasterPath, "utf8")).cases;
const expectedByName = new Map(goldmasterCases.map((testCase) => [testCase.name, testCase.expected]));

const inputCases = [
  {
    name: "body-gap-normalization",
    input: {
      schemaVersion: "1.0.0",
      documentId: "semantic:body-gap",
      source: { layoutDocumentId: "layout:body-gap" },
      nodes: [
        {
          id: "n1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "TH",
          text: "Item",
          bbox: [0, 0, 10, 10],
          confidence: 0.96,
          readingOrder: 0,
          tableGroupId: "table-1",
          tableRowIndex: 0,
          tableColumnIndex: 0,
          tableSection: "head"
        },
        {
          id: "n2",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "TH",
          text: "Qty",
          bbox: [10, 0, 10, 10],
          confidence: 0.96,
          readingOrder: 1,
          tableGroupId: "table-1",
          tableRowIndex: 0,
          tableColumnIndex: 1,
          tableSection: "head"
        },
        {
          id: "n3",
          pageNumber: 1,
          sourceBlockId: "b3",
          role: "TH",
          text: "Total",
          bbox: [20, 0, 10, 10],
          confidence: 0.96,
          readingOrder: 2,
          tableGroupId: "table-1",
          tableRowIndex: 0,
          tableColumnIndex: 2,
          tableSection: "head"
        },
        {
          id: "n4",
          pageNumber: 1,
          sourceBlockId: "b4",
          role: "TD",
          text: "Bolts",
          bbox: [0, 12, 10, 10],
          confidence: 0.95,
          readingOrder: 3,
          tableGroupId: "table-1",
          tableRowIndex: 1,
          tableColumnIndex: 0,
          tableSection: "body"
        },
        {
          id: "n5",
          pageNumber: 1,
          sourceBlockId: "b5",
          role: "TD",
          text: "10",
          bbox: [10, 12, 10, 10],
          confidence: 0.95,
          readingOrder: 4,
          tableGroupId: "table-1",
          tableRowIndex: 1,
          tableColumnIndex: 1,
          tableSection: "body"
        },
        {
          id: "n6",
          pageNumber: 1,
          sourceBlockId: "b6",
          role: "TD",
          text: "$5",
          bbox: [20, 12, 10, 10],
          confidence: 0.95,
          readingOrder: 5,
          tableGroupId: "table-1",
          tableRowIndex: 1,
          tableColumnIndex: 2,
          tableSection: "body"
        },
        {
          id: "n7",
          pageNumber: 1,
          sourceBlockId: "b7",
          role: "TD",
          text: "Nuts",
          bbox: [0, 24, 10, 10],
          confidence: 0.95,
          readingOrder: 6,
          tableGroupId: "table-1",
          tableRowIndex: 2,
          tableColumnIndex: 0,
          tableSection: "body"
        },
        {
          id: "n8",
          pageNumber: 1,
          sourceBlockId: "b8",
          role: "TD",
          text: "$3",
          bbox: [20, 24, 10, 10],
          confidence: 0.95,
          readingOrder: 7,
          tableGroupId: "table-1",
          tableRowIndex: 2,
          tableColumnIndex: 2,
          tableSection: "body"
        }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]
    }
  },
  {
    name: "header-gap-normalization",
    input: {
      schemaVersion: "1.0.0",
      documentId: "semantic:header-gap",
      source: { layoutDocumentId: "layout:header-gap" },
      nodes: [
        {
          id: "n1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "TH",
          text: "Sales Overview",
          bbox: [0, 0, 30, 10],
          confidence: 0.97,
          readingOrder: 0,
          tableGroupId: "table-2",
          tableRowIndex: 0,
          tableColumnIndex: 0,
          tableColumnSpan: 3,
          tableSection: "head"
        },
        {
          id: "n2",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "TH",
          text: "Region",
          bbox: [10, 12, 10, 10],
          confidence: 0.97,
          readingOrder: 1,
          tableGroupId: "table-2",
          tableRowIndex: 1,
          tableColumnIndex: 1,
          tableSection: "head"
        },
        {
          id: "n3",
          pageNumber: 1,
          sourceBlockId: "b3",
          role: "TH",
          text: "Revenue",
          bbox: [20, 12, 10, 10],
          confidence: 0.97,
          readingOrder: 2,
          tableGroupId: "table-2",
          tableRowIndex: 1,
          tableColumnIndex: 2,
          tableSection: "head"
        },
        {
          id: "n4",
          pageNumber: 1,
          sourceBlockId: "b4",
          role: "TD",
          text: "East",
          bbox: [0, 24, 10, 10],
          confidence: 0.95,
          readingOrder: 3,
          tableGroupId: "table-2",
          tableRowIndex: 2,
          tableColumnIndex: 0,
          tableSection: "body"
        },
        {
          id: "n5",
          pageNumber: 1,
          sourceBlockId: "b5",
          role: "TD",
          text: "$9M",
          bbox: [10, 24, 10, 10],
          confidence: 0.95,
          readingOrder: 4,
          tableGroupId: "table-2",
          tableRowIndex: 2,
          tableColumnIndex: 1,
          tableSection: "body"
        },
        {
          id: "n6",
          pageNumber: 1,
          sourceBlockId: "b6",
          role: "TD",
          text: "North",
          bbox: [20, 24, 10, 10],
          confidence: 0.95,
          readingOrder: 5,
          tableGroupId: "table-2",
          tableRowIndex: 2,
          tableColumnIndex: 2,
          tableSection: "body"
        }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4", "n5", "n6"]
    }
  },
  {
    name: "rowspan-carry-preservation",
    input: {
      schemaVersion: "1.0.0",
      documentId: "semantic:rowspan-carry",
      source: { layoutDocumentId: "layout:rowspan-carry" },
      nodes: [
        {
          id: "n1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "TH",
          text: "Region",
          bbox: [0, 0, 10, 20],
          confidence: 0.97,
          readingOrder: 0,
          tableGroupId: "table-3",
          tableRowIndex: 0,
          tableColumnIndex: 0,
          tableRowSpan: 2,
          tableSection: "body"
        },
        {
          id: "n2",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "TD",
          text: "Q1",
          bbox: [10, 0, 10, 10],
          confidence: 0.95,
          readingOrder: 1,
          tableGroupId: "table-3",
          tableRowIndex: 0,
          tableColumnIndex: 1,
          tableSection: "body"
        },
        {
          id: "n3",
          pageNumber: 1,
          sourceBlockId: "b3",
          role: "TD",
          text: "Q2",
          bbox: [10, 12, 10, 10],
          confidence: 0.95,
          readingOrder: 2,
          tableGroupId: "table-3",
          tableRowIndex: 1,
          tableColumnIndex: 1,
          tableSection: "body"
        }
      ],
      orderedNodeIds: ["n1", "n2", "n3"]
    }
  },
  {
    name: "trailing-rowspan-continuation",
    input: {
      schemaVersion: "1.0.0",
      documentId: "semantic:trailing-rowspan",
      source: { layoutDocumentId: "layout:trailing-rowspan" },
      nodes: [
        {
          id: "n1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "TH",
          text: "Region",
          bbox: [0, 0, 10, 20],
          confidence: 0.97,
          readingOrder: 0,
          tableGroupId: "table-4",
          tableRowIndex: 0,
          tableColumnIndex: 0,
          tableRowSpan: 2,
          tableSection: "body"
        },
        {
          id: "n2",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "TD",
          text: "Q1",
          bbox: [10, 0, 10, 10],
          confidence: 0.95,
          readingOrder: 1,
          tableGroupId: "table-4",
          tableRowIndex: 0,
          tableColumnIndex: 1,
          tableSection: "body"
        }
      ],
      orderedNodeIds: ["n1", "n2"]
    }
  }
];

for (const testCase of inputCases) {
  test(`tag builder goldmaster preserves ${testCase.name}`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-builder-goldmaster-"));
    const inputPath = path.join(tempDir, "semantic.json");

    try {
      await writeFile(inputPath, JSON.stringify(testCase.input, null, 2));
      const actual = await buildTagTree(inputPath);
      const expected = expectedByName.get(testCase.name);

      assert.ok(expected, `Missing goldmaster for ${testCase.name}`);
      assert.deepEqual(actual, expected);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}
