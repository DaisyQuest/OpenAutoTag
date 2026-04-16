import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateColumnBoundaries,
  validateParagraphLength,
  validateEmbeddedHeadings,
  validateReadingOrderPreservation,
  validateConsistentSpacing,
  runAllValidators
} from "../lib/validators.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(nodes) {
  return { nodes };
}

function makePNode(id, overrides = {}) {
  return {
    id,
    role: "P",
    pageNumber: 1,
    bbox: [50, 50, 200, 12],
    text: "Some paragraph text.",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// validateColumnBoundaries
// ---------------------------------------------------------------------------
describe("validateColumnBoundaries", () => {
  it("detects cross-column merge", () => {
    const original = makeDoc([
      makePNode("o0", { columnHint: 0, bbox: [50, 50, 200, 12] }),
      makePNode("o1", { columnHint: 1, bbox: [350, 50, 200, 12] })
    ]);
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1"],
        text: "Left col text. Right col text.",
        bbox: [50, 50, 500, 12]
      })
    ]);

    const warnings = validateColumnBoundaries(merged, original);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, "cross-column merge");
    assert.equal(warnings[0].severity, "error");
    assert.equal(warnings[0].suggestion, "split back at column boundary");
  });

  it("passes when all sources are same column", () => {
    const original = makeDoc([
      makePNode("o0", { columnHint: 0 }),
      makePNode("o1", { columnHint: 0 })
    ]);
    const merged = makeDoc([
      makePNode("m0", { _mergedFrom: ["o0", "o1"] })
    ]);

    const warnings = validateColumnBoundaries(merged, original);
    assert.equal(warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// validateParagraphLength
// ---------------------------------------------------------------------------
describe("validateParagraphLength", () => {
  it("flags paragraph > 2000 chars as warning", () => {
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1"],
        text: "A".repeat(2500)
      })
    ]);

    const warnings = validateParagraphLength(merged);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, "long paragraph");
    assert.equal(warnings[0].severity, "warning");
  });

  it("flags paragraph > 4000 chars as error", () => {
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1"],
        text: "B".repeat(4500)
      })
    ]);

    const warnings = validateParagraphLength(merged);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, "excessive paragraph length");
    assert.equal(warnings[0].severity, "error");
  });

  it("flags short merged paragraph < 15 chars", () => {
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1"],
        text: "Hi there."
      })
    ]);

    const warnings = validateParagraphLength(merged);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, "short merged paragraph");
    assert.equal(warnings[0].severity, "warning");
  });
});

// ---------------------------------------------------------------------------
// validateEmbeddedHeadings
// ---------------------------------------------------------------------------
describe("validateEmbeddedHeadings", () => {
  it("detects original heading merged into P", () => {
    const original = makeDoc([
      makePNode("o0", { role: "H2", text: "Section Title" }),
      makePNode("o1", { text: "Body text follows." })
    ]);
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1"],
        text: "Section Title Body text follows."
      })
    ]);

    const warnings = validateEmbeddedHeadings(merged, original);
    assert.ok(warnings.length >= 1);
    assert.ok(warnings.some((w) => w.type === "embedded heading"));
    assert.ok(warnings.some((w) => w.suggestion === "split before heading text"));
  });

  it("detects ALL CAPS line mid-paragraph", () => {
    const original = makeDoc([
      makePNode("o0", { text: "Intro text here." }),
      makePNode("o1", { text: "THIS IS A VERY IMPORTANT HEADING LINE" }),
      makePNode("o2", { text: "More body text." })
    ]);
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1", "o2"],
        text: "Intro text here.\nTHIS IS A VERY IMPORTANT HEADING LINE\nMore body text."
      })
    ]);

    const warnings = validateEmbeddedHeadings(merged, original);
    assert.ok(warnings.length >= 1);
    assert.ok(warnings.some((w) => w.type === "embedded heading" && w.detail.includes("ALL CAPS")));
  });
});

