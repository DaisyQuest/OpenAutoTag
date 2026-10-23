import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {renderPageVariantsWithPdfBox,normalizeRecognizedTextBlocks,runOcrPipeline} from "../../modules/parser/ocr-pipeline.js";
import {parsePdf} from "../../modules/parser/index.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../scripts/java-runtime.js";

test("OCR image bounds map to the same display coordinates across crop, rotation, UserUnit and resolution",async t=>{
  const dir=process.env.OCR_GEOMETRY_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),"ocr-geometry-"));await mkdir(dir,{recursive:true});
  if(!process.env.OCR_GEOMETRY_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
  const jar=path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),probe=path.resolve("modules/parser/test/fixtures/OcrGeometryProbe.java");
  const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
  const run=args=>promisify(execFile)(java,["-cp",jar,probe,...args],{env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  await run(["create",dir]);
  const pdfPath=path.join(dir,"source.pdf"),hash=async()=>createHash("sha256").update(await readFile(pdfPath)).digest("hex"),before=await hash();
  const pages=JSON.parse(await readFile(path.join(dir,"oracle.json"))),outputDir=path.join(dir,"renders");
  const rendered=await renderPageVariantsWithPdfBox({pdfPath,pages,outputDir,renderVariants:[96,173,300].map(dpi=>({name:`gray-${dpi}`,dpi,imageType:"GRAY"}))});
  const bounds=JSON.parse((await run(["bounds",outputDir])).stdout),byFile=new Map(bounds.map(b=>[b.file,b.box])),evidence=[];
  for(const p of rendered.pages)for(const v of p.variants){
    const expected=pages.find(o=>o.pageNumber===p.pageNumber),box=byFile.get(path.basename(v.imagePath));
    const variant={...v,pdfWidth:p.pdfWidth,pdfHeight:p.pdfHeight,coordinateSpace:p.coordinateSpace};
    const [block]=normalizeRecognizedTextBlocks({rotateRadians:0,blocks:[{text:"IMAGE TEXT 123",confidence:100,bbox:box}]},variant,p.pageNumber,`${v.name}/oracle`);
    const errors=block.bbox.map((n,i)=>Math.abs(n-expected.bbox[i]));
    assert.ok(Math.max(...errors)<=1.6*72/v.dpi,JSON.stringify({page:p.pageNumber,dpi:v.dpi,expected:expected.bbox,actual:block.bbox,errors}));
    assert.ok(Math.abs(v.imageWidth-p.pdfWidth*v.dpi/72)<1.01);assert.ok(Math.abs(v.imageHeight-p.pdfHeight*v.dpi/72)<1.01);
    evidence.push({page:p.pageNumber,dpi:v.dpi,rotation:expected.rotation,userUnit:expected.userUnit,expected:expected.bbox,actual:block.bbox,maxError:Math.max(...errors)});
  }
  assert.equal(evidence.length,48);assert.equal(await hash(),before);
  await writeFile(path.join(dir,"geometry-evidence.json"),JSON.stringify({sourceHash:before,cases:evidence},null,2));
  await t.test("production orchestration passes render geometry into the recognizer",async()=>{
    const result=await runOcrPipeline({pdfPath,pages:[pages[0]],languages:["eng"],renderVariants:[{name:"gray-96",dpi:96,imageType:"GRAY"}],createRecognizer:async()=>({
      async recognizeVariant(v){
        const [block]=normalizeRecognizedTextBlocks({blocks:[{text:"IMAGE TEXT 123",bbox:byFile.get("page-001-gray-96.png")}]},v,1,"oracle");
        return [{candidateName:"oracle",score:1,text:block.text,textBlocks:[block]}];
      },async close(){}
    })});
    assert.deepEqual(result.pages[0].textBlocks[0].bbox,evidence[0].actual);
  });
  await t.test("invalid variants and oversized renders fail before allocating images",async()=>{
    for(const renderVariants of [[{name:"../escape",dpi:96,imageType:"RGB"}],[{name:"large",dpi:1201,imageType:"RGB"}],Array(2).fill({name:"duplicate",dpi:96,imageType:"RGB"})])
      await assert.rejects(renderPageVariantsWithPdfBox({pdfPath,pages:[pages[0]],outputDir,renderVariants}),/Invalid|exceeds/);
    await assert.rejects(renderPageVariantsWithPdfBox({pdfPath:path.join(dir,"oversized.pdf"),pages:[pages[0]],outputDir,renderVariants:[{name:"huge",dpi:300,imageType:"GRAY"}]}),/exceeds/);
  });
  await t.test("native parser geometry remains unchanged and image-only evidence is explicit",async()=>{
    const layout=await parsePdf(pdfPath,{ocr:{mode:"off"}});
    assert.equal(layout.pages.length,16);assert.ok(layout.pages.every(p=>p.textBlocks.length===0&&p.figures.length===1));
    assert.ok(layout.pages.every(p=>Math.abs(p.width-360.375)<.001&&Math.abs(p.height-240.625)<.001));
  });
});
