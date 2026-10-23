import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,PDFName,PDFString,decodePDFRawStream} from 'pdf-lib';
import {writeTaggedArtifacts} from '../index.js';
import {checkSavedSemantics} from '../../../scripts/check-saved-semantics.js';
import {resolveJavaTool,buildJavaExecEnv} from '../../../scripts/java-runtime.js';
const n=PDFName.of;

test('native links own exact source anchors and retain annotations and editable controls',async t=>{
 const dir=process.env.NATIVE_LINK_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'native-links-'));await mkdir(dir,{recursive:true});
 if(!process.env.NATIVE_LINK_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const fixture=(name,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${name}.java`),...args],{env,windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
 await fixture('NativeLinkFixture',dir,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'));
 const evidence=[];
 for(const mode of ['partial','operators','array','simple','nested','destination','authored-contents','appearance','two-links','overlap','no-anchor','hidden','quad-review','shared','two-nodes','existing-link','existing-link-boundary','generated-text','differing-text','ancestor-text','authored-scope'])await t.test(mode,async()=>{
  const pdfPath=path.join(dir,`${mode}.pdf`),outputPath=path.join(dir,`${mode}-tagged.pdf`),tagsPath=path.join(dir,`${mode}-tags.json`),semanticPath=path.join(dir,`${mode}-semantic.json`);
  const texts=mode==='two-nodes'?['Before open','café after']:[mode==='existing-link'?'open café':mode==='nested'?'Before open café after Before open café after':'Before open café after'];
  const nodes=texts.map((text,i)=>({id:`body-${i}`,sourceBlockId:`body-${i}`,pageNumber:1,role:'P',text,bbox:[72+i*62,80,300,mode==='nested'?130:20],confidence:1,readingOrder:i}));
  await writeFile(semanticPath,JSON.stringify({schemaVersion:'1.0.0',documentId:'links',source:{layoutDocumentId:'links'},nodes}));
  const tags={schemaVersion:'1.0.0',documentId:'link-tags',source:{semanticDocumentId:'links'},root:{id:'root',type:'Document',children:nodes.map(o=>({id:o.id,type:mode.startsWith('existing-link')?'Link':'P',sourceNodeIds:[o.id],label:o.text,children:[]}))}};
  if(mode==='generated-text')tags.root.children[0].actualText=texts[0];
  if(mode==='differing-text')tags.root.children[0].actualText='Before  open café after';
  if(mode==='ancestor-text')tags.root.actualText=texts[0];
  await writeFile(tagsPath,JSON.stringify(tags));
  const before=await readFile(pdfPath);
  if(mode==='shared'){await assert.rejects(writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:'native'}),/repeated in page arrays/);assert.deepEqual(await readFile(pdfPath),before);return;}
  await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:'native'});
  assert.deepEqual(await readFile(pdfPath),before);
  const ownership=JSON.parse(await readFile(`${outputPath}.ownership.json`)),bound=ownership.nativeLinks.filter(l=>l.status==='bound');
  const positive=!['overlap','no-anchor','hidden','quad-review','two-nodes','existing-link-boundary','differing-text','ancestor-text','authored-scope'].includes(mode);
  assert.equal(bound.length,positive?(mode==='two-links'?2:1):0,JSON.stringify(ownership.nativeLinks));
  if(positive){assert.equal(bound[0].anchorText,'open café');assert.ok(bound[0].ranges.length);}
  if(mode==='generated-text')assert.equal(bound[0].suppressedRedundantActualText,true);
  const a=await PDFDocument.load(before),b=await PDFDocument.load(await readFile(outputPath));
  assert.equal(b.getForm().getTextField('entry').getText(),'Original café');
  const annotations=doc=>doc.getPage(0).node.Annots().asArray().map(ref=>doc.context.lookup(ref));
  const aa=annotations(a),bb=annotations(b);assert.equal(aa.length,bb.length);
  for(let i=0;i<aa.length;i++){
   for(const key of ['Rect','F','Border','BS','H','QuadPoints'])assert.equal(bb[i].get(n(key))?.toString(),aa[i].get(n(key))?.toString(),`${mode}:${key}`);
   if(aa[i].has(n('A')))assert.equal(bb[i].lookup(n('A')).get(n('URI'))?.decodeText(),aa[i].lookup(n('A')).get(n('URI'))?.decodeText());
   if(aa[i].has(n('Contents')))assert.equal(bb[i].get(n('Contents')).decodeText(),aa[i].get(n('Contents')).decodeText());
   if(aa[i].has(n('AP'))){const ap=o=>decodePDFRawStream(o.lookup(n('AP')).lookup(n('N'))).decode();assert.deepEqual(ap(aa[i]),ap(bb[i]));}
  }
  const report=await checkSavedSemantics({pdfPath:outputPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:`${outputPath}.ownership.json`});
  assert.equal(report.summary.failed,0,JSON.stringify(report.checks.filter(c=>c.status==='fail')));
  assert.equal(report.ownershipStatus,'verified');
  if(positive)assert.ok(report.checks.some(c=>c.code==='NATIVE_LINK_EXACT_GLYPHS'&&c.status==='pass'));
  assert.match((await fixture('CidMapFixture','verify',pdfPath,outputPath)).stdout,/preserved/);
  await writeFile(path.join(dir,`${mode}-saved-proof.json`),JSON.stringify(report,null,2));
  evidence.push({mode,pdfPath,outputPath,tagsPath,semanticPath,ownership,savedChecks:report.summary});
 });
 for(const mutation of ['uri','rectangle','parent-key','parent-tree-array','object-reference','empty-replacement','steal-prefix','forged-prefix-proof','missing-proof','duplicate-proof','wrong-source-reference','stale-range','page-rotation','authored-contents','destination','forged-redundant-proof','ancestor-replacement'])await t.test(`saved ${mutation} corruption is rejected`,async()=>{
  const mode=['authored-contents','destination'].includes(mutation)?mutation:'partial',original=evidence.find(e=>e.mode===mode);
  assert.ok(original,`positive ${mode} evidence is required`);
  const pdf=await PDFDocument.load(await readFile(original.outputPath)),proof=structuredClone(original.ownership);
  const [linkRef,link]=pdf.context.enumerateIndirectObjects().find(([,o])=>o.get?.(n('ID'))?.decodeText?.()===proof.nativeLinks[0].linkStructureId);
  const annotation=pdf.getPage(0).node.Annots().lookup(0),root=pdf.catalog.lookup(n('StructTreeRoot'));
  const kids=link.lookup(n('K'));
  let expectedCode;
  switch(mutation){
   case 'uri':annotation.lookup(n('A')).set(n('URI'),PDFString.of('https://www.nasa.gov/'));expectedCode='NATIVE_LINK_ANNOTATION_PRESERVED';break;
   case 'rectangle':annotation.set(n('Rect'),pdf.context.obj([10,10,30,30]));expectedCode='NATIVE_LINK_ANNOTATION_PRESERVED';break;
   case 'parent-key':annotation.set(n('StructParent'),pdf.context.obj(99999));expectedCode='NATIVE_LINK_PARENT_KEY';break;
   case 'parent-tree-array':{const nums=root.lookup(n('ParentTree')).lookup(n('Nums'));for(let i=0;i<nums.size();i+=2)if(nums.lookup(i).asNumber()===proof.nativeLinks[0].parentTreeKey)nums.set(i+1,pdf.context.obj([linkRef]));expectedCode='STRUCTURE_INTEGRITY';break;}
   case 'object-reference':for(let i=0;i<kids.size();i++)if(kids.lookup(i).get(n('Type'))?.toString()==='/OBJR'){kids.remove(i);break;}expectedCode='NATIVE_LINK_OBJECT_REFERENCE';break;
   case 'empty-replacement':link.set(n('ActualText'),PDFString.of(''));expectedCode='NATIVE_LINK_REPLACEMENT';break;
   case 'steal-prefix':case 'forged-prefix-proof':{
    const parent=pdf.context.lookup(link.get(n('P'))),parentKids=parent.lookup(n('K')),prefix=parentKids.get(0),prefixDict=pdf.context.lookup(prefix);
    assert.equal(prefixDict.get(n('Type')).toString(),'/MCR');parentKids.remove(0);kids.insert(0,prefix);
    const nums=root.lookup(n('ParentTree')).lookup(n('Nums')),pageKey=pdf.getPage(0).node.get(n('StructParents')).asNumber();
    for(let i=0;i<nums.size();i+=2)if(nums.lookup(i).asNumber()===pageKey)nums.lookup(i+1).set(prefixDict.get(n('MCID')).asNumber(),linkRef);
    expectedCode='NATIVE_LINK_EXACT_GLYPHS';
    if(mutation==='forged-prefix-proof'){proof.nativeLinks[0].ranges[0].glyphStart=0;proof.nativeLinks[0].anchorText='Before open café';expectedCode='NATIVE_LINK_GLYPH_GEOMETRY';}
    break;
   }
   case 'missing-proof':delete proof.nativeLinks;expectedCode='SOURCE_PAINT_OWNER';break;
   case 'duplicate-proof':proof.nativeLinks.push(structuredClone(proof.nativeLinks[0]));expectedCode='NATIVE_LINK_UNIQUE_DECLARATION';break;
   case 'wrong-source-reference':proof.nativeLinks[0].sourceAnnotationRef='999999 0 R';expectedCode='NATIVE_LINK_DECLARED_SOURCE';break;
   case 'stale-range':proof.nativeLinks[0].ranges[0].glyphEnd=999;expectedCode='NATIVE_LINK_SOURCE_RANGE';break;
   case 'page-rotation':pdf.getPage(0).node.set(n('Rotate'),pdf.context.obj(90));expectedCode='NATIVE_LINK_DOCUMENT_GEOMETRY';break;
   case 'authored-contents':annotation.set(n('Contents'),PDFString.of('Changed authored description'));expectedCode='NATIVE_LINK_AUTHORED_CONTENTS';break;
   case 'destination':annotation.lookup(n('Dest')).set(0,pdf.getPage(1).ref);expectedCode='NATIVE_LINK_ANNOTATION_PRESERVED';break;
   case 'forged-redundant-proof':proof.nativeLinks[0].suppressedRedundantActualText=true;expectedCode='NATIVE_LINK_REDUNDANT_REPLACEMENT';break;
   case 'ancestor-replacement':pdf.context.lookup(link.get(n('P'))).set(n('ActualText'),PDFString.of('Before open café after'));expectedCode='NATIVE_LINK_ANCESTOR_REPLACEMENT';break;
  }
  const pdfPath=path.join(dir,`corrupt-${mutation}.pdf`),ownershipPath=path.join(dir,`corrupt-${mutation}.json`);await writeFile(pdfPath,await pdf.save());await writeFile(ownershipPath,JSON.stringify(proof));
  const report=await checkSavedSemantics({pdfPath,tagsPath:original.tagsPath,sourcePdfPath:original.pdfPath,ownershipPath});
  assert.equal(report.disposition,'rejected');assert.ok(report.checks.some(c=>c.code===expectedCode&&c.status==='fail'),JSON.stringify(report.checks.filter(c=>c.status==='fail')));
  await writeFile(path.join(dir,`corrupt-${mutation}-saved-proof.json`),JSON.stringify(report,null,2));
 });
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));
});
