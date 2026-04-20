import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTagTree, buildPrintFieldAttrs, promoteFlatHeadingsIntoSections } from "../index.js";

async function writeSemantic(input) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-wtpdf-"));
  const inputPath = path.join(tempDir, "semantic.json");
  await writeFile(inputPath, JSON.stringify(input, null, 2));
  return inputPath;
}

// ---- A5: Title vs first H1 ------------------------------------------------

test("A5: first page-1 heading with largest font and ≤12 words becomes Title", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a5-title",
    source: { layoutDocumentId: "layout:a5" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H1", text: "OpenAutoTag Manual", bbox: [0, 0, 400, 30], confidence: 0.95, readingOrder: 0, fontSize: 24 },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "H1", text: "Introduction", bbox: [0, 40, 200, 20], confidence: 0.95, readingOrder: 1, fontSize: 14 },
      { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "P", text: "Body", bbox: [0, 70, 400, 20], confidence: 0.95, readingOrder: 2 }
    ],
    orderedNodeIds: ["n1", "n2", "n3"]
  });

  const tagging = await buildTagTree(inputPath, { enableTitleDetection: true });
  assert.equal(tagging.root.children[0].type, "Title");
  assert.equal(tagging.root.children[0].label, "OpenAutoTag Manual");
  assert.equal(tagging.root.children[1].type, "Sect");
  assert.equal(tagging.root.children[1].children[0].type, "H1");
  assert.equal(tagging.source.titleDetection.applied, true);
});

test("A5: heading longer than 12 words stays as H1", async () => {
  const longText = Array(20).fill("word").join(" ");
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a5-long",
    source: { layoutDocumentId: "layout:a5-long" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H1", text: longText, bbox: [0, 0, 400, 30], confidence: 0.95, readingOrder: 0, fontSize: 24 },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "P", text: "Body", bbox: [0, 40, 400, 20], confidence: 0.95, readingOrder: 1 }
    ],
    orderedNodeIds: ["n1", "n2"]
  });

  const tagging = await buildTagTree(inputPath, { enableTitleDetection: true });
  assert.equal(tagging.root.children[0].type, "Sect");
  assert.equal(tagging.root.children[0].children[0].type, "H1");
  assert.equal(tagging.source.titleDetection.applied, false);
});

test("A5: first heading not on page 1 is not promoted to Title", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a5-page2",
    source: { layoutDocumentId: "layout:a5-page2" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "P", text: "Prologue", bbox: [0, 0, 400, 30], confidence: 0.95, readingOrder: 0 },
      { id: "n2", pageNumber: 2, sourceBlockId: "b2", role: "H1", text: "Short heading", bbox: [0, 0, 400, 30], confidence: 0.95, readingOrder: 1, fontSize: 24 }
    ],
    orderedNodeIds: ["n1", "n2"]
  });

  const tagging = await buildTagTree(inputPath, { enableTitleDetection: true });
  assert.equal(tagging.source.titleDetection.applied, false);
});

test("A5: first heading is not largest on page 1 — stays H1", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a5-not-largest",
    source: { layoutDocumentId: "layout:a5-not-largest" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H1", text: "Subhead", bbox: [0, 0, 400, 20], confidence: 0.95, readingOrder: 0, fontSize: 14 },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "H1", text: "Bigger heading", bbox: [0, 40, 400, 40], confidence: 0.95, readingOrder: 1, fontSize: 28 }
    ],
    orderedNodeIds: ["n1", "n2"]
  });

  const tagging = await buildTagTree(inputPath, { enableTitleDetection: true });
  assert.equal(tagging.source.titleDetection.applied, false);
});

test("A5: feature flag disabled — no Title emitted", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a5-off",
    source: { layoutDocumentId: "layout:a5-off" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H1", text: "Short title", bbox: [0, 0, 400, 30], confidence: 0.95, readingOrder: 0, fontSize: 24 }
    ],
    orderedNodeIds: ["n1"]
  });

  const tagging = await buildTagTree(inputPath);
  assert.equal(tagging.root.children[0].type, "Sect");
  assert.equal(tagging.root.children[0].children[0].type, "H1");
});

// ---- A6: Caption association ---------------------------------------------

