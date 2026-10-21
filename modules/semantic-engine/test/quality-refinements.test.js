import test from "node:test";
import assert from "node:assert/strict";
import { refineHeadingMembership, refineContinuations, contextOrderRelations, listOrdinal } from "../semantic-quality.js";
import { enrichDocumentRelations } from "../document-relations.js";
const n = (id, extra = {}) => ({ id, pageNumber: 1, role: "P", text: "unfinished text", bbox: [72, 720, 200, 12], fontName: "Sans", fontSize: 12, columnHint: 0, ...extra });
const pages = [1, 2, 3].map((pageNumber) => ({ pageNumber, height: 800 }));

test("only short, widget-associated heading labels are automatically reclassified", () => {
  const nodes = [n("field", { role: "H2", headingLevel: 2, text: "Index #:", formFieldIds: ["w"] }),
    n("section", { role: "H2", text: "Supporting documents:" }), n("numbered", { role: "H2", text: "1. Applicant:", formFieldIds: ["w"] })];
  refineHeadingMembership(nodes, pages);
  assert.deepEqual(nodes.map((p) => p.role), ["P", "H2", "H2"]);
  assert.equal(nodes[0].headingLevel, undefined);
});
test("repeated marginal headings are reviewed without discarding content", () => {
  const nodes = pages.map((p) => n(`h${p.pageNumber}`, { role: "H2", text: "Repeated publication name", pageNumber: p.pageNumber, bbox: [72, 12, 250, 12] }));
  assert.equal(refineHeadingMembership(nodes, pages).length, 3);
  assert.ok(nodes.every((p) => p.role === "H2"));
});
test("list ordinals distinguish decimal, Roman and lettered sequences", () => {
  assert.deepEqual(["12. Item", "iv) Item", "V. Item", "b) Item"].map(listOrdinal), [
    { style: "decimal", value: 12 }, { style: "roman-lower", value: 4 }, { style: "roman-upper", value: 5 }, { style: "alpha-lower", value: 2 }]);
  assert.equal(listOrdinal("• Item"), null); assert.equal(listOrdinal("ordinary prose"), null);
});
test("paragraph continuation requires typography, alignment, sentence and page-boundary evidence", () => {
  for (const change of [{ text: "New sentence" }, { fontName: "Serif" }, { bbox: [90, 100, 200, 12] }, { formFieldIds: ["w"] },
    { tableId: "table" }, { semanticRole: "Footnote" }, { direction: "rtl" }, { columnHint: 1 }, { pageNumber: 3 }]) {
    const nodes = [n("a"), n("b", { pageNumber: 2, text: "continued sentence", bbox: [72, 100, 200, 12], ...change })];
    assert.deepEqual(refineContinuations(nodes, pages), [], JSON.stringify(change));
    assert.equal(nodes[1].paragraphGroupId, undefined);
  }
  const nodes = [n("a"), n("b", { pageNumber: 2, text: "continued sentence", bbox: [72, 100, 200, 12] })];
  assert.equal(refineContinuations(nodes, pages).length, 1); assert.equal(nodes[0].paragraphGroupId, nodes[1].paragraphGroupId);
});
test("wrapped-label matching rejects separated fragments and ambiguous complete labels", () => {
  for (const extra of [{ bbox: [100, 116, 200, 12] }, { bbox: [72, 300, 200, 12] }, { columnHint: 1 }]) {
    const nodes = [n("a", { text: "Legal", formFieldIds: ["w"], bbox: [72, 100, 200, 12] }),
      n("b", { text: "name:", formFieldIds: ["w"], bbox: [72, 116, 200, 12], ...extra })];
    const r = enrichDocumentRelations(nodes, [{ pageNumber: 1, formFields: [{ id: "w", tooltip: "Legal name" }] }]);
    assert.equal(r.relations.filter((r) => r.type === "labels").length, 0);
    assert.ok(r.semanticReviewTasks.some((t) => t.code === "FORM_LABEL_AMBIGUOUS"));
  }
});
test("explicit anchors generate precedence and unresolved targets remain reviewable", () => {
  const nodes = [n("body"), n("note", { footnoteReferenceId: "body" }), n("caption", { captionForId: "missing" })];
  assert.deepEqual(contextOrderRelations(nodes), [{ type: "precedes", from: "body", to: "note", evidence: "explicit-footnote-reference" }]);
  assert.ok(enrichDocumentRelations(nodes, []).semanticReviewTasks.some((t) => t.code === "READING_ANCHOR_UNRESOLVED"));
});
test("wrapped labels can extend beyond the nearest parser fragment; conflicting tooltips require review", () => {
  const nodes = [n("first", { text: "Full legal", bbox: [72, 100, 180, 12] }),
    n("last", { text: "name:", formFieldIds: ["w"], bbox: [72, 116, 180, 12] })];
  const pages = [{ pageNumber: 1, formFields: [{ id: "w", bbox: [260, 116, 180, 12], tooltip: "Full legal name" }] }];
  const good = enrichDocumentRelations(nodes, pages);
  assert.deepEqual(good.formRelationships[0].widgets[0].labelNodeIds, ["first", "last"]);
  pages[0].formFields[0].tooltip = "Unrelated instruction";
  const mismatch = enrichDocumentRelations(nodes, pages);
  assert.ok(mismatch.semanticReviewTasks.some((t) => t.code === "FORM_LABEL_AMBIGUOUS"));
});
test("checkbox markers and separately worded explanation prompts preserve the authored accessible name", () => {
  const nodes = [n("choice", { text: "☐ The papers were not delivered. (explain below)", formFieldIds: ["w"] })];
  const tooltip = "The papers were not delivered (explain in the designated text box on page 2)";
  const result = enrichDocumentRelations(nodes, [{ pageNumber: 1, formFields: [{ id: "w", tooltip }] }]);
  assert.deepEqual(result.formRelationships[0].widgets[0].labelNodeIds, ["choice"]);
  assert.equal(result.formRelationships[0].widgets[0].tooltip, tooltip);
});
