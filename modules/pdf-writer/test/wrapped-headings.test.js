import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFOperator, StandardFonts } from "pdf-lib";
import { writeTaggedArtifacts } from "../index.js";

const name = (key) => PDFName.of(key);

async function createFixture(dir, { firstText = "Application in", secondText = "Support of Relief", size = 18,
  secondX = 72, secondY = 699.3, secondSize = 18, differentFont = false, blocker = false,
  differentSection = false, centered = false, thirdText = null } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle("Wrapped title fixture");
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const firstX = centered ? 250 - bold.widthOfTextAtSize(firstText, size) / 2 : 72;
  if (centered) secondX = 250 - (differentFont ? regular : bold).widthOfTextAtSize(secondText, secondSize) / 2;
  const lines = [
    { id: "first", text: firstText, x: firstX, y: 720, size, font: bold, role: "H2", mcid: 0 },
    { id: "second", text: secondText, x: secondX, y: secondY, size: secondSize, font: differentFont ? regular : bold, role: "H2", mcid: 1 },
    { id: "code", text: "FORM-42", x: blocker ? 80 : 450, y: 711, size: 10, font: regular, role: "P", mcid: 2 },
    { id: "label", text: "County", x: 72, y: 650, size: 12, font: regular, role: "P", mcid: 3 }
  ];
  if (thirdText) lines.push({ id: "third", text: thirdText, x: 72, y: 678.6, size: 18, font: bold, role: "H2", mcid: 4 });
  for (const line of lines) {
    page.pushOperators(PDFOperator.of("BDC", [name(line.role), doc.context.obj({ MCID: line.mcid })]));
    page.drawText(line.text, { x: line.x, y: line.y, size: line.size, font: line.font });
    page.pushOperators(PDFOperator.of("EMC"));
  }
  const field = doc.getForm().createTextField("county");
  field.acroField.dict.set(name("TU"), PDFString.of("County name"));
  field.addToPage(page, { x: 130, y: 644, width: 130, height: 18 });
  const widget = field.acroField.getWidgets()[0];
  widget.dict.set(name("StructParent"), doc.context.obj(1));

  const register = (value) => doc.context.register(doc.context.obj(value));
  const root = register({ Type: "StructTreeRoot" });
  const document = register({ Type: "StructElem", S: "Document", P: root });
  const part1 = register({ Type: "StructElem", S: differentSection ? "Sect" : "Part", P: document });
  const part2 = register({ Type: "StructElem", S: differentSection ? "Sect" : "Part", P: document });
  const first = register({ Type: "StructElem", S: "H2", P: part1, Pg: page.ref, K: 0, ID: PDFString.of("line-1"), C: "HeadingMain" });
  const second = register({ Type: "StructElem", S: "H2", P: part2, Pg: page.ref, K: 1, ID: PDFString.of("line-2"), C: ["HeadingMain", "HeadingContinuation"] });
  const code = register({ Type: "StructElem", S: "P", P: part1, Pg: page.ref, K: 2 });
  const third = thirdText ? register({ Type: "StructElem", S: "H2", P: part2, Pg: page.ref, K: 4 }) : null;
  const label = register({ Type: "StructElem", S: "P", P: part2, Pg: page.ref });
  const form = register({ Type: "StructElem", S: "Form", P: label, Pg: page.ref,
    K: { Type: "OBJR", Pg: page.ref, Obj: doc.context.getObjectRef(widget.dict) } });
  doc.context.lookup(label, PDFDict).set(name("K"), doc.context.obj([3, form]));
  doc.context.lookup(part1, PDFDict).set(name("K"), doc.context.obj([first, code]));
  doc.context.lookup(part2, PDFDict).set(name("K"), doc.context.obj(third ? [second, third, label] : [second, label]));
  doc.context.lookup(document, PDFDict).set(name("K"), doc.context.obj([part1, part2]));
  const rootDict = doc.context.lookup(root, PDFDict);
  rootDict.set(name("K"), doc.context.obj([document]));
  rootDict.set(name("ParentTree"), register({ Nums: [0, third ? [first, second, code, label, third] : [first, second, code, label], 1, form] }));
  rootDict.set(name("ParentTreeNextKey"), doc.context.obj(2));
  rootDict.set(name("ClassMap"), doc.context.obj({ HeadingMain: { O: "Layout" }, HeadingContinuation: { O: "Layout", SpaceAfter: 0 } }));
  rootDict.set(name("IDTree"), register({ Names: [PDFString.of("line-1"), first, PDFString.of("line-2"), second] }));
  doc.catalog.set(name("StructTreeRoot"), root);
  doc.catalog.set(name("MarkInfo"), doc.context.obj({ Marked: true }));
  page.node.set(name("StructParents"), doc.context.obj(0));

  const pdfPath = path.join(dir, "source.pdf"), semanticPath = path.join(dir, "semantic.json"), tagsPath = path.join(dir, "tags.json");
  await writeFile(pdfPath, await doc.save());
  const nodes = lines.map((line, i) => ({ id: line.id, role: line.role, pageNumber: 1, sourceBlockId: `b${i}`,
    text: line.text, bbox: [line.x, 792 - line.y - line.size, 350, line.size], confidence: 1, readingOrder: i }));
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "fixture",
    source: { layoutDocumentId: "fixture" }, nodes }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags",
    source: { semanticDocumentId: "fixture" }, root: { id: "root", type: "Document", children: nodes.map((n) =>
      ({ id: `tag:${n.id}`, type: n.role, label: n.text, sourceNodeIds: [n.id], children: [] })) } }));
  return { pdfPath, semanticPath, tagsPath, first, second, third, part1, part2, form, label };
}

