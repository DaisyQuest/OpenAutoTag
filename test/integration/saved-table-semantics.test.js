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
import { checkSavedSemantics } from "../../scripts/check-saved-semantics.js";
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
  const node = (id, role, text, row, col, extra = {}) => ({ id, sourceBlockId: id, role, text, confidence: 1, pageNumber: 1,
    bbox: [72 + col * 180, 100 + row * 32, 160, 14], tableId: "measurements", tableRowIndex: row, tableColumnIndex: col, ...extra });
  const nodes = [node("group", "TH", "Measurements", 0, 0, { tableColumnSpan: 2, tableSection: "head" }),
    node("length", "TH", "Length", 1, 0, { tableSection: "head" }), node("width", "TH", "Width", 1, 1, { tableSection: "head" }),
    node("data", "TD", "1234", 2, 0, { tableColumnSpan: 2 }),
    ...["iv. First item", "v. Second item"].map((text, i) => ({ id: `list${i}`, sourceBlockId: `list${i}`, role: "LI", text, confidence: 1, pageNumber: 1,
      bbox: [72, 300 + i * 22, 200, 14], listGroupId: "roman", listLevel: 1, listStyle: "ordered" }))];
  const bundledJavaHome=path.join(process.cwd(),"modules/validator/vendor/java");
  const java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome});
  const probe=path.resolve("modules/pdf-writer/test/fixtures/ListSplitProbe.java"), jar=path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  // Embedded source font isolates content tagging from the legacy Standard 14 replacement.
  await promisify(execFile)(java,["-cp",jar,probe,"create",pdfPath,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")],{env:await buildJavaExecEnv({bundledJavaHome}),windowsHide:true});
  await writeFile(semanticPath, JSON.stringify({ schemaVersion: "1.0.0", documentId: "saved-table", source: { layoutDocumentId: "layout", filePath: pdfPath },
    nodes, orderedNodeIds: nodes.map((n) => n.id) }));
  const tagging = await buildTagTree(semanticPath); await writeFile(tagsPath, JSON.stringify(tagging));
  for (const mode of ["native", "raster"]) await t.test(mode, async () => {
    const outputPath = path.join(dir, `${mode}.pdf`); await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath, mode });
    const saved = await PDFDocument.load(await readFile(outputPath)), all = elements(saved);
    const ids = all.filter((d) => d.get(name("S")) === name("TH")).map((d) => d.lookup(name("ID"), PDFString).decodeText());
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
    for (const cell of all.filter(d => [name("TH"), name("TD")].includes(d.get(name("S"))))) {
      assert.equal(cell.has(name("ActualText")), false, "Table semantics must not be replaced by ActualText");
      const kids = cell.lookup(name("K"));
      const span = kids instanceof PDFArray ? kids.lookup(0) : kids;
      assert.equal(span.get(name("S")), name("Span"));
      assert.ok(span.lookup(name("ActualText"), PDFString).decodeText());
    }
    const data = all.find((d) => d.get(name("S")) === name("TD")), attrs = data.lookup(name("A"));
    const headers = attrs instanceof PDFArray ? attrs.lookup(0).lookup(name("Headers")) : attrs.lookup(name("Headers"));
    assert.deepEqual(Array.from({ length: headers.size() }, (_, i) => headers.lookup(i).decodeText()).sort(), ids.sort());
    const names = saved.catalog.lookup(name("StructTreeRoot")).lookup(name("IDTree")).lookup(name("Names"));
    for (let i = 0; i < names.size(); i += 2) assert.equal(names.lookup(i + 1).lookup(name("ID")).decodeText(), names.lookup(i).decodeText());
    const list = all.find((d) => d.get(name("S")) === name("L"));
    assert.equal(list.lookup(name("A")).get(name("ListNumbering")).toString(), "/LowerRoman");
    const comparison = await checkSavedSemantics({ pdfPath: outputPath, tagsPath });
    const failures = comparison.checks.filter(c => c.status === "fail");
    assert.equal(comparison.summary.failed, 0, JSON.stringify(failures));
    if(mode==="native") {
      const bundledJavaHome=path.join(process.cwd(),"modules/validator/vendor/java");
      const java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome});
      const {stdout}=await promisify(execFile)(java,["-cp",path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),path.resolve("modules/pdf-writer/test/fixtures/ListSplitProbe.java"),pdfPath,outputPath],{env:await buildJavaExecEnv({bundledJavaHome}),windowsHide:true});
      assert.match(stdout,/pixels unchanged/);
    }
  });
  await t.test("reopened semantic comparison rejects role, header, order and ownership mutations", async () => {
    // Start from the passing writer result, so an unrelated known defect cannot
    // make these mutations pass without detecting the deliberate corruption.
    const source = await readFile(path.join(dir, "raster.pdf"));
    for (const kind of ["role", "headers", "order", "duplicate-content", "actual-text", "alternate-text", "missing-replacement"]) {
      const mutated = await PDFDocument.load(source), all = elements(mutated);
      const td = all.find(d => d.get(name("S")) === name("TD"));
      if (kind === "role") td.set(name("S"), name("P"));
      if (kind === "headers") {
        const attrs=td.lookup(name("A"));
        if(attrs instanceof PDFArray){for(let i=0;i<attrs.size();i++){const item=attrs.lookup(i);if(item instanceof PDFDict)item.delete(name("Headers"));}}
        else attrs.delete(name("Headers"));
      }
      if (kind === "actual-text") td.set(name("ActualText"), PDFString.of("Wrong replacement"));
      if (kind === "alternate-text") td.set(name("Alt"), PDFString.of("Unexpected alternate text"));
      if (kind === "missing-replacement") {
        const kids = td.lookup(name("K"));
        (kids instanceof PDFArray ? kids.lookup(0) : kids).delete(name("ActualText"));
      }
      if (kind === "order") {
        const list = all.find(d => d.get(name("S")) === name("L"));
        const kids = list.lookup(name("K")); const first = kids.get(0); kids.set(0, kids.get(1)); kids.set(1, first);
      }
      if (kind === "duplicate-content") {
        const other = all.find(d => d.get(name("S")) === name("TH")); other.set(name("K"), td.get(name("K")));
      }
      const file = path.join(dir, `${kind}.pdf`); await writeFile(file, await mutated.save());
      const comparison = await checkSavedSemantics({ pdfPath: file, tagsPath });
      assert.equal(comparison.disposition, "rejected", kind);
      const code={role:"SAVED_ROLE",headers:"TABLE_HEADERS",order:"CHILD_ORDER","duplicate-content":"STRUCTURE_INTEGRITY","actual-text":"ACTUAL_TEXT","alternate-text":"ALTERNATE_TEXT","missing-replacement":"ACTUAL_TEXT"}[kind];
      assert.ok(comparison.checks.some(c=>c.code===code&&c.status==="fail"),kind);
    }
  });
  await t.test("class-based table attributes resolve through the saved ClassMap",async()=>{
    const doc=await PDFDocument.load(await readFile(path.join(dir,"raster.pdf"))),td=elements(doc).find(d=>d.get(name("S"))===name("TD"));
    const attrs=td.lookup(name("A")),table=attrs instanceof PDFArray?attrs.lookup(0):attrs;
    const root=doc.catalog.lookup(name("StructTreeRoot"));
    root.set(name("ClassMap"),doc.context.obj({CellStyle:table}));td.delete(name("A"));td.set(name("C"),name("CellStyle"));
    const file=path.join(dir,"class-attrs.pdf");await writeFile(file,await doc.save());
    assert.equal((await checkSavedSemantics({pdfPath:file,tagsPath})).summary.failed,0);
    await assert.rejects(checkSavedSemantics({pdfPath:file,referencePath:path.join(dir,"raster.pdf")}),/unchanged source bytes/);
    td.set(name("C"),name("MissingClass"));await writeFile(file,await doc.save());
    assert.ok((await checkSavedSemantics({pdfPath:file,tagsPath})).checks.some(c=>c.code==="STRUCTURE_INTEGRITY"&&c.status==="fail"));
  });
  await t.test("dangling header references are rejected before publication", async () => {
    // A marker that cannot be matched at an exact source glyph boundary must
    // remain a detected semantic loss, never a guessed byte split.
    const badMarker=structuredClone(tagging);
    const change=n=>{if(n.type==="Lbl")n.actualText="zz.";for(const c of n.children||[])change(c);};change(badMarker.root);
    const markerPath=path.join(dir,"bad-marker.json"),markerPdf=path.join(dir,"bad-marker.pdf");
    await writeFile(markerPath,JSON.stringify(badMarker));
    await writeTaggedArtifacts({pdfPath,tagsPath:markerPath,semanticPath,outputPath:markerPdf,mode:"native"});
    const mismatch=await checkSavedSemantics({pdfPath:markerPdf,tagsPath:markerPath});
    assert.ok(mismatch.checks.some(c=>c.code==="EMITTED_NODE"&&c.status==="fail"));
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
