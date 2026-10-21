import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, PDFName, PDFString, PDFDict, PDFOperator, StandardFonts } from "pdf-lib";

export async function createListFormFixture(dir, variant = "valid") {
  const doc = await PDFDocument.create(), name = PDFName.of;
  const page = doc.addPage([612, 792]);
  const otherPage = variant === "cross-page" ? doc.addPage([612, 792]) : page;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle("List form preservation fixture");
  for (const [mcid, text, y, role] of [[0, "Application", 730, "H1"], [1, "1.", 680, "Lbl"], [2, "I request relief", 660, "LBody"]]) {
    page.pushOperators(PDFOperator.of("BDC", [name(role), doc.context.obj({ MCID: mcid })]));
    page.drawText(text, { x: 72, y, size: 12, font }); page.pushOperators(PDFOperator.of("EMC"));
  }
  const checkbox = doc.getForm().createCheckBox("request");
  checkbox.addToPage(page, { x: 52, y: 658, width: 12, height: 12 });
  checkbox.check(); checkbox.acroField.dict.set(name("TU"), PDFString.of("Request relief"));
  const text = doc.getForm().createTextField("details");
  text.addToPage(page, { x: 200, y: 658, width: 180, height: 18 });
  text.setText("Existing details"); text.acroField.dict.set(name("TU"), PDFString.of("Details"));
  const widgets = [checkbox, text].map((f) => f.acroField.getWidgets()[0]);
  widgets.forEach((w, i) => w.dict.set(name("StructParent"), doc.context.obj(i + 1)));
  const register = (v) => doc.context.register(doc.context.obj(v));
  const root = register({ Type: "StructTreeRoot" });
  const document = register({ Type: "StructElem", S: "Document", P: root });
  const heading = register({ Type: "StructElem", S: "H1", P: document, Pg: page.ref, K: 0 });
  const list = register({ Type: "StructElem", S: "L", P: document });
  const item = register({ Type: "StructElem", S: "LI", P: list });
  const label = register({ Type: "StructElem", S: "Lbl", P: item, Pg: page.ref, K: 1 });
  const body = register({ Type: "StructElem", S: "LBody", P: item, Pg: page.ref, K: variant === "array-body" ? [2] : 2 });
  const forms = widgets.map((w, i) => register({ Type: "StructElem", S: "Form", P: item,
    ID: PDFString.of(`form-${i}`), K: { Type: "OBJR", Pg: i === 0 ? otherPage.ref : page.ref, Obj: doc.context.getObjectRef(w.dict) } }));
  let kids = [forms[0], label, body, forms[1]];
  if (variant === "multi-widget") {
    const first = doc.context.lookup(forms[0], PDFDict), second = doc.context.lookup(forms[1], PDFDict);
    first.set(name("K"), doc.context.obj([first.get(name("K")), second.get(name("K"))]));
    kids = [forms[0], label, body]; forms.pop();
  }
  if (variant === "duplicate-widget") {
    doc.context.lookup(forms[1], PDFDict).set(name("K"), doc.context.obj({ Type: "OBJR", Pg: page.ref, Obj: doc.context.getObjectRef(widgets[0].dict) }));
  }
  if (variant === "multiple-bodies") kids.push(register({ Type: "StructElem", S: "LBody", P: item, Pg: page.ref, K: 2 }));
  if (variant === "unknown-role") kids.push(register({ Type: "StructElem", S: "P", P: item, Pg: page.ref, K: 2 }));
  if (variant === "raw-item-content") kids.push(2);
  if (variant === "shared-form") kids.push(forms[0]);
  if (variant === "no-body") kids = kids.filter((k) => k !== body);
  if (variant === "bad-parent") doc.context.lookup(forms[0], PDFDict).set(name("P"), document);
  if (variant === "ambiguous-form") doc.context.lookup(forms[0], PDFDict).set(name("K"), doc.context.obj([2]));
  if (variant === "empty-body") doc.context.lookup(body, PDFDict).set(name("K"), doc.context.obj([]));
  if (variant === "nested-body") doc.context.lookup(body, PDFDict).set(name("K"), register({ Type: "StructElem", S: "P", P: body, Pg: page.ref, K: 2 }));
  doc.context.lookup(item, PDFDict).set(name("K"), doc.context.obj(kids));
  doc.context.lookup(list, PDFDict).set(name("K"), doc.context.obj([item]));
  doc.context.lookup(document, PDFDict).set(name("K"), doc.context.obj([heading, list]));
  const rootDict = doc.context.lookup(root, PDFDict);
  rootDict.set(name("K"), doc.context.obj([document]));
  rootDict.set(name("ParentTree"), register({ Nums: [0, [heading, label, body], 1, forms[0], 2, forms[1] ?? forms[0]] }));
  rootDict.set(name("IDTree"), register({ Names: forms.flatMap((ref, i) => [PDFString.of(`form-${i}`), ref]) }));
  page.node.set(name("StructParents"), doc.context.obj(0));
  doc.catalog.set(name("StructTreeRoot"), root); doc.catalog.set(name("MarkInfo"), doc.context.obj({ Marked: true }));
  const pdfPath = path.join(dir, "source.pdf"), tagsPath = path.join(dir, "tags.json"), semanticPath = path.join(dir, "semantic.json");
  await writeFile(pdfPath, await doc.save());
  const nodes = ["Application", "1.", "I request relief"].map((text, i) => ({ id: `n${i}`, role: "P", text,
    pageNumber: 1, sourceBlockId: `b${i}`, bbox: [72, 50 + 25 * i, 200, 12], confidence: 1, readingOrder: i }));
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "fixture", source: { layoutDocumentId: "layout" }, nodes }));
  await writeFile(tagsPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "tags", source: { semanticDocumentId: "fixture" },
    root: { id: "root", type: "Document", children: nodes.map((n) => ({ id: `tag-${n.id}`, type: "P", label: n.text, sourceNodeIds: [n.id], children: [] })) } }));
  return { pdfPath, tagsPath, semanticPath, refs: { item, label, body, forms, heading } };
}
