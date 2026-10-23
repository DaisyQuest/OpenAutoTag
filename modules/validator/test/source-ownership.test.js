import test from "node:test";
import assert from "node:assert/strict";
import { authoredReplacementIndex, textWithAuthoredReplacements, canonicalText, exactOverprintText } from "../source-ownership.js";

const run = (text, start = 0) => ({ pageNumber: 1, glyphStart: start, glyphEnd: start + text.length, glyphs: [...text].map(c => [c.charCodeAt(0), c]), owners: ["mcid:0"] });
const scope = (text, start = 0, end = 2) => ({ pageNumber: 1, glyphStart: start, glyphEnd: end, text, outermost: true });
const snapshot = scopes => ({ structure: [], textRuns: [], replacementScopes: scopes });
test("full text comparison keeps punctuation and requires all non-whitespace characters", () => {
  assert.equal(canonicalText("ﬁ x\n y"), "fixy");
  assert.notEqual(canonicalText("whole text"), canonicalText("whole"));
  assert.notEqual(canonicalText("a-b"), canonicalText("ab"));
});
test("only exact authored ranges authorize a replacement and adjacent text stays outside", () => {
  const source = snapshot([scope("expanded")]), saved = snapshot([scope("expanded")]), checks = [];
  const allowed = authoredReplacementIndex(source, saved, true, (...c) => checks.push(c));
  assert.equal(textWithAuthoredReplacements([run("XY"), run("!", 2)], allowed, "expanded!"), "expanded!");
  assert.equal(textWithAuthoredReplacements([run("X")], allowed, "expanded"), "X");
  assert.equal(textWithAuthoredReplacements([run("XY")], allowed, "XY"), "XY");
  assert.ok(checks.every(c => c[2] === c[3]));
  for (const actual of [scope("invented"), scope("expanded", 0, 1)]) {
    const failed = [], index = authoredReplacementIndex(source, snapshot([actual]), true, (...c) => failed.push(c));
    assert.equal(index.size, 0); assert.ok(failed.some(c => c[2] !== c[3]));
  }
  assert.equal(authoredReplacementIndex(source, saved, false, () => {}).size, 0);
});
test("source structure ActualText qualifies only across one continuous owned range", () => {
  const source = snapshot([]); source.textRuns = [run("XY")];
  source.structure = [{ objectRef: "s", parentRef: "root", actualTextPresent: true, actualText: "expanded", contentRefs: ["mcid:0"], children: [] }];
  const candidate = snapshot([scope("expanded")]);
  assert.equal(authoredReplacementIndex(source, candidate, true, () => {}).size, 1);
  source.textRuns = [run("X"), run("Y", 2)];
  assert.equal(authoredReplacementIndex(source, snapshot([scope("expanded", 0, 3)]), true, () => {}).size, 0);
});
test("contradictory source replacement scopes do not authorize exceptions", () => {
  const source = snapshot([scope("outer", 0, 3), scope("inner", 1, 2)]);
  assert.equal(authoredReplacementIndex(source, snapshot([scope("outer", 0, 3)]), true, () => {}).size, 0);
});
test("overprint collapse requires identical font, character and every position component", () => {
  const first = { ...run("XY"), fontName: "Same", positions: [[12,0,0,12,70,700,.6,0], [12,0,0,12,78,700,.6,0]] };
  const copy = structuredClone(first);
  assert.deepEqual(exactOverprintText([first, copy]), { text: "XY", removed: 2 });
  copy.positions[0][4] += .01; copy.positions[1][4] += .01;
  assert.equal(exactOverprintText([first, copy]), null);
  assert.equal(exactOverprintText([first, { ...first, fontName: "Different" }]), null);
  assert.equal(exactOverprintText([first, { ...first, positions: [] }]), null);
});
