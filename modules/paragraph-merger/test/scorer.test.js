import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreMergeResult } from "../lib/scorer.js";

// ---------------------------------------------------------------------------
// Helper: build minimal original / merged structures
// ---------------------------------------------------------------------------
function makeOriginal(nodes) {
  return { nodes };
}

function makeMerged(nodes) {
  return { nodes };
}

function makeReport(totalMerges, totalSkips, pages = []) {
  return { summary: { totalMerges, totalSkips }, pages };
}

// ---------------------------------------------------------------------------
// Weight-tuning regression: v3-aggressive vs v4-style
// ---------------------------------------------------------------------------
describe("scoreMergeResult — weight tuning", () => {
  it("v3-aggressive (high reduction, high overMerge) scores LOWER than v4 (moderate reduction, low overMerge)", () => {
    // Shared original: 20 P-nodes on one page, modest bboxes
    const origNodes = Array.from({ length: 20 }, (_, i) => ({
      id: `o${i}`,
      role: "P",
      pageNumber: 1,
      bbox: [50, 50 + i * 30, 200, 12],
      text: "Original paragraph text number " + i + "."
    }));
    const original = makeOriginal(origNodes);

    // --- v3-aggressive: merges aggressively, 4 result paragraphs (80% reduction)
    // but 2 of 4 have over-merge signals (double newlines, >800 chars)
    const v3Nodes = [
      {
        id: "m0", role: "P", pageNumber: 1, bbox: [50, 50, 200, 12],
        _mergedFrom: ["o0", "o1", "o2", "o3", "o4"],
        text: "A".repeat(900) // >800 chars = over-merge signal
      },
      {
        id: "m1", role: "P", pageNumber: 1, bbox: [50, 200, 200, 12],
        _mergedFrom: ["o5", "o6", "o7", "o8", "o9"],
        text: "First part.\n\nSecond part after double newline." // double-newline signal
      },
      {
        id: "m2", role: "P", pageNumber: 1, bbox: [50, 350, 200, 12],
        _mergedFrom: ["o10", "o11", "o12", "o13", "o14"],
        text: "Clean merged paragraph that ends properly."
      },
      {
        id: "m3", role: "P", pageNumber: 1, bbox: [50, 500, 200, 12],
        _mergedFrom: ["o15", "o16", "o17", "o18", "o19"],
        text: "Another clean merged paragraph."
      }
    ];
    const v3Merged = makeMerged(v3Nodes);
    const v3Report = makeReport(16, 0);

    // --- v4-style: moderate merging, 10 result paragraphs (50% reduction)
    // but zero over-merge signals
    const v4Nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `v4m${i}`,
      role: "P",
      pageNumber: 1,
      bbox: [50, 50 + i * 60, 200, 12],
      _mergedFrom: [`o${i * 2}`, `o${i * 2 + 1}`],
      text: "Properly merged paragraph pair number " + i + "."
    }));
    const v4Merged = makeMerged(v4Nodes);
    const v4Report = makeReport(10, 0);

    const v3Score = scoreMergeResult(original, v3Merged, v3Report);
    const v4Score = scoreMergeResult(original, v4Merged, v4Report);

    // v4 should win under new weights that penalise over-merging heavily
    assert.ok(
      v4Score.aggregate > v3Score.aggregate,
      `v4 aggregate (${v4Score.aggregate.toFixed(4)}) should be > v3 aggregate (${v3Score.aggregate.toFixed(4)})`
    );

    // Verify over-merge rate is higher for v3
    assert.ok(
      v3Score.overMergeRate > v4Score.overMergeRate,
      `v3 overMergeRate (${v3Score.overMergeRate}) should be > v4 overMergeRate (${v4Score.overMergeRate})`
    );
  });
});

// ---------------------------------------------------------------------------
// Over-merge detection: new heuristics
// ---------------------------------------------------------------------------
describe("scoreMergeResult — over-merge detection", () => {
  it("detects >800 char paragraphs as over-merged", () => {
    const original = makeOriginal([
      { id: "o0", role: "P", pageNumber: 1, bbox: [50, 50, 200, 12], text: "A" },
      { id: "o1", role: "P", pageNumber: 1, bbox: [50, 70, 200, 12], text: "B" }
    ]);
    const merged = makeMerged([
      {
        id: "m0", role: "P", pageNumber: 1, bbox: [50, 50, 200, 12],
        _mergedFrom: ["o0", "o1"],
        text: "X".repeat(801)
      }
    ]);
    const report = makeReport(1, 0);
    const scores = scoreMergeResult(original, merged, report);
    assert.ok(scores.overMergeRate > 0, "should detect over-merge for >800 char paragraph");
  });

  it("detects ALL CAPS heading mid-paragraph as over-merged", () => {
    const original = makeOriginal([
      { id: "o0", role: "P", pageNumber: 1, bbox: [50, 50, 200, 12], text: "A" },
      { id: "o1", role: "P", pageNumber: 1, bbox: [50, 70, 200, 12], text: "B" }
    ]);
    const merged = makeMerged([
      {
        id: "m0", role: "P", pageNumber: 1, bbox: [50, 50, 200, 12],
        _mergedFrom: ["o0", "o1"],
        text: "Some intro text.\nTHIS IS A HEADING LINE HERE\nSome body text after."
      }
    ]);
    const report = makeReport(1, 0);
    const scores = scoreMergeResult(original, merged, report);
    assert.ok(scores.overMergeRate > 0, "should detect over-merge for mid-paragraph heading");
  });

  it("detects cross-column merge in multi-column doc", () => {
    // Two-column original: nodes at x=50 and x=350 on a ~600px wide page
    const original = makeOriginal([
      { id: "o0", role: "P", pageNumber: 1, bbox: [50, 50, 200, 12], text: "Left col." },
      { id: "o1", role: "P", pageNumber: 1, bbox: [350, 50, 200, 12], text: "Right col." }
    ]);
    // Merged spans full page width (560 > 90% of 550)
    const merged = makeMerged([
      {
        id: "m0", role: "P", pageNumber: 1, bbox: [50, 50, 510, 12],
        _mergedFrom: ["o0", "o1"],
        text: "Left col. Right col."
      }
    ]);
    const report = makeReport(1, 0);
    const scores = scoreMergeResult(original, merged, report);
    assert.ok(scores.overMergeRate > 0, "should detect cross-column over-merge");
  });
});
