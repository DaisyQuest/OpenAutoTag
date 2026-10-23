import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PDFName, PDFNumber, PDFDocument } from "pdf-lib";
import { createSavedContentFixture } from "../fixtures/saved-content-fixture.js";
import { checkSavedSemantics } from "../../scripts/check-saved-semantics.js";
import { inspectPdfLowLevel } from "../../scripts/inspect-pdf-low-level.js";
const name = PDFName.of;

test("saved validation follows executed sequences and reciprocal page/Form/annotation scopes", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "saved-content-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "valid.pdf"), tagsPath = path.join(dir, "tags.json"), fixture = await createSavedContentFixture();
  const bytes = await fixture.doc.save(); await writeFile(pdfPath, bytes); await writeFile(tagsPath, JSON.stringify(fixture.tags));
  const hash = b => createHash("sha256").update(b).digest("hex");
  const inspection = await inspectPdfLowLevel({ pdfPath, preservation: true });
  assert.deepEqual(inspection.issues, []); assert.equal(inspection.markedContent.length, 8);
  assert.equal(inspection.markedContent.find(c => c.contentRef === "page:1:stream:page:mcid:0").meaningfulGlyphCount, 5);
  assert.equal(inspection.markedContent.find(c => c.contentRef === "page:1:stream:page:mcid:3").graphicsCount, 1);
  const good = await checkSavedSemantics({ pdfPath, tagsPath }); assert.equal(good.summary.failed, 0);
  assert.equal(hash(await readFile(pdfPath)), hash(bytes), "inspection must not modify the PDF");
  const results = [];
  const variants = {
    "missing-wrapper": [f => f.content = f.content.replace("/Span /AlphaProps BDC", "/Span BMC"), "MISSING_MARKED_CONTENT_SEQUENCE"],
    "changed-mcid": [f => f.content = f.content.replace("/Span /AlphaProps BDC", "/Span << /MCID 99 >> BDC"), "MISSING_MARKED_CONTENT_SEQUENCE"],
    "empty-wrapper": [f => f.content = f.content.replace("(Alpha) Tj", "() Tj"), "CONTENT_ATTACHED"],
    "whitespace-wrapper": [f => f.content = f.content.replace("(Alpha) Tj", "(   ) Tj"), "CONTENT_ATTACHED"],
    "replacement-only": [f => f.content = f.content.replace("/Span /AlphaProps BDC", "/Span << /MCID 0 /ActualText (Alpha) >> BDC").replace("(Alpha) Tj", "() Tj"), "CONTENT_ATTACHED"],
    "unknown-font": [f => f.content = f.content.replace("BT /F1 12 Tf", "BT /Missing 12 Tf"), "CONTENT_ATTACHED"],
    "artifact-only": [f => f.content = f.content.replace("(Alpha) Tj", "/Artifact BMC (Alpha) Tj EMC"), "CONTENT_ATTACHED"],
    "graphic-for-text": [f => f.content = f.content.replace("(Alpha) Tj", "() Tj ET 10 10 5 5 re f BT"), "CONTENT_ATTACHED"],
    "duplicate-sequence": [f => f.content += "\n/Span /AlphaProps BDC BT /F1 12 Tf (Extra) Tj ET EMC", "DUPLICATE_MARKED_CONTENT_SEQUENCE"],
    "missing-emc": [f => f.content = f.content.replace(" EMC", ""), "UNBALANCED_MARKED_CONTENT"],
    "unresolved-property": [f => f.content = f.content.replace("/AlphaProps", "/MissingProps"), "UNRESOLVED_MARKED_CONTENT_PROPERTIES"],
    "invalid-operator-args": [f => f.content = f.content.replace("/Span /AlphaProps BDC", "/Span /AlphaProps BMC"), "INVALID_MARKED_CONTENT_OPERANDS"],
    "fractional-mcid": [f => f.content = f.content.replace("/Span /AlphaProps BDC", "/Span << /MCID 0.5 >> BDC"), "INVALID_MARKED_CONTENT_ID"],
    "fractional-mcr": [f => f.doc.context.lookup(f.refs["form-a"]).lookup(name("K")).set(name("MCID"), PDFNumber.of(0.5)), "INVALID_MCR_IDENTIFIER"],
    "uninvoked-form": [f => f.content = f.content.replace("/FA Do", ""), "MISSING_MARKED_CONTENT_SEQUENCE"],
    "wrong-form-ref": [f => f.doc.context.lookup(f.refs["form-a"]).lookup(name("K")).set(name("Stm"), f.refs.formB), "MCID_PARENT_TREE_MISMATCH"],
    "duplicate-form-key": [f => f.doc.context.lookup(f.refs.formB).dict.set(name("StructParents"), PDFNumber.of(10)), "DUPLICATE_PARENT_SCOPE_KEY"],
    "page-form-key": [f => f.doc.getPage(0).node.set(name("StructParents"), PDFNumber.of(10)), "DUPLICATE_PARENT_SCOPE_KEY"],
    "annotation-page-key": [f => f.doc.context.lookup(f.refs.annotationWidget).set(name("StructParent"), PDFNumber.of(0)), "DUPLICATE_PARENT_SCOPE_KEY"],
    "annotation-wrong-owner": [f => f.refs.parentNums.set(9, f.refs.link), "OBJR_PARENT_TREE_MISMATCH"],
    "orphan-parent-key": [f => { f.refs.parentNums.push(PDFNumber.of(99)); f.refs.parentNums.push(f.refs.alpha); }, "ORPHAN_PARENT_TREE_KEY"],
    "orphan-array-target": [f => f.refs.parentNums.lookup(1).push(f.refs.alpha), "PARENT_TREE_REVERSE_MISMATCH"],
    "orphan-annotation-target": [f => f.doc.context.lookup(f.refs.widget).delete(name("K")), "OBJR_PARENT_TREE_REVERSE_MISMATCH"],
    "conflicting-scope-keys": [f => f.doc.getPage(0).node.set(name("StructParent"), PDFNumber.of(99)), "CONFLICTING_PARENT_SCOPE_KEYS"],
    "fractional-scope-key": [f => f.doc.getPage(0).node.set(name("StructParents"), PDFNumber.of(0.5)), "INVALID_PARENT_SCOPE_KEY"],
    "missing-scope-key": [f => f.doc.context.lookup(f.refs.formA).dict.delete(name("StructParents")), "MCID_PARENT_TREE_MISMATCH"],
    "wrong-annotation-page": [f => f.doc.context.lookup(f.refs.widget).lookup(name("K")).set(name("Pg"), f.doc.getPage(1).ref), "WIDGET_OBJR_PAGE_MISMATCH"],
  };
  for (const [variant, [mutate, expected]] of Object.entries(variants)) await t.test(variant, async () => {
    const f = await createSavedContentFixture(); mutate(f);
    f.doc.getPage(0).node.set(name("Contents"), f.doc.context.register(f.doc.context.flateStream(f.content)));
    const target = path.join(dir, `${variant}.pdf`); await writeFile(target, await f.doc.save());
    const report = await checkSavedSemantics({ pdfPath: target, tagsPath });
    const failures = report.checks.filter(c => c.status === "fail");
    assert.equal(report.disposition, "rejected", variant);
    assert.ok(failures.some(c => c.code === expected || c.target.startsWith(expected + ":")), JSON.stringify(failures));
    results.push({ variant, expected, candidateHash: report.candidateHash, detected: true });
    if (process.env.TAGGING_SAVED_CONTENT_EVIDENCE_DIR && ["missing-wrapper", "changed-mcid", "duplicate-form-key", "annotation-page-key"].includes(variant)) {
      await mkdir(process.env.TAGGING_SAVED_CONTENT_EVIDENCE_DIR, { recursive: true });
      await writeFile(path.join(process.env.TAGGING_SAVED_CONTENT_EVIDENCE_DIR, `${variant}.pdf`), await readFile(target));
    }
  });
  await t.test("repeated invocation of the same Form does not fabricate a second lexical declaration", async () => {
    const f = await createSavedContentFixture(); f.content += "\nq 1 0 0 1 0 -100 cm /FA Do Q";
    f.doc.getPage(0).node.set(name("Contents"), f.doc.context.register(f.doc.context.flateStream(f.content)));
    const target = path.join(dir, "reuse.pdf"); await writeFile(target, await f.doc.save());
    assert.equal((await checkSavedSemantics({ pdfPath: target, tagsPath })).summary.failed, 0);
  });
  await t.test("page stream arrays, quote operators, graphics-state fonts and inherited Form resources resolve", async () => {
    const f = await createSavedContentFixture(), ctx = f.doc.context, page = f.doc.getPage(0);
    const resources = page.node.lookup(name("Resources"));
    const font = resources.lookup(name("Font")).get(name("F1"));
    resources.set(name("ExtGState"), ctx.obj({ TextFont: { Font: [font, 12] } }));
    f.content = f.content.replace("(Alpha) Tj", "[(Al) 0 (pha)] TJ").replace("(Beta) Tj", "(Beta) '").replace("(Docs) Tj", '0 0 (Docs) "');
    f.content = f.content.replace("BT /F1 12 Tf", "q /Missing 12 Tf Q BT /TextFont gs");
    ctx.lookup(f.refs.formNested).dict.delete(name("Resources"));
    const split = f.content.indexOf(" EMC") + 1;
    page.node.set(name("Contents"), ctx.obj([ctx.register(ctx.flateStream(f.content.slice(0, split))), ctx.register(ctx.flateStream(f.content.slice(split)))]));
    const target = path.join(dir, "operators.pdf"); await writeFile(target, await f.doc.save());
    assert.equal((await checkSavedSemantics({ pdfPath: target, tagsPath })).summary.failed, 0);
  });
  await t.test("excessive marked-content nesting is rejected", async () => {
    const f = await createSavedContentFixture();
    f.doc.getPage(0).node.set(name("Contents"), f.doc.context.register(f.doc.context.flateStream("/Span BMC\n".repeat(129))));
    const target = path.join(dir, "depth.pdf"); await writeFile(target, await f.doc.save());
    await assert.rejects(checkSavedSemantics({ pdfPath: target, tagsPath }), /Saved marked-content depth exceeded/);
  });
  await t.test("cyclic Form execution fails closed", async () => {
    const doc = await PDFDocument.load(bytes), page = doc.getPage(0), resources = page.node.lookup(name("Resources"));
    const form = resources.lookup(name("XObject")).lookup(name("FA"));
    const replacement = doc.context.flateStream("/Loop Do", { ...Object.fromEntries(form.dict.entries().map(([k, v]) => [k.decodeText(), v])), Resources: { XObject: { Loop: resources.lookup(name("XObject")).get(name("FA")) } } });
    doc.context.assign(resources.lookup(name("XObject")).get(name("FA")), replacement);
    const target = path.join(dir, "cycle.pdf"); await writeFile(target, await doc.save());
    await assert.rejects(checkSavedSemantics({ pdfPath: target, tagsPath }), /Cyclic saved Form invocation/);
  });
  if (process.env.TAGGING_SAVED_CONTENT_EVIDENCE_DIR) {
    const output = process.env.TAGGING_SAVED_CONTENT_EVIDENCE_DIR; await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "valid.pdf"), bytes); await writeFile(path.join(output, "tags.json"), JSON.stringify(fixture.tags, null, 2));
    await writeFile(path.join(output, "proof.json"), JSON.stringify({ validHash: hash(bytes), validSaved: good.summary, sequences: inspection.markedContent.length, mutations: results, sourceUnchanged: true }, null, 2));
  }
});
