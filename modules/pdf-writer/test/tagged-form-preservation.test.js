import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFOperator, StandardFonts } from "pdf-lib";
import { writeTaggedArtifacts } from "../index.js";

test("metadata passthrough does not add Type while reading a Form XObject", async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"form-xobject-type-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=await createTaggedForm(dir), doc=await PDFDocument.load(await readFile(input.pdfPath));
  const page=doc.getPages()[0], name=PDFName.of;
  const form=doc.context.flateStream("q 1 0 0 rg 5 5 20 20 re f Q",{Subtype:"Form",BBox:[0,0,100,100],Resources:{}});
  const ref=doc.context.register(form);
  page.node.Resources().set(name("XObject"),doc.context.obj({Probe:ref}));
  page.pushOperators(PDFOperator.of("BMC",[name("Artifact")]),PDFOperator.of("Do",[name("Probe")]),PDFOperator.of("EMC"));
  await writeFile(input.pdfPath,await doc.save());
  const outputPath=path.join(dir,"candidate.pdf");
  assert.equal((await writeTaggedArtifacts({...input,outputPath,mode:"auto"})).writerMode,"passthrough");
  const output=await PDFDocument.load(await readFile(outputPath));
  const saved=output.context.lookup(ref);
  assert.equal(saved.dict.has(name("Type")),false);
  assert.deepEqual(Buffer.from(saved.getContents()),Buffer.from(form.getContents()));
  assert.equal(output.getForm().getFields().length,1);
});

async function createTaggedForm(dir) {
  const doc = await PDFDocument.create();
  doc.setTitle("Existing authored form title");
  doc.catalog.set(PDFName.of("Lang"), PDFString.of("en-GB"));
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [role, mcid, text, y] of [["H2", 0, "Court Form", 720], ["P", 1, "County", 680]]) {
    page.pushOperators(PDFOperator.of("BDC", [PDFName.of(role), doc.context.obj({ MCID: mcid })]));
    page.drawText(text, { x: 72, y, size: 12, font });
    page.pushOperators(PDFOperator.of("EMC"));
  }
  const field = doc.getForm().createTextField("county");
  field.acroField.dict.set(PDFName.of("TU"), PDFString.of("County name"));
  field.addToPage(page, { x: 130, y: 674, width: 130, height: 18 });
  const widget = field.acroField.getWidgets()[0];
  widget.dict.set(PDFName.of("TU"), PDFString.of("County name"));
  widget.dict.set(PDFName.of("StructParent"), doc.context.obj(1));
  const root = doc.context.obj({ Type: "StructTreeRoot" });
  const rootRef = doc.context.register(root);
  const document = doc.context.obj({ Type: "StructElem", S: "Document", P: rootRef });
  const documentRef = doc.context.register(document);
  const heading = doc.context.obj({ Type: "StructElem", S: "H2", P: documentRef, Pg: page.ref, K: 0 });
  const headingRef = doc.context.register(heading);
  const paragraph = doc.context.obj({ Type: "StructElem", S: "P", P: documentRef, Pg: page.ref });
  const paragraphRef = doc.context.register(paragraph);
  const form = doc.context.obj({ Type: "StructElem", S: "Form", P: paragraphRef, Pg: page.ref,
    K: { Type: "OBJR", Pg: page.ref, Obj: doc.context.getObjectRef(widget.dict) } });
  const formRef = doc.context.register(form);
  paragraph.set(PDFName.of("K"), doc.context.obj([1, formRef]));
  document.set(PDFName.of("K"), doc.context.obj([headingRef, paragraphRef]));
  root.set(PDFName.of("K"), doc.context.obj([documentRef]));
  root.set(PDFName.of("ParentTree"), doc.context.register(doc.context.obj({ Nums: [0, [headingRef, paragraphRef], 1, formRef] })));
  root.set(PDFName.of("ParentTreeNextKey"), doc.context.obj(2));
  doc.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
  doc.catalog.set(PDFName.of("MarkInfo"), doc.context.obj({ Marked: true }));
  page.node.set(PDFName.of("StructParents"), doc.context.obj(0));
  page.node.set(PDFName.of("Tabs"), PDFName.of("S"));
  const pdfPath = path.join(dir, "00-source.pdf");
  await writeFile(pdfPath, await doc.save());
  const nodes = [
    { id: "title", role: "P", text: "Court Form", bbox: [72, 60, 140, 12] },
    { id: "county", role: "P", text: "County", bbox: [72, 100, 140, 12] }
  ].map((n, i) => ({ ...n, pageNumber: 1, sourceBlockId: `b${i}`, confidence: 1, readingOrder: i }));
  const semanticPath = path.join(dir, "semantic.json");
  const tagsPath = path.join(dir, "tagging.json");
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "form",
    source: { layoutDocumentId: "form-layout" }, nodes }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "form-tags",
    source: { semanticDocumentId: "form" }, root: { id: "document", type: "Document", children:
      nodes.map((n) => ({ id: `tag:${n.id}`, type: "P", label: n.text, sourceNodeIds: [n.id], children: [] })) } }));
  return { pdfPath, tagsPath, semanticPath };
}

