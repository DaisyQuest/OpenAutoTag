import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

// Build the saved PDF independently of the tagger and its writer. Each stream
// uses its own MCID scope, including repeated MCID zero in two invoked Forms.
export async function createSavedContentFixture() {
  const doc = await PDFDocument.create(), ctx = doc.context, pages = [doc.addPage(), doc.addPage()];
  const font = await doc.embedFont(StandardFonts.Helvetica), resources = ctx.obj({ Font: { F1: font.ref } });
  const root = ctx.obj({ Type: "StructTreeRoot" }), rootRef = ctx.register(root);
  const document = ctx.obj({ Type: "StructElem", S: "Document", P: rootRef, ID: PDFString.of("oat:root") });
  const documentRef = ctx.register(document), children = [], ids = [["oat:root", documentRef]];
  const tags = { schemaVersion: "1.0.0", documentId: "saved-content", source: { semanticDocumentId: "independent" }, root: { id: "root", type: "Document", children: [] } };
  const refs = {};
  const element = (id, role, label, page, k) => {
    const dict = ctx.obj({ Type: "StructElem", S: role, P: documentRef, Pg: page.ref, ID: PDFString.of(`oat:${id}`), K: k });
    const ref = ctx.register(dict); children.push(ref); refs[id] = ref; ids.push([`oat:${id}`, ref]);
    // Authored Link structures are inspected even before native Link intent is
    // added to the public tag-builder contract (tracked separately as A36).
    if (role !== "Link") tags.root.children.push({ id, type: role, label, sourceNodeIds: [id], children: [] }); return ref;
  };
  const text = (value, y = 700) => `BT /F1 12 Tf 72 ${y} Td (${value}) Tj ET`;
  const form = (value, key) => ctx.register(ctx.flateStream(`/Span << /MCID 0 >> BDC ${text(value, key === 10 ? 640 : 610)} EMC`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Resources: resources, StructParents: key }));
  refs.formA = form("FormAlpha", 10); refs.formB = form("FormBeta", 11);
  refs.formNested = ctx.register(ctx.flateStream(text("Nested", 580), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Resources: resources }));
  const mcr = stream => ctx.obj({ Type: "MCR", Pg: pages[0].ref, Stm: stream, MCID: 0 });
  const alpha = element("alpha", "P", "Alpha", pages[0], 0), beta = element("beta", "P", "Beta", pages[0], 1);
  const fa = element("form-a", "P", "FormAlpha", pages[0], mcr(refs.formA)), fb = element("form-b", "P", "FormBeta", pages[0], mcr(refs.formB));
  const nested = element("nested", "P", "Nested", pages[0], 2), figure = element("figure", "Figure", "A square", pages[0], 3);
  refs.annotationWidget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: PDFString.of("name"), TU: PDFString.of("Full name"),
    V: PDFString.of("Ada"), Rect: [72, 400, 220, 425], F: 4, P: pages[0].ref, StructParent: 20 }));
  const widget = element("widget", "Form", "Full name", pages[0], ctx.obj({ Type: "OBJR", Pg: pages[0].ref, Obj: refs.annotationWidget }));
  refs.annotationLink = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 350, 160, 365], P: pages[0].ref, StructParent: 21,
    A: { S: "URI", URI: PDFString.of("https://example.test/docs") } }));
  const link = element("link", "Link", "Docs", pages[0], ctx.obj([4, { Type: "OBJR", Pg: pages[0].ref, Obj: refs.annotationLink }]));
  const gamma = element("gamma", "P", "Gamma", pages[1], 0);
  refs.parentNums = ctx.obj([0, [alpha, beta, nested, figure, link], 1, [gamma], 10, [fa], 11, [fb], 20, widget, 21, link]);
  root.set(PDFName.of("ParentTree"), ctx.obj({ Nums: refs.parentNums }));
  ids.sort(([a], [b]) => a.localeCompare(b));
  root.set(PDFName.of("IDTree"), ctx.obj({ Names: ids.flatMap(([id, ref]) => [PDFString.of(id), ref]) }));
  root.set(PDFName.of("K"), documentRef); document.set(PDFName.of("K"), ctx.obj(children));
  doc.catalog.set(PDFName.of("StructTreeRoot"), rootRef); doc.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [refs.annotationWidget], DR: resources, DA: PDFString.of("/F1 12 Tf 0 g") }));
  const content = `/Span /AlphaProps BDC ${text("Alpha")} EMC\n/Span << /MCID 1 >> BDC ${text("Beta", 670)} EMC\n` +
    `q /FA Do Q q /FB Do Q\n/Span << /MCID 2 >> BDC /FN Do EMC\n` +
    `/Figure << /MCID 3 >> BDC 72 500 40 40 re f EMC\n/Link << /MCID 4 >> BDC ${text("Docs", 350)} EMC`;
  pages[0].node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
  pages[0].node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font.ref }, Properties: { AlphaProps: { MCID: 0 } }, XObject: { FA: refs.formA, FB: refs.formB, FN: refs.formNested } }));
  pages[0].node.set(PDFName.of("StructParents"), ctx.obj(0)); pages[0].node.set(PDFName.of("Annots"), ctx.obj([refs.annotationWidget, refs.annotationLink]));
  pages[1].node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`/P << /MCID 0 >> BDC ${text("Gamma")} EMC`)));
  pages[1].node.set(PDFName.of("Resources"), resources); pages[1].node.set(PDFName.of("StructParents"), ctx.obj(1));
  return { doc, tags, refs, content };
}
