import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { groupTextItemsToBlocks, parsePdf } from "../index.js";

const item = extra => ({ str: "Repeated", transform: [12, 0, 0, 12, 72, 700], width: 55, height: 12, fontName: "F1", dir: "ltr", ...extra });

test("overprinted text is represented once while source items and line boundaries are preserved", () => {
  const items = [item(), item({ hasEOL: true }), item({ str: "Next", transform: [12, 0, 0, 12, 140, 700], width: 30 })];
  const original = structuredClone(items);
  assert.deepEqual(groupTextItemsToBlocks(1, 792, items).map(n => n.text), ["Repeated", "Next"]);
  assert.deepEqual(items, original);
});

test("overprint recognition requires identical geometry, text and source font resource", () => {
  for (const change of [
    { transform: [12, 0, 0, 12, 72.001, 700] }, { width: 55.001 }, { height: 12.001 },
    { fontName: "F2" }, { fontResourceName: "resource2" }, { str: "Different" }, { dir: "rtl" },
    { transform: [0, 12, -12, 0, 72, 700] }
  ]) {
    const blocks = groupTextItemsToBlocks(1, 792, [item({ fontResourceName: "resource1" }), item({ fontResourceName: "resource1", ...change })]);
    assert.equal(blocks.map(n => n.text).join(" ").replaceAll(" ", ""), "Repeated" + (change.str || "Repeated"));
  }
});

test("rotated exact overprints collapse but the same words elsewhere remain", () => {
  const rotated = item({ transform: [0, 12, -12, 0, 72, 700], hasEOL: true });
  const blocks = groupTextItemsToBlocks(1, 792, [rotated, { ...rotated }, { ...rotated, transform: [0, 12, -12, 0, 140, 700] }]);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(n => n.text === "Repeated"));
});

test("real PDF extraction removes semantic overprints without changing the source PDF", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parser-overprint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pdf = await PDFDocument.create(), page = pdf.addPage(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const y of [700, 700, 660]) page.drawText("One visible label", { x: 72, y, font, size: 12 });
  const file = path.join(dir, "overprint.pdf"), source = await pdf.save(); await writeFile(file, source);
  const parsed = await parsePdf(file, { ocr: { mode: "off" } });
  assert.deepEqual(parsed.pages[0].textBlocks.map(n => n.text), ["One visible label", "One visible label"]);
  assert.deepEqual(new Uint8Array(await readFile(file)), source);
});