function structurePaths(doc) {
  const paths = [];
  const visit = (value, parents = []) => {
    const resolved = doc.context.lookup(value);
    if (resolved instanceof PDFArray) {
      for (const kid of resolved.asArray()) visit(kid, parents);
    } else if (resolved instanceof PDFDict) {
      const role = resolved.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText();
      const current = role ? [...parents, role] : parents;
      if (role) paths.push(current.join("/"));
      const kids = resolved.get(PDFName.of("K"));
      if (kids) visit(kids, current);
    }
  };
  visit(doc.catalog.get(PDFName.of("StructTreeRoot")));
  return paths;
}

test("auto mode preserves an authored form tree and metadata even with high text match", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tagged-form-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputs = await createTaggedForm(dir);
  const outputPath = path.join(dir, "result.pdf");
  const result = await writeTaggedArtifacts({ ...inputs, outputPath, mode: "auto" });
  assert.equal(result.writerMode, "passthrough");
  assert.equal(result.sourceTaggingPreserved, true);
  assert.ok(result.probeMatchRate >= 0.8, "regression requires a high-match source");
  assert.equal(result.title, "Existing authored form title");
  assert.equal(result.language, "en-GB");
  const before = await readFile(inputs.pdfPath);
  const after = await readFile(outputPath);
  assert.deepEqual(after.subarray(0, before.length), before, "minimal refresh must append to the source bytes");
  const sourceDoc = await PDFDocument.load(before);
  const outputDoc = await PDFDocument.load(after);
  assert.deepEqual(structurePaths(outputDoc), structurePaths(sourceDoc));
  assert.ok(structurePaths(outputDoc).includes("Document/P/Form"), "widget stays beside its label");
  assert.equal(outputDoc.getTitle(), sourceDoc.getTitle());
  const viewerPreferences = outputDoc.catalog.lookup(PDFName.of("ViewerPreferences"), PDFDict);
  assert.equal(viewerPreferences.lookup(PDFName.of("DisplayDocTitle")).toString(), "true");
  assert.equal(outputDoc.getForm().getFields().length, 1);
  assert.equal(outputDoc.getForm().getTextField("county").acroField.dict.lookup(PDFName.of("TU"), PDFString).decodeText(), "County name");
});

test("explicit native mode still permits deliberate retagging of an authored form", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tagged-form-native-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputs = await createTaggedForm(dir);
  const result = await writeTaggedArtifacts({ ...inputs, outputPath: path.join(dir, "result.pdf"), mode: "native" });
  assert.equal(result.writerMode, "native");
});

test("marked content without both catalog tagging signals does not trigger preservation", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "marked-content-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const missing of ["StructTreeRoot", "MarkInfo"]) {
    const caseDir = path.join(dir, missing);
    await mkdir(caseDir);
    const inputs = await createTaggedForm(caseDir);
    const doc = await PDFDocument.load(await readFile(inputs.pdfPath));
    doc.catalog.delete(PDFName.of(missing));
    await writeFile(inputs.pdfPath, await doc.save());
    const result = await writeTaggedArtifacts({ ...inputs, outputPath: path.join(caseDir, "result.pdf"), mode: "auto" });
    assert.equal(result.writerMode, "native", missing);
  }
});

test("raster bailout refuses to flatten an authored form", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tagged-form-raster-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputs = await createTaggedForm(dir);
  const original = await readFile(inputs.pdfPath), outputPath = path.join(dir, "result.pdf");
  await assert.rejects(writeTaggedArtifacts({ ...inputs, outputPath,
    mode: "auto", alreadyTaggedPolicy: "bailout-to-raster" }), /Raster output would flatten native form widgets/);
  assert.deepEqual(await readFile(inputs.pdfPath), original);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});
