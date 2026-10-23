import test from "node:test";
import assert from "node:assert/strict";
import { mergeHeadingContinuations } from "../heading-continuation.js";

const line = (id, text, y, overrides = {}) => ({
  id, text, pageNumber: 1, sourceBlockId: `b-${id}`, role: "H2", headingLevel: 2,
  fontName: "ABCDEF+Arial-BoldMT", fontSize: 18, bbox: [122.4, y, 280, 18],
  confidence: 0.98, columnHint: 0, ...overrides
});

test("wrapped heading lines merge while side metadata and other pages stay separate", () => {
  const nodes = [line("a", "Supplemental Affirmation in", 35),
    line("code", "UCS-CC-5 (07/2026)", 44, { role: "P", bbox: [458, 44, 112, 12], fontSize: 12 }),
    line("b", "Support of Order to Show Cause", 55.7),
    line("page2", "Unrelated content", 45, { role: "P", pageNumber: 2 })];
  const before = structuredClone(nodes);
  const result = mergeHeadingContinuations(nodes);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.nodes[0].text, "Supplemental Affirmation in Support of Order to Show Cause");
  assert.deepEqual(result.nodes[0].sourceBlockIds, ["b-a", "b-b"]);
  assert.equal(result.nodes[0].headingLineCount, 2);
  assert.deepEqual(result.summary, { mergedGroups: 1, absorbedLines: 1 });
  assert.equal(result.nodes[1].text, "UCS-CC-5 (07/2026)");
  assert.deepEqual(nodes, before, "input nodes must not be mutated");
  assert.deepEqual(mergeHeadingContinuations(result.nodes).nodes, result.nodes, "a second pass is idempotent");
});

test("centered and three-line headings preserve their complete text", () => {
  const result = mergeHeadingContinuations([
    line("a", "Statement in", 35, { bbox: [172, 35, 180, 18] }),
    line("b", "Support of", 55.7, { bbox: [192, 55.7, 140, 18] }),
    line("c", "Relief", 76.4, { bbox: [222, 76.4, 80, 18] })
  ]);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].text, "Statement in Support of Relief");
  assert.equal(result.nodes[0].headingLineCount, 3);
});

test("a heading in another column does not interrupt a wrapped title", () => {
  const result = mergeHeadingContinuations([line("a", "Application for", 35),
    line("side", "Office Use", 44, { bbox: [458, 44, 112, 18], columnHint: 1 }),
    line("b", "Temporary Relief", 55.7)]);
  assert.equal(result.nodes[0].text, "Application for Temporary Relief");
  assert.equal(result.nodes.length, 2);
});

test("independent headings and incompatible layout boundaries are not joined", () => {
  const variants = [
    { text: "Separate Heading", firstText: "Introduction" },
    { fontName: "ArialMT" }, { fontSize: 12 }, { role: "H1" }, { pageNumber: 2 },
    { bbox: [122.4, 110, 280, 18] }, { bbox: [420, 55.7, 100, 18] },
    { columnHint: 1 }, { formFieldIds: ["field"] }, { textRotation: 90 },
    { bbox: [122.4, 35, 280, 18] }
  ];
  for (const { firstText = "Application for", ...overrides } of variants) {
    const nodes = [line("a", firstText, 35), line("b", "Temporary Relief", 55.7, overrides)];
    assert.equal(mergeHeadingContinuations(nodes).nodes.length, 2, JSON.stringify(overrides));
  }
  const blocked = [line("a", "Application for", 35),
    line("body", "Intervening instructions", 45, { role: "P" }), line("b", "Temporary Relief", 55.7)];
  assert.equal(mergeHeadingContinuations(blocked).nodes.length, 3);
});

test("mixed bold faces and uppercase connector lines form one heading while subtitle rank is retained",()=>{
 for(const text of ["An overview","THE BIG PICTURE","For applicants"])assert.equal(mergeHeadingContinuations([line("a","Introduction",35),line("b",text,55.7)]).nodes.length,2,text);
 for(const fontName of ["ABCDEF+Arial-BoldItalicMT","TimesNewRoman-Bold","Helvetica-Bold"]) {
  const result=mergeHeadingContinuations([line("a","SUPPLEMENTAL AFFIRMATION",35),
   line("b","IN SUPPORT OF ORDER TO SHOW CAUSE",55.7,{fontName}),line("subtitle","Instructions for applicants",83,{role:"H3",headingLevel:3,fontSize:14})]);
  assert.equal(result.nodes.length,2,fontName);assert.equal(result.nodes[0].headingLineCount,2);
  assert.equal(result.nodes[0].text,"SUPPLEMENTAL AFFIRMATION IN SUPPORT OF ORDER TO SHOW CAUSE");
  assert.equal(result.nodes[1].role,"H3");assert.deepEqual(result.nodes[0].sourceBlockIds,["b-a","b-b"]);
 }
});
