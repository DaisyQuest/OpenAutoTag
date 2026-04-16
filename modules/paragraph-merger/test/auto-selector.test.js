import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDocumentFeatures,
  selectVersion,
  autoSelectVersion,
} from "../lib/auto-selector.js";

// ---------------------------------------------------------------------------
// Helpers: build minimal semantic documents
// ---------------------------------------------------------------------------

/** Create N paragraph nodes spread across the given number of pages. */
function makeParagraphDoc(count, { pages = 1, textLen = 80, columnHint = 0, confidence = 0.95, extraText = "" } = {}) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const page = (i % pages) + 1;
    nodes.push({
      pageNumber: page,
      role: "P",
      bbox: [50, 50 + i * 20, 400, 14],
      text: extraText || "x".repeat(textLen),
      confidence,
      columnHint,
      sourceBlockId: `block-${i}`,
    });
  }
  return { nodes };
}

/** Inject heading nodes into a doc. */
function addHeadings(doc, count) {
  for (let i = 0; i < count; i++) {
    doc.nodes.push({
      pageNumber: 1,
      role: "H2",
      bbox: [50, 10 + i * 10, 300, 16],
      text: `Heading ${i}`,
      confidence: 0.98,
      columnHint: 0,
      sourceBlockId: `heading-${i}`,
    });
  }
  return doc;
}

const ALL_VERSIONS = [
  "v1-conservative",
  "v2-balanced",
  "v3-aggressive",
  "v4-legal-tuned",
  "v6-hybrid",
  "v7-refined",
  "v8-precision",
];

const WITHOUT_V7_V8 = [
  "v1-conservative",
  "v2-balanced",
  "v3-aggressive",
  "v4-legal-tuned",
  "v6-hybrid",
];

// ---------------------------------------------------------------------------
// extractDocumentFeatures
// ---------------------------------------------------------------------------
describe("extractDocumentFeatures", () => {
  it("returns correct totals for a simple document", () => {
    const doc = makeParagraphDoc(10, { pages: 2 });
    const f = extractDocumentFeatures(doc);
    assert.equal(f.totalNodes, 10);
    assert.equal(f.totalPages, 2);
    assert.equal(f.nodesPerPage, 5);
    assert.equal(f.hasMultipleColumns, false);
    assert.equal(f.maxColumnHint, 0);
    assert.equal(f.paragraphRatio, 1);
    assert.equal(f.headingRatio, 0);
    assert.equal(f.isLegalFiling, false);
    assert.equal(f.isScanned, false);
  });

  it("detects legal filing from text patterns", () => {
    const doc = makeParagraphDoc(10);
    doc.nodes[0].text = "SUPREME COURT OF THE STATE OF NEW YORK — NYSCEF filing";
    doc.nodes[1].text = "Petitioner v. Defendant, Index No. 123456/2024";
    const f = extractDocumentFeatures(doc);
    assert.equal(f.isLegalFiling, true);
  });

  it("detects multi-column layout", () => {
    const doc = makeParagraphDoc(30, { columnHint: 1 });
    const f = extractDocumentFeatures(doc);
    assert.equal(f.hasMultipleColumns, true);
    assert.equal(f.maxColumnHint, 1);
  });

  it("detects scanned/OCR from low confidence", () => {
    const doc = makeParagraphDoc(20, { confidence: 0.55 });
    const f = extractDocumentFeatures(doc);
    assert.equal(f.isScanned, true);
    assert.ok(f.meanConfidence < 0.75);
  });

  it("handles empty document gracefully", () => {
    const f = extractDocumentFeatures({ nodes: [] });
    assert.equal(f.totalNodes, 0);
    assert.equal(f.totalPages, 1);
    assert.equal(f.meanConfidence, 1); // default when no confidence data
  });
});

// ---------------------------------------------------------------------------
// selectVersion — Rule 1: Short document
// ---------------------------------------------------------------------------
describe("selectVersion — short documents", () => {
  it("selects v1-conservative for document with < 20 nodes", () => {
    const doc = makeParagraphDoc(15);
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, ALL_VERSIONS);
    assert.equal(result.selectedVersionId, "v1-conservative");
    assert.ok(result.confidence > 0);
    assert.ok(result.reasoning.length > 0);
  });

  it("selects v1-conservative even with only v1 and v3 available", () => {
    const doc = makeParagraphDoc(10);
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, ["v1-conservative", "v3-aggressive"]);
    assert.equal(result.selectedVersionId, "v1-conservative");
  });

  it("falls back to v2-balanced when v1 is unavailable for short doc", () => {
    const doc = makeParagraphDoc(5);
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, ["v2-balanced", "v3-aggressive"]);
    assert.equal(result.selectedVersionId, "v2-balanced");
  });
});

// ---------------------------------------------------------------------------
// selectVersion — Rule 2: Legal filing
// ---------------------------------------------------------------------------
describe("selectVersion — legal filing", () => {
  it("selects v7-refined for legal filing when available", () => {
    const doc = makeParagraphDoc(40);
    doc.nodes[0].text = "NYSCEF Doc. No. 12 — SUPREME COURT";
    doc.nodes[1].text = "Petitioner v. Respondent, Case No. 2024-001";
    const features = extractDocumentFeatures(doc);
    assert.equal(features.isLegalFiling, true);
    const result = selectVersion(features, ALL_VERSIONS);
    assert.equal(result.selectedVersionId, "v7-refined");
    assert.ok(result.reasoning.length >= 1);
  });

  it("selects v4-legal-tuned when v7-refined is unavailable", () => {
    const doc = makeParagraphDoc(40);
    doc.nodes[0].text = "NYSCEF Doc. No. 12 — Court of Appeals";
    doc.nodes[1].text = "Plaintiff brings this MOTION TO dismiss";
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, WITHOUT_V7_V8);
    assert.equal(result.selectedVersionId, "v4-legal-tuned");
  });
});

