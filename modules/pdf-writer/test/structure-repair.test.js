import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFString, PDFOperator } from "pdf-lib";
import { createListFormFixture } from "./fixtures/list-form-fixture.js";
import { repairStructure } from "../structure-repair.js";
import { inspectPdfLowLevel } from "../../../scripts/inspect-pdf-low-level.js";
import { checkPdfPreservation } from "../../../scripts/check-pdf-preservation.js";

const name = PDFName.of;
test("reviewed heading membership changes require exact decisions and independent saved-object proof", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heading-membership-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = await createListFormFixture(dir), sourceHash = createHash("sha256").update(await readFile(input.pdfPath)).digest("hex");
  const paragraphs = [String(input.refs.heading)], candidatePdf = path.join(dir, "paragraph.pdf");
  const options = { sourcePdf: input.pdfPath, outputPdf: candidatePdf, paragraphs, sourceSha256: sourceHash };
  await assert.rejects(repairStructure({ ...options, sourceSha256: undefined }), /matching --source-sha256/);
  await assert.rejects(repairStructure({ ...options, paragraphs: [paragraphs[0], paragraphs[0]] }), /Invalid reviewed paragraph/);
  const audit = await repairStructure(options);
  assert.ok(audit.repairLedger.some((r) => r.ruleId === "reviewed-heading-paragraph" && r.decision === "apply"));
  assert.deepEqual(await repairStructure({ ...options, outputPdf: undefined, candidatePdf }), audit);
  const validationReport = path.join(dir, "validation.json"), structureDecisions = path.join(dir, "decisions.json");
  await writeFile(validationReport, JSON.stringify({ status: "completed", isCompliant: true, pdfSha256: audit.candidateHash, overall: { status: "pass" }, findings: [], fontAudit: { status: "ok" } }));
  await writeFile(structureDecisions, JSON.stringify({ sourceSha256: sourceHash, paragraphs }));
  const gate = { sourcePdf: input.pdfPath, candidatePdf, validationReport, outputPath: path.join(dir, "quality.json") };
  assert.equal((await checkPdfPreservation(gate)).disposition, "rejected");
  assert.ok((await checkPdfPreservation({ ...gate, structureRepairs: true, structureDecisions })).checks.every((c) => c.status === "pass"));
  await writeFile(structureDecisions, JSON.stringify({ sourceSha256: "0".repeat(64), paragraphs }));
  assert.equal((await checkPdfPreservation({ ...gate, structureRepairs: true, structureDecisions })).disposition, "error");
  const changed = await PDFDocument.load(await readFile(candidatePdf)); changed.getForm().getTextField("details").setText("Changed");
  const changedPdf = path.join(dir, "changed.pdf"); await writeFile(changedPdf, await changed.save());
  await assert.rejects(repairStructure({ ...options, outputPdf: undefined, candidatePdf: changedPdf }), /Unexpected saved-object change/);
});
async function fixture(dir, variant) {
  const input = await createListFormFixture(dir), doc = await PDFDocument.load(await readFile(input.pdfPath));
  const page = doc.getPages()[0], root = doc.catalog.lookup(name("StructTreeRoot"), PDFDict);
  const document = root.lookup(name("K"), PDFArray).lookup(0, PDFDict), children = document.lookup(name("K"), PDFArray);
  const parent = doc.context.getObjectRef(document), nums = root.lookup(name("ParentTree"), PDFDict).lookup(name("Nums"), PDFArray);
  const slots = nums.lookup(1, PDFArray), register = (v) => doc.context.register(doc.context.obj(v));
  const first = doc.context.lookup(input.refs.heading, PDFDict);
  const levels = variant === "ambiguous" ? ["H2", "H5", "H3"] : variant === "valid" ? ["H1", "H2", "H2"] : ["H2", "H4", "H4"];
  first.set(name("S"), name(levels[0]));
  for (let i = 1; i < levels.length; i++) {
    const mcid = i + 2, heading = register({ Type: "StructElem", S: levels[i], P: parent, Pg: page.ref, K: mcid });
    children.push(heading); slots.push(heading);
    page.pushOperators(PDFOperator.of("BDC", [name("H4"), doc.context.obj({ MCID: mcid })]));
    page.drawText(`Section ${i}`, { x: 70, y: 600 - i * 20, size: 12 }); page.pushOperators(PDFOperator.of("EMC"));
  }
  if (variant === "mapped") {
    first.set(name("S"), name("TitleHeading")); root.set(name("RoleMap"), doc.context.obj({ TitleHeading: "H2" }));
  }
  if (variant === "generic") children.push(register({ Type: "StructElem", S: "H", P: parent }));
  if (variant === "bad-parent") first.set(name("P"), doc.catalog.get(name("StructTreeRoot")));
  if (variant === "cycle") children.push(parent);
  if (variant === "role-cycle") root.set(name("RoleMap"), doc.context.obj({ H2: "Loop", Loop: "H2" }));
  if (variant === "custom-cycle") {
    first.set(name("S"), name("Custom")); root.set(name("RoleMap"), doc.context.obj({ Custom: "Other", Other: "Custom" }));
  }
  if (variant === "standard-role-map") {
    first.set(name("S"), name("Table")); root.set(name("RoleMap"), doc.context.obj({ Table: "H2" }));
  }
  if (variant === "pdf2") doc.catalog.set(name("Version"), name("2.0"));
  const figure = register({ Type: "StructElem", S: "Artifact", P: parent, Pg: page.ref, K: 5 });
  children.push(figure); slots.push(figure);
  const dict = doc.context.lookup(figure, PDFDict);
  if (variant === "described") dict.set(name("Alt"), PDFString.of("Authored description"));
  if (variant === "actual-text") dict.set(name("ActualText"), PDFString.of("Authored text"));
  if (variant === "mapped-artifact") root.set(name("RoleMap"), doc.context.obj({ Artifact: "Span" }));
  if (variant === "wrong-slot") slots.set(5, input.refs.heading);
  if (variant === "shared-mcid") children.push(register({ Type: "StructElem", S: "Span", P: parent, Pg: page.ref, K: 5 }));
  if (variant === "bad-number-tree") nums.push(doc.context.obj(77));
  if (variant === "namespace") dict.set(name("NS"), register({ Type: "Namespace", NS: PDFString.of("example") }));
  if (variant === "outer-artifact") page.pushOperators(PDFOperator.of("BMC", [name("Artifact")]));
  page.pushOperators(PDFOperator.of("BDC", [name(variant === "marked-artifact" ? "Artifact" : "Figure"), doc.context.obj({ MCID: 5,
    ...(variant === "marked-actual-text" ? { ActualText: PDFString.of("Authored replacement") } : {}) })]));
  if (variant === "clip-wrappers") page.pushOperators(PDFOperator.of("BMC", [name("ClipSpan")]), PDFOperator.of("BMC", [name("Clip")]));
  const png = await doc.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=", "base64"));
  page.drawImage(png, { x: 70, y: 500, width: 20, height: 20 });
  if (variant === "text-image") page.drawText("Meaningful text", { x: 70, y: 500, size: 12 });
  if (variant === "two-images") page.drawImage(png, { x: 90, y: 500, width: 20, height: 20 });
  if (variant === "nested") { page.pushOperators(PDFOperator.of("BMC", [name("Span")]), PDFOperator.of("EMC")); }
  if (variant === "clip-wrappers") page.pushOperators(PDFOperator.of("EMC"), PDFOperator.of("EMC"));
  page.pushOperators(PDFOperator.of("EMC"));
  if (variant === "outer-artifact") page.pushOperators(PDFOperator.of("EMC"));
  if (variant === "duplicate-mcid") page.pushOperators(PDFOperator.of("BDC", [name("Figure"), doc.context.obj({ MCID: 5 })]), PDFOperator.of("EMC"));
  const bytes = await doc.save(); await writeFile(input.pdfPath, bytes);
  return { sourcePdf: input.pdfPath, sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    figures: [{ ref: String(figure), alt: "Reviewed accessibility symbol" }], outputPdf: path.join(dir, "candidate.pdf") };
}

