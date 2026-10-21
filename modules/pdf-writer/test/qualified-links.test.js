import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFString, StandardFonts, degrees } from "pdf-lib";
import { writeTaggedArtifacts } from "../index.js";
import { createListFormFixture } from "./fixtures/list-form-fixture.js";
import { inspectPdfLowLevel } from "../../../scripts/inspect-pdf-low-level.js";
import { repairLinks } from "../link-repair.js";
import { checkPdfPreservation } from "../../../scripts/check-pdf-preservation.js";

const name = PDFName.of;
async function fixture(dir, variant) {
  const result = await createListFormFixture(dir), doc = await PDFDocument.load(await readFile(result.pdfPath));
  const root = doc.catalog.lookup(name("StructTreeRoot"), PDFDict), document = root.lookup(name("K"), PDFArray).lookup(0, PDFDict);
  const register = (value) => doc.context.register(doc.context.obj(value));
  const page = doc.getPages()[0], uri = "https://example.test/help";
  const annotation = (destination, key) => register({ Type: "Annot", Subtype: "Link", Rect: [72,600,180,620], P: page.ref,
    A: { S: "URI", URI: PDFString.of(destination) }, ...(key == null ? {} : { StructParent: key }) });
  const literal = variant.startsWith("literal"), targetUri = variant === "literal-mail" ? "mailto:help@example.test" : "https://new.test";
  const owned = annotation(uri, 3), duplicate = annotation(literal ? targetUri : variant === "different-destination" ? `${uri}?other` : uri);
  const parent = doc.context.getObjectRef(document);
  const link = register({ Type: "StructElem", S: "Link", P: parent, Pg: page.ref, K: { Type: "OBJR", Obj: owned, Pg: page.ref } });
  const nums = root.lookup(name("ParentTree"), PDFDict).lookup(name("Nums"), PDFArray);
  nums.push(doc.context.obj(3)); nums.push(link); document.lookup(name("K"), PDFArray).push(link);
  page.node.Annots().push(owned); page.node.Annots().push(duplicate);
  if (variant === "ambiguous" || variant === "literal-ambiguous") {
    const second = annotation(uri, 4), secondLink = register({ Type: "StructElem", S: "Link", P: parent, Pg: page.ref, K: { Type: "OBJR", Obj: second, Pg: page.ref } });
    page.node.Annots().push(second); document.lookup(name("K"), PDFArray).push(secondLink); nums.push(doc.context.obj(4)); nums.push(secondLink);
  }
  if (variant === "stale-parent" || variant === "literal-stale-parent") doc.context.lookup(duplicate, PDFDict).set(name("StructParent"), doc.context.obj(777));
  if (literal) {
    if (variant !== "literal-no-text") page.drawText(variant === "literal-wrong-text" ? "Unrelated" : variant === "literal-mail" ? "help@example.test" : "new.test", {
      x: 74, y: 605, size: 10, font: await doc.embedFont(StandardFonts.Helvetica)
    });
    const annotationDict = doc.context.lookup(duplicate, PDFDict), linkDict = doc.context.lookup(link, PDFDict);
    if (variant === "literal-rolemap" || variant === "literal-single") {
      const span = register({ Type: "StructElem", S: "StyledLinkSpan", P: parent, K: variant === "literal-single" ? link : [link] });
      linkDict.set(name("P"), span); document.lookup(name("K"), PDFArray).set(2, span);
      root.set(name("RoleMap"), doc.context.obj({ StyledLinkSpan: "Span" }));
    }
    if (variant === "literal-preserved-description") annotationDict.set(name("Contents"), PDFString.of("Authored description"));
    if (variant === "literal-rotated") page.setRotation(degrees(90));
    if (variant === "literal-quad") annotationDict.set(name("QuadPoints"), doc.context.obj([72,620,180,620,72,600,180,600]));
    if (variant === "literal-hidden") annotationDict.set(name("F"), doc.context.obj(2));
    if (variant === "literal-chained-action") annotationDict.lookup(name("A"), PDFDict).set(name("Next"), doc.context.obj({ S: "URI", URI: PDFString.of("https://different.test") }));
    if (variant === "literal-bad-parent") linkDict.set(name("P"), doc.catalog.get(name("StructTreeRoot")));
    if (variant === "literal-odd-tree") nums.push(doc.context.obj(99));
    if (variant === "literal-cyclic-tree") {
      const tree = root.lookup(name("ParentTree"), PDFDict); tree.set(name("Kids"), doc.context.obj([doc.context.getObjectRef(tree)]));
    }
  }
  await writeFile(result.pdfPath, await doc.save());
  return { ...result, duplicate: String(duplicate), owned: String(owned), uri: literal ? targetUri : uri };
}

