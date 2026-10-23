import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {PDFDocument,PDFName} from 'pdf-lib';
import {parsePdf} from '../../parser/index.js';
import {analyzeLayout} from '../../layout-analyzer/index.js';
import {buildSemanticDocument} from '../../semantic-engine/index.js';
import {mergeWithStrategy} from '../../paragraph-merger/index.js';
import {assignReadingOrder} from '../../reading-order/index.js';
import {buildTagTree} from '../../tag-builder/index.js';
import {writeTaggedArtifacts} from '../index.js';
import {buildTableStructureMap} from '../../../scripts/build-table-structure-map.js';
import {checkSavedSemantics} from '../../../scripts/check-saved-semantics.js';
import {resolveJavaTool,buildJavaExecEnv} from '../../../scripts/java-runtime.js';
const all=n=>[n,...n.children.flatMap(all)],key=PDFName.of;
test('diagram discrimination preserves label ownership, genuine tables and editable forms through saved output',async t=>{
 const dir=process.env.DIAGRAM_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'diagram-'));await mkdir(dir,{recursive:true});if(!process.env.DIAGRAM_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const pdfPath=path.join(dir,'source.pdf'),rawPath=path.join(dir,'raw-layout.json'),layoutPath=path.join(dir,'layout.json'),mapPath=path.join(dir,'table-map.json'),semanticPath=path.join(dir,'semantic.json'),tagsPath=path.join(dir,'tagging.json');
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(name,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${name}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
 await run('DiagramFixture',pdfPath,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'));const before=await readFile(pdfPath);
 await writeFile(rawPath,JSON.stringify(await parsePdf(pdfPath)));const map=await buildTableStructureMap({pdfPath,layoutPath:rawPath,outputPath:mapPath});assert.equal(map.pages[0].graphicEvidence.obliqueSegments.length,4);assert.equal(map.pages[1].graphicEvidence.obliqueSegments.length,0);
 const layout=await analyzeLayout(rawPath,{tableStructurePath:mapPath});await writeFile(layoutPath,JSON.stringify(layout));assert.equal(layout.pages[0].diagramRegions.length,1);assert.equal(layout.pages[0].diagramRegions[0].blockIds.length,8);assert.equal(layout.pages[0].structureSignals.tableCount,0);assert.equal(layout.pages[1].structureSignals.tableCount,1);
 const semantic=await buildSemanticDocument(layoutPath),labels=semantic.nodes.filter(n=>n.diagramRegionId);assert.equal(labels.length,8);assert.deepEqual(labels.map(n=>n.text),Array.from({length:8},(_,i)=>`Component ${i}`));assert.ok(labels.every(n=>n.role==='P'&&!n.tableId&&!n.blockQuoteGroupId));assert.equal(semantic.semanticReviewTasks.filter(t=>t.code==='DIAGRAM_DESCRIPTION_AND_ORDER_REQUIRED').length,1);
 for(const strategy of ['text-structure','pairwise']){const merged=mergeWithStrategy(semantic,{strategy}).document;assert.deepEqual(merged.nodes.filter(n=>n.diagramRegionId).map(n=>[n.id,n.text]),labels.map(n=>[n.id,n.text]));}
 await writeFile(semanticPath,JSON.stringify(mergeWithStrategy(semantic,{strategy:'text-structure'}).document));await writeFile(semanticPath,JSON.stringify(await assignReadingOrder(semanticPath)));const tags=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tags));
 const sections=all(tags.root).filter(n=>n.id.startsWith('tag:diagram:'));assert.equal(sections.length,1);assert.equal(sections[0].type,'Sect');assert.deepEqual(sections[0].children.map(n=>n.label),labels.map(n=>n.text));assert.equal(all(tags.root).filter(n=>n.type==='Table').length,1);assert.ok(!all(sections[0]).some(n=>n.label?.startsWith('Ordinary')));
 const cases=[];
 for(const mode of ['native','raster'])await t.test(`${mode} saves diagram text and independent table roles`,async()=>{
  const outputPath=path.join(dir,`${mode}.pdf`);await writeTaggedArtifacts({pdfPath,outputPath,semanticPath,tagsPath,mode});const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,outputPath:path.join(dir,`${mode}-saved.json`),...(mode==='native'?{sourcePdfPath:pdfPath,ownershipPath:outputPath+'.ownership.json'}:{})});assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==='fail')));if(mode==='native')assert.match((await run('CidMapFixture','verify',pdfPath,outputPath)).stdout,/preserved/);cases.push({mode,outputPath,saved:saved.summary});assert.deepEqual(await readFile(pdfPath),before);
 });
 await t.test('saved diagram-to-table corruption rejects',async()=>{
  const doc=await PDFDocument.load(await readFile(path.join(dir,'native.pdf'))),section=doc.context.enumerateIndirectObjects().map(([,v])=>v).find(v=>v.get?.(key('ID'))?.decodeText?.()==='oat:'+sections[0].id);assert.ok(section);section.set(key('S'),key('Table'));const bad=path.join(dir,'bad-role.pdf');await writeFile(bad,await doc.save());const saved=await checkSavedSemantics({pdfPath:bad,tagsPath,outputPath:path.join(dir,'bad-role.json')});assert.ok(saved.checks.some(c=>c.code==='SAVED_ROLE'&&c.status==='fail'));
 });
 await t.test('excessive connector evidence declines inference without partial geometry',async()=>{
  const doc=await PDFDocument.load(before),page=doc.getPage(0);for(let i=0;i<4097;i++)page.drawLine({start:{x:120,y:660},end:{x:400,y:590},thickness:1});const stress=path.join(dir,'connector-limit.pdf');await writeFile(stress,await doc.save());
  const limited=await buildTableStructureMap({pdfPath:stress,layoutPath:rawPath});assert.equal(limited.pages[0].graphicEvidence.status,'limit-exceeded');assert.deepEqual(limited.pages[0].graphicEvidence.obliqueSegments,[]);assert.deepEqual(limited.pages[1].tables,map.pages[1].tables);
 });
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify({pdfPath,rawPath,layoutPath,mapPath,semanticPath,tagsPath,diagramLabels:labels.map(n=>({id:n.id,text:n.text})),cases,nativeFillSaveReopen:true},null,2));
});
