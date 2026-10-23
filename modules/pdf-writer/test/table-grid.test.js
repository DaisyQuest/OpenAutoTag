import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, PDFName, PDFNumber, PDFArray } from "pdf-lib";
import { buildTagTree } from "../../tag-builder/index.js";
import { writeTaggedArtifacts } from "../index.js";
import { checkSavedSemantics } from "../../../scripts/check-saved-semantics.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";
const all = n => [n, ...n.children.flatMap(all)];

test("saved merged grids preserve declared spans, source fragments and editable controls", async t => {
  const dir = process.env.TABLE_GRID_EVIDENCE_DIR || await mkdtemp(path.join(os.tmpdir(), "saved-grids-"));
  await mkdir(dir, { recursive: true }); if (!process.env.TABLE_GRID_EVIDENCE_DIR) t.after(() => rm(dir, { recursive: true, force: true }));
  const nodes = [], add = (page,row,col,text,extra={}) => {
    const id = `cell${nodes.length}`, { xColumn = col ?? 0, yOffset = 0, ...properties } = extra;
    nodes.push({ id, sourceBlockId: id, pageNumber: page, role: "TD", text, textProvenance: "native", bbox: [72+xColumn*80,100+row*48+yOffset,74,12], confidence: 1,
      tableId: `grid${page}`, tableRowIndex: row, ...(col == null ? {} : {tableColumnIndex: col}), ...properties });
  };
  add(1,0,0,"Merged",{role:"TH",tableColumnSpan:2,tableSection:"head"});
  add(1,0,0,"measurements",{role:"TH",tableColumnSpan:2,tableSection:"head",yOffset:15});
  add(1,1,0,"Length",{role:"TH",tableSection:"head"}); add(1,1,1,"Width",{role:"TH",tableSection:"head"});
  add(1,2,0,"123",{tableRowSpan:2}); add(1,2,1,"200"); add(1,3,1,"300");
  add(2,0,0,"Region 20",{role:"TH",scope:"Row",tableRowSpan:2});
  add(2,0,null,"Value 30",{tableRowSpan:2,xColumn:2}); add(2,1,1,"Total 40");
  add(3,0,null,"First",{role:"TH",tableSection:"head"}); add(3,0,5,"Sixth",{role:"TH",tableSection:"head"});
  add(3,1,0,"100"); add(3,1,5,"600");
  add(4,0,0,"Rate 60",{role:"TH",scope:"Row",tableRowSpan:2}); add(4,0,1,"100");
  const pdfPath=path.join(dir,"source.pdf"),outputPath=path.join(dir,"candidate.pdf"),semanticPath=path.join(dir,"semantic.json"),tagsPath=path.join(dir,"tagging.json"),textPath=path.join(dir,"text.tsv");
  const semantic={schemaVersion:"1.0.0",documentId:"table-grids",source:{layoutDocumentId:"grids",filePath:pdfPath,coordinateSpace:"crop-display-points"},nodes,orderedNodeIds:nodes.map(n=>n.id)};
  await writeFile(semanticPath,JSON.stringify(semantic)); await writeFile(textPath,nodes.map(n=>[n.pageNumber,n.bbox[0],n.bbox[1],n.text].join("\t")).join("\n"));
  const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
  const run=(fixture,...args)=>promisify(execFile)(java,["-XX:TieredStopAtLevel=1","-cp",path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),path.resolve(`modules/pdf-writer/test/fixtures/${fixture}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  await run("TableGridFixture",pdfPath,textPath,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf"));
  const before=await readFile(pdfPath),tagging=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tagging));
  const flat=all(tagging.root);assert.ok(flat.every(n=>!n.tableGridReview));assert.equal(tagging.source.tableCellMerges.length,1);
  assert.equal(flat.find(n=>n.id==="tag:cell8").tableColumnIndex,2);
  assert.equal(flat.find(n=>n.id==="tag:cell11").tableColumnIndex,5);
  assert.equal(flat.find(n=>n.id==="tag:cell0").children.length,2);
  await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:"native"});
  assert.deepEqual(await readFile(pdfPath),before);
  const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:outputPath+".ownership.json",outputPath:path.join(dir,"saved.json")});
  assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==="fail")));
  assert.match((await run("CidMapFixture","verify",pdfPath,outputPath)).stdout,/preserved/);
  await t.test("header-only trailing spans save rows under their table section",async()=>{
    const headerSemantic=structuredClone(semantic);headerSemantic.nodes.at(-1).role="TH";
    const input=path.join(dir,"header-only-semantic.json"),tags=path.join(dir,"header-only-tags.json"),target=path.join(dir,"header-only.pdf");
    await writeFile(input,JSON.stringify(headerSemantic));const headerTags=await buildTagTree(input);await writeFile(tags,JSON.stringify(headerTags));
    assert.ok(all(headerTags.root).filter(n=>n.type==="TR").every(n=>n.children.every(c=>["TH","TD"].includes(c.type))));
    await writeTaggedArtifacts({pdfPath,outputPath:target,tagsPath:tags,semanticPath:input,mode:"native"});
    const report=await checkSavedSemantics({pdfPath:target,tagsPath:tags,sourcePdfPath:pdfPath,ownershipPath:target+".ownership.json",outputPath:path.join(dir,"header-only-saved.json")});assert.equal(report.summary.failed,0,JSON.stringify(report.checks.filter(c=>c.status==="fail")));
    assert.match((await run("CidMapFixture","verify",pdfPath,target)).stdout,/preserved/);
  });
  for(const mode of ["native","raster"])await t.test(`unresolved cells cannot be written in ${mode} mode`,async()=>{
    const bad=structuredClone(semantic);bad.nodes[1].tableColumnSpan=1;
    const input=path.join(dir,`conflict-${mode}.json`),plan=path.join(dir,`conflict-${mode}-tags.json`),target=path.join(dir,`refused-${mode}.pdf`);
    await writeFile(input,JSON.stringify(bad));const tags=await buildTagTree(input);assert.ok(all(tags.root).some(n=>n.tableGridReview));await writeFile(plan,JSON.stringify(tags));
    await assert.rejects(writeTaggedArtifacts({pdfPath,outputPath:target,tagsPath:plan,semanticPath:input,mode}),/Table grid requires review/);await assert.rejects(access(target));assert.deepEqual(await readFile(pdfPath),before);
  });
  await t.test("saved validation cannot hide a pending grid review behind a valid PDF",async()=>{
    const tags=structuredClone(tagging),table=all(tags.root).find(n=>n.type==="Table");table.tableGridReview={algorithm:"declared-grid-v1",status:"review_required",tableId:table.id,issues:[{code:"OVERLAPPING_SPANS",cellId:"tag:cell0",message:"Unresolved supplied evidence"}]};
    const pending=path.join(dir,"pending-tags.json");await writeFile(pending,JSON.stringify(tags));const r=await checkSavedSemantics({pdfPath:outputPath,tagsPath:pending});assert.ok(r.checks.some(c=>c.code==="TABLE_GRID_REVIEW"&&c.status==="fail"));
  });
  for(const attribute of ["RowSpan","ColSpan"])await t.test(`saved ${attribute} corruption is detected`,async()=>{
    const doc=await PDFDocument.load(await readFile(outputPath)),key=PDFName.of;
    const target=doc.context.enumerateIndirectObjects().find(([,v])=>v.get?.(key("ID"))?.decodeText?.()==="oat:tag:cell4")?.[1];assert.ok(target);
    const attrs=target.lookup(key("A")),dict=attrs instanceof PDFArray?attrs.lookup(0):attrs;dict.set(key(attribute),PDFNumber.of(5));
    const mutated=path.join(dir,`corrupt-${attribute}.pdf`);await writeFile(mutated,await doc.save());const r=await checkSavedSemantics({pdfPath:mutated,tagsPath});assert.ok(r.checks.some(c=>c.code===(attribute==="RowSpan"?"ROW_SPAN":"COLUMN_SPAN")&&c.status==="fail"));
  });
  await writeFile(path.join(dir,"evidence.json"),JSON.stringify({pdfPath,outputPath,tagsPath,semanticPath,summary:saved.summary,merges:tagging.source.tableCellMerges,regularity:tagging.source.tableRegularityCorrection,fieldFillSaveReopen:true},null,2));
});
