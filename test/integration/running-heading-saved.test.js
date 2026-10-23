import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,mkdir,copyFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {getDocument} from "pdfjs-dist/legacy/build/pdf.mjs";
import {buildSemanticDocument} from "../../modules/semantic-engine/index.js";
import {assignReadingOrder} from "../../modules/reading-order/index.js";
import {buildTagTree} from "../../modules/tag-builder/index.js";
import {writeTaggedArtifacts} from "../../modules/pdf-writer/index.js";
import {checkSavedSemantics} from "../../scripts/check-saved-semantics.js";
import {inspectPdfLowLevel} from "../../scripts/inspect-pdf-low-level.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../scripts/java-runtime.js";

test("saved running artifacts and mixed-font headings preserve source pixels and corrected section hierarchy",async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"running-headings-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const pdfPath=path.join(dir,"source.pdf"),outputPath=path.join(dir,"candidate.pdf"),semanticPath=path.join(dir,"semantic.json"),tagsPath=path.join(dir,"tags.json");
 const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const jar=path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
 const run=args=>promisify(execFile)(java,args,{env,windowsHide:true,timeout:90000,maxBuffer:8*1024*1024});
 await run(["-cp",jar,path.resolve("test/fixtures/RunningHeadingFixture.java"),pdfPath,
  ...["noto-sans/NotoSans-Regular.ttf","noto-sans/NotoSans-Bold.ttf","noto-serif/NotoSerif-Bold.ttf"].map(f=>path.resolve("modules/font-embedder/vendor/fonts",f))]);
 const rows=[['header','Mission reference',20,10,'paragraph','NotoSans-Regular'],['title','SUPPLEMENTAL AFFIRMATION',70,18,'heading','NotoSans-Bold',1],
  ['wrap','IN SUPPORT OF ORDER TO SHOW CAUSE',90.7,18,'heading','NotoSerif-Bold',1],['subtitle','Instructions for applicants',130,14,'heading','NotoSans-Bold',2],
  ['child','Details',160,12,'heading','NotoSans-Bold',3],['measurement','3.14 meters',200,12,'heading','NotoSans-Regular',2],
  ['date','2026.10.23',220,12,'heading','NotoSans-Regular',3],['list','1. First action',250,12,'list-item','NotoSans-Regular'],['body','Useful body text survives.',290,12,'paragraph','NotoSans-Regular']];
 const pages=[1,2,3,4].map(p=>({pageNumber:p,width:612,height:792,textBlocks:[...rows.map(([id,text,y,fontSize,blockType,fontName,headingLevel])=>({id:`${p}-${id}`,text,bbox:[50,y,500,fontSize],fontSize,fontName,blockType,...(headingLevel?{headingLevel}:{})})),
  {id:`${p}-counter`,text:`Page ${p} of 4`,bbox:[p%2===0?480:50,755+p,70,10],fontSize:10,fontName:'NotoSans-Regular',blockType:'paragraph'}]}));
 await writeFile(semanticPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'running-headings',source:{filePath:pdfPath},pages}));
 const semantic=await buildSemanticDocument(semanticPath);
 assert.equal(semantic.nodes.filter(n=>n.artifactEvidence).length,8);assert.equal(semantic.headingMergeSummary.mergedGroups,4);
 assert.ok(semantic.nodes.filter(n=>/measurement|date/.test(n.sourceBlockId)).every(n=>n.role==='P'));
 await writeFile(semanticPath,JSON.stringify(semantic));const ordered=await assignReadingOrder(semanticPath);
 // Imported corrections may still carry old detection metadata into tag-builder.
 for(const n of ordered.nodes)if(n.sourceBlockId.endsWith('child'))n.headingLevel=2;else if(n.sourceBlockId.endsWith('measurement'))n.headingLevel=4;
 await writeFile(semanticPath,JSON.stringify(ordered));const tags=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tags));
 await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:'native'});
 const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath});assert.equal(saved.summary.failed,0);
 const inspection=await inspectPdfLowLevel({pdfPath:outputPath,preservation:true}),byId=new Map(inspection.structure.map(n=>[n.identifier,n])),byRef=new Map(inspection.structure.map(n=>[n.objectRef,n]));
 for(const p of [1,2,3,4]) {
  const find=s=>ordered.nodes.find(n=>n.sourceBlockId===`${p}-${s}`),id=s=>'oat:tag:'+find(s).id;
  assert.equal(byId.get(id('title')).role,'H1');assert.equal(byId.get(id('subtitle')).role,'H2');assert.equal(byId.get(id('child')).role,'H3');
  assert.equal(byId.get(id('measurement')).role,'P');assert.equal(byId.get(id('date')).role,'P');
  const section=s=>byId.get('oat:tag:section:'+find(s).id);
  assert.equal(byRef.get(section('child').parentRef).identifier,section('subtitle').identifier);
  assert.equal(byRef.get(section('subtitle').parentRef).identifier,section('title').identifier);
  assert.equal(byId.has(id('header')),false);assert.equal(byId.has(id('counter')),false);
 }
 const pdf=await getDocument({data:new Uint8Array(await readFile(outputPath))}).promise;
 let artifactText=0,bodyText=0;
 for(let p=1;p<=4;p++) {
  const items=(await (await pdf.getPage(p)).getTextContent({includeMarkedContent:true})).items,stack=[];
  for(const item of items) {
   if(item.type==='beginMarkedContent'||item.type==='beginMarkedContentProps')stack.push(item.tag);
   else if(item.type==='endMarkedContent')stack.pop();
   else if(item.str?.trim()) {
    if(item.str==='Mission reference'||item.str===`Page ${p} of 4`){assert.ok(stack.includes('Artifact'),item.str);artifactText++;}
    if(item.str==='Useful body text survives.'){assert.ok(!stack.includes('Artifact'));bodyText++;}
   }
  }
 }
 await pdf.destroy();assert.equal(artifactText,8);assert.equal(bodyText,4);
 assert.match((await run(['-cp',jar,path.resolve('modules/pdf-writer/test/fixtures/NativeOperatorProbe.java'),'pixels',pdfPath,outputPath])).stdout,/All pages pixel-identical/);
 const raw=JSON.parse((await promisify(execFile)(process.execPath,['modules/validator/index.js','--pdf',outputPath,'--manifest',outputPath+'.tags.json'],{env,windowsHide:true,timeout:90000,maxBuffer:8*1024*1024})).stdout);
 assert.equal(raw.rawSummary.failedChecks,0);
 if(process.env.TAGGING_HEADING_EVIDENCE_DIR) {
  await mkdir(process.env.TAGGING_HEADING_EVIDENCE_DIR,{recursive:true});
  for(const [name,file] of [['source.pdf',pdfPath],['candidate.pdf',outputPath],['semantic.json',semanticPath],['tags.json',tagsPath]])await copyFile(file,path.join(process.env.TAGGING_HEADING_EVIDENCE_DIR,name));
  await writeFile(path.join(process.env.TAGGING_HEADING_EVIDENCE_DIR,'proof.json'),JSON.stringify({saved:saved.summary,raw:raw.rawSummary,artifactText,bodyText,verifiedSectionTrees:4,pixelIdenticalPages:4},null,2));
 }
});
