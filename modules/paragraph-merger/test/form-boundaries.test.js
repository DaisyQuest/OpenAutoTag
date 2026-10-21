import test from "node:test";
import assert from "node:assert/strict";
import { textStructureMerge } from "../lib/text-structure-merge.js";

const node = (id, text, y, extra = {}) => ({
  id, text, role: "P", pageNumber: 1, bbox: [72, y, 240, 12], fontSize: 12, ...extra
});
const merge = (nodes) => textStructureMerge({ nodes }).document.nodes;

test("checkbox options retain boundaries while their continuation lines can merge", () => {
  const nodes = merge([node("a", "☐ First option that", 100),
    node("b", "continues on the next line.", 114), node("c", "☐ Second option.", 128)]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].text, "☐ First option that continues on the next line.");
  assert.equal(nodes[1].text, "☐ Second option.");
});

test("paragraphs cannot merge through headings or list items", () => {
  for (const role of ["H1", "LI", "TH"]) {
    const nodes = merge([node("a", "Previous paragraph.", 100),
      node("barrier", "Intervening element", 114, { role }), node("b", "Following paragraph.", 128)]);
    assert.equal(nodes.length, 3, role);
    assert.ok(nodes.some((n) => n.text === "Following paragraph."));
  }
});

test("separate same-row labels and differently sized text do not merge", () => {
  const labels = merge([node("a", "County", 100, { bbox: [36, 100, 45, 12] }),
    node("b", "Index", 100, { bbox: [423, 100, 50, 12] })]);
  assert.equal(labels.length, 2);
  assert.equal(merge([node("title", "Title", 100, { fontSize: 18 }),
    node("body", "Instructions", 114)]).length, 2);
});

test("same-row word fragments with coarse bounding boxes can still form a line", () => {
  const nodes = merge([node("a", "CIVIL COURT", 100, { bbox: [71, 100, 30, 12] }),
    node("b", "OF THE CITY", 100, { bbox: [149, 100, 80, 12] })]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "CIVIL COURT OF THE CITY");
});

test("different form fields stay separate while a shared field label can wrap", () => {
  assert.equal(merge([node("a", "County", 100, { formFieldIds: ["county"] }),
    node("b", "Index", 114, { formFieldIds: ["index"] })]).length, 2);
  assert.equal(merge([node("a", "County", 100, { formFieldIds: ["county"] }),
    node("b", "Instructions", 114)]).length, 2);
  assert.equal(merge([node("a", "Long field label", 100, { formFieldIds: ["field"] }),
    node("b", "continued.", 114, { formFieldIds: ["field"] })]).length, 1);
});