test("structure metadata repair preserves peers, images, fields and all saved objects", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "structure-repair-")); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const variant of ["standard", "mapped", "clip-wrappers", "valid", "ambiguous", "generic"]) await t.test(variant, async () => {
    const folder = path.join(dir, variant); await mkdir(folder); const input = await fixture(folder, variant);
    const source = await inspectPdfLowLevel({ pdfPath: input.sourcePdf, preservation: true });
    const audit = await repairStructure(input), candidate = await inspectPdfLowLevel({ pdfPath: input.outputPdf, preservation: true });
    for (const key of ["pages", "fields", "widgets", "links"]) assert.deepEqual(candidate[key], source[key]);
    const oldHeadings = Object.entries(source.headings), newHeadings = Object.entries(candidate.headings);
    assert.equal(newHeadings.length, oldHeadings.length);
    for (const [ref, heading] of oldHeadings) assert.deepEqual(candidate.headings[ref].contentRefs, heading.contentRefs);
    assert.equal(audit.repairLedger.filter((r) => r.ruleId === "heading-rank-compaction" && r.decision === "apply").length,
      ["standard", "mapped", "clip-wrappers"].includes(variant) ? 3 : 0);
    assert.equal(audit.repairLedger.some((r) => r.ruleId === "heading-rank-compaction" && r.decision === "review"), ["ambiguous", "generic"].includes(variant));
    const saved = await PDFDocument.load(await readFile(input.outputPdf));
    const figure = saved.context.enumerateIndirectObjects().find(([ref]) => String(ref) === input.figures[0].ref)[1];
    assert.equal(figure.get(name("S")).toString(), "/Figure"); assert.equal(figure.get(name("Alt")).decodeText(), input.figures[0].alt);
    assert.deepEqual(await repairStructure({ ...input, outputPdf: undefined, candidatePdf: input.outputPdf }), audit);
    const repeated = await repairStructure({ sourcePdf: input.outputPdf, outputPdf: path.join(folder, "repeat.pdf") });
    assert.equal(repeated.sourceHash, repeated.candidateHash);
    assert.equal(repeated.repairLedger.filter((r) => r.decision === "apply").length, 0);
    if (variant === "standard") {
      const validationReport = path.join(folder, "validation.json");
      await writeFile(validationReport, JSON.stringify({ status: "completed", isCompliant: true, pdfSha256: audit.candidateHash,
        overall: { status: "pass" }, findings: [], fontAudit: { status: "ok" } }));
      const quality = await checkPdfPreservation({ sourcePdf: input.sourcePdf, candidatePdf: input.outputPdf, validationReport, outputPath: path.join(folder, "quality.json") });
      assert.ok(quality.checks.every((c) => c.status === "pass"), JSON.stringify(quality.checks));
      await assert.rejects(repairStructure(input), /overwrite existing/);
      await assert.rejects(repairStructure({ ...input, outputPdf: input.sourcePdf }), /overwrite its source/);
      for (const [file, mutate] of [["field", (d) => d.getForm().getTextField("details").setText("Changed")],
        ["description", (d) => d.context.enumerateIndirectObjects().find(([ref]) => String(ref) === input.figures[0].ref)[1].set(name("Alt"), PDFString.of("Unreviewed"))]]) {
        const altered = await PDFDocument.load(await readFile(input.outputPdf)); mutate(altered);
        const candidatePdf = path.join(folder, `${file}.pdf`); await writeFile(candidatePdf, await altered.save());
        await assert.rejects(repairStructure({ ...input, outputPdf: undefined, candidatePdf }), /Unexpected saved-object change/);
      }
    }
  });
});