// ---------------------------------------------------------------------------
// validateReadingOrderPreservation
// ---------------------------------------------------------------------------
describe("validateReadingOrderPreservation", () => {
  it("detects reading order inversion", () => {
    // Original order: o0 at index 0, o1 at index 1, o2 at index 2
    const original = makeDoc([
      makePNode("o0", { bbox: [50, 50, 200, 12] }),
      makePNode("o1", { bbox: [50, 70, 200, 12] }),
      makePNode("o2", { bbox: [50, 90, 200, 12] })
    ]);
    // Merged has them in wrong order: o2 before o1
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o2", "o1"],
        text: "First. Third. Second."
      })
    ]);

    const warnings = validateReadingOrderPreservation(merged, original);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, "reading order inversion");
  });

  it("passes when order is preserved", () => {
    const original = makeDoc([
      makePNode("o0"),
      makePNode("o1"),
      makePNode("o2")
    ]);
    const merged = makeDoc([
      makePNode("m0", { _mergedFrom: ["o0", "o1", "o2"] })
    ]);

    const warnings = validateReadingOrderPreservation(merged, original);
    assert.equal(warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// validateConsistentSpacing
// ---------------------------------------------------------------------------
describe("validateConsistentSpacing", () => {
  it("flags inconsistent vertical gaps", () => {
    // 4 original nodes: 3 close together then one with a big gap
    const original = makeDoc([
      makePNode("o0", { bbox: [50, 50, 200, 12] }),
      makePNode("o1", { bbox: [50, 67, 200, 12] }),  // gap = 5
      makePNode("o2", { bbox: [50, 84, 200, 12] }),  // gap = 5
      makePNode("o3", { bbox: [50, 146, 200, 12] })  // gap = 50 — huge variance
    ]);
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1", "o2", "o3"],
        text: "Line one. Line two. Line three. Line four after gap."
      })
    ]);

    const warnings = validateConsistentSpacing(merged, original);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, "inconsistent spacing");
  });

  it("passes when spacing is uniform", () => {
    const original = makeDoc([
      makePNode("o0", { bbox: [50, 50, 200, 12] }),
      makePNode("o1", { bbox: [50, 67, 200, 12] }),  // gap = 5
      makePNode("o2", { bbox: [50, 84, 200, 12] }),  // gap = 5
      makePNode("o3", { bbox: [50, 101, 200, 12] })  // gap = 5
    ]);
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1", "o2", "o3"],
        text: "Uniform spacing throughout."
      })
    ]);

    const warnings = validateConsistentSpacing(merged, original);
    assert.equal(warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// runAllValidators — clean merge
// ---------------------------------------------------------------------------
describe("runAllValidators", () => {
  it("clean merge passes all validators with 0 warnings", () => {
    const original = makeDoc([
      makePNode("o0", { columnHint: 0, bbox: [50, 50, 200, 12] }),
      makePNode("o1", { columnHint: 0, bbox: [50, 67, 200, 12] }),
      makePNode("o2", { columnHint: 0, bbox: [50, 84, 200, 12] })
    ]);
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1", "o2"],
        text: "A clean merged paragraph that is not too long and not too short for validation.",
        bbox: [50, 50, 200, 46]
      })
    ]);

    const result = runAllValidators(merged, original);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.summary.errorCount, 0);
    assert.equal(result.summary.warningCount, 0);
    assert.equal(result.summary.flaggedNodeCount, 0);
    assert.equal(result.summary.passedNodeCount, 1);
  });

  it("errors sort before warnings", () => {
    const original = makeDoc([
      makePNode("o0", { columnHint: 0 }),
      makePNode("o1", { columnHint: 1 })
    ]);
    const merged = makeDoc([
      makePNode("m0", {
        _mergedFrom: ["o0", "o1"],
        text: "A".repeat(2500) // warning-level length
      })
    ]);

    const result = runAllValidators(merged, original);
    // Should have at least 1 error (cross-column) and 1 warning (length)
    assert.ok(result.summary.errorCount >= 1);
    assert.ok(result.summary.warningCount >= 1);
    // First warning should be error severity
    assert.equal(result.warnings[0].severity, "error");
  });
});
