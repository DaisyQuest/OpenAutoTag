import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {applyReviewedOutline} from '../reviewed-outline.js';
import {writeTaggedArtifacts} from '../index.js';
import {inspectPdfLowLevel} from '../../../scripts/inspect-pdf-low-level.js';
import {checkPdfPreservation} from '../../../scripts/check-pdf-preservation.js';
import {checkSavedSemantics} from '../../../scripts/check-saved-semantics.js';
import {resolveJavaTool,buildJavaExecEnv} from '../../../scripts/java-runtime.js';
const sha=b=>createHash('sha256').update(b).digest('hex');

test('reviewed outlines round-trip Unicode hierarchy and retain authored navigation and editable controls',async t=>{
 const dir=process.env.NAVIGATION_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'navigation-'));await mkdir(dir,{recursive:true});if(!process.env.NAVIGATION_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(fixture,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${fixture}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
 const rawPath=path.join(dir,'raw.pdf'),sourcePdf=path.join(dir,'source.pdf'),outputPdf=path.join(dir,'candidate.pdf'),reviewPath=path.join(dir,'review.json'),tagsPath=path.join(dir,'tags.json'),semanticPath=path.join(dir,'semantic.json');
 await run('NavigationFixture','create',rawPath,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'),'mixed');
 const nodes=Array.from({length:6},(_,i)=>({id:`body-${i+1}`,sourceBlockId:`body-${i+1}`,pageNumber:i+1,role:'P',text:`Navigation page ${i+1}`,bbox:[72,80,200,16],confidence:1,readingOrder:i}));
 await writeFile(semanticPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'nav',source:{layoutDocumentId:'nav'},nodes}));
 await writeFile(tagsPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'nav-tags',source:{semanticDocumentId:'nav'},root:{id:'root',type:'Document',children:nodes.map(n=>({id:n.id,type:'P',sourceNodeIds:[n.id],label:n.text,children:[]}))}}));
 await writeTaggedArtifacts({pdfPath:rawPath,outputPath:sourcePdf,tagsPath,semanticPath,mode:'native'});
 const original=await readFile(sourcePdf),source=await inspectPdfLowLevel({pdfPath:sourcePdf,preservation:true});
 assert.deepEqual(source.navigation.pageLabels.labels,['i','ii','Sec-1','Sec-2','AA','BB']);assert.deepEqual(source.navigation.issues,[]);
 assert.deepEqual((await inspectPdfLowLevel({pdfPath:rawPath,preservation:true})).navigation,source.navigation);
 const leaf=(id,title,pageNumber,children=[],open=false)=>({id,title,pageNumber,children,open});
 const review={schemaVersion:'1.0.0',sourceHash:sha(original),decision:'accepted',reviewer:'Automated fixture reviewer',evidence:'Explicit test outline; not a human review of a production document.',bookmarks:[leaf('main','Résumé – navigation 🚀',1,[leaf('one','Café and forms',2),leaf('two','Supplement 漢字',4,[leaf('last','Appendix',6)],true)],true),leaf('end','Closing remarks',6,[leaf('closed-child','Closed branch child',5)])]};
 await writeFile(reviewPath,JSON.stringify(review));const report=await applyReviewedOutline({sourcePdf,outputPdf,reviewPath});
 assert.equal(report.addedBookmarks,6);assert.deepEqual(await readFile(sourcePdf),original);assert.ok((await readFile(outputPdf)).subarray(0,original.length).equals(original));
 assert.deepEqual(await applyReviewedOutline({sourcePdf,candidatePdf:outputPdf,reviewPath}),report);
 const candidate=await inspectPdfLowLevel({pdfPath:outputPdf,preservation:true});assert.deepEqual(candidate.navigation.issues,[]);
 assert.deepEqual(candidate.navigation.pageLabels,source.navigation.pageLabels);assert.equal(candidate.navigation.namedDestinationsHash,source.navigation.namedDestinationsHash);
 assert.deepEqual(candidate.navigation.outlines.items.slice(0,2),source.navigation.outlines.items);
 const summary=nodes=>nodes.map(n=>({title:n.title,pageNumber:n.destination.pageNumber,open:n.children.length?n.count>0:false,children:summary(n.children)}));
 const expected=nodes=>nodes.map(n=>({title:n.title,pageNumber:n.pageNumber,open:n.children.length?n.open:false,children:expected(n.children)}));
 assert.deepEqual(summary(candidate.navigation.outlines.items.slice(2)),expected(review.bookmarks));
 assert.match((await run('CidMapFixture','verify',sourcePdf,outputPdf)).stdout,/preserved/);
 await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));await writeFile(path.join(dir,'source-inspection.json'),JSON.stringify(source,null,2));await writeFile(path.join(dir,'candidate-inspection.json'),JSON.stringify(candidate,null,2));
 const validationPath=path.join(dir,'validation-stub.json');const validation=async pdf=>writeFile(validationPath,JSON.stringify({status:'completed',pdfSha256:sha(await readFile(pdf)),isCompliant:true,overall:{status:'pass'},findings:[],fontAudit:{status:'ok'}}));
 // The stub isolates the preservation gate; real veraPDF validation is recorded separately.
 await validation(outputPdf);const gate={sourcePdf,candidatePdf:outputPdf,validationReport:validationPath,outputPath:path.join(dir,'quality.json')};
 assert.equal((await checkPdfPreservation(gate)).disposition,'rejected');assert.ok((await checkPdfPreservation({...gate,outlineReviewPath:reviewPath})).checks.every(c=>c.status==='pass'));
 for(const mutation of ['title','destination','remote-destination','named-destination','parent','cycle','count','reviewed-title','label-prefix','label-start','label-style','label-remove','label-cycle','label-zero','label-limits','label-kid-order','field'])await t.test(`saved ${mutation} change cannot qualify`,async()=>{
  const target=path.join(dir,`corrupt-${mutation}.pdf`);await run('NavigationFixture','mutate',outputPdf,target,mutation);
  await assert.rejects(applyReviewedOutline({sourcePdf,candidatePdf:target,reviewPath}),/Unexpected saved-object change/);
  await validation(target);const result=await checkPdfPreservation({...gate,candidatePdf:target,outputPath:path.join(dir,`quality-${mutation}.json`)});
  assert.ok(['error','rejected'].includes(result.disposition));
  if(!['cycle','label-cycle','label-zero','label-limits','label-kid-order','field'].includes(mutation))assert.ok(result.findings.some(f=>/OUTLINE_CHANGED|DESTINATIONS_CHANGED|PAGE_LABELS_CHANGED|NAVIGATION_REGRESSION/.test(f.code)),JSON.stringify(result.findings));
 });
 for(const change of ['stale','unaccepted','duplicate','bad-page','blank','surrogate','too-deep'])await t.test(`review ${change} rejects before creating output`,async()=>{
  const bad=structuredClone(review);if(change==='stale')bad.sourceHash='0'.repeat(64);if(change==='unaccepted')bad.decision='pending';if(change==='duplicate')bad.bookmarks[1].id='main';if(change==='bad-page')bad.bookmarks[0].pageNumber=99;if(change==='blank')bad.bookmarks[0].title=' ';if(change==='surrogate')bad.bookmarks[0].title='\ud800';
  if(change==='too-deep'){let n=bad.bookmarks[0];for(let i=0;i<34;i++){n.children=[leaf(`deep-${i}`,'Deep',1)];n=n.children[0];}}
  const reviewFile=path.join(dir,`review-${change}.json`),target=path.join(dir,`invalid-${change}.pdf`);await writeFile(reviewFile,JSON.stringify(bad));await assert.rejects(applyReviewedOutline({sourcePdf,outputPdf:target,reviewPath:reviewFile}));await assert.rejects(access(target));
 });
 await t.test('source/input aliases and existing output reject',async()=>{await assert.rejects(applyReviewedOutline({sourcePdf,outputPdf:sourcePdf,reviewPath}),/overwrite/);await assert.rejects(applyReviewedOutline({sourcePdf,outputPdf:reviewPath,reviewPath}),/overwrite/);await assert.rejects(applyReviewedOutline({sourcePdf,outputPdf,reviewPath}),/overwrite/);});
 for(const style of ['absent','prefix','R','a'])await t.test(`page labels ${style} preserve exact meaning`,async()=>{
  const file=path.join(dir,`labels-${style}.pdf`);await run('NavigationFixture','create',file,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'),style);
  const d=await inspectPdfLowLevel({pdfPath:file,preservation:true});const labels=style==='absent'?['1','2','3','4','5','6']:style==='prefix'?Array(6).fill('Appendix'):style==='R'?['I','II','III','IV','V','VI']:['a','b','c','d','e','f'];assert.deepEqual(d.navigation.pageLabels.labels,labels);
 });
 for(const mode of ['fresh','empty-outline'])await t.test(`accepted outline creates a ${mode} hierarchy`,async()=>{
  const file=path.join(dir,`${mode}.pdf`),target=path.join(dir,`${mode}-candidate.pdf`),reviewFile=path.join(dir,`${mode}-review.json`);
  await run('NavigationFixture','create',file,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'),mode);
  const decision={...review,sourceHash:sha(await readFile(file))};await writeFile(reviewFile,JSON.stringify(decision));
  const proof=await applyReviewedOutline({sourcePdf:file,outputPdf:target,reviewPath:reviewFile});assert.equal(proof.addedBookmarks,6);
  const inspected=await inspectPdfLowLevel({pdfPath:target,preservation:true});assert.deepEqual(summary(inspected.navigation.outlines.items),expected(review.bookmarks));assert.deepEqual(inspected.navigation.issues,[]);
  assert.match((await run('CidMapFixture','verify',file,target)).stdout,/preserved/);
 });
 for(const mode of ['parent','cycle','count'])await t.test(`inconsistent source outline ${mode} cannot be extended`,async()=>{
  const file=path.join(dir,`corrupt-${mode}.pdf`),target=path.join(dir,`refused-${mode}.pdf`),reviewFile=path.join(dir,`source-${mode}-review.json`);
  await writeFile(reviewFile,JSON.stringify({...review,sourceHash:sha(await readFile(file))}));
  await assert.rejects(applyReviewedOutline({sourcePdf:file,outputPdf:target,reviewPath:reviewFile}),/existing outline/);await assert.rejects(access(target));
 });
 const saved=await checkSavedSemantics({pdfPath:sourcePdf,tagsPath,sourcePdfPath:rawPath,ownershipPath:`${sourcePdf}.ownership.json`,outputPath:path.join(dir,'saved-native.json')});assert.equal(saved.summary.failed,0);
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify({rawPath,sourcePdf,outputPdf,tagsPath,semanticPath,reviewPath,sourceHash:sha(original),candidateHash:sha(await readFile(outputPdf)),report,saved:saved.summary},null,2));
});