test("preserved PDFs consolidate a wrapped heading without changing MCIDs, IDs, styles or widgets", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wrapped-heading-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await createFixture(dir);
  const outputPath = path.join(dir, "result.pdf");
  const result = await writeTaggedArtifacts({ ...fixture, outputPath, mode: "auto" });
  assert.equal(result.writerMode, "passthrough");
  assert.equal(result.headingContinuationsMerged, 1);
  const bytes = await readFile(outputPath), original = await readFile(fixture.pdfPath);
  assert.deepEqual(bytes.subarray(0, original.length), original);
  const doc = await PDFDocument.load(bytes);
  const first = doc.context.lookup(fixture.first, PDFDict), second = doc.context.lookup(fixture.second, PDFDict);
  assert.equal(first.lookup(name("S"), PDFName).decodeText(), "H2");
  assert.equal(second.lookup(name("S"), PDFName).decodeText(), "Span");
  assert.equal(second.get(name("P")).toString(), fixture.first.toString());
  assert.deepEqual(first.lookup(name("K"), PDFArray).asArray().map(String), ["0", fixture.second.toString()]);
  assert.equal(second.lookup(name("K")).toString(), "1");
  assert.deepEqual(second.lookup(name("C"), PDFArray).asArray().map(String), ["/HeadingMain", "/HeadingContinuation"]);
  const part2Kids = doc.context.lookup(fixture.part2, PDFDict).lookup(name("K"), PDFArray).asArray();
  assert.deepEqual(part2Kids.map(String), [fixture.label.toString()]);
  assert.equal(doc.context.lookup(fixture.form, PDFDict).get(name("P")).toString(), fixture.label.toString());
  const root = doc.catalog.lookup(name("StructTreeRoot"), PDFDict);
  const slots = root.lookup(name("ParentTree"), PDFDict).lookup(name("Nums"), PDFArray).lookup(1, PDFArray);
  assert.equal(slots.get(0).toString(), fixture.first.toString());
  assert.equal(slots.get(1).toString(), fixture.second.toString());
  const ids = root.lookup(name("IDTree"), PDFDict).lookup(name("Names"), PDFArray);
  assert.equal(ids.get(3).toString(), fixture.second.toString());
  assert.equal(second.lookup(name("ID"), PDFString).decodeText(), "line-2");
  assert.equal(doc.getForm().getFields().length, 1);
  const again = await writeTaggedArtifacts({ ...fixture, pdfPath: outputPath, outputPath: path.join(dir, "again.pdf"), mode: "auto" });
  assert.equal(again.headingContinuationsMerged, 0, "the repair must be idempotent");
});

test("preserved headings keep their boundaries when geometry, style, text or sections disagree", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "separate-headings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [{ firstText: "Introduction", secondText: "Background" }, { secondY: 640 },
    { secondX: 450 }, { secondSize: 12 }, { differentFont: true }, { blocker: true }, { differentSection: true }];
  for (const [i, options] of cases.entries()) {
    const caseDir = path.join(dir, String(i));
    await mkdir(caseDir);
    const fixture = await createFixture(caseDir, options);
    const result = await writeTaggedArtifacts({ ...fixture, outputPath: path.join(caseDir, "result.pdf"), mode: "auto" });
    assert.equal(result.headingContinuationsMerged, 0, JSON.stringify(options));
    const doc = await PDFDocument.load(await readFile(result.outputPath));
    assert.equal(doc.context.lookup(fixture.second, PDFDict).lookup(name("S"), PDFName).decodeText(), "H2");
  }
});

test("centered and three-line authored headings are consolidated without losing content", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heading-layouts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [i, options] of [{ centered: true }, { firstText: "Statement in", secondText: "Support of", thirdText: "Relief" }].entries()) {
    const caseDir = path.join(dir, String(i));
    await mkdir(caseDir);
    const fixture = await createFixture(caseDir, options);
    const result = await writeTaggedArtifacts({ ...fixture, outputPath: path.join(caseDir, "result.pdf"), mode: "auto" });
    assert.equal(result.headingContinuationsMerged, options.thirdText ? 2 : 1);
    const doc = await PDFDocument.load(await readFile(result.outputPath));
    const kids = doc.context.lookup(fixture.first, PDFDict).lookup(name("K"), PDFArray);
    assert.equal(kids.size(), options.thirdText ? 3 : 2);
    if (fixture.third) {
      const third = doc.context.lookup(fixture.third, PDFDict);
      assert.equal(third.get(name("P")).toString(), fixture.first.toString());
      assert.equal(third.lookup(name("S"), PDFName).decodeText(), "Span");
      assert.equal(third.lookup(name("K")).toString(), "4");
    }
  }
});
