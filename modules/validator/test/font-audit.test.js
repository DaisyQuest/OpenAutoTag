import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { runFontAuditCli } from "../index.js";
import {
  buildPdfWithIncompleteToUnicode,
  buildPdfWithSubsetEmbeddedTtf,
  buildPdfWithFormFieldDaMissingFont
} from "./fixtures/font-audit-fixtures.js";

async function tmp(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("font-audit flags Standard 14 unembedded fonts", async () => {
  const dir = await tmp("font-audit-std14-");
  const pdfPath = path.join(dir, "standard14.pdf");

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Hello PDF/UA", { x: 72, y: 720, size: 18, font });
  await writeFile(pdfPath, await doc.save());

  const result = await runFontAuditCli(pdfPath);

  assert.ok(result.fonts.length >= 1, "expected at least one font");
  const helvetica = result.fonts.find((f) => f.name.endsWith("Helvetica"));
  assert.ok(helvetica, "expected Helvetica entry");
  assert.equal(helvetica.embedded, false);
  assert.equal(helvetica.standard14, true);

  const std14Findings = result.findings.filter((f) => f.code === "FONT_STANDARD_14");
  assert.equal(std14Findings.length, 1);
  assert.equal(std14Findings[0].severity, "error");
});

test("font-audit flags incomplete /ToUnicode coverage as error", async () => {
  const dir = await tmp("font-audit-tounicode-");
  const pdfPath = path.join(dir, "incomplete-tounicode.pdf");
  await buildPdfWithIncompleteToUnicode(pdfPath);

  const result = await runFontAuditCli(pdfPath);

  const incomplete = result.findings.filter((f) => f.code === "TO_UNICODE_INCOMPLETE");
  assert.ok(incomplete.length >= 1, `expected TO_UNICODE_INCOMPLETE finding, got ${JSON.stringify(result.findings)}`);
  assert.equal(incomplete[0].severity, "error");

  const fontEntry = result.fonts.find((f) => f.usedGlyphCount > 0);
  assert.ok(fontEntry);
  assert.ok(fontEntry.toUnicodeCoverage < 0.95, `coverage ${fontEntry.toUnicodeCoverage} should be < 0.95`);
});

test("font-audit emits zero findings for fully embedded TTF subset with complete /ToUnicode", async () => {
  const dir = await tmp("font-audit-clean-");
  const pdfPath = path.join(dir, "clean-embedded.pdf");
  await buildPdfWithSubsetEmbeddedTtf(pdfPath);

  const result = await runFontAuditCli(pdfPath);

  assert.ok(result.fonts.length >= 1);
  const blocking = result.findings.filter((f) => f.severity === "error");
  assert.equal(
    blocking.length,
    0,
    `expected no error findings, got ${JSON.stringify(blocking)}`
  );
});

test("font-audit reports DA_FONT_NOT_IN_DR for form field referencing missing font", async () => {
  const dir = await tmp("font-audit-da-");
  const pdfPath = path.join(dir, "da-missing.pdf");
  await buildPdfWithFormFieldDaMissingFont(pdfPath);

  const result = await runFontAuditCli(pdfPath);

  const daFindings = result.findings.filter((f) => f.code === "DA_FONT_NOT_IN_DR");
  assert.equal(daFindings.length, 1, `expected DA_FONT_NOT_IN_DR, got ${JSON.stringify(result.findings)}`);
  assert.equal(daFindings[0].severity, "error");
});

test("font-audit output is byte-stable across two runs", async () => {
  const dir = await tmp("font-audit-deterministic-");
  const pdfPath = path.join(dir, "stable.pdf");
  await buildPdfWithSubsetEmbeddedTtf(pdfPath);

  const first = await runFontAuditCli(pdfPath);
  const second = await runFontAuditCli(pdfPath);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
