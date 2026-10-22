import test from "node:test";
import assert from "node:assert/strict";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { widgetAppearanceText } from "../widget-evidence.js";
const glyphs = text => [...text].map(unicode => ({ unicode }));
const read = entries => widgetAppearanceText({ fnArray: entries.map(e => OPS[e[0]]), argsArray: entries.map(e => e.slice(1)) }, OPS);

test("appearance text is isolated by widget identity and includes split runs and TJ spaces", () => {
  const result = read([
    ["showText", glyphs("page content")], ["beginAnnotation", "reset"], ["showText", glyphs("Reset ")],
    ["moveText", 20, 0], ["showText", glyphs("form")], ["endAnnotation"],
    ["beginAnnotation", "print"], ["showText", [...glyphs("Print"), -250, ...glyphs("form")]], ["endAnnotation"],
    ["beginAnnotation", "unfinished"], ["showText", glyphs("Ignore")]
  ]);
  assert.deepEqual([...result], [["reset", "Reset form"], ["print", "Print form"]]);
});

test("unreadable, invisible, unsupported and excessive appearance text abstains", () => {
  for (const body of [
    [["setTextRenderingMode", 3], ["showText", glyphs("Invisible")]],
    [["setTextRenderingMode", 7], ["showText", glyphs("Clip only")]],
    [["showText", [{ fontChar: "X" }]]], [["showText", glyphs("\ufffd")]],
    [["showText", glyphs("x".repeat(321))]], [["showText", "bad operand"]],
    [["nextLineShowText", glyphs("unsupported")]], [["showText", glyphs("   ")]]
  ]) assert.equal(read([["beginAnnotation", "w"], ...body, ["endAnnotation"]]).size, 0);
  assert.equal(read([["beginAnnotation", "w"], ["save"], ["setTextRenderingMode", 3], ["restore"],
    ["showText", glyphs("Visible")], ["endAnnotation"]]).get("w"), "Visible");
});
