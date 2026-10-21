import test from "node:test";
import assert from "node:assert/strict";
import { enrichDocumentRelations } from "../document-relations.js";
const node = (id, extra = {}) => ({ id, role: "P", text: id, bbox: [72, 100, 100, 12], pageNumber: 1, ...extra });

test("authored tooltips disambiguate labels and shared field identities group widgets", () => {
  const nodes = [node("label", { text: "Name:", formFieldIds: ["w1", "w2"] }), node("instruction", { formFieldIds: ["w1"] })];
  const result = enrichDocumentRelations(nodes, [{ pageNumber: 1, formFields: [
    { id: "w1", fieldId: "name", fieldType: "Tx", tooltip: "Name" }, { id: "w2", fieldId: "name", fieldType: "Tx" } ] }]);
  assert.equal(result.formRelationships.length, 1);
  assert.equal(result.formRelationships[0].widgets.length, 2);
  assert.deepEqual(result.relations.filter((r) => r.type === "labels").map((r) => r.from), ["label", "label"]);
  assert.deepEqual(result.semanticReviewTasks, []);
  const ambiguous = enrichDocumentRelations(nodes, [{ pageNumber: 1, formFields: [{ id: "w1" }] }]);
  assert.equal(ambiguous.relations.filter((r) => r.type === "labels").length, 0);
  assert.equal(ambiguous.semanticReviewTasks[0].code, "FORM_LABEL_AMBIGUOUS");
});

test("numbered headings retain levels four through six; style conflicts become review tasks", () => {
  const nodes = [4, 5, 6].map((depth) => node(`h${depth}`, { role: "H2", text: `${Array(depth).fill(1).join(".")} Topic`, bbox: [72, depth * 20, 100, 12] }));
  nodes.push(node("first", { role: "H1", fontName: "Times", fontSize: 12 }), node("conflict", { role: "H2", fontName: "Times", fontSize: 12, bbox: [72, 140, 100, 12] }));
  const result = enrichDocumentRelations(nodes, []);
  assert.deepEqual(nodes.slice(0, 3).map((n) => n.role), ["H4", "H5", "H6"]);
  assert.ok(result.semanticReviewTasks.some((t) => t.nodeId === "conflict"));
});

test("cross-page list continuation requires numbering, alignment, boundary position and known groups", () => {
  const pages = [1, 2].map((pageNumber) => ({ pageNumber, height: 800 }));
  const pair = () => [node("a", { role: "LI", text: "1. First", listGroupId: "one", bbox: [72, 700, 100, 12] }),
    node("b", { role: "LI", text: "2. Second", listGroupId: "two", pageNumber: 2 })];
  const good = pair();
  assert.equal(enrichDocumentRelations(good, pages).relations[0].type, "continues");
  assert.equal(good[1].listGroupId, "one");
  for (const change of [{ text: "1. Restart" }, { bbox: [120, 100, 100, 12] }, { bbox: [72, 500, 100, 12] }, { formFieldIds: ["w"] }, { listGroupId: undefined }]) {
    const nodes = pair(); Object.assign(nodes[1], change);
    assert.equal(enrichDocumentRelations(nodes, pages).relations.length, 0, JSON.stringify(change));
  }
});
