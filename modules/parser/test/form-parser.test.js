import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { parsePdf } from "../index.js";

test("parser exposes real font names, existing title and widget label relationships", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "form-parser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = await PDFDocument.create();
  doc.setTitle("Existing court form title");
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Court Form", { x: 72, y: 720, size: 18, font: bold });
  page.drawText("County", { x: 72, y: 680, size: 12, font: regular });
  const field = doc.getForm().createTextField("county");
  field.acroField.dict.set(PDFName.of("TU"), PDFString.of("County name"));
  field.addToPage(page, { x: 125, y: 674, width: 130, height: 18 });
  field.acroField.getWidgets()[0].dict.set(PDFName.of("TU"), PDFString.of("County name"));
  const file = path.join(dir, "00-source.pdf");
  await writeFile(file, await doc.save());
  const parsed = await parsePdf(file, { ocr: { mode: "off" } });
  assert.equal(parsed.source.title, "Existing court form title");
  const result = parsed.pages[0];
  assert.match(result.textBlocks.find((block) => block.text === "Court Form").fontName, /Bold/);
  assert.equal(result.formFields.length, 1);
  assert.equal(result.formFields[0].fieldName, "county");
  assert.equal(result.formFields[0].tooltip, "County name");
  assert.deepEqual(result.textBlocks.find((block) => block.text === "County").formFieldIds,
    [result.formFields[0].id]);
});