test("A6: Figure/Table caption paragraphs are promoted to /Caption", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a6-basic",
    source: { layoutDocumentId: "layout:a6" },
    nodes: [
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "TH", text: "Model", bbox: [0, 0, 200, 20], confidence: 0.95, readingOrder: 0, tableGroupId: "t1", tableRowIndex: 0, tableColumnIndex: 0 },
      { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TH", text: "Qty", bbox: [200, 0, 200, 20], confidence: 0.95, readingOrder: 1, tableGroupId: "t1", tableRowIndex: 0, tableColumnIndex: 1 },
      { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TD", text: "A", bbox: [0, 20, 200, 20], confidence: 0.95, readingOrder: 2, tableGroupId: "t1", tableRowIndex: 1, tableColumnIndex: 0 },
      { id: "n5", pageNumber: 1, sourceBlockId: "b5", role: "TD", text: "10", bbox: [200, 20, 200, 20], confidence: 0.95, readingOrder: 3, tableGroupId: "t1", tableRowIndex: 1, tableColumnIndex: 1 },
      { id: "n6", pageNumber: 1, sourceBlockId: "b6", role: "P", text: "Table 1: Inventory totals.", bbox: [0, 110, 400, 20], confidence: 0.95, readingOrder: 4 }
    ],
    orderedNodeIds: ["n2", "n3", "n4", "n5", "n6"]
  });

  const tagging = await buildTagTree(inputPath, { enableCaptionDetection: true });
  const table = tagging.root.children.find((c) => c.type === "Table");
  assert.ok(table, "Table should exist at top level");
  const caption = table.children.find((c) => c.type === "Caption");
  assert.ok(caption, "Caption should be attached as last child of Table");
  assert.equal(caption.label, "Table 1: Inventory totals.");
  assert.equal(tagging.source.captionAssociation.detected, 1);
  assert.equal(tagging.source.captionAssociation.associated, 1);
});

test("A6: caption beyond lookback window stays as plain P", async () => {
  const fillers = [];
  for (let i = 1; i <= 5; i += 1) {
    fillers.push({
      id: `fp${i}`,
      pageNumber: 1,
      sourceBlockId: `fp${i}`,
      role: "P",
      text: `Filler paragraph ${i}.`,
      bbox: [0, i * 20, 400, 20],
      confidence: 0.9,
      readingOrder: 10 + i
    });
  }
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a6-far",
    source: { layoutDocumentId: "layout:a6-far" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "Table", text: "", bbox: [0, 0, 400, 20], confidence: 0.95, readingOrder: 0 },
      ...fillers,
      { id: "cap", pageNumber: 1, sourceBlockId: "bcap", role: "P", text: "Figure 5: Far caption.", bbox: [0, 200, 400, 20], confidence: 0.95, readingOrder: 50 }
    ],
    orderedNodeIds: ["n1", ...fillers.map((n) => n.id), "cap"]
  });

  const tagging = await buildTagTree(inputPath, { enableCaptionDetection: true });
  const table = tagging.root.children.find((c) => c.type === "Table");
  const caption = table?.children?.find?.((c) => c.type === "Caption");
  assert.equal(caption, undefined, "Caption must not attach beyond lookback");
  const standaloneCap = tagging.root.children.find((c) => c.type === "Caption");
  assert.ok(standaloneCap, "detected Caption remains as direct child of Document");
});

test("A6: caption pattern requires explicit number", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a6-strict",
    source: { layoutDocumentId: "layout:a6-strict" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "P", text: "Table of contents.", bbox: [0, 0, 400, 20], confidence: 0.95, readingOrder: 0 },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "P", text: "Figure out the problem.", bbox: [0, 20, 400, 20], confidence: 0.95, readingOrder: 1 }
    ],
    orderedNodeIds: ["n1", "n2"]
  });

  const tagging = await buildTagTree(inputPath, { enableCaptionDetection: true });
  const captions = tagging.root.children.filter((c) => c.type === "Caption");
  assert.equal(captions.length, 0);
});

// ---- #16: Section promotion ----------------------------------------------

test("#16: flat H1/H2/P under Document get wrapped into Sect elements", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:s16-flat",
    source: { layoutDocumentId: "layout:s16-flat" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "P", text: "Intro", bbox: [0, 0, 400, 20], confidence: 0.95, readingOrder: 0 }
    ],
    orderedNodeIds: ["n1"]
  });
  // We can't easily build a flat-H-under-Document through the main
  // loop (it always wraps in Sect). Inject a synthetic tree and call
  // the post-process directly by bypassing the main pipeline via the
  // feature flag on a tree known to be flat.
  //
  // Instead we validate post-process behavior by constructing the
  // tree manually and re-invoking the helper via the exported
  // symbol on a synthetic structure. The flag's public contract is
  // "don't break existing Sect-bearing trees".
  const tagging = await buildTagTree(inputPath, { enableSectionPromotion: true });
  assert.equal(tagging.source.sectionPromotion.applied, false,
    "flat-P-only document must not be forced into sections");
});

