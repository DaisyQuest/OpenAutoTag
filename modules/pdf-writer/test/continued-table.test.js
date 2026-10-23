import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {PDFDocument,PDFName,PDFArray,PDFString} from "pdf-lib";
import {buildTagTree} from "../../tag-builder/index.js";
import {writeTaggedArtifacts} from "../index.js";
import {checkSavedSemantics} from "../../../scripts/check-saved-semantics.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../../scripts/java-runtime.js";
import {continuedTableFixture} from "../../../test/fixtures/continued-table.js";
const all=n=>[n,...n.children.flatMap(all)],key=PDFName.of;

test("continued tables save all page occurrences in order with local headers and editable fields",async t=>{
  const dir=process.env.CONTINUED_TABLE_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),"continued-table-"));
  await mkdir(dir,{recursive:true});if(!process.env.CONTINUED_TABLE_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
  const fixture=continuedTableFixture(),{nodes,headers,repeats}=fixture;
  const pdfPath=path.join(dir,"source.pdf"),semanticPath=path.join(dir,"semantic.json"),tagsPath=path.join(dir,"tagging.json"),textPath=path.join(dir,"text.tsv");
  await writeFile(semanticPath,JSON.stringify({schemaVersion:"1.0.0",documentId:"continued-table",source:{layoutDocumentId:"continued",filePath:pdfPath,coordinateSpace:"crop-display-points"},nodes,orderedNodeIds:nodes.map(n=>n.id)}));
  await writeFile(textPath,nodes.map(n=>[n.pageNumber,n.bbox[0],n.bbox[1],n.text].join("\t")).join("\n"));await writeFile(path.join(dir,"oracle.json"),JSON.stringify(fixture,null,2));
  const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
  const run=(name,...args)=>promisify(execFile)(java,["-XX:TieredStopAtLevel=1","-cp",path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),path.resolve(`modules/pdf-writer/test/fixtures/${name}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  await run("TableGridFixture",pdfPath,textPath,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf"));
  const before=await readFile(pdfPath),tags=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tags));
  const intended=new Map(all(tags.root).map(n=>[n.id,n])),emit=id=>{const n=intended.get(`tag:${id}`);return n.headerId||`oat:${n.id}`;};
  assert.deepEqual(all(tags.root).flatMap(n=>n.sourceNodeIds||[]),nodes.map(n=>n.id));assert.equal(tags.source.repeatedHeaderRows,4);
  const cases=[];
  for(const mode of ["native","raster"])await t.test(`${mode} keeps occurrences, sections, row order and exact targets`,async()=>{
    const outputPath=path.join(dir,`${mode}.pdf`);await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode});
    const doc=await PDFDocument.load(await readFile(outputPath)),objects=new Map(doc.context.enumerateIndirectObjects().filter(([,v])=>v.get?.(key("ID"))?.decodeText).map(([,v])=>[v.get(key("ID")).decodeText(),v]));
    const actualOrder=[];
    const walk=raw=>{const n=doc.context.lookup(raw);if(n instanceof PDFArray)for(let i=0;i<n.size();i++)walk(n.get(i));else if(n?.get?.(key("S"))){const id=n.get(key("ID"))?.decodeText();if(id?.endsWith(":span"))actualOrder.push(id);walk(n.get(key("K")));}};
    walk(doc.catalog.lookup(key("StructTreeRoot")).get(key("K")));assert.deepEqual(actualOrder,nodes.map(n=>`oat:tag:${n.id}:span`));
    for(const[id,targets]of Object.entries(headers)){const object=objects.get(emit(id));assert.ok(object,id);let a=object.lookup(key("A"));if(a instanceof PDFArray)a=Array.from({length:a.size()},(_,i)=>a.lookup(i)).find(v=>v.get(key("O"))===key("Table"));const refs=a?.lookup(key("Headers"));const actual=refs?Array.from({length:refs.size()},(_,i)=>refs.lookup(i).decodeText()):[];assert.deepEqual(actual,targets.map(emit),id);}
    for(const[id,original]of Object.entries(repeats)){assert.notEqual(objects.get(emit(id)),objects.get(emit(original)));assert.equal(intended.get(`tag:${id}`).repeatedHeaderOf,`tag:${original}`);}
    assert.equal([...objects.values()].filter(v=>v.get(key("S"))===key("THead")).length,2);
    const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,outputPath:path.join(dir,`${mode}-saved.json`),...(mode==="native"?{sourcePdfPath:pdfPath,ownershipPath:outputPath+".ownership.json"}:{})});assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==="fail")));
    assert.deepEqual(await readFile(pdfPath),before);if(mode==="native")assert.match((await run("CidMapFixture","verify",pdfPath,outputPath)).stdout,/preserved/);cases.push({mode,outputPath,saved:saved.summary});
  });
  for(const kind of ["row-order","old-header"])await t.test(`saved ${kind} corruption is rejected`,async()=>{
    const doc=await PDFDocument.load(await readFile(path.join(dir,"native.pdf"))),objects=new Map(doc.context.enumerateIndirectObjects().filter(([,v])=>v.get?.(key("ID"))?.decodeText).map(([,v])=>[v.get(key("ID")).decodeText(),v]));
    if(kind==="row-order"){const body=[...objects.values()].find(v=>v.get(key("S"))===key("TBody")),rows=body.lookup(key("K"));const first=rows.get(0);rows.set(0,rows.get(2));rows.set(2,first);}
    else{const a=objects.get(emit("p2-n1")).lookup(key("A")),attrs=a instanceof PDFArray?a.lookup(0):a;attrs.lookup(key("Headers")).set(0,PDFString.of(emit("p1-count")));}
    const outputPath=path.join(dir,`bad-${kind}.pdf`);await writeFile(outputPath,await doc.save());const report=await checkSavedSemantics({pdfPath:outputPath,tagsPath,outputPath:path.join(dir,`bad-${kind}.json`)});assert.ok(report.checks.some(c=>c.code===(kind==="row-order"?"CHILD_ORDER":"TABLE_HEADERS")&&c.status==="fail"));
  });
  let artifacts;
  await t.test("painted running artifacts preserve the continued table and editable appearance",async()=>{
    const artifactNodes=nodes.flatMap((n,i)=>[n,...([9,19].includes(i)?[{id:`footer${n.pageNumber}`,sourceBlockId:`footer${n.pageNumber}`,pageNumber:n.pageNumber,role:"Artifact",text:"Continued table",bbox:[50,745,140,14],confidence:1,artifactType:"footer"}]:[])]);
    const source=path.join(dir,"artifact-source.pdf"),semantic=path.join(dir,"artifact-semantic.json"),plan=path.join(dir,"artifact-tags.json"),candidate=path.join(dir,"artifact.pdf"),text=path.join(dir,"artifact.tsv");
    await writeFile(text,artifactNodes.map(n=>[n.pageNumber,n.bbox[0],n.bbox[1],n.text].join("\t")).join("\n"));await run("TableGridFixture",source,text,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf"));
    const input=JSON.parse(await readFile(semanticPath));input.source.filePath=source;input.nodes=artifactNodes;input.orderedNodeIds=artifactNodes.map(n=>n.id);await writeFile(semantic,JSON.stringify(input));
    const tagged=await buildTagTree(semantic);assert.equal(all(tagged.root).filter(n=>n.type==="Table").length,2);assert.equal(tagged.source.repeatedHeaderRows,4);assert.deepEqual(tagged.root,tags.root);await writeFile(plan,JSON.stringify(tagged));
    await writeTaggedArtifacts({pdfPath:source,outputPath:candidate,tagsPath:plan,semanticPath:semantic,mode:"native"});const r=await checkSavedSemantics({pdfPath:candidate,tagsPath:plan,sourcePdfPath:source,ownershipPath:candidate+".ownership.json",outputPath:path.join(dir,"artifact-saved.json")});assert.equal(r.summary.failed,0,JSON.stringify(r.checks.filter(c=>c.status==="fail")));
    assert.match((await run("CidMapFixture","verify",source,candidate)).stdout,/preserved/);artifacts={pdfPath:source,semanticPath:semantic,tagsPath:plan,outputPath:candidate,saved:r.summary};
  });
  await writeFile(path.join(dir,"evidence.json"),JSON.stringify({pdfPath,semanticPath,tagsPath,cases,artifacts,cellCount:nodes.length,retainedRepeatedHeaders:Object.keys(repeats).length,repeatedHeaderRows:tags.source.repeatedHeaderRows,nativeFillSaveReopen:true},null,2));
});