test("unreviewed images remain unchanged; stale decisions and ambiguous ownership fail closed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "structure-negative-")); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const variant of ["bad-parent", "cycle", "role-cycle", "custom-cycle", "standard-role-map", "pdf2", "marked-artifact", "outer-artifact", "marked-actual-text", "described", "actual-text", "mapped-artifact", "wrong-slot", "shared-mcid",
    "bad-number-tree", "namespace", "text-image", "two-images", "nested", "duplicate-mcid"]) await t.test(variant, async () => {
    const folder = path.join(dir, variant); await mkdir(folder); const input = await fixture(folder, variant);
    await assert.rejects(repairStructure(input)); await assert.rejects(readFile(input.outputPdf), { code: "ENOENT" });
  });
  await t.test("decisions are opt-in and source-bound", async () => {
    const folder = path.join(dir, "opt-in"); await mkdir(folder); const input = await fixture(folder, "valid");
    await assert.rejects(repairStructure({ ...input, sourceSha256: undefined }), /matching --source-sha256/);
    await assert.rejects(repairStructure({ ...input, sourceSha256: "0".repeat(64) }), /matching --source-sha256/);
    await assert.rejects(repairStructure({ ...input, figures: [...input.figures, ...input.figures] }), /Invalid reviewed/);
    await assert.rejects(repairStructure({ ...input, figures: [{ ref: "9999 0 R", alt: "Reviewed" }] }), /Invalid or duplicate/);
    await assert.rejects(repairStructure({ ...input, figures: [{ ref: input.figures[0].ref, alt: " " }] }), /Invalid reviewed/);
    await assert.rejects(repairStructure({}), /Required/);
    const audit = await repairStructure({ ...input, figures: [] });
    assert.equal(audit.sourceHash, audit.candidateHash); assert.ok(audit.repairLedger.every((r) => r.decision === "review"));
  });
});
