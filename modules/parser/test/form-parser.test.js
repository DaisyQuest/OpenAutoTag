import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFName, PDFString, PDFHexString, PDFRef, StandardFonts } from "pdf-lib";
import { parsePdf } from "../index.js";
import { authoredWidgetCaptions } from "../authored-widget-captions.js";

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

test("parser extracts button-owned captions and multiline metadata without treating values as labels", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "widget-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]), form = doc.getForm();
  form.createButton("reset").addToPage("Reset form", page, { x: 72, y: 700, width: 90, height: 24 });
  const check = form.createCheckBox("approved");
  check.addToPage(page, { x: 72, y: 650, width: 16, height: 16 });
  const text = form.createTextField("notes"); text.enableMultiline(); text.setText("Private field value");
  text.addToPage(page, { x: 72, y: 400, width: 200, height: 100 });
  const file = path.join(dir, "source.pdf"), bytes = Buffer.from(await doc.save());
  await writeFile(file, bytes);
  const parsed = await parsePdf(file, { ocr: { mode: "off" } });
  const button = parsed.pages[0].formFields.find(w => w.fieldName === "reset");
  const notes = parsed.pages[0].formFields.find(w => w.fieldName === "notes");
  assert.equal(button.appearanceText, "Reset form");
  assert.equal(button.appearanceTextSource, "normal-widget-appearance");
  assert.equal(button.authoredCaption, "Reset form");
  assert.equal(button.authoredCaptionSource, "widget-MK-CA");
  assert.equal(parsed.pages[0].formFields.find(w => w.fieldName === "approved").authoredCaption, undefined);
  assert.equal(notes.multiLine, true); assert.equal(notes.appearanceText, undefined);
  assert.deepEqual(await readFile(file), bytes);
});

test("authored captions stay bound to individual widgets sharing one field name", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authored-captions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = await PDFDocument.create(), button = doc.getForm().createButton("shared");
  for (const caption of ["First action", "Second action"]) {
    button.addToPage(caption, doc.addPage([612, 792]), { x: 72, y: 700, width: 110, height: 24 });
  }
  const file = path.join(dir, "source.pdf"), bytes = Buffer.from(await doc.save());
  await writeFile(file, bytes);
  const parsed = await parsePdf(file, { ocr: { mode: "off" } });
  const ws = parsed.pages.flatMap(p => p.formFields);
  assert.deepEqual(ws.map(w => w.authoredCaption), ["First action", "Second action"]);
  assert.deepEqual(ws.map(w => w.appearanceText), ["First action", "Second action"]);
  assert.equal(ws[0].fieldId, ws[1].fieldId); assert.notEqual(ws[0].id, ws[1].id);
  assert.deepEqual(await readFile(file), bytes);
});

test("caption metadata reader handles indirect strings, generations and invalid evidence conservatively", async () => {
  const doc = await PDFDocument.create(); doc.addPage();
  const ctx = doc.context;
  const add = value => ctx.register(ctx.obj(value));
  const widget = mk => add({ Subtype: "Widget", MK: mk });
  const literal = widget({ CA: PDFString.of("  Reset\n form  ") });
  const unicode = PDFRef.of(90, 3);
  ctx.assign(unicode, ctx.obj({ Subtype: "Widget", MK: add({ CA: ctx.register(PDFHexString.fromText("Réinitialiser")) }) }));
  for (const ca of [PDFString.of(" "), PDFString.of("x".repeat(161)), PDFString.of("bad\x00caption"),
    PDFHexString.fromText("bad\ufffdcaption"), PDFName.of("NameIsNotText"), 12]) widget({ CA: ca });
  widget({}); widget(12); add({ Subtype: "Widget" }); add({ Subtype: "Link", MK: { CA: PDFString.of("Wrong annotation") } });
  const bytes = await doc.save({ useObjectStreams: false });
  const result = await authoredWidgetCaptions(bytes);
  assert.equal(result.error, undefined);
  assert.deepEqual([...result.captions], [[`${literal.objectNumber}R`, "Reset form"], ["90R3", "Réinitialiser"]]);
  const invalid = await authoredWidgetCaptions(new Uint8Array(Buffer.from("Not a PDF")));
  assert.equal(invalid.captions.size, 0); assert.match(invalid.error, /captions unavailable/);
});