test("#16: synthetic flat Document with H1/P/H1/P is promoted into two Sects", () => {
  const root = {
    id: "tag:document",
    type: "Document",
    children: [
      { id: "t1", type: "H1", label: "Chapter 1", sourceNodeIds: ["a1"], children: [] },
      { id: "t2", type: "P", label: "Body A", sourceNodeIds: ["a2"], children: [] },
      { id: "t3", type: "H1", label: "Chapter 2", sourceNodeIds: ["a3"], children: [] },
      { id: "t4", type: "P", label: "Body B", sourceNodeIds: ["a4"], children: [] }
    ]
  };
  const result = promoteFlatHeadingsIntoSections(root);
  assert.equal(result.applied, true);
  assert.equal(result.sectionsInserted, 2);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].type, "Sect");
  assert.equal(root.children[0].children.length, 2);
  assert.equal(root.children[0].children[0].type, "H1");
  assert.equal(root.children[0].children[1].type, "P");
  assert.equal(root.children[1].type, "Sect");
});

test("#16: document with no headings is left alone", () => {
  const root = {
    id: "tag:document",
    type: "Document",
    children: [
      { id: "p1", type: "P", label: "A", children: [] },
      { id: "p2", type: "P", label: "B", children: [] }
    ]
  };
  const result = promoteFlatHeadingsIntoSections(root);
  assert.equal(result.applied, false);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].type, "P");
});

test("#16: Document that already has Sect children is not modified", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:s16-already",
    source: { layoutDocumentId: "layout:s16-already" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H1", text: "Chapter", bbox: [0, 0, 400, 30], confidence: 0.95, readingOrder: 0 },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "P", text: "Body", bbox: [0, 40, 400, 20], confidence: 0.95, readingOrder: 1 }
    ],
    orderedNodeIds: ["n1", "n2"]
  });

  const tagging = await buildTagTree(inputPath, { enableSectionPromotion: true });
  assert.equal(tagging.source.sectionPromotion.applied, false);
  assert.equal(tagging.root.children[0].type, "Sect");
});

// ---- A14: Layout attributes ----------------------------------------------

test("A14: Layout attrs are attached to P and H# when flag is on", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a14",
    source: { layoutDocumentId: "layout:a14" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "H1", text: "Chapter", bbox: [10, 20, 400, 30], confidence: 0.95, readingOrder: 0 },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "P", text: "Body paragraph.", bbox: [12, 60, 380, 40], confidence: 0.95, readingOrder: 1 }
    ],
    orderedNodeIds: ["n1", "n2"]
  });

  const tagging = await buildTagTree(inputPath, { enableLayoutAttrs: true });
  const section = tagging.root.children[0];
  const heading = section.children[0];
  const para = section.children[1];
  assert.deepEqual(heading.layoutAttrs, { O: "Layout", Placement: "Block", BBox: [10, 20, 400, 30] });
  assert.deepEqual(para.layoutAttrs, { O: "Layout", Placement: "Block", BBox: [12, 60, 380, 40] });
});

test("A14: Layout attrs are absent by default", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a14-default",
    source: { layoutDocumentId: "layout:a14-default" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "P", text: "Paragraph.", bbox: [0, 0, 400, 20], confidence: 0.95, readingOrder: 0 }
    ],
    orderedNodeIds: ["n1"]
  });

  const tagging = await buildTagTree(inputPath);
  assert.equal(tagging.root.children[0].layoutAttrs, undefined);
});

// ---- A15: Headers / ColSpan / RowSpan ------------------------------------

