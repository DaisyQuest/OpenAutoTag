import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTagTree, resolveOrderedNodes } from "../index.js";

test("tag builder resolves ordered node ids without repeated linear scans", () => {
  const nodes = [
    { id: "n1", readingOrder: 1 },
    { id: "n2", readingOrder: 0 }
  ];
  nodes.find = () => {
    throw new Error("resolveOrderedNodes should not call Array.prototype.find");
  };

  const orderedNodes = resolveOrderedNodes({
    nodes,
    orderedNodeIds: ["n2", "n1", "missing"]
  });

  assert.deepEqual(
    orderedNodes.map((node) => node?.id || null),
    ["n2", "n1", null]
  );
});

test("tag builder groups content under heading-driven sections", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:sample",
      source: { layoutDocumentId: "layout:sample" },
      nodes: [
        { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H1", text: "Heading", bbox: [0, 0, 10, 10], confidence: 0.9, readingOrder: 0 },
        { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "P", text: "Intro paragraph", bbox: [0, 10, 10, 10], confidence: 0.9, readingOrder: 1 },
        { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "LI", text: "Item 1", bbox: [0, 20, 10, 10], confidence: 0.9, readingOrder: 2 },
        { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "LI", text: "Item 2", bbox: [0, 30, 10, 10], confidence: 0.9, readingOrder: 3 },
        { id: "n5", pageNumber: 1, sourceBlockId: "b5", role: "H2", text: "Subheading", bbox: [0, 40, 10, 10], confidence: 0.9, readingOrder: 4 },
        { id: "n6", pageNumber: 1, sourceBlockId: "b6", role: "P", text: "Details", bbox: [0, 50, 10, 10], confidence: 0.9, readingOrder: 5 }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4", "n5", "n6"]
    }, null, 2)
  );

  const tagging = await buildTagTree(inputPath);
  const section = tagging.root.children[0];
  const nestedSection = section.children[3];

  assert.equal(tagging.root.type, "Document");
  assert.equal(section.type, "Sect");
  assert.equal(section.children[0].type, "H1");
  assert.equal(section.children[1].type, "P");
  assert.equal(section.children[2].type, "L");
  assert.equal(section.children[2].children.length, 2);
  assert.equal(nestedSection.type, "Sect");
  assert.equal(nestedSection.children[0].type, "H2");
  assert.equal(nestedSection.children[1].type, "P");
});

test("tag builder skips artifacts and groups table headers and cells into table rows", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-table-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:table-sample",
      source: { layoutDocumentId: "layout:table-sample" },
      nodes: [
        { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "Artifact", text: "Page 1", bbox: [0, 0, 10, 10], confidence: 0.7, readingOrder: 0 },
        { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "H1", text: "Quarterly Metrics", bbox: [0, 20, 10, 10], confidence: 0.9, readingOrder: 1 },
        { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TH", text: "Revenue Summary", bbox: [0, 40, 30, 10], confidence: 0.95, readingOrder: 2, tableGroupId: "table-1", tableRowIndex: 0, tableColumnSpan: 2, tableSection: "head", tableSource: "vector-grid" },
        { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TH", text: "Region", bbox: [0, 55, 10, 10], confidence: 0.95, readingOrder: 3, tableGroupId: "table-1", tableRowIndex: 1, tableSection: "head" },
        { id: "n5", pageNumber: 1, sourceBlockId: "b5", role: "TH", text: "Revenue", bbox: [20, 55, 10, 10], confidence: 0.95, readingOrder: 4, tableGroupId: "table-1", tableRowIndex: 1, tableSection: "head" },
        { id: "n6", pageNumber: 1, sourceBlockId: "b6", role: "TD", text: "North", bbox: [0, 70, 10, 10], confidence: 0.95, readingOrder: 5, tableGroupId: "table-1", tableRowIndex: 2, tableSection: "body" },
        { id: "n7", pageNumber: 1, sourceBlockId: "b7", role: "TD", text: "$12M", bbox: [20, 70, 10, 10], confidence: 0.95, readingOrder: 6, tableGroupId: "table-1", tableRowIndex: 2, tableSection: "body" }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4", "n5", "n6", "n7"]
    }, null, 2)
  );

  const tagging = await buildTagTree(inputPath);
  const section = tagging.root.children[0];
  const table = section.children[1];
  const headerSection = table.children[0];
  const bodySection = table.children[1];

  assert.equal(tagging.root.children.length, 1);
  assert.equal(section.children[0].type, "H1");
  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((child) => child.type), ["THead", "TBody"]);
  assert.equal(headerSection.children.length, 2);
  assert.equal(headerSection.children[0].type, "TR");
  assert.deepEqual(headerSection.children[0].children.map((child) => child.type), ["TH"]);
  assert.equal(headerSection.children[0].children[0].columnSpan, 2);
  assert.equal(headerSection.children[0].children[0].tableSource, "vector-grid");
  assert.deepEqual(headerSection.children[0].children.map((child) => child.label), ["Revenue Summary"]);
  assert.deepEqual(headerSection.children[1].children.map((child) => child.type), ["TH", "TH"]);
  assert.deepEqual(headerSection.children[1].children.map((child) => child.label), ["Region", "Revenue"]);
  assert.equal(bodySection.children.length, 1);
  assert.deepEqual(bodySection.children[0].children.map((child) => child.type), ["TD", "TD"]);
  assert.deepEqual(bodySection.children[0].children.map((child) => child.label), ["North", "$12M"]);
});