test("link repair uses a unique existing owner, preserves actions and is idempotent; ambiguous links stay untouched", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-links-"));
  const prior = process.env.PASSTHROUGH_REPAIR_LINKS; process.env.PASSTHROUGH_REPAIR_LINKS = "1";
  t.after(async () => { if (prior == null) delete process.env.PASSTHROUGH_REPAIR_LINKS; else process.env.PASSTHROUGH_REPAIR_LINKS = prior; await rm(dir, { recursive: true, force: true }); });
  for (const variant of ["unique", "different-destination", "ambiguous", "stale-parent"]) {
    const folder = path.join(dir, variant); await mkdir(folder); const input = await fixture(folder, variant);
    const source = await inspectPdfLowLevel({ pdfPath: input.pdfPath, preservation: true });
    const outputPath = path.join(folder, "candidate.pdf"); const result = await writeTaggedArtifacts({ ...input, outputPath, mode: "auto" });
    const candidate = await inspectPdfLowLevel({ pdfPath: outputPath, preservation: true });
    assert.equal(result.repairAudit.candidateHash, candidate.sourceHash);
    assert.equal(result.repairAudit.sourceHash, source.sourceHash);
    assert.deepEqual(candidate.pages, source.pages); assert.deepEqual(candidate.fields, source.fields);
    assert.equal(candidate.links[input.duplicate].digest, source.links[input.duplicate].digest);
    if (variant === "unique") {
      assert.equal(candidate.links[input.duplicate].owners.length, 1);
      assert.equal(candidate.links[input.duplicate].contents, input.uri);
      assert.deepEqual(candidate.issues, []);
      const again = await writeTaggedArtifacts({ ...input, pdfPath: outputPath, outputPath: path.join(folder, "again.pdf"), mode: "auto" });
      assert.equal(again.repairLedger.filter((r) => r.decision === "apply").length, 0);
    } else {
      assert.deepEqual(candidate.links[input.duplicate].owners, []);
      assert.equal(candidate.links[input.duplicate].contents, source.links[input.duplicate].uri);
      assert.ok(result.repairLedger.some((r) => r.target === input.duplicate && r.decision === "review"));
    }
  }
});

test("literal URL/email links retain separate actions and fail closed outside the qualified context", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "literal-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const variant of ["literal", "literal-rolemap", "literal-single", "literal-mail", "literal-preserved-description",
    "literal-rotated", "literal-quad", "literal-hidden", "literal-no-text", "literal-wrong-text", "literal-ambiguous", "literal-stale-parent", "literal-chained-action",
    "literal-bad-parent", "literal-odd-tree", "literal-cyclic-tree"]) {
    await t.test(variant, async () => {
      const folder = path.join(dir, variant); await mkdir(folder); const input = await fixture(folder, variant);
      const sourcePdf = input.pdfPath, outputPdf = path.join(folder, "candidate.pdf");
      const malformed = ["literal-bad-parent", "literal-odd-tree", "literal-cyclic-tree"].includes(variant);
      if (malformed) {
        await assert.rejects(repairLinks({ sourcePdf, outputPdf }), /structure parent|ParentTree/);
        await assert.rejects(readFile(outputPdf), { code: "ENOENT" }); return;
      }
      const source = await inspectPdfLowLevel({ pdfPath: sourcePdf, preservation: true });
      const audit = await repairLinks({ sourcePdf, outputPdf });
      const candidate = await inspectPdfLowLevel({ pdfPath: outputPdf, preservation: true });
      assert.deepEqual(candidate.pages, source.pages); assert.deepEqual(candidate.fields, source.fields); assert.deepEqual(candidate.widgets, source.widgets);
      assert.deepEqual(candidate.headings, source.headings);
      assert.deepEqual(candidate.links[input.owned], { ...source.links[input.owned], contents: source.links[input.owned].uri });
      assert.equal(candidate.links[input.duplicate].digest, source.links[input.duplicate].digest);
      const applied = ["literal", "literal-rolemap", "literal-single", "literal-mail", "literal-preserved-description"].includes(variant);
      assert.equal(candidate.links[input.duplicate].owners.length, applied ? 1 : 0);
      if (applied) {
        assert.notDeepEqual(candidate.links[input.duplicate].owners, candidate.links[input.owned].owners);
        assert.ok(audit.repairLedger.some((r) => r.ruleId === "link-literal-adjacent-binding" && r.decision === "apply"));
        const validationReport = path.join(folder, "validation.json");
        await writeFile(validationReport, JSON.stringify({ status: "completed", isCompliant: true, pdfSha256: audit.candidateHash,
          overall: { status: "pass" }, findings: [], fontAudit: { status: "ok" } }));
        const quality = await checkPdfPreservation({ sourcePdf, candidatePdf: outputPdf, validationReport, outputPath: path.join(folder, "quality.json") });
        assert.equal(quality.disposition, "review_required");
        assert.ok(quality.checks.every((c) => c.status === "pass"));
      }
      if (variant === "literal-preserved-description") assert.equal(candidate.links[input.duplicate].contents, "Authored description");
      const repeated = await repairLinks({ sourcePdf: outputPdf, outputPdf: path.join(folder, "repeat.pdf") });
      assert.equal(repeated.sourceHash, repeated.candidateHash);
      assert.equal(repeated.repairLedger.filter((r) => r.decision === "apply").length, 0);
      assert.deepEqual(await repairLinks({ sourcePdf, candidatePdf: outputPdf }), audit);
      if (variant === "literal") {
        await assert.rejects(repairLinks({ sourcePdf, outputPdf }), /overwrite existing/);
        await assert.rejects(repairLinks({ sourcePdf, outputPdf: sourcePdf }), /overwrite its source/);
        await assert.rejects(repairLinks({}), /Required/);
        // Exact replay rejects a candidate with any additional change, even if link ownership is valid.
        const changed = await PDFDocument.load(await readFile(outputPdf)); changed.getForm().getTextField("details").setText("Changed");
        const changedPdf = path.join(folder, "changed.pdf"); await writeFile(changedPdf, await changed.save());
        await assert.rejects(repairLinks({ sourcePdf, candidatePdf: changedPdf }), /Unexpected saved-object change/);
      }
    });
  }
});