// ---------------------------------------------------------------------------
// selectVersion — Rule 3: Multi-column
// ---------------------------------------------------------------------------
describe("selectVersion — multi-column", () => {
  it("selects v8-precision for multi-column with many nodes", () => {
    const doc = makeParagraphDoc(50, { columnHint: 1 });
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, ALL_VERSIONS);
    assert.equal(result.selectedVersionId, "v8-precision");
    assert.ok(result.reasoning.some((r) => /multi-column/i.test(r)));
  });

  it("selects v2-balanced for multi-column when v8 unavailable", () => {
    const doc = makeParagraphDoc(50, { columnHint: 2 });
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, WITHOUT_V7_V8);
    assert.equal(result.selectedVersionId, "v2-balanced");
  });
});

// ---------------------------------------------------------------------------
// selectVersion — Rule 4: High heading ratio
// ---------------------------------------------------------------------------
describe("selectVersion — high heading ratio", () => {
  it("selects v2-balanced for heavily structured docs", () => {
    // 20 P nodes + 6 headings = 26 total; heading ratio = 6/26 ≈ 23%
    const doc = makeParagraphDoc(20);
    addHeadings(doc, 6);
    const features = extractDocumentFeatures(doc);
    assert.ok(features.headingRatio > 0.15);
    const result = selectVersion(features, ALL_VERSIONS);
    assert.equal(result.selectedVersionId, "v2-balanced");
  });
});

// ---------------------------------------------------------------------------
// selectVersion — Rule 5: Scanned / low confidence
// ---------------------------------------------------------------------------
describe("selectVersion — scanned/OCR", () => {
  it("selects v6-hybrid for low-confidence OCR document", () => {
    const doc = makeParagraphDoc(40, { confidence: 0.5 });
    const features = extractDocumentFeatures(doc);
    assert.equal(features.isScanned, true);
    const result = selectVersion(features, ALL_VERSIONS);
    assert.equal(result.selectedVersionId, "v6-hybrid");
    assert.ok(result.reasoning.some((r) => /OCR|scanned|confidence/i.test(r)));
  });
});

// ---------------------------------------------------------------------------
// selectVersion — Rule 6: Dense single-column
// ---------------------------------------------------------------------------
describe("selectVersion — dense single-column", () => {
  it("selects v7-refined for dense single-column text", () => {
    // 30 nodes, 1 page, 200 chars each → textDensity = 6000
    const doc = makeParagraphDoc(30, { pages: 1, textLen: 200 });
    const features = extractDocumentFeatures(doc);
    assert.ok(features.textDensity > 5000);
    assert.equal(features.hasMultipleColumns, false);
    const result = selectVersion(features, ALL_VERSIONS);
    assert.equal(result.selectedVersionId, "v7-refined");
    assert.ok(result.reasoning.some((r) => /dense|density/i.test(r)));
  });

  it("selects v6-hybrid for dense text when v7 unavailable", () => {
    const doc = makeParagraphDoc(30, { pages: 1, textLen: 200 });
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, WITHOUT_V7_V8);
    assert.equal(result.selectedVersionId, "v6-hybrid");
  });
});

// ---------------------------------------------------------------------------
// selectVersion — Rule 7: Default
// ---------------------------------------------------------------------------
describe("selectVersion — default fallback", () => {
  it("selects v7-refined as default when all versions available", () => {
    // Normal doc: enough nodes, not legal, single column, normal heading ratio, high confidence, moderate density
    const doc = makeParagraphDoc(40, { pages: 4, textLen: 100 });
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, ALL_VERSIONS);
    assert.equal(result.selectedVersionId, "v7-refined");
    assert.ok(result.reasoning.length > 0);
  });

  it("selects v2-balanced as default when v7 unavailable", () => {
    const doc = makeParagraphDoc(40, { pages: 4, textLen: 100 });
    const features = extractDocumentFeatures(doc);
    const result = selectVersion(features, WITHOUT_V7_V8);
    assert.equal(result.selectedVersionId, "v2-balanced");
  });
});

// ---------------------------------------------------------------------------
// autoSelectVersion — integration
// ---------------------------------------------------------------------------
describe("autoSelectVersion — integration", () => {
  it("returns features alongside selection", () => {
    const doc = makeParagraphDoc(25, { pages: 2 });
    const result = autoSelectVersion(doc, ALL_VERSIONS);
    assert.ok(result.features);
    assert.equal(result.features.totalNodes, 25);
    assert.ok(result.selectedVersionId);
    assert.ok(typeof result.confidence === "number");
    assert.ok(Array.isArray(result.reasoning));
    assert.ok(result.reasoning.length > 0);
  });

  it("every rule path produces non-empty reasoning", () => {
    // Test all major paths produce reasoning
    const scenarios = [
      makeParagraphDoc(5),                                     // short
      makeParagraphDoc(40, { pages: 4, textLen: 100 }),        // default
      makeParagraphDoc(30, { pages: 1, textLen: 200 }),        // dense
      makeParagraphDoc(50, { columnHint: 1 }),                 // multi-col
      makeParagraphDoc(40, { confidence: 0.5 }),               // scanned
    ];
    for (const doc of scenarios) {
      const result = autoSelectVersion(doc, ALL_VERSIONS);
      assert.ok(result.reasoning.length > 0, `Empty reasoning for doc with ${doc.nodes.length} nodes`);
    }
  });
});
