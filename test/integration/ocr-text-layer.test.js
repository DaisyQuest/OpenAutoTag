import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,writeFile,access} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {parsePdf} from "../../modules/parser/index.js";
import {buildSemanticDocument} from "../../modules/semantic-engine/index.js";
import {buildTagTree} from "../../modules/tag-builder/index.js";
import {writeTaggedArtifacts} from "../../modules/pdf-writer/index.js";
import {checkSavedSemantics} from "../../scripts/check-saved-semantics.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../scripts/java-runtime.js";

test("saved invisible OCR preserves scans, native glyphs and editable fields across display geometries",async t=>{
 const dir=process.env.OCR_LAYER_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),"ocr-layer-"));await mkdir(dir,{recursive:true});
 if(!process.env.OCR_LAYER_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const jar=path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),font=path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf");
 const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(probe,args)=>promisify(execFile)(java,["-cp",jar,path.resolve(probe),...args],{env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
 const probe="modules/pdf-writer/test/fixtures/OcrLayerProbe.java";
 await run("modules/parser/test/fixtures/OcrGeometryProbe.java",["create",dir]);
 const source=path.join(dir,"source.pdf"),mixed=path.join(dir,"mixed.pdf"),oracle=JSON.parse(await readFile(path.join(dir,"oracle.json")));
 await run(probe,["mixed",source,mixed,font]);
 const results=[];
 for(const [name,pdfPath] of [["scan",source],["mixed",mixed]]) {
   const hash=async()=>createHash("sha256").update(await readFile(pdfPath)).digest("hex"),before=await hash();
   const nodes=oracle.map(({pageNumber,bbox})=>{
     const [x,y,w,h]=bbox,quad=[x,y,x+w,y,x+w,y+h,x,y+h];
     const sourceBlockId=`scan-${pageNumber}`,text="IMAGE TEXT 123";
     return {id:sourceBlockId,sourceBlockId,pageNumber,role:"P",text,bbox,confidence:1,fontName:"OCR",fontSize:h,textProvenance:"ocr",
       ocrSegments:[{sourceBlockId,text,confidence:100,geometry:{coordinateSpace:"crop-display-points",imageSize:[720,480],recognitionRotationRadians:0,pixelBox:[x*2,y*2,(x+w)*2,(y+h)*2],pixelToDisplay:[.5,0,0,.5,0,0],quad,clipped:false}}]};
   });
   if(name==="mixed") {
     const layout=await parsePdf(pdfPath,{ocr:{mode:"off"}});
     const b=layout.pages[0].textBlocks.find(b=>b.text==="Native words stay once");assert.ok(b);
     nodes.push({id:"native",sourceBlockId:"native",pageNumber:1,role:"P",text:b.text,bbox:b.bbox,fontSize:b.fontSize,fontName:b.fontName,textProvenance:"native",confidence:1});
     await t.test("small OCR additions retain native text and carry overlap conflicts into semantic review",async()=>{
       const recognized={id:"recognized",text:"IMAGE TEXT 123",bbox:nodes[0].bbox,fontSize:nodes[0].fontSize,fontName:"OCR",ocrGeometry:nodes[0].ocrSegments[0].geometry,ocrConfidence:100};
       const duplicates=[{...b,id:"duplicate"},{...b,id:"conflict",text:"Native words misread"}];
       const options=blocks=>({ocr:{mode:"force",minCharacterGain:10000,
         renderPageVariants:async()=>({pages:[{pageNumber:1,pdfWidth:360.375,pdfHeight:240.625,coordinateSpace:"crop-display-points",variants:[{name:"fixture"}]}]}),
         createRecognizer:async()=>({async recognizeVariant(){return [{candidateName:"fixture",score:1,characterCount:40,wordCount:8,averageConfidence:100,text:blocks.map(b=>b.text).join(" "),textBlocks:blocks}];},async close(){}})}});
       const enriched=await parsePdf(pdfPath,options([...duplicates,recognized]));const page=enriched.pages[0];
       assert.equal(page.ocr.status,"applied");assert.equal(page.ocr.suppressedDuplicates,2);
       assert.deepEqual(page.textBlocks.map(b=>b.text),["IMAGE TEXT 123","Native words stay once"]);
       const lp=path.join(dir,"mixed-layout.json");await writeFile(lp,JSON.stringify(enriched));const sem=await buildSemanticDocument(lp);
       const conflict=sem.semanticReviewTasks.find(r=>r.code==="OCR_NATIVE_CONFLICT"),native=sem.nodes.find(n=>n.text==="Native words stay once");
       assert.deepEqual(conflict.candidates,[native.id]);assert.equal(conflict.nativeText,native.text);assert.equal(conflict.ocrText,"Native words misread");assert.deepEqual(conflict.bbox,b.bbox);
       assert.deepEqual(sem.nodes.find(n=>n.text==="IMAGE TEXT 123").ocrSegments[0].geometry,recognized.ocrGeometry);
       const retained=await parsePdf(pdfPath,options(duplicates));assert.equal(retained.pages[0].ocr.status,"retained-native-text");
       assert.equal(retained.pages[0].ocr.alignmentReview[0].ocrText,"Native words misread");
     });
   }
   const semanticPath=path.join(dir,`${name}-semantic.json`),tagsPath=path.join(dir,`${name}-tags.json`),outputPath=path.join(dir,`${name}-candidate.pdf`);
   const semantic={schemaVersion:"1.0.0",documentId:name,source:{layoutDocumentId:name,coordinateSpace:"crop-display-points",filePath:pdfPath},nodes};
   await writeFile(semanticPath,JSON.stringify(semantic));const tags=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tags));
   const report=await writeTaggedArtifacts({pdfPath,semanticPath,tagsPath,outputPath,mode:"auto"});
   assert.equal(report.writerMode,"native");assert.equal(report.ocrTextLines,16);
   assert.ok(report.structureElementCount>=16);
   const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:report.sourceOwnershipPath});
   await writeFile(path.join(dir,`${name}-saved.json`),JSON.stringify(saved,null,2));
   assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==="fail")));
   assert.equal(saved.ownershipStatus,"verified");assert.equal(saved.checks.filter(c=>c.code==="OCR_TEXT_EXACT").length,16);
   assert.match((await run(probe,["verify",pdfPath,outputPath])).stdout,/preserved/);assert.equal(await hash(),before);
   results.push({name,sourceHash:before,candidateHash:saved.candidateHash,summary:saved.summary,ocrLines:report.ocrTextLines});
   if(name==="mixed") {
     for(const [mode,code] of [["visible","OCR_TEXT_INVISIBLE"],["shifted","OCR_LINE_GEOMETRY"],["partial","OCR_TEXT_EXACT"],["owner","SOURCE_PAINT_OWNER"],["duplicate","OCR_LINE_COUNT"],["missing","OCR_LINE_COUNT"]])await t.test(`saved ${mode} OCR is rejected`,async()=>{
       const bad=path.join(dir,`${mode}.pdf`);await run(probe,["mutate",outputPath,bad,mode]);
       const checked=await checkSavedSemantics({pdfPath:bad,tagsPath,sourcePdfPath:pdfPath,ownershipPath:report.sourceOwnershipPath});
       assert.equal(checked.disposition,"rejected");assert.ok(checked.checks.some(c=>c.code===code&&c.status==="fail"),JSON.stringify(checked.summary));
     });
   }
   if(name==="scan")await t.test("declared OCR Unicode is preserved without GSUB ligature substitutions",async()=>{
     const changed=structuredClone(semantic);changed.nodes[0].text="office first Effects Café € Ω –";changed.nodes[0].ocrSegments[0].text=changed.nodes[0].text;
     const sp=path.join(dir,"unicode-semantic.json"),tp=path.join(dir,"unicode-tags.json"),out=path.join(dir,"unicode.pdf");
     await writeFile(sp,JSON.stringify(changed));await writeFile(tp,JSON.stringify(await buildTagTree(sp)));
     const written=await writeTaggedArtifacts({pdfPath,semanticPath:sp,tagsPath:tp,outputPath:out,mode:"native"});
     const checked=await checkSavedSemantics({pdfPath:out,tagsPath:tp,sourcePdfPath:pdfPath,ownershipPath:written.sourceOwnershipPath});
     assert.equal(checked.summary.failed,0,JSON.stringify(checked.checks.filter(c=>c.status==="fail")));
     assert.equal(checked.checks.find(c=>c.code==="OCR_TEXT_EXACT").actual,changed.nodes[0].text);
   });
   if(name==="scan")await t.test("unsupported OCR glyphs cannot create an apparently successful candidate",async()=>{
     const broken=structuredClone(semantic);broken.nodes[0].text="Unsupported \u{1f9ec}";broken.nodes[0].ocrSegments[0].text=broken.nodes[0].text;
     const sp=path.join(dir,"unsupported-semantic.json"),tp=path.join(dir,"unsupported-tags.json"),out=path.join(dir,"unsupported.pdf");
     await writeFile(sp,JSON.stringify(broken));await writeFile(tp,JSON.stringify(await buildTagTree(sp)));
     await assert.rejects(writeTaggedArtifacts({pdfPath,semanticPath:sp,tagsPath:tp,outputPath:out,mode:"native"}),/OCR font cannot encode/);
     await assert.rejects(access(out));
   });
   if(name==="scan")await t.test("out-of-page, degenerate and nonrectangular OCR quadrilaterals fail before save",async()=>{
     for(const [index,quad] of [[-10,10,100,10,100,20,-10,20],[10,10,10,10,10,20,10,20],[10,10,100,10,110,20,10,20]].entries()){
       const bad=structuredClone(tags);const visit=n=>{if(n.ocrSegments?.length){n.ocrSegments[0].quad=quad;return true;}return n.children?.some(visit);};visit(bad.root);
       const tp=path.join(dir,`bad-geometry-${index}.json`),out=path.join(dir,`bad-geometry-${index}.pdf`);await writeFile(tp,JSON.stringify(bad));
       await assert.rejects(writeTaggedArtifacts({pdfPath,semanticPath,tagsPath:tp,outputPath:out,mode:"native"}),/OCR.*quadrilateral/);await assert.rejects(access(out));
     }
   });
 }
 await writeFile(path.join(dir,"evidence.json"),JSON.stringify(results,null,2));
});
