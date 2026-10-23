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

test('native wrapped anchors group complete inline siblings and preserve their identities',async t=>{
 const dir=process.env.NATIVE_LINK_GROUP_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'link-groups-'));await mkdir(dir,{recursive:true});
 if(!process.env.NATIVE_LINK_GROUP_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(fixture,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${fixture}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:16*1024*1024});
 await run('NativeLinkGroupFixture',dir,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'));
 const cases=JSON.parse(await readFile(path.join(dir,'cases.json'))),pdfPath=path.join(dir,'source.pdf'),outputPath=path.join(dir,'candidate.pdf'),tagsPath=path.join(dir,'tags.json'),semanticPath=path.join(dir,'semantic.json');
 const nodes=[],parents=[];
 for(const item of cases){
  const runs=item.runs.map((run,i)=>({id:`run-${item.pageNumber}-${i}`,sourceBlockId:`run-${item.pageNumber}-${i}`,pageNumber:item.pageNumber,role:'P',...run,confidence:1,readingOrder:nodes.length+i}));
  const spans=runs.map(r=>({id:r.id,type:'Span',sourceNodeIds:[r.id],label:r.text,children:[]}));
  const parent={id:`body-${item.pageNumber}`,type:'P',children:spans.slice(0,4)};
  if(item.mode==='generated-text')for(const span of spans)span.actualText=span.label;
  if(item.mode==='mixed-language'){spans[1].lang='en-US';spans[2].lang='fr';}
  if(item.mode==='separate-paragraphs')for(const span of spans)span.type='P';
  if(item.mode==='intervening-sibling')parent.children=[spans[0],spans[1],spans[4],spans[2],spans[3]];
  if(item.mode==='different-parents')parent.children=[{id:`first-${item.pageNumber}`,type:'P',children:spans.slice(0,2)},{id:`last-${item.pageNumber}`,type:'P',children:spans.slice(2,4)}];
  if(item.mode==='partial-span'){
   const joined={...runs[0],text:runs[0].text+runs[1].text,bbox:[72,780-700,100,14]};
   runs.splice(0,2,joined);spans[0].label=joined.text;parent.children=[spans[0],spans[2],spans[3]];
  }
  if(item.mode==='differing-text')spans[1].actualText='open  ';
  if(item.mode==='ancestor-text')parent.actualText='Before open café after';
  if(item.mode==='alternate-text')spans[1].alt='Alternate anchor';
  if(item.mode==='nested-span')parent.children=[spans[0],{id:`nested-${item.pageNumber}`,type:'Span',children:[spans[1]]},spans[2],spans[3]];
  nodes.push(...runs);parents.push(parent);
  if(item.mode!=='intervening-sibling')parents.push({id:`nearby-${item.pageNumber}`,type:'P',children:[spans[4]]});
 }
 await writeFile(semanticPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'groups',source:{layoutDocumentId:'groups',coordinateSpace:'crop-display-points'},nodes}));
 await writeFile(tagsPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'group-tags',source:{semanticDocumentId:'groups'},root:{id:'root',type:'Document',children:parents}}));
 const before=await readFile(pdfPath);await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:'native'});assert.deepEqual(await readFile(pdfPath),before);
 const ownership=JSON.parse(await readFile(`${outputPath}.ownership.json`));
 for(const item of cases)await t.test(item.mode,()=>{
  const links=ownership.nativeLinks.filter(l=>l.pageNumber===item.pageNumber),bound=links.filter(l=>l.status==='bound');
  assert.equal(bound.length,item.positive?(item.mode==='two-groups'?2:1):0,JSON.stringify(links));
  for(const link of bound){assert.equal(link.ownerTagId,`body-${item.pageNumber}`);assert.equal(link.groupedOwnerTagIds.length,2);assert.equal(link.ranges.length,2);}
  if(item.positive&&item.mode!=='two-groups')assert.equal(bound[0].anchorText,'open café');
 });
 const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:`${outputPath}.ownership.json`,outputPath:path.join(dir,'saved.json')});
 const expectedFailures=saved.checks.filter(c=>c.status==='fail');
 assert.deepEqual(expectedFailures,[]);
 assert.equal(saved.ownershipStatus,'verified');
 const candidate=await PDFDocument.load(await readFile(outputPath));
 const byId=id=>candidate.context.enumerateIndirectObjects().find(([,o])=>o.get?.(PDFName.of('ID'))?.decodeText?.()===id)?.[1];
 assert.equal(byId('oat:run-5-1').get(PDFName.of('Lang')).decodeText(),'en-US');
 assert.equal(byId('oat:run-5-2').get(PDFName.of('Lang')).decodeText(),'fr');
 assert.equal(byId('oat:run-4-1').get(PDFName.of('ActualText')).decodeText(),'open ');
 assert.equal(candidate.getForm().getTextField('entry').getText(),'Original café');
 assert.match((await run('CidMapFixture','verify',pdfPath,outputPath)).stdout,/preserved/);
 const resavedPath=path.join(dir,'resaved.pdf');await run('NativeLinkGroupFixture','mutate',outputPath,resavedPath,'none');
 const resaved=await checkSavedSemantics({pdfPath:resavedPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:`${outputPath}.ownership.json`});assert.equal(resaved.summary.failed,0);
 for(const mutation of ['child-order','steal-neighbor','wrong-parent','missing-group-proof','forged-members','forged-range-order','group-replacement','extra-content','member-replacement','member-role'])await t.test(`saved ${mutation} is rejected`,async()=>{
  const proof=structuredClone(ownership),declaration=proof.nativeLinks.find(l=>l.pageNumber===1);
  let code='NATIVE_LINK_CHILDREN';
  if(mutation==='wrong-parent')code='STRUCTURE_INTEGRITY';
  if(mutation==='missing-group-proof')delete declaration.groupedOwnerTagIds;
  if(mutation==='forged-members'){declaration.groupedOwnerTagIds.reverse();code='NATIVE_LINK_GROUP_SIBLINGS';}
  if(mutation==='forged-range-order'){declaration.ranges.reverse();declaration.anchorText='caféopen ';code='NATIVE_LINK_GROUP_SOURCE_ORDER';}
  if(mutation==='group-replacement')code='NATIVE_LINK_REPLACEMENT';
  if(mutation==='extra-content')code='NATIVE_LINK_GROUP_CONTENT';
  if(['member-replacement','member-role'].includes(mutation))code='NATIVE_LINK_GROUP_MEMBER';
  const candidatePath=path.join(dir,`corrupt-${mutation}.pdf`),proofPath=path.join(dir,`corrupt-${mutation}.json`);await run('NativeLinkGroupFixture','mutate',outputPath,candidatePath,mutation);await writeFile(proofPath,JSON.stringify(proof));
  const report=await checkSavedSemantics({pdfPath:candidatePath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:proofPath});
  assert.equal(report.disposition,'rejected');assert.ok(report.checks.some(c=>c.code===code&&c.status==='fail'),JSON.stringify(report.checks.filter(c=>c.status==='fail')));
  await writeFile(path.join(dir,`corrupt-${mutation}-saved.json`),JSON.stringify(report,null,2));
 });
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify({pdfPath,outputPath,tagsPath,semanticPath,cases,ownership,saved:saved.summary,expectedFailures},null,2));
});
