import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFString } from "pdf-lib";
import { buildTagTree } from "../../modules/tag-builder/index.js";
import { writeTaggedArtifacts } from "../../modules/pdf-writer/index.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";
const name = PDFName.of;
function elements(doc) {
  const found = [], seen = new Set();
  const walk = (raw) => {
    const v = doc.context.lookup(raw); if (!v || seen.has(v)) return; seen.add(v);
    if (v instanceof PDFArray) { for (let i = 0; i < v.size(); i++) walk(v.get(i)); }
    else if (v instanceof PDFDict) { if (v.has(name("S"))) found.push(v); walk(v.get(name("K"))); }
  };
  walk(doc.catalog.lookup(name("StructTreeRoot")).get(name("K"))); return found;
}
test("both writer paths save resolvable complex table headers and Roman list semantics", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "saved-table-semantics-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "source.pdf"), tagsPath = path.join(dir, "tagging.json"), semanticPath = path.join(dir, "semantic.json");
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]);
  const node = (id, role, text, row, col, extra = {}) => ({ id, sourceBlockId: id, role, text, confidence: 1, pageNumber: 1,
    bbox: [72 + col * 180, 100 + row * 32, 160, 14], tableId: "measurements", tableRowIndex: row, tableColumnIndex: col, ...extra });
  const nodes = [node("group", "TH", "Measurements", 0, 0, { tableColumnSpan: 2, tableSection: "head" }),
    node("length", "TH", "Length", 1, 0, { tableSection: "head" }), node("width", "TH", "Width", 1, 1, { tableSection: "head" }),
    node("data", "TD", "1234", 2, 0, { tableColumnSpan: 2 }),
    ...["iv. First item", "v. Second item"].map((text, i) => ({ id: `list${i}`, sourceBlockId: `list${i}`, role: "LI", text, confidence: 1, pageNumber: 1,
      bbox: [72, 300 + i * 22, 200, 14], listGroupId: "roman", listLevel: 1, listStyle: "ordered" }))];
  for (const n of nodes) page.drawText(n.text, { x: n.bbox[0], y: 792 - n.bbox[1] - 12, size: 12 });
  await writeFile(pdfPath, await doc.save());
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "saved-table", source: { layoutDocumentId: "layout", filePath: pdfPath },
    nodes, orderedNodeIds: nodes.map((n) => n.id) }));
  const tagging = await buildTagTree(semanticPath); await writeFile(tagsPath, JSON.stringify(tagging));
  for (const mode of ["native", "raster"]) await t.test(mode, async () => {
    const outputPath = path.join(dir, `${mode}.pdf`); await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath, mode });
    const saved = await PDFDocument.load(await readFile(outputPath)), all = elements(saved);
    const ids = all.filter((d) => d.get(name("S")) === name("TH")).map((d) => d.lookup(name("ID"), PDFString).decodeText());
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
    const data = all.find((d) => d.get(name("S")) === name("TD")), attrs = data.lookup(name("A"));
    const headers = attrs instanceof PDFArray ? attrs.lookup(0).lookup(name("Headers")) : attrs.lookup(name("Headers"));
    assert.deepEqual(Array.from({ length: headers.size() }, (_, i) => headers.lookup(i).decodeText()).sort(), ids.sort());
    const names = saved.catalog.lookup(name("StructTreeRoot")).lookup(name("IDTree")).lookup(name("Names"));
    for (let i = 0; i < names.size(); i += 2) assert.equal(names.lookup(i + 1).lookup(name("ID")).decodeText(), names.lookup(i).decodeText());
    const list = all.find((d) => d.get(name("S")) === name("L"));
    assert.equal(list.lookup(name("A")).get(name("ListNumbering")).toString(), "/LowerRoman");
  });
  await t.test("dangling header references are rejected before publication", async () => {
    const walk = (n) => { if (n.type === "TD") n.tableAttrs.Headers = ["missing-header"]; for (const c of n.children || []) walk(c); };
    walk(tagging.root); await writeFile(tagsPath, JSON.stringify(tagging));
    await assert.rejects(writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath: path.join(dir, "bad.pdf"), mode: "native" }), /Missing emitted table header ID/);
  });
  await t.test("ID registry rejects duplicates, wrong types, cross-table targets and excessive depth", async () => {
    const root = process.cwd(), bundledJavaHome = path.join(root, "modules/validator/vendor/java");
    const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
    const { stdout } = await promisify(execFile)(java, ["-cp", [getRuntimeBuildDir("modules-pdf-writer", { repoRoot: root }), path.join(root, "modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar")].join(path.delimiter),
      path.join(root, "modules/pdf-writer/test/fixtures/StructureIdentifiersProbe.java")], { env: await buildJavaExecEnv({ bundledJavaHome }), windowsHide: true });
    assert.match(stdout, /6 ID registry cases passed/);
  });
});