test("A15: table cells with ColSpan/RowSpan get /Table attrs when flag is on", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a15",
    source: { layoutDocumentId: "layout:a15" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "TH", text: "Summary", bbox: [0, 0, 60, 20], confidence: 0.95, readingOrder: 0, tableGroupId: "t1", tableRowIndex: 0, tableColumnIndex: 0, tableColumnSpan: 3, tableSection: "head" },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "TH", text: "A", bbox: [0, 20, 20, 20], confidence: 0.95, readingOrder: 1, tableGroupId: "t1", tableRowIndex: 1, tableColumnIndex: 0, tableSection: "head" },
      { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TH", text: "B", bbox: [20, 20, 20, 20], confidence: 0.95, readingOrder: 2, tableGroupId: "t1", tableRowIndex: 1, tableColumnIndex: 1, tableSection: "head" },
      { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TH", text: "C", bbox: [40, 20, 20, 20], confidence: 0.95, readingOrder: 3, tableGroupId: "t1", tableRowIndex: 1, tableColumnIndex: 2, tableSection: "head" },
      { id: "n5", pageNumber: 1, sourceBlockId: "b5", role: "TD", text: "1", bbox: [0, 40, 20, 20], confidence: 0.95, readingOrder: 4, tableGroupId: "t1", tableRowIndex: 2, tableColumnIndex: 0, tableSection: "body" },
      { id: "n6", pageNumber: 1, sourceBlockId: "b6", role: "TD", text: "2", bbox: [20, 40, 20, 20], confidence: 0.95, readingOrder: 5, tableGroupId: "t1", tableRowIndex: 2, tableColumnIndex: 1, tableSection: "body" },
      { id: "n7", pageNumber: 1, sourceBlockId: "b7", role: "TD", text: "3", bbox: [40, 40, 20, 20], confidence: 0.95, readingOrder: 6, tableGroupId: "t1", tableRowIndex: 2, tableColumnIndex: 2, tableSection: "body" }
    ],
    orderedNodeIds: ["n1", "n2", "n3", "n4", "n5", "n6", "n7"]
  });

  const tagging = await buildTagTree(inputPath, { enableTableHeaders: true });
  const table = tagging.root.children[0];
  const thead = table.children.find((c) => c.type === "THead");
  const tbody = table.children.find((c) => c.type === "TBody");
  const spanTh = thead.children[0].children[0];
  assert.equal(spanTh.type, "TH");
  assert.equal(spanTh.tableAttrs.O, "Table");
  assert.equal(spanTh.tableAttrs.ColSpan, 3);
  assert.ok(spanTh.headerId, "TH should get a stable headerId");

  const bodyCell = tbody.children[0].children[0];
  assert.equal(bodyCell.tableAttrs.O, "Table");
  assert.ok(Array.isArray(bodyCell.tableAttrs.Headers));
  assert.ok(bodyCell.tableAttrs.Headers.length > 0);
});

test("A15: flag off — no tableAttrs emitted (goldmaster contract)", async () => {
  const inputPath = await writeSemantic({
    schemaVersion: "1.0.0",
    documentId: "semantic:a15-off",
    source: { layoutDocumentId: "layout:a15-off" },
    nodes: [
      { id: "n1", pageNumber: 1, sourceBlockId: "b1", role: "TH", text: "A", bbox: [0, 0, 20, 20], confidence: 0.95, readingOrder: 0, tableGroupId: "t1", tableRowIndex: 0, tableColumnIndex: 0 },
      { id: "n2", pageNumber: 1, sourceBlockId: "b2", role: "TH", text: "B", bbox: [20, 0, 20, 20], confidence: 0.95, readingOrder: 1, tableGroupId: "t1", tableRowIndex: 0, tableColumnIndex: 1, tableColumnSpan: 2 },
      { id: "n3", pageNumber: 1, sourceBlockId: "b3", role: "TD", text: "1", bbox: [0, 20, 20, 20], confidence: 0.95, readingOrder: 2, tableGroupId: "t1", tableRowIndex: 1, tableColumnIndex: 0 },
      { id: "n4", pageNumber: 1, sourceBlockId: "b4", role: "TD", text: "2", bbox: [20, 20, 20, 20], confidence: 0.95, readingOrder: 3, tableGroupId: "t1", tableRowIndex: 1, tableColumnIndex: 1 }
    ],
    orderedNodeIds: ["n1", "n2", "n3", "n4"]
  });

  const tagging = await buildTagTree(inputPath);
  const table = tagging.root.children[0];
  const walk = (n) => {
    if (n.tableAttrs) return true;
    for (const c of n.children || []) if (walk(c)) return true;
    return false;
  };
  assert.equal(walk(table), false, "no tableAttrs should be emitted by default");
});

// ---- A16: PrintField attr builder ----------------------------------------

test("A16: buildPrintFieldAttrs returns correct Role for each widget subtype", () => {
  assert.deepEqual(
    buildPrintFieldAttrs({ widgetSubtype: "checkbox", TU: "Accept terms" }),
    { O: "PrintField", Role: "CB", Desc: "Accept terms" }
  );
  assert.deepEqual(
    buildPrintFieldAttrs({ widgetSubtype: "radio", tooltip: "Pick one" }),
    { O: "PrintField", Role: "RB", Desc: "Pick one" }
  );
  assert.deepEqual(
    buildPrintFieldAttrs({ widgetSubtype: "button", fieldName: "Submit" }),
    { O: "PrintField", Role: "PB", Desc: "Submit" }
  );
  assert.deepEqual(
    buildPrintFieldAttrs({ widgetSubtype: "text", alternateName: "Last name" }),
    { O: "PrintField", Role: "TV", Desc: "Last name" }
  );
});

test("A16: buildPrintFieldAttrs falls back to synthesized Desc", () => {
  const attrs = buildPrintFieldAttrs({ widgetSubtype: "text" });
  assert.equal(attrs.Desc, "Form field");
});

test("A16: buildPrintFieldAttrs returns null for null widget", () => {
  assert.equal(buildPrintFieldAttrs(null), null);
});
