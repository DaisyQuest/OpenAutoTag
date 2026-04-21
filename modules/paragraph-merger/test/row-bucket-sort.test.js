import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { textStructureMerge } from "../lib/text-structure-merge.js";

function makeDoc(nodes) {
  return { sourceFile: "test.pdf", pageCount: 1, nodes };
}

function node(id, text, x, y, width = 30) {
  return { id, role: "P", text, bbox: [x, y, width, 11], pageNumber: 1 };
}

function footnoteNode(id, text, x, y, width = 30) {
  return {
    ...node(id, text, x, y, width),
    semanticRole: "Footnote",
    footnote: true,
    footnoteGroupId: "footnote:1:88:1",
    footnoteMarker: "88"
  };
}

describe("row-bucket sort for same-line blocks with fractional Y drift", () => {
  it("sorts same-visual-row blocks left-to-right regardless of content-stream order", () => {
    // Regression for 2025_35268: each word is its own block, emitted in
    // right-to-left content-stream order with tiny fractional Y
    // differences. Strict Y-sort used to preserve the reversed order;
    // bucket-based row-snap must group them and sort by X.
    const doc = makeDoc([
      node("n1", "YORK", 275, 73.338),
      node("n2", "NEW",  244, 73.520),
      node("n3", "OF",   226, 73.624),
      node("n4", "CITY", 195, 73.807),
      node("n5", "THE",  168, 73.963),
      node("n6", "OF",   149, 74.073),
      node("n7", "CIVIL COURT", 71, 74.530)
    ]);

    const result = textStructureMerge(doc);
    const merged = result.document.nodes.find((n) => (n.text || "").includes("CIVIL"));

    assert.ok(merged, "expected a merged paragraph");
    assert.equal(
      merged.text,
      "CIVIL COURT OF THE CITY OF NEW YORK",
      "same-row blocks must be concatenated in ascending-X order"
    );
  });

  it("does not merge blocks that are clearly on different visual rows", () => {
    const doc = makeDoc([
      node("n1", "first line",  50, 100),
      node("n2", "second line", 50, 120)
    ]);

    const result = textStructureMerge(doc);
    assert.equal(result.document.nodes.length, 1, "both lines merge into one paragraph");
    assert.equal(result.document.nodes[0].text, "first line second line");
  });

  it("keeps footnotes separate from body text while merging the footnote lines", () => {
    const doc = makeDoc([
      node("body", "The body paragraph ends near the bottom.", 72, 700, 260),
      footnoteNode("fn-marker", "88", 72, 732.8, 7),
      footnoteNode("fn-line-1", "When a 3% discount rate is applied,", 81, 732.3, 220),
      footnoteNode("fn-line-2", "the annualized cost saving is $276 million.", 72, 743.8, 258)
    ]);

    const result = textStructureMerge(doc);
    const body = result.document.nodes.find((n) => n.id === "body");
    const footnote = result.document.nodes.find((n) => n.footnoteGroupId === "footnote:1:88:1");

    assert.equal(result.document.nodes.length, 2);
    assert.equal(body.text, "The body paragraph ends near the bottom.");
    assert.equal(footnote.semanticRole, "Footnote");
    assert.equal(
      footnote.text,
      "88 When a 3% discount rate is applied, the annualized cost saving is $276 million."
    );
  });
});
