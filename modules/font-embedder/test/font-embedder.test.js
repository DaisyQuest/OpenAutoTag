// Module-local tests for the font-embedder.
//
// Fixture A runs the full CLI pipeline against a tiny pdf-lib generated PDF
// that uses Standard 14 Helvetica unembedded. The remaining fixtures exercise
// analyzeFont() with hand-built pdfjs-style Font records that mirror the
// shapes of real embedded TTF, missing-ToUnicode TTF, and CID Identity-H
// composite fonts. Each test re-validates the assembled inventory through the
// JSON schema.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { analyzeFont } from "../lib/analyze.js";
import {
  buildFontInventory,
  buildInventoryFromEntries,
  getInventoryValidator
} from "../index.js";
import { buildTinyTtf } from "./fixtures/build-tiny-ttf.js";

const validateInventory = getInventoryValidator();

function findEntryByBaseFont(inventory, predicate) {
  return inventory.fonts.find((entry) => predicate(entry.baseFont));
}

test("Fixture A — Standard 14 unembedded font is flagged and remediated", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "font-embedder-A-"));
  const pdfPath = path.join(tempDir, "standard14.pdf");

  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const helvetica = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Hello standard fonts", { x: 72, y: 720, size: 18, font: helvetica });
  await writeFile(pdfPath, await document.save());

  const inventory = await buildFontInventory({ pdfPath });

  assert.ok(validateInventory(inventory), `inventory failed schema: ${JSON.stringify(validateInventory.errors)}`);
  assert.equal(inventory.summary.totalFonts >= 1, true, "expected at least one font");

  const helveticaEntry = findEntryByBaseFont(inventory, (baseFont) => /Helvetica/i.test(baseFont));
  assert.ok(helveticaEntry, "expected a Helvetica font entry");
  assert.equal(helveticaEntry.standard14, true, "Helvetica should be flagged as standard 14");
  assert.equal(helveticaEntry.embedded, false, "Helvetica should not be embedded");
  assert.equal(helveticaEntry.plan.action, "substitute-fallback");
  assert.ok(helveticaEntry.plan.fallbackKey, "expected a fallbackKey");
  assert.ok(inventory.fallbacks && inventory.fallbacks[helveticaEntry.plan.fallbackKey], "fallbacks map should describe the chosen fallback");
  assert.ok(inventory.summary.blockers.some((blocker) => blocker.blocker === "standard-14"));
});

function buildToUnicodeMap(pairs) {
  const map = new Map();
  for (const [key, value] of pairs) {
    map.set(key, value);
  }
  return map;
}

test("Fixture B — Embedded TTF with valid ToUnicode plans embed-as-is", () => {
  const ttf = buildTinyTtf({
    codeToGlyph: new Map([
      [0x41, 1],
      [0x42, 2],
      [0x43, 3],
      [0x44, 4]
    ]),
    fsType: 0
  });

  const pdfFont = {
    name: "GoodFont",
    loadedName: "g_d0_f1",
    type: "TrueType",
    subtype: "TrueType",
    isEmbedded: true,
    data: new Uint8Array(ttf),
    encodingName: "WinAnsiEncoding",
    differences: null,
    toUnicode: buildToUnicodeMap([
      [0x41, "A"],
      [0x42, "B"],
      [0x43, "C"],
      [0x44, "D"]
    ])
  };

  const rawRecord = {
    fontId: "g_d0_f1",
    pdfFont,
    pages: [1],
    glyphCount: 4,
    glyphIds: [0x41, 0x42, 0x43, 0x44],
    sampleText: "ABCD",
    inFormDA: false
  };

  const { fontEntry, blocker } = analyzeFont(rawRecord);
  assert.equal(fontEntry.embedded, true);
  assert.equal(fontEntry.standard14, false);
  assert.equal(fontEntry.toUnicode.present, true);
  assert.equal(fontEntry.toUnicode.coverage, 1);
  assert.equal(fontEntry.plan.action, "embed-as-is");
  assert.equal(blocker, null);

  const inventory = buildInventoryFromEntries({
    documentId: "font-inventory:fixture-b",
    source: { pdfPath: "/tmp/fixture-b.pdf" },
    fontEntries: [fontEntry],
    blockers: []
  });
  assert.ok(validateInventory(inventory), `inventory failed schema: ${JSON.stringify(validateInventory.errors)}`);
});