test("tag builder infers table head and body sections when explicit section metadata is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-table-infer-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:table-infer",
      source: { layoutDocumentId: "layout:table-infer" },
      nodes: [
        { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "TH", text: "Quarter", bbox: [0, 20, 10, 10], confidence: 0.95, readingOrder: 0, tableGroupId: "table-1", tableRowIndex: 0, tableColumnIndex: 0 },
        { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "TH", text: "Revenue", bbox: [20, 20, 10, 10], confidence: 0.95, readingOrder: 1, tableGroupId: "table-1", tableRowIndex: 0, tableColumnIndex: 1 },
        { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TD", text: "Q1", bbox: [0, 35, 10, 10], confidence: 0.95, readingOrder: 2, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 0 },
        { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TD", text: "$10M", bbox: [20, 35, 10, 10], confidence: 0.95, readingOrder: 3, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 1 }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4"]
    }, null, 2)
  );

  const tagging = await buildTagTree(inputPath);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((child) => child.type), ["THead", "TBody"]);
  assert.deepEqual(table.children[0].children[0].children.map((child) => child.label), ["Quarter", "Revenue"]);
  assert.deepEqual(table.children[1].children[0].children.map((child) => child.label), ["Q1", "$10M"]);
});

test("tag builder flattens redundant tbody wrappers for body-only tables", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-table-body-only-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:table-body-only",
      source: { layoutDocumentId: "layout:table-body-only" },
      nodes: [
        { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "TH", text: "Model", bbox: [0, 20, 10, 10], confidence: 0.95, readingOrder: 0, tableGroupId: "table-1", tableRowIndex: 0, tableColumnIndex: 0, tableSection: "body" },
        { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "TD", text: "TK4N", bbox: [20, 20, 10, 10], confidence: 0.95, readingOrder: 1, tableGroupId: "table-1", tableRowIndex: 0, tableColumnIndex: 1, tableSection: "body" },
        { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TH", text: "Power", bbox: [0, 35, 10, 10], confidence: 0.95, readingOrder: 2, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 0, tableSection: "body" },
        { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TD", text: "100-240 VAC", bbox: [20, 35, 10, 10], confidence: 0.95, readingOrder: 3, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 1, tableSection: "body" }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4"]
    }, null, 2)
  );

  const tagging = await buildTagTree(inputPath);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((child) => child.type), ["TR", "TR"]);
  assert.deepEqual(table.children[0].children.map((child) => child.type), ["TH", "TD"]);
  assert.deepEqual(table.children[1].children.map((child) => child.label), ["Power", "100-240 VAC"]);
});

