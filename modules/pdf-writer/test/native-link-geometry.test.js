import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,PDFName} from 'pdf-lib';
import {writeTaggedArtifacts} from '../index.js';
import {checkSavedSemantics} from '../../../scripts/check-saved-semantics.js';
import {resolveJavaTool,buildJavaExecEnv} from '../../../scripts/java-runtime.js';
const n=PDFName.of;

test('native link regions preserve rotated/cropped/scaled source geometry and exclude neighboring text',async t=>{
 const dir=process.env.NATIVE_LINK_GEOMETRY_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'link-geometry-'));await mkdir(dir,{recursive:true});
 if(!process.env.NATIVE_LINK_GEOMETRY_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(fixture,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${fixture}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:16*1024*1024});
 await run('NativeLinkGeometryFixture',dir,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'));
 const cases=JSON.parse(await readFile(path.join(dir,'cases.json'))),pdfPath=path.join(dir,'source.pdf'),outputPath=path.join(dir,'candidate.pdf'),tagsPath=path.join(dir,'tags.json'),semanticPath=path.join(dir,'semantic.json');
 const nodes=[];
 for(const item of cases){
  nodes.push({id:`body-${item.pageNumber}`,sourceBlockId:`body-${item.pageNumber}`,pageNumber:item.pageNumber,role:'P',text:'Before open café after',bbox:item.bbox,confidence:1,readingOrder:nodes.length});
  if(item.decoyBox)nodes.push({id:`nearby-${item.pageNumber}`,sourceBlockId:`nearby-${item.pageNumber}`,pageNumber:item.pageNumber,role:'P',text:'NEARBY',bbox:item.decoyBox,confidence:1,readingOrder:nodes.length});
 }
 await writeFile(semanticPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'geometry',source:{layoutDocumentId:'geometry',coordinateSpace:'crop-display-points'},nodes}));
 await writeFile(tagsPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'geometry-tags',source:{semanticDocumentId:'geometry'},root:{id:'root',type:'Document',children:nodes.map(o=>({id:o.id,type:'P',sourceNodeIds:[o.id],label:o.text,actualText:o.text,children:[]}))}}));
 const before=await readFile(pdfPath);await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:'native'});assert.deepEqual(await readFile(pdfPath),before);
 const ownership=JSON.parse(await readFile(`${outputPath}.ownership.json`));
 for(const item of cases)await t.test(item.mode,()=>{
  const links=ownership.nativeLinks.filter(l=>l.pageNumber===item.pageNumber),bound=links.filter(l=>l.status==='bound');
  assert.equal(bound.length,item.expectedBound,JSON.stringify(links));
  if(item.positive){assert.equal(bound[0].anchorText,item.expectedAnchor||'open café');assert.ok(bound[0].ranges.length>=1);if(item.mode==='multiline')assert.equal(bound[0].ranges.length,2);}
  else assert.ok(links.every(l=>l.reason.length>0));
 });
 const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:`${outputPath}.ownership.json`,outputPath:path.join(dir,'saved.json')});
 assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==='fail')));assert.equal(saved.ownershipStatus,'verified');
 assert.match((await run('CidMapFixture','verify',pdfPath,outputPath)).stdout,/preserved/);
 const source=await PDFDocument.load(before),candidate=await PDFDocument.load(await readFile(outputPath));
 assert.equal(candidate.getForm().getTextField('entry').getText(),'Original café');
 for(let p=0;p<cases.length;p++){
  const aa=source.getPage(p).node.Annots().asArray().map(r=>source.context.lookup(r)),bb=candidate.getPage(p).node.Annots().asArray().map(r=>candidate.context.lookup(r));
  assert.equal(aa.length,bb.length);
  for(let i=0;i<aa.length;i++)for(const key of ['Rect','QuadPoints','F','Border','Path'])assert.equal(bb[i].get(n(key))?.toString(),aa[i].get(n(key))?.toString());
 }
 for(const mutation of ['quad-change','quad-removed','quad-forged-source','steal-nearby'])await t.test(`saved ${mutation} is rejected`,async()=>{
  const pdf=await PDFDocument.load(await readFile(outputPath)),proof=structuredClone(ownership),item=cases.find(c=>c.mode==='quad-0'),annotation=pdf.getPage(item.pageNumber-1).node.Annots().lookup(0);
  let expected='NATIVE_LINK_ANNOTATION_PRESERVED';
  if(mutation==='quad-change')annotation.set(n('QuadPoints'),pdf.context.obj([180,340,320,340,320,370,180,370]));
  if(mutation==='quad-removed')annotation.delete(n('QuadPoints'));
  if(mutation==='quad-forged-source'){
   const link=proof.nativeLinks.find(l=>l.pageNumber===item.pageNumber);link.ranges[0].glyphStart=0;link.anchorText='Before open café';expected='NATIVE_LINK_GLYPH_GEOMETRY';
  }
  if(mutation==='steal-nearby'){
   const multi=cases.find(c=>c.mode==='multiline'),link=proof.nativeLinks.find(l=>l.pageNumber===multi.pageNumber),nearby=proof.ranges.find(r=>r.tagNodeId===`nearby-${multi.pageNumber}`);
   link.ranges.push({streamOrigin:nearby.streamOrigin,operatorIndex:nearby.operatorIndex,glyphStart:nearby.glyphStart,glyphEnd:nearby.glyphEnd});link.anchorText+='NEARBY';expected='NATIVE_LINK_GLYPH_GEOMETRY';
  }
  const candidatePath=path.join(dir,`corrupt-${mutation}.pdf`),proofPath=path.join(dir,`corrupt-${mutation}.json`);await writeFile(candidatePath,await pdf.save());await writeFile(proofPath,JSON.stringify(proof));
  const report=await checkSavedSemantics({pdfPath:candidatePath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:proofPath});
  assert.equal(report.disposition,'rejected');assert.ok(report.checks.some(c=>c.code===expected&&c.status==='fail'),JSON.stringify(report.checks.filter(c=>c.status==='fail')));
  await writeFile(path.join(dir,`corrupt-${mutation}-saved.json`),JSON.stringify(report,null,2));
 });
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify({pdfPath,outputPath,tagsPath,semanticPath,cases,ownership,saved:saved.summary},null,2));
});
