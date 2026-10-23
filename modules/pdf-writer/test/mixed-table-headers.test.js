import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, PDFName, PDFArray, PDFString } from "pdf-lib";
import { buildTagTree } from "../../tag-builder/index.js";
import { writeTaggedArtifacts } from "../index.js";
import { checkSavedSemantics } from "../../../scripts/check-saved-semantics.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";
import fixture from "../../../test/fixtures/mixed-table-headers.json" with {type:"json"};
const all = n => [n,...n.children.flatMap(all)], key=PDFName.of;

test("mixed headers save exact ordered relations and preserve native editable appearance",async t=>{
  const dir=process.env.MIXED_HEADERS_EVIDENCE_DIR || await mkdtemp(path.join(os.tmpdir(),"mixed-headers-"));
  await mkdir(dir,{recursive:true});if(!process.env.MIXED_HEADERS_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
  const nodes=fixture.tables.flatMap(table=>table.cells.map(([id,role,text,row,col,extra={}])=>({id:`${table.id}-${id}`,sourceBlockId:`${table.id}-${id}`,pageNumber:table.page,role,text,textProvenance:"native",confidence:1,bbox:[50+col*100,80+row*38,90,14],tableId:table.id,tableRowIndex:row,tableColumnIndex:col,...extra})));
  const pdfPath=path.join(dir,"source.pdf"),semanticPath=path.join(dir,"semantic.json"),tagsPath=path.join(dir,"tagging.json"),textPath=path.join(dir,"text.tsv");
  await writeFile(semanticPath,JSON.stringify({schemaVersion:"1.0.0",documentId:"mixed-headers",source:{layoutDocumentId:"mixed",filePath:pdfPath,coordinateSpace:"crop-display-points"},nodes,orderedNodeIds:nodes.map(n=>n.id)}));
  await writeFile(textPath,nodes.map(n=>[n.pageNumber,n.bbox[0],n.bbox[1],n.text].join("\t")).join("\n"));
  const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
  const run=(name,...args)=>promisify(execFile)(java,["-XX:TieredStopAtLevel=1","-cp",path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),path.resolve(`modules/pdf-writer/test/fixtures/${name}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  await run("TableGridFixture",pdfPath,textPath,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf"));
  const before=await readFile(pdfPath),tagging=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tagging));
  const intended=new Map(all(tagging.root).map(n=>[n.id,n])),cases=[];
  for(const mode of ["native","raster"])await t.test(`${mode} relationships match the independent oracle`,async()=>{
    let modeSource=pdfPath;
    if(mode==='raster') {
      await assert.rejects(writeTaggedArtifacts({pdfPath,outputPath:path.join(dir,'flattened.pdf'),tagsPath,semanticPath,mode}),/Raster output would flatten native form widgets/);
      modeSource=path.join(dir,'plain.pdf');await run('TableGridFixture',modeSource,textPath,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'),'no-form');
    }
    const outputPath=path.join(dir,`${mode}.pdf`);await writeTaggedArtifacts({pdfPath:modeSource,outputPath,tagsPath,semanticPath,mode});
    const doc=await PDFDocument.load(await readFile(outputPath)),objects=new Map(doc.context.enumerateIndirectObjects().filter(([,o])=>o.get?.(key("ID"))?.decodeText).map(([,o])=>[o.get(key("ID")).decodeText(),o]));
    const emitted=id=>{const n=intended.get(`tag:${id}`);return n.headerId || `oat:${n.id}`;};
    for(const table of fixture.tables)for(const [id,expected]of Object.entries(table.headers)){
      const n=intended.get(`tag:${table.id}-${id}`),saved=objects.get(emitted(`${table.id}-${id}`));assert.ok(saved,id);
      let attr=saved.lookup(key("A"));if(attr instanceof PDFArray)attr=Array.from({length:attr.size()},(_,i)=>attr.lookup(i)).find(a=>a.get(key("O"))===key("Table"));
      const refs=attr?.lookup(key("Headers"));const actual=refs?Array.from({length:refs.size()},(_,i)=>refs.lookup(i).decodeText()):[];
      assert.deepEqual(actual,expected.map(h=>emitted(`${table.id}-${h}`)),`${mode}/${table.id}/${id}`);
      assert.equal(saved.get(key("S")).toString(),`/${n.type}`);
      assert.equal(attr?.get(key("Scope"))?.toString() || "",n.scope?`/${n.scope}`:"");
      assert.equal(new Set(actual).size,actual.length);
    }
    const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,outputPath:path.join(dir,`${mode}-saved.json`),...(mode==="native"?{sourcePdfPath:pdfPath,ownershipPath:outputPath+".ownership.json"}:{})});
    assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==="fail")));assert.deepEqual(await readFile(pdfPath),before);
    if(mode==="native")assert.match((await run("CidMapFixture","verify",pdfPath,outputPath)).stdout,/preserved/);
    cases.push({mode,outputPath,saved:saved.summary});
  });
  for(const mutation of ["order","unrelated","scope","unexpected-scope"])await t.test(`saved ${mutation} corruption fails qualification`,async()=>{
    const doc=await PDFDocument.load(await readFile(path.join(dir,"native.pdf"))),n=intended.get(mutation==="scope"?"tag:mixed-units":"tag:mixed-n1"),id=n.headerId||`oat:${n.id}`;
    const saved=doc.context.enumerateIndirectObjects().find(([,v])=>v.get?.(key("ID"))?.decodeText?.()===id)?.[1];assert.ok(saved);
    const raw=saved.lookup(key("A")),a=raw instanceof PDFArray?raw.lookup(0):raw;
    if(mutation.includes("scope"))a.set(key("Scope"),key("Both"));
    else{const h=a.lookup(key("Headers"));if(mutation==="order"){const first=h.get(0);h.set(0,h.get(1));h.set(1,first);}else h.push(PDFString.of(intended.get("tag:bands-oldX").headerId));}
    const pdf=path.join(dir,`bad-${mutation}.pdf`);await writeFile(pdf,await doc.save());const report=await checkSavedSemantics({pdfPath:pdf,tagsPath,outputPath:path.join(dir,`bad-${mutation}.json`)});
    assert.ok(report.checks.some(c=>c.code===(mutation.includes("scope")?"TABLE_SCOPE":"TABLE_HEADERS")&&c.status==="fail"));
  });
  await writeFile(path.join(dir,"evidence.json"),JSON.stringify({pdfPath,semanticPath,tagsPath,cases,cellCount:nodes.length,nativeFillSaveReopen:true,corruptionsRejected:4},null,2));
});