test("tag builder keeps mixed row-header rows together when section metadata is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-table-row-header-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:table-row-header",
      source: { layoutDocumentId: "layout:table-row-header" },
      nodes: [
        { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "TH", text: "Model", bbox: [0, 20, 10, 10], confidence: 0.95, readingOrder: 0, tableGroupId: "table-1", tableRowIndex: 0, tableColumnIndex: 0 },
        { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "TD", text: "TK4N", bbox: [20, 20, 10, 10], confidence: 0.95, readingOrder: 1, tableGroupId: "table-1", tableRowIndex: 0, tableColumnIndex: 1 },
        { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TH", text: "Power", bbox: [0, 35, 10, 10], confidence: 0.95, readingOrder: 2, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 0 },
        { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TD", text: "100-240 VAC", bbox: [20, 35, 10, 10], confidence: 0.95, readingOrder: 3, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 1 }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4"]
    }, null, 2)
  );

  const tagging = await buildTagTree(inputPath);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((child) => child.type), ["TR", "TR"]);
  assert.deepEqual(table.children[0].children.map((child) => child.label), ["Model", "TK4N"]);
  assert.deepEqual(table.children[0].children.map((child) => child.type), ["TH", "TD"]);
  assert.deepEqual(table.children[1].children.map((child) => child.label), ["Power", "100-240 VAC"]);
});

test("tag builder promotes contiguous leading header rows into thead when metadata is incomplete", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-table-multihead-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:table-multihead",
      source: { layoutDocumentId: "layout:table-multihead" },
      nodes: [
        { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "TH", text: "Specifications", bbox: [0, 20, 30, 10], confidence: 0.95, readingOrder: 0, tableGroupId: "table-1", tableRowIndex: 0, tableColumnIndex: 0, tableColumnSpan: 2 },
        { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "TH", text: "Item", bbox: [0, 35, 10, 10], confidence: 0.95, readingOrder: 1, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 0 },
        { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TH", text: "Value", bbox: [20, 35, 10, 10], confidence: 0.95, readingOrder: 2, tableGroupId: "table-1", tableRowIndex: 1, tableColumnIndex: 1 },
        { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TD", text: "Power", bbox: [0, 50, 10, 10], confidence: 0.95, readingOrder: 3, tableGroupId: "table-1", tableRowIndex: 2, tableColumnIndex: 0 },
        { id: "n5", pageNumber: 1, sourceBlockId: "b5", role: "TD", text: "100-240 VAC", bbox: [20, 50, 10, 10], confidence: 0.95, readingOrder: 4, tableGroupId: "table-1", tableRowIndex: 2, tableColumnIndex: 1 }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4", "n5"]
    }, null, 2)
  );

  const tagging = await buildTagTree(inputPath);
  const table = tagging.root.children[0];

  assert.equal(table.type, "Table");
  assert.deepEqual(table.children.map((child) => child.type), ["THead", "TBody"]);
  assert.equal(table.children[0].children.length, 2);
  assert.deepEqual(table.children[0].children[0].children.map((child) => child.label), ["Specifications"]);
  assert.deepEqual(table.children[0].children[1].children.map((child) => child.label), ["Item", "Value"]);
  assert.deepEqual(table.children[1].children[0].children.map((child) => child.label), ["Power", "100-240 VAC"]);
});

test("tag builder normalizes heading levels so the first heading is H1 and skipped levels are compressed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-heading-normalization-test-"));
  const inputPath = path.join(tempDir, "semantic.json");

  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:heading-normalization",
      source: { layoutDocumentId: "layout:heading-normalization" },
      nodes: [
        { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H2", text: "Detected chapter", bbox: [0, 0, 10, 10], confidence: 0.91, readingOrder: 0, headingLevel: 2 },
        { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "P", text: "Intro", bbox: [0, 10, 10, 10], confidence: 0.9, readingOrder: 1 },
        { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "H3", text: "Detected subsection", bbox: [0, 20, 10, 10], confidence: 0.91, readingOrder: 2, headingLevel: 3 },
        { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "P", text: "Details", bbox: [0, 30, 10, 10], confidence: 0.9, readingOrder: 3 }
      ],
      orderedNodeIds: ["n1", "n2", "n3", "n4"]
    }, null, 2)
  );

  const tagging = await buildTagTree(inputPath);
  const topSection = tagging.root.children[0];
  const nestedSection = topSection.children[2];

  assert.equal(tagging.source.headingNormalization.applied, true);
  assert.equal(tagging.source.headingNormalization.adjustedHeadingCount, 2);
  assert.equal(tagging.source.headingNormalization.firstDetectedHeading, "H2");
  assert.equal(topSection.children[0].type, "H1");
  assert.equal(topSection.children[0].detectedType, "H2");
  assert.equal(nestedSection.type, "Sect");
  assert.equal(nestedSection.children[0].type, "H2");
  assert.equal(nestedSection.children[0].detectedType, "H3");
});
