import test from "node:test";
import assert from "node:assert/strict";
import { compareSavedSemantics } from "../saved-semantics.js";

const key = "page:1:stream:page:mcid:0";
function fixture(type = "P") {
  const node = { objectRef: "1 0 R", parentRef: "root", identifier: "oat:a", role: type, children: [], contentRefs: [key], headers: [], actualText: "", alt: "" };
  const inspection = { sourceHash: "a".repeat(64), issues: [], structure: [node], contentOrder: [key],
    navigation:{pageLabels:{present:false,treeHash:'a'.repeat(64),ranges:[],labels:['1']},outlines:{present:false,count:0,propertiesHash:'a'.repeat(64),graphHash:'a'.repeat(64),items:[]},namedDestinationsHash:'a'.repeat(64),issues:[]},
    textRuns: [{ pageNumber: 1, streamOrigin: "page", operatorIndex: 0, glyphStart: 0, glyphEnd: 4, owners: [key], artifact: false, fontName: "Fixture", glyphs: [..."Text"].map(c => [c.charCodeAt(0), c]) }],
    markedContent: [{ contentRef: key, sequenceCount: 1, glyphCount: 4, meaningfulGlyphCount: 4, unknownGlyphCount: 0, graphicsCount: 0 }] };
  const tagging = { root: { id: "a", type, label: "Text", sourceNodeIds: ["source"], children: [] } };
  return { inspection, tagging };
}
const failures = input => compareSavedSemantics(input).checks.filter(c => c.status === "fail");

test("an unexpected empty ActualText cannot silently suppress valid text", () => {
  const input = fixture(); input.inspection.structure[0].actualTextPresent = true;
  assert.ok(failures(input).some(c => c.code === "EMPTY_ACTUAL_TEXT"));
});
test("saved content evidence is mandatory and cannot be duplicated or absent", () => {
  assert.deepEqual(failures(fixture()), []);
  for (const change of [i => delete i.markedContent, i => i.markedContent = [], i => i.markedContent.push({ ...i.markedContent[0] }), i => i.markedContent[0].sequenceCount = 2]) {
    const input = fixture(); change(input.inspection); assert.ok(failures(input).length);
  }
});
test("empty, whitespace, unknown glyphs, graphics and OBJRs do not establish intended text", () => {
  for (const patch of [{ glyphCount: 0, meaningfulGlyphCount: 0 }, { meaningfulGlyphCount: 0 }, { meaningfulGlyphCount: 0, unknownGlyphCount: 4 }, { meaningfulGlyphCount: 0, graphicsCount: 1 }]) {
    const input = fixture(); Object.assign(input.inspection.markedContent[0], patch);
    assert.ok(failures(input).some(c => c.code === "CONTENT_ATTACHED"));
  }
  const input = fixture(); input.inspection.structure[0].contentRefs = ["obj:annot"];
  assert.ok(failures(input).some(c => c.code === "CONTENT_ATTACHED"));
});
test("graphical roles and intentionally blank cells retain appropriate attachment rules", () => {
  const figure = fixture("Figure"); Object.assign(figure.inspection.markedContent[0], { meaningfulGlyphCount: 0, graphicsCount: 1 });
  assert.deepEqual(failures(figure), []);
  const form = fixture("Form"); form.inspection.structure[0].contentRefs = ["obj:widget"];
  assert.deepEqual(failures(form), []);
  const blank = fixture(); blank.tagging.root.label = ""; blank.inspection.structure[0].contentRefs = []; blank.inspection.markedContent = [];
  assert.deepEqual(failures(blank), []);
});
test("preserved reference comparison checks saved sequence evidence in both inputs", () => {
  const { inspection } = fixture(), reference = structuredClone(inspection);
  assert.deepEqual(failures({ inspection, reference }), []);
  inspection.markedContent[0].meaningfulGlyphCount--;
  assert.ok(failures({ inspection, reference }).some(c => c.code === "SAVED_CONTENT_EVIDENCE"));
  delete reference.markedContent;
  assert.ok(failures({ inspection, reference }).some(c => c.code === "REFERENCE_CONTENT_INSPECTED"));
});

test("saved semantic comparison requires unchanged, well-formed navigation evidence",()=>{
  const {inspection}=fixture(),reference=structuredClone(inspection);
  inspection.navigation.pageLabels.labels[0]='i';assert.ok(failures({inspection,reference}).some(c=>c.code==='NAVIGATION_PRESERVED'));
  inspection.navigation=structuredClone(reference.navigation);inspection.navigation.issues=['OUTLINE_PARENT:1'];assert.ok(failures({inspection,reference}).some(c=>c.code==='NAVIGATION_WELL_FORMED'));
  delete inspection.navigation;assert.ok(failures({inspection,reference}).some(c=>c.code==='NAVIGATION_INSPECTED'));
});
