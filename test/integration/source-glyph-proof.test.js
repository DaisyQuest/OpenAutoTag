import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, PDFName, PDFArray, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { writeTaggedArtifacts } from "../../modules/pdf-writer/index.js";
import { checkSavedSemantics } from "../../scripts/check-saved-semantics.js";
const name = PDFName.of;

test("source occurrence proof rejects wrong owners even when the text is identical", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "source-glyph-proof-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.pdf"), candidate = path.join(dir, "candidate.pdf"), tagsPath = path.join(dir, "tags.json"), semanticPath = path.join(dir, "semantic.json");
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]), font = await doc.embedFont(StandardFonts.Helvetica);
  const nodes = ["Repeat", "Repeat", "Ending"].map((text, i) => {
    page.drawText(text, { x: 72, y: 720 - i * 60, size: 12, font });
    return { id: `n${i}`, sourceBlockId: `b${i}`, pageNumber: 1, role: "P", text, bbox: [72, 58 + i * 60, 100, 18], confidence: 1, readingOrder: i };
  });
  await writeFile(source, await doc.save());
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "source-proof", source: { layoutDocumentId: "source-proof" }, nodes }));
  const tags = { schemaVersion: "1.0.0", documentId: "proof", source: { semanticDocumentId: "source-proof" }, root: { id: "root", type: "Document", children: nodes.map(n => ({ id: n.id, type: "P", label: n.text, sourceNodeIds: [n.id], children: [] })) } };
  await writeFile(tagsPath, JSON.stringify(tags));
  const writer = await writeTaggedArtifacts({ pdfPath: source, outputPath: candidate, tagsPath, semanticPath, mode: "native" });
  const args = { tagsPath, sourcePdfPath: source, ownershipPath: writer.sourceOwnershipPath };
  const valid = await checkSavedSemantics({ ...args, pdfPath: candidate });
  assert.equal(valid.summary.failed, 0, JSON.stringify(valid.checks.filter(c => c.status === "fail")));
  assert.ok(valid.checks.some(c => c.code === "SOURCE_PAINT_OWNER"));
  const bytes = await readFile(candidate);
  for (const variant of ["swapped-identical-text", "moved-identical-text", "partial-text", "generated-replacement", "nested-owner"]) await t.test(variant, async () => {
    const d = await PDFDocument.load(bytes), p = d.getPage(0), content = p.node.lookup(name("Contents"));
    const streams = content instanceof PDFArray ? Array.from({ length: content.size() }, (_, i) => content.lookup(i)) : [content];
    let text = streams.map(s => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")).join("\n");
    assert.match(text, /\/MCID 0/); assert.match(text, /\/MCID 1/);
    if (variant === "swapped-identical-text") text = text.replace(/\/MCID 0\b/, "/MCID TEMP").replace(/\/MCID 1\b/, "/MCID 0").replace("/MCID TEMP", "/MCID 1");
    if (variant === "moved-identical-text") text = text.replace("72 720 Tm", "72 TEMP Tm").replace("72 660 Tm", "72 720 Tm").replace("72 TEMP Tm", "72 660 Tm");
    if (variant === "partial-text" || variant === "generated-replacement") {
      assert.match(text, /\(Repeat\)/); text = text.replace("(Repeat)", "(Rep)");
      if (variant === "generated-replacement") text = text.replace("/MCID 0", "/MCID 0 /ActualText (Repeat)");
    }
    if (variant === "nested-owner") {
      text = text.replace(/(\/P\s*<<\s*\/MCID 0\s*>>\s*BDC)/, "/P << /MCID 99 >> BDC\n$1").replace("EMC", "EMC\nEMC");
      const root = d.catalog.lookup(name("StructTreeRoot")), document = root.lookup(name("K"));
      const docNode = document instanceof PDFArray ? document.lookup(0) : document;
      const second = docNode.lookup(name("K")).lookup(1), kids = second.lookup(name("K"));
      const mcr = d.context.obj({ Type: "MCR", Pg: p.ref, MCID: 99 });
      second.set(name("K"), kids instanceof PDFArray ? d.context.obj([...Array.from({ length: kids.size() }, (_, i) => kids.get(i)), mcr]) : d.context.obj([second.get(name("K")), mcr]));
      const nums = root.lookup(name("ParentTree")).lookup(name("Nums"));
      const array = nums.lookup(1); while (array.size() < 99) array.push(d.context.obj(null)); array.push(d.context.getObjectRef(second));
    }
    p.node.set(name("Contents"), d.context.register(d.context.flateStream(text)));
    const output = path.join(dir, `${variant}.pdf`); await writeFile(output, await d.save());
    const report = await checkSavedSemantics({ ...args, pdfPath: output }), failed = report.checks.filter(c => c.status === "fail");
    assert.equal(report.disposition, "rejected");
    assert.ok(failed.some(c => c.code === (variant === "nested-owner" ? "EXCLUSIVE_PAINT_OWNER" : variant === "swapped-identical-text" ? "SOURCE_PAINT_OWNER" : variant === "moved-identical-text" ? "SOURCE_GLYPH_POSITIONS" : "CONTENT_TEXT_COMPLETE")), JSON.stringify(failed));
    if (variant === "swapped-identical-text") assert.ok(!failed.some(c => c.code === "CONTENT_TEXT_COMPLETE"), "the ownership proof, not word comparison, must catch this swap");
  });
  await t.test("stale intent and overlapping source ranges reject", async () => {
    const ownership = JSON.parse(await readFile(writer.sourceOwnershipPath)); ownership.ranges.push({ ...ownership.ranges[0] });
    const altered = path.join(dir, "overlap.json"); await writeFile(altered, JSON.stringify(ownership));
    const report = await checkSavedSemantics({ ...args, pdfPath: candidate, ownershipPath: altered });
    assert.ok(report.checks.some(c => c.code === "DUPLICATE_SOURCE_GLYPH_OWNER" && c.status === "fail"));
    ownership.intentHash = "0".repeat(64); await writeFile(altered, JSON.stringify(ownership));
    await assert.rejects(checkSavedSemantics({ ...args, pdfPath: candidate, ownershipPath: altered }), /intent hashes/);
  });
  await t.test("an authored expansion needs the complete original range and unchanged replacement", async () => {
    const d = await PDFDocument.create(), p = d.addPage([612,792]), f = await d.embedFont(StandardFonts.Helvetica);
    p.node.set(name("Resources"), d.context.obj({ Font: { F1: f.ref } }));
    p.node.set(name("Contents"), d.context.register(d.context.flateStream("BT /F1 12 Tf 72 720 Td /Span << /ActualText (Expanded words) >> BDC (XY) Tj EMC ET")));
    const original = path.join(dir,"expanded-source.pdf"), output = path.join(dir,"expanded.pdf"), intent = path.join(dir,"expanded-tags.json"), semantic = path.join(dir,"expanded-semantic.json");
    await writeFile(original, await d.save());
    const altered = structuredClone(tags); altered.root.children = [{ ...altered.root.children[0], label: "Expanded words" }];
    await writeFile(intent, JSON.stringify(altered));
    await writeFile(semantic, JSON.stringify({ schemaVersion: "1.0.0", documentId: "expanded", source: { layoutDocumentId: "expanded" }, nodes: [{ ...nodes[0], text: "XY" }] }));
    const written = await writeTaggedArtifacts({ pdfPath: original, outputPath: output, tagsPath: intent, semanticPath: semantic, mode: "native" });
    const input = { tagsPath: intent, sourcePdfPath: original, ownershipPath: written.sourceOwnershipPath };
    const verified = await checkSavedSemantics({ ...input, pdfPath: output });
    assert.equal(verified.summary.failed, 0, JSON.stringify(verified.checks.filter(c => c.status === "fail")));
    assert.ok(verified.checks.some(c => c.code === "INLINE_REPLACEMENT_AUTHORIZED"));
    for (const corruption of ["changed", "partial"]) {
      const modified = await PDFDocument.load(await readFile(output)), page = modified.getPage(0);
      const stream = page.node.lookup(name("Contents"));
      const actual = stream instanceof PDFArray ? stream.lookup(0) : stream;
      let content = Buffer.from(decodePDFRawStream(actual).decode()).toString("latin1");
      if (corruption === "changed") { assert.match(content, /Expanded words/); content = content.replace("Expanded words", "Invented words"); }
      else { assert.match(content, /\(XY\)/); content = content.replace("(XY)", "(X)"); }
      page.node.set(name("Contents"), modified.context.register(modified.context.flateStream(content)));
      const target = path.join(dir,`expanded-${corruption}.pdf`); await writeFile(target, await modified.save());
      const rejected = await checkSavedSemantics({ ...input, pdfPath: target });
      assert.equal(rejected.disposition,"rejected");
      assert.ok(rejected.checks.some(c => c.status === "fail" && c.code === (corruption === "changed" ? "INLINE_REPLACEMENT_AUTHORIZED" : "SOURCE_GLYPH_SEQUENCE")));
    }
  });
  await t.test("complete exact source overprints may use their intended saved replacement text", async () => {
    const d = await PDFDocument.load(await readFile(source)), p = d.getPage(0), f = await d.embedFont(StandardFonts.Helvetica);
    p.drawText("Repeat", { x:72, y:720, size:12, font:f });
    const original = path.join(dir,"overprint-source.pdf"), output = path.join(dir,"overprint.pdf"), intent = path.join(dir,"overprint-tags.json");
    await writeFile(original,await d.save());
    const approved = structuredClone(tags); approved.root.children[0].actualText = "Repeat"; await writeFile(intent,JSON.stringify(approved));
    const written = await writeTaggedArtifacts({ pdfPath:original, outputPath:output, tagsPath:intent, semanticPath, mode:"native" });
    const report = await checkSavedSemantics({ pdfPath:output, tagsPath:intent, sourcePdfPath:original, ownershipPath:written.sourceOwnershipPath });
    assert.equal(report.summary.failed,0,JSON.stringify(report.checks.filter(c=>c.status==="fail")));
    assert.ok(report.checks.some(c=>c.code==="OVERPRINT_REPLACEMENT_PROVEN"));
    const unqualified = await checkSavedSemantics({ pdfPath:output, tagsPath:intent });
    assert.ok(unqualified.checks.some(c=>c.code==="CONTENT_TEXT_COMPLETE"&&c.status==="fail"));
  });
});
