import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {PDFDocument,PDFName,PDFArray} from 'pdf-lib';
import {parsePdf} from '../../parser/index.js';import {buildTagTree} from '../../tag-builder/index.js';import {writeTaggedArtifacts} from '../index.js';
import {checkSavedSemantics} from '../../../scripts/check-saved-semantics.js';import {resolveJavaTool,buildJavaExecEnv} from '../../../scripts/java-runtime.js';
const all=n=>[n,...n.children.flatMap(all)],key=PDFName.of;
test('caption relationships save actual images, table boundaries and source order with editable forms',async t=>{
 const dir=process.env.CAPTION_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'captions-'));await mkdir(dir,{recursive:true});if(!process.env.CAPTION_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const pdfPath=path.join(dir,'source.pdf'),semanticPath=path.join(dir,'semantic.json'),tagsPath=path.join(dir,'tagging.json'),outputPath=path.join(dir,'native.pdf');
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(name,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${name}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
 await run('CaptionFixture',pdfPath,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'));const original=await readFile(pdfPath);
 const layout=await parsePdf(pdfPath);await writeFile(path.join(dir,'layout.json'),JSON.stringify(layout));
 const nodes=[],figures=[];
 for(const page of layout.pages){
  for(const b of page.textBlocks){const n={id:`n:${b.id}`,sourceBlockId:b.id,pageNumber:page.pageNumber,role:'P',text:b.text,bbox:b.bbox,fontSize:12,confidence:1,readingOrder:nodes.length};
   const cells=page.pageNumber===1?['Item','Count','North','100']:page.pageNumber===2?['Model','Value','South','200']:[];
   const c=cells.indexOf(b.text.trim());if(c>=0)Object.assign(n,{role:c<2?'TH':'TD',tableId:`table${page.pageNumber}`,tableRowIndex:Math.floor(c/2),tableColumnIndex:c%2});
   if(/^Table \d/.test(b.text)){n.captionForId=`table${page.pageNumber}`;n.semanticRole='Caption';}
   nodes.push(n);
  }
  const images=page.figures.filter(f=>Math.abs(f.bbox[0]-72)<.5&&Math.abs(f.bbox[1]-100)<.5);assert.equal(images.length,1,JSON.stringify(page.figures));
  const caption=nodes.find(n=>n.pageNumber===page.pageNumber&&/^Figure \d/.test(n.text));assert.ok(caption);caption.semanticRole='Caption';
  figures.push({...images[0],captionNodeIds:[caption.id],status:'requires-description-review',pageNumber:page.pageNumber});delete figures.at(-1).source;delete figures.at(-1).operatorIndex;
 }
 const semantic={schemaVersion:'1.0.0',documentId:'caption-fixture',source:{layoutDocumentId:layout.documentId,filePath:pdfPath,coordinateSpace:layout.source.coordinateSpace},nodes,figures};await writeFile(semanticPath,JSON.stringify(semantic));
 const tags=await buildTagTree(semanticPath);assert.equal(tags.source.captionAssociation.associated,6,JSON.stringify(tags.source.captionAssociation));assert.deepEqual(tags.source.captionAssociation.reviews,[]);
 const imageNodes=all(tags.root).filter(n=>n.nativeFigure);assert.equal(imageNodes.length,4);assert.ok(imageNodes.every(n=>!n.alt));for(const n of imageNodes)n.alt='Two colored panels with horizontal variations: blue on the left, orange on the right.';
 await writeFile(tagsPath,JSON.stringify(tags));await writeTaggedArtifacts({pdfPath,outputPath,semanticPath,tagsPath,mode:'native'});
 const check=async(file=outputPath,source=true)=>checkSavedSemantics({pdfPath:file,tagsPath,...(source?{sourcePdfPath:pdfPath,ownershipPath:outputPath+'.ownership.json'}:{})});
 const saved=await check();await writeFile(path.join(dir,'saved.json'),JSON.stringify(saved,null,2));assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==='fail')));assert.equal(saved.ownershipStatus,'verified');assert.equal(saved.checks.filter(c=>c.code==='CAPTION_RELATION_SAVED').length,6);
 assert.match((await run('NativeOperatorProbe','pixels',pdfPath,outputPath)).stdout,/All pages pixel-identical/);
 assert.match((await run('CidMapFixture','verify',pdfPath,outputPath)).stdout,/preserved/);
 assert.deepEqual(await readFile(pdfPath),original);
 await t.test('image ownership remains unqualified without source evidence',async()=>{assert.ok((await check(outputPath,false)).checks.some(c=>c.code==='FIGURE_SOURCE_VERIFIED'&&c.status==='fail'));});
 await t.test('swapped saved Figure content rejects even when both images look identical',async()=>{
  const doc=await PDFDocument.load(await readFile(outputPath)),objects=doc.context.enumerateIndirectObjects().map(([,v])=>v),find=id=>objects.find(v=>v.get?.(key('ID'))?.decodeText?.()==='oat:'+id);
  const a=find(imageNodes[0].id),b=find(imageNodes[1].id),k=a.get(key('K'));a.set(key('K'),b.get(key('K')));b.set(key('K'),k);
  const bad=path.join(dir,'swapped-images.pdf');await writeFile(bad,await doc.save());assert.ok((await check(bad)).checks.some(c=>c.code==='FIGURE_SOURCE_OWNER'&&c.status==='fail'));
 });
 await t.test('saved table caption at the wrong boundary rejects',async()=>{
  const doc=await PDFDocument.load(await readFile(outputPath)),table=doc.context.enumerateIndirectObjects().map(([,v])=>v).find(v=>v.get?.(key('S'))===key('Table'));
  const kids=table.lookup(key('K'),PDFArray),items=kids.asArray();assert.ok(items.length>1);table.set(key('K'),doc.context.obj([...items.slice(1),items[0]]));
  const bad=path.join(dir,'wrong-caption-boundary.pdf');await writeFile(bad,await doc.save());assert.ok((await check(bad)).checks.some(c=>c.code==='CAPTION_RELATION_SAVED'&&c.status==='fail'));
 });
 await t.test('unmatched source image geometry refuses to save',async()=>{
  const bad=structuredClone(tags);all(bad.root).find(n=>n.nativeFigure).nativeFigure.bbox[0]+=20;const file=path.join(dir,'bad-geometry.json');await writeFile(file,JSON.stringify(bad));
  await assert.rejects(writeTaggedArtifacts({pdfPath,outputPath:path.join(dir,'bad.pdf'),semanticPath,tagsPath:file,mode:'native'}),/one unique image occurrence/);
 });
 for(const mode of ['duplicate','artifact-form'])await t.test(`source ${mode} image requires review before tagging`,async()=>{
  const source=path.join(dir,mode+'.pdf');await run('CaptionFixture',source,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'),mode);
  await assert.rejects(writeTaggedArtifacts({pdfPath:source,outputPath:path.join(dir,mode+'-bad.pdf'),semanticPath,tagsPath,mode:'native'}),mode==='duplicate'?/one unique image occurrence/:/unprotected image XObject/);
 });
 await t.test('raster mode refuses to silently discard native image ownership',async()=>{await assert.rejects(writeTaggedArtifacts({pdfPath,outputPath:path.join(dir,'raster.pdf'),semanticPath,tagsPath,mode:'raster'}),/requires native writer mode/);});
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify({pdfPath,outputPath,semanticPath,tagsPath,saved:saved.summary,figures:4,captionRelationships:6,nativePixelMatch:true,fillSaveReopen:true},null,2));
});
