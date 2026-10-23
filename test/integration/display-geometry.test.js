import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {parsePdf} from "../../modules/parser/index.js";
import {analyzeLayout} from "../../modules/layout-analyzer/index.js";
import {buildSemanticDocument} from "../../modules/semantic-engine/index.js";
import {assignReadingOrder} from "../../modules/reading-order/index.js";
import {buildTagTree} from "../../modules/tag-builder/index.js";
import {writeTaggedArtifacts} from "../../modules/pdf-writer/index.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../scripts/java-runtime.js";
import {checkSavedSemantics} from "../../scripts/check-saved-semantics.js";
import {getRuntimeBuildDir} from "../../scripts/runtime-paths.js";
import {renderPageVariantsWithPdfBox} from "../../modules/parser/ocr-pipeline.js";
import {buildSourceTextMap} from "../../scripts/build-source-text-map.js";
import {buildTableStructureMap} from "../../scripts/build-table-structure-map.js";

test("cropped, rotated and scaled pages share display geometry through extraction and saved native tags",async t=>{
  const dir=process.env.DISPLAY_GEOMETRY_EVIDENCE_DIR || await mkdtemp(path.join(os.tmpdir(),"display-geometry-"));
  await mkdir(dir,{recursive:true});
  if(!process.env.DISPLAY_GEOMETRY_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
  const pdfPath=path.join(dir,"source.pdf"),outputPath=path.join(dir,"candidate.pdf"),tagsPath=path.join(dir,"tags.json"),semanticPath=path.join(dir,"semantic.json"),layoutPath=path.join(dir,"layout.json");
  const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
  const jar=path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),probe=path.resolve("modules/pdf-writer/test/fixtures/DisplayGeometryProbe.java"),font=path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf");
  const run=args=>promisify(execFile)(java,args,{env,windowsHide:true,timeout:90000,maxBuffer:50*1024*1024});
  await run(["-cp",jar,probe,"create",pdfPath,font]);
  const layout=await parsePdf(pdfPath,{ocr:{mode:"off"}});
  await writeFile(layoutPath,JSON.stringify(layout));
  assert.equal(layout.source.coordinateSpace,"crop-display-points");
  const close=(a,b)=>assert.ok(Math.abs(a-b)<0.025,`${a} != ${b}`);
  for(const p of layout.pages){
    close(p.width,612);close(p.height,792);
    const title=p.textBlocks.find(b=>b.text.startsWith("Geometry "));
    assert.ok(title,`page ${p.pageNumber} title`);close(title.bbox[0],200);close(title.bbox[1],190);close(title.fontSize,21);
    assert.equal(p.figures.length,1);p.figures[0].bbox.forEach((v,i)=>close(v,[480,662,40,30][i]));
    for(const f of p.formFields||[])f.bbox.forEach((v,i)=>close(v,[150,490,140,25][i]));
    const lines=p.textBlocks.filter(b=>/column has|Shared label/.test(b.text));
    assert.equal(lines.length,8);lines.forEach(b=>close(b.fontSize,10));
  }
  const analyzed=await analyzeLayout(layoutPath);await writeFile(layoutPath,JSON.stringify(analyzed));
  for(const p of analyzed.pages.slice(0,24))assert.equal(p.columns,2,`page ${p.pageNumber} columns`);
  const semantic=await buildSemanticDocument(layoutPath);await writeFile(semanticPath,JSON.stringify(semantic));
  const ordered=await assignReadingOrder(semanticPath);await writeFile(semanticPath,JSON.stringify(ordered));
  assert.equal(ordered.source.coordinateSpace,"crop-display-points");
  const byId=new Map(ordered.nodes.map(n=>[n.id,n]));
  for(let page=1;page<=24;page++){
    const body=ordered.orderedNodeIds.map(id=>byId.get(id)).filter(n=>n.pageNumber===page&&/column has|Shared label/.test(n.text));
    assert.deepEqual(body.map(n=>Math.round(n.bbox[0])),[63,63,63,63,318,318,318,318],`page ${page} reading order`);
  }
  const tags=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tags));
  await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:"native"});
  assert.match((await run(["-cp",jar,probe,"verify",pdfPath,outputPath])).stdout,/28 display geometries.*preserved/);
  const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:`${outputPath}.ownership.json`});
  await writeFile(path.join(dir,"saved-semantics.json"),JSON.stringify(saved));
  assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks?.filter(c=>c.status==="fail")));
  await t.test("source-text and ruled-table diagnostics compare coordinates in the layout frame",async()=>{
    const source=await buildSourceTextMap({pdfPath,layoutPath,outputPath:path.join(dir,"source-text-map.json")});
    const tables=await buildTableStructureMap({pdfPath,layoutPath,outputPath:path.join(dir,"table-map.json")});
    assert.equal(source.coordinateSpace,"crop-display-points");assert.equal(tables.coordinateSpace,"crop-display-points");
    for(const p of layout.pages){
      const title=source.sourceRuns.find(r=>r.pageNumber===p.pageNumber&&r.text.startsWith("Geometry "));
      assert.ok(title);close(title.bbox[0],200);close(title.bbox[1]+title.bbox[3],211);close(title.fontSize,21);
      const table=tables.pages[p.pageNumber-1].tables;assert.equal(table.length,1,`page ${p.pageNumber} table`);
      table[0].bbox.forEach((v,i)=>close(v,[60,295,500,42][i]));assert.equal(table[0].rowCount,2);assert.equal(table[0].columnCount,2);
      assert.equal(table[0].assignedBlockIds.length,4);
    }
    await analyzeLayout(layoutPath,{tableStructurePath:path.join(dir,"table-map.json")});
    delete tables.coordinateSpace;const incompatible=path.join(dir,"legacy-table-map.json");await writeFile(incompatible,JSON.stringify(tables));
    await assert.rejects(analyzeLayout(layoutPath,{tableStructurePath:incompatible}),/coordinate spaces must agree/);
  });
  await t.test("veraPDF checks the saved native output",async()=>{
    const result=await promisify(execFile)(process.execPath,[path.resolve("modules/validator/index.js"),"--pdf",outputPath,"--manifest",`${outputPath}.tags.json`],{env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
    const validation=JSON.parse(result.stdout);await writeFile(path.join(dir,"validation.json"),JSON.stringify(validation));
    assert.equal(validation.rawSummary.failedChecks,0);
  });
  await t.test("OCR render metadata uses the same displayed physical dimensions",async()=>{
    const result=await renderPageVariantsWithPdfBox({pdfPath,pages:layout.pages.slice(24),outputDir:path.join(dir,"ocr"),renderVariants:[{name:"small",dpi:72,imageType:"RGB"},{name:"large",dpi:144,imageType:"RGB"}]});
    for(const p of result.pages){
      close(p.pdfWidth,612);close(p.pdfHeight,792);
      assert.equal(p.coordinateSpace,"crop-display-points");
      for(const v of p.variants){close(v.imageWidth,612*v.dpi/72);close(v.imageHeight,792*v.dpi/72);close(v.pixelToDisplay[0],72/v.dpi);}
    }
  });
  await t.test("the matcher rejects missing scale or an incompatible coordinate frame",async()=>{
    const cp=`${getRuntimeBuildDir("modules-pdf-writer",{repoRoot:process.cwd()})}${path.delimiter}${jar}`;
    const operators=JSON.parse(await readFile(`${outputPath}.native-operators.json`,"utf8"));
    for(const variant of ["missing-unit","zero-unit","missing-size","invalid-rotation","bottom-origin","unknown-frame"]){
      const op=structuredClone(operators),sem=structuredClone(ordered);
      if(variant==="missing-unit")delete op.pages[0].userUnit;
      if(variant==="zero-unit")op.pages[0].userUnit=0;
      if(variant==="missing-size")delete op.pages[0].pageWidth;
      if(variant==="invalid-rotation")op.pages[0].rotation=45;
      if(variant==="bottom-origin")op.coordinateOrigin="bottom";
      if(variant==="unknown-frame")sem.source.coordinateSpace="unrecognized";
      const opPath=path.join(dir,"invalid-operators.json"),semPath=path.join(dir,"invalid-semantic.json");await writeFile(opPath,JSON.stringify(op));await writeFile(semPath,JSON.stringify(sem));
      await assert.rejects(run(["-cp",cp,"NativeTagMatcher","--operators",opPath,"--semantic",semPath,"--tags",tagsPath,"--output",path.join(dir,"invalid-plan.json")]),/Display-point matching requires|Unsupported semantic coordinate space/);
    }
  });
  await t.test("raster rendering, invisible text and redaction boxes honor the display frame",async()=>{
    const rasterSource=path.join(dir,"raster-source.pdf"),rasterOut=path.join(dir,"raster.pdf"),rasterSemantic=path.join(dir,"raster-semantic.json"),rasterTags=path.join(dir,"raster-tags.json");
    await run(["-cp",jar,probe,"create",rasterSource,font,"raster"]);
    const sem=structuredClone(ordered);sem.nodes=sem.nodes.filter(n=>n.pageNumber<=24);const ids=new Set(sem.nodes.map(n=>n.id));sem.orderedNodeIds=sem.orderedNodeIds.filter(id=>ids.has(id));delete sem.widgets;delete sem.formFields;
    // This variant contains only the first 24 form-free pages. Drop relationships
    // to widgets on pages 25-28 alongside their removed semantic nodes.
    sem.formRelationships=(sem.formRelationships||[]).map(f=>({...f,widgets:f.widgets.filter(w=>w.pageNumber<=24)})).filter(f=>f.widgets.length);
    assert.deepEqual(sem.formRelationships,[]);delete sem.formNavigation;
    await writeFile(rasterSemantic,JSON.stringify(sem));await writeFile(rasterTags,JSON.stringify(await buildTagTree(rasterSemantic)));
    await writeTaggedArtifacts({pdfPath:rasterSource,outputPath:rasterOut,tagsPath:rasterTags,semanticPath:rasterSemantic,mode:"raster"});
    assert.match((await run(["-cp",jar,probe,"verify-raster",rasterSource,rasterOut])).stdout,/24 raster display transforms/);
    const redactionsPath=path.join(dir,"redactions.json"),redactedOut=path.join(dir,"redacted-raster.pdf");
    const plan={schemaVersion:"1.0.0",workloadId:"tag-and-ssn-redact",sourcePdf:rasterSource,semanticDocumentId:sem.documentId,coordinateSpace:"crop-display-points",summary:{pagesProcessed:24,candidateMatches:24,redactedMatches:24,pagesRedacted:24,outputMode:"semantic-mask-plan"},matches:Array.from({length:24},(_,i)=>({matchId:`r${i}`,pageNumber:i+1,sourceBlockId:`b${i}`,sourceNodeId:`n${i}`,maskedText:"",bbox:[480,662,40,30]}))};
    await writeFile(redactionsPath,JSON.stringify(plan));
    await writeTaggedArtifacts({pdfPath:rasterSource,outputPath:redactedOut,tagsPath:rasterTags,semanticPath:rasterSemantic,redactionsPath,mode:"raster"});
    assert.match((await run(["-cp",jar,probe,"verify-raster",rasterSource,redactedOut,"redacted"])).stdout,/display-coordinate redactions/);
    const standalone=path.join(dir,"standalone-redacted.pdf"),instructions=path.join(dir,"standalone-redactions.tsv");
    await writeFile(instructions,Array.from({length:24},(_,i)=>`${i+1}\t480\t662\t40\t30`).join("\n"));
    await run(["-cp",jar,path.resolve("modules/redactor/java/PdfSsnRedactorCli.java"),"--pdf",rasterSource,"--instructions",instructions,"--output",standalone,"--coordinate-space","crop-display-points"]);
    assert.match((await run(["-cp",jar,probe,"verify-raster",rasterSource,standalone,"standalone"])).stdout,/display-coordinate redactions/);
  });
});
