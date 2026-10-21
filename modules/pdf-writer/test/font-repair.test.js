import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, decodePDFRawStream } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { repairFonts } from "../font-repair.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";
import { checkPdfPreservation } from "../../../scripts/check-pdf-preservation.js";

const exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fontDir = path.join(root, "node_modules/pdfjs-dist/standard_fonts");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const name = PDFName.of;
const decoded = (s) => Buffer.from(decodePDFRawStream(s).decode());
async function render(file) {
  const pdf = await getDocument({ data: new Uint8Array(await readFile(file)), standardFontDataUrl: fontDir + "/", useSystemFonts: false }).promise;
  try {
    const page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    return sha(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } finally { await pdf.destroy(); }
}

test("qualified font repairs preserve forms and enforce their qualification boundary", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-fonts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundledJavaHome = path.join(root, "modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome }), env = await buildJavaExecEnv({ bundledJavaHome });
  const fixture = (...args) => exec(java, ["-XX:TieredStopAtLevel=1", "-cp", path.join(root, "modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),
    path.join(root, "modules/pdf-writer/test/fixtures/FontRepairFixture.java"), ...args], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  await fixture("create", dir, path.join(fontDir, "LiberationSans-Regular.ttf"));
  const sourcePdf = path.join(dir, "valid.pdf"), candidatePdf = path.join(dir, "candidate.pdf");
  const sourceBytes = await readFile(sourcePdf), result = await repairFonts({ sourcePdf, outputPdf: candidatePdf });

  await t.test("editable defaults preserve existing pixels, provide Unicode and support accented entry", async () => {
    const source = path.join(dir, "editable.pdf"), candidate = path.join(dir, "editable-fixed.pdf");
    const report = await repairFonts({ sourcePdf: source, outputPdf: candidate });
    assert.ok(report.repairLedger.some((r) => r.ruleId === "editable-truetype-unicode" && r.decision === "apply"));
    assert.ok(report.repairLedger.some((r) => r.ruleId === "editable-helvetica-source-program" && r.decision === "apply"));
    assert.equal(await render(source), await render(candidate));
    assert.equal((await repairFonts({ sourcePdf: source, candidatePdf: candidate })).verification.status, "pass");
    const saved = path.join(dir, "editable-filled.pdf"); await fixture("interact", candidate, saved, "accented");
    const pdf = await getDocument({ data: new Uint8Array(await readFile(saved)), standardFontDataUrl: fontDir + "/", useSystemFonts: false }).promise;
    try { assert.ok((await (await pdf.getPage(1)).getAnnotations()).some((a) => a.fieldValue === "Jos\u00e9 \u20ac caf\u00e9")); }
    finally { await pdf.destroy(); }
    const repeat = await repairFonts({ sourcePdf: candidate, outputPdf: path.join(dir, "editable-repeat.pdf") });
    assert.equal(repeat.sourceHash, repeat.candidateHash);
  });
  for (const mode of ["editable-custom", "editable-used", "editable-duplicate", "editable-widths"]) {
    await t.test(`${mode} cannot qualify editable Helvetica replacement`, async () => {
      const report = await repairFonts({ sourcePdf: path.join(dir, `${mode}.pdf`), outputPdf: path.join(dir, `${mode}-fixed.pdf`) });
      assert.ok(report.repairLedger.some((r) => r.ruleId === "editable-helvetica-source-program" && r.decision === "review"));
      assert.ok(!report.repairLedger.some((r) => r.ruleId === "editable-helvetica-source-program" && r.decision === "apply"));
    });
  }

  await t.test("saved repair is verified, preserves the prefix, and embeds each shared resource once", async () => {
    assert.equal(result.verification.status, "pass");
    assert.deepEqual(result.repairLedger.filter((r) => r.decision === "apply").map((r) => r.ruleId).sort(),
      ["identity-cidset-complete", "space-only-times-embed", "standard-dingbats-embed"]);
    assert.deepEqual((await readFile(candidatePdf)).subarray(0, sourceBytes.length), sourceBytes);
    assert.deepEqual(await readFile(sourcePdf), sourceBytes);
    assert.equal((await repairFonts({ sourcePdf, candidatePdf })).verification.status, "pass");
    const repeat = path.join(dir, "repeat.pdf");
    const second = await repairFonts({ sourcePdf: candidatePdf, outputPdf: repeat });
    assert.equal(second.repairLedger.filter((r) => r.decision === "apply").length, 0);
    assert.equal(second.sourceHash, second.candidateHash, "No-op must be byte-identical");
    await assert.rejects(repairFonts({ sourcePdf, outputPdf: candidatePdf }), /overwrite existing/);
    await assert.rejects(repairFonts({ sourcePdf, outputPdf: sourcePdf }), /overwrite its source/);
    await assert.rejects(repairFonts({}), /Required/);
    await assert.rejects(repairFonts({ sourcePdf, outputPdf: candidatePdf, candidatePdf }), /exactly one/);
  });
  await t.test("complete CIDSet uses the original full TrueType program and zero padding", async () => {
    const a = await PDFDocument.load(sourceBytes), b = await PDFDocument.load(await readFile(candidatePdf));
    const resources = (d) => d.getPage(0).node.Resources().lookup(name("Font"));
    const cidDescriptor = (d) => resources(d).lookup(name("Embedded")).lookup(name("DescendantFonts")).lookup(0).lookup(name("FontDescriptor"));
    const before = cidDescriptor(a), after = cidDescriptor(b), program = decoded(before.lookup(name("FontFile2")));
    assert.deepEqual(decoded(after.lookup(name("FontFile2"))), program);
    let count;
    for (let i = 0; i < program.readUInt16BE(4); i++) { const p = 12 + i * 16; if (program.toString("ascii", p, p + 4) === "maxp") count = program.readUInt16BE(program.readUInt32BE(p + 8) + 4); }
    assert.ok(count > 100);
    const bitmap = after.lookup(name("CIDSet")); assert.equal(bitmap.dict.has(name("Filter")), false);
    const expected = Buffer.alloc(Math.ceil(count / 8)); for (let i = 0; i < count; i++) expected[i >> 3] |= 128 >> (i % 8);
    assert.deepEqual(decoded(bitmap), expected);
    const zapf = resources(b).lookup(name("ZaDb"));
    assert.equal(zapf.lookup(name("Widths")).lookup(52).asNumber(), 846);
    assert.equal(sha(decoded(zapf.lookup(name("FontDescriptor")).lookup(name("FontFile3")))), "845c752392b6c914fb989c75a08b7792b88f542d2499042ef2889f8c814a16ed");
    assert.match(decoded(zapf.lookup(name("ToUnicode"))).toString(), /<34> <2714>/i);
  });
  await t.test("normal and filled checkbox/text appearances match in PDF.js", async () => {
    assert.equal(await render(sourcePdf), await render(candidatePdf));
    const filledSource = path.join(dir, "source-filled.pdf"), filledCandidate = path.join(dir, "candidate-filled.pdf");
    await fixture("interact", sourcePdf, filledSource); await fixture("interact", candidatePdf, filledCandidate);
    assert.equal(await render(filledSource), await render(filledCandidate));
  });
  for (const [mode, rule] of [["visible", "space-only-times-embed"], ["hidden-visible", "space-only-times-embed"],
    ["dynamic", "space-only-times-embed"], ["pattern", "space-only-times-embed"], ["custom", "standard-dingbats-embed"],
    ["widths", "standard-dingbats-embed"], ["nonidentity", "identity-cidset-complete"]]) {
    await t.test(`${mode} is left unchanged for review`, async () => {
      const report = await repairFonts({ sourcePdf: path.join(dir, `${mode}.pdf`), outputPdf: path.join(dir, `${mode}-out.pdf`) });
      assert.ok(report.repairLedger.some((r) => r.ruleId === rule && r.decision === "review"));
      assert.ok(!report.repairLedger.some((r) => r.ruleId === rule && r.decision === "apply"));
    });
  }
  await t.test("bad programs, signatures and unqualified replacements fail without output", async () => {
    for (const mode of ["badttf", "signed"]) {
      const outputPdf = path.join(dir, `${mode}-out.pdf`);
      await assert.rejects(repairFonts({ sourcePdf: path.join(dir, `${mode}.pdf`), outputPdf }));
      await assert.rejects(readFile(outputPdf), { code: "ENOENT" });
    }
    const badFonts = path.join(dir, "bad-fonts"); await mkdir(badFonts);
    await writeFile(path.join(badFonts, "FoxitDingbats.pfb"), "unqualified");
    await assert.rejects(repairFonts({ sourcePdf, outputPdf: path.join(dir, "wrong-program.pdf"), fontDir: badFonts }), /Unqualified font program hash/);
  });
  await fixture("mutate", candidatePdf, dir);
  for (const mode of ["value", "appearance", "content", "geometry", "program", "unicode", "structure", "info"]) {
    await t.test(`saved ${mode} mutation is rejected`, async () => {
      const report = await repairFonts({ sourcePdf, candidatePdf: path.join(dir, `${mode}.pdf`) });
      assert.equal(report.verification.status, "fail");
      assert.match(report.verification.reason, /Unexpected saved-object change/);
    });
  }
  await t.test("preservation gate requires fresh replay before allowing changed font resources", async () => {
    const validationReport = path.join(dir, "validation.json"), outputPath = path.join(dir, "quality.json");
    const validation = { status: "completed", pdfSha256: result.candidateHash, isCompliant: true, overall: { status: "pass" }, findings: [], fontAudit: { status: "ok" } };
    await writeFile(validationReport, JSON.stringify(validation));
    const options = { sourcePdf, candidatePdf, validationReport, outputPath };
    assert.equal((await checkPdfPreservation(options)).disposition, "rejected");
    const qualified = await checkPdfPreservation({ ...options, fontRepairs: true });
    assert.equal(qualified.disposition, "review_required");
    assert.equal(qualified.checks.find((c) => c.id === "qualifiedFontChanges").status, "pass");
    const changed = path.join(dir, "value.pdf"); validation.pdfSha256 = sha(await readFile(changed));
    await writeFile(validationReport, JSON.stringify(validation));
    assert.equal((await checkPdfPreservation({ ...options, candidatePdf: changed, fontRepairs: true })).disposition, "error");
  });
});