test("Fixture C — Embedded TTF without ToUnicode reconstructs from cmap-table", () => {
  const ttf = buildTinyTtf({
    codeToGlyph: new Map([
      [0x41, 1],
      [0x42, 2],
      [0x43, 3]
    ]),
    fsType: 0x0002 // restricted licence — should be reported but not block
  });

  const pdfFont = {
    name: "ABCDEF+SansEmbedded",
    loadedName: "g_d0_f2",
    type: "TrueType",
    subtype: "TrueType",
    isEmbedded: true,
    data: new Uint8Array(ttf),
    encodingName: "WinAnsiEncoding",
    differences: null,
    toUnicode: null
  };

  const rawRecord = {
    fontId: "g_d0_f2",
    pdfFont,
    pages: [1, 2],
    glyphCount: 3,
    glyphIds: [1, 2, 3],
    sampleText: "ABC",
    inFormDA: false
  };

  const { fontEntry, blocker } = analyzeFont(rawRecord);
  assert.equal(fontEntry.embedded, true);
  assert.equal(fontEntry.standard14, false);
  assert.equal(fontEntry.subsetPrefix, "ABCDEF");
  assert.equal(fontEntry.toUnicode.present, false);
  assert.equal(fontEntry.toUnicode.repairStrategy, "from-cmap-table");
  assert.equal(fontEntry.plan.action, "inject-to-unicode");
  assert.equal(fontEntry.license.flag, "restricted", "fsType bit 1 should map to restricted");
  assert.ok(blocker, "missing ToUnicode should still surface a warning blocker");
  assert.equal(blocker.blocker, "missing-to-unicode");
  assert.equal(blocker.severity, "warning");

  const inventory = buildInventoryFromEntries({
    documentId: "font-inventory:fixture-c",
    source: { pdfPath: "/tmp/fixture-c.pdf" },
    fontEntries: [fontEntry],
    blockers: [{ fontKey: fontEntry.fontKey, ...blocker }]
  });
  assert.ok(validateInventory(inventory), `inventory failed schema: ${JSON.stringify(validateInventory.errors)}`);
});

test("Fixture D — CID Identity-H composite font surfaces cidSystemInfo", () => {
  const pdfFont = {
    name: "MSung-Light",
    loadedName: "g_d0_f3",
    type: "Type0",
    subtype: "Type0",
    composite: true,
    cidFontType: 0,
    isEmbedded: true,
    data: new Uint8Array([0x00, 0x01, 0x02]),
    encodingName: "Identity-H",
    cidSystemInfo: { registry: "Adobe", ordering: "Identity", supplement: 0 },
    toUnicode: buildToUnicodeMap([
      [1, "中"],
      [2, "文"]
    ])
  };

  const rawRecord = {
    fontId: "g_d0_f3",
    pdfFont,
    pages: [1],
    glyphCount: 2,
    glyphIds: [1, 2],
    sampleText: "中文",
    inFormDA: false
  };

  const { fontEntry, blocker } = analyzeFont(rawRecord);
  assert.equal(fontEntry.subtype, "Type0");
  assert.equal(fontEntry.encoding.name, "Identity-H");
  assert.deepEqual(fontEntry.cidSystemInfo, { registry: "Adobe", ordering: "Identity", supplement: 0 });
  assert.equal(fontEntry.toUnicode.present, true);
  assert.equal(fontEntry.toUnicode.coverage, 1);
  assert.equal(fontEntry.plan.action, "embed-as-is");
  assert.equal(blocker, null);

  const inventory = buildInventoryFromEntries({
    documentId: "font-inventory:fixture-d",
    source: { pdfPath: "/tmp/fixture-d.pdf" },
    fontEntries: [fontEntry],
    blockers: []
  });
  assert.ok(validateInventory(inventory), `inventory failed schema: ${JSON.stringify(validateInventory.errors)}`);
});

test("Deterministic ordering — fonts and missingGlyphs are sorted", () => {
  const entries = [
    { fontKey: "ffffffffffffffff", baseFont: "ZFont", subtype: "TrueType", embedded: true, standard14: false,
      toUnicode: { present: true, coverage: 1, missingGlyphs: [], repairStrategy: null },
      encoding: { name: "WinAnsiEncoding", hasDifferences: false, isSymbolic: false },
      cidSystemInfo: null,
      usage: { pages: [2, 1], glyphCount: 3, sampleText: "ZZZ", inFormDA: false },
      license: { fsType: 0, flag: "installable", source: "os2-table" },
      plan: { action: "embed-as-is" } },
    { fontKey: "0000000000000001", baseFont: "AFont", subtype: "TrueType", embedded: true, standard14: false,
      toUnicode: { present: true, coverage: 1, missingGlyphs: [3, 1, 2], repairStrategy: null },
      encoding: { name: "WinAnsiEncoding", hasDifferences: false, isSymbolic: false },
      cidSystemInfo: null,
      usage: { pages: [1], glyphCount: 3, sampleText: "AAA", inFormDA: false },
      license: { fsType: 0, flag: "installable", source: "os2-table" },
      plan: { action: "embed-as-is" } }
  ];

  const inventory = buildInventoryFromEntries({
    documentId: "font-inventory:fixture-sort",
    source: { pdfPath: "/tmp/sort.pdf" },
    fontEntries: entries,
    blockers: []
  });
  assert.ok(validateInventory(inventory));
  assert.equal(inventory.fonts[0].baseFont, "AFont");
  assert.equal(inventory.fonts[1].baseFont, "ZFont");
});

test("CLI writes JSON to --output and validates via schema", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "font-embedder-cli-"));
  const pdfPath = path.join(tempDir, "cli.pdf");
  const outputPath = path.join(tempDir, "fonts.json");

  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const helvetica = await document.embedFont(StandardFonts.HelveticaBold);
  page.drawText("CLI test", { x: 72, y: 720, size: 18, font: helvetica });
  await writeFile(pdfPath, await document.save());

  const inventory = await buildFontInventory({ pdfPath });
  await writeFile(outputPath, JSON.stringify(inventory, null, 2));
  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  assert.ok(validateInventory(parsed));
  assert.equal(parsed.schemaVersion, "1.0.0");
});
