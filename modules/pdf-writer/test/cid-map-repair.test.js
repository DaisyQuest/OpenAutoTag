import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";
import {PDFDocument,PDFName,decodePDFRawStream} from "pdf-lib";
import {repairFonts} from "../font-repair.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../../scripts/java-runtime.js";

const hash=b=>createHash("sha256").update(b).digest("hex"),rule="embedded-truetype-missing-cidmap";
test("missing CID mappings are repaired only with embedded glyph equivalence and complete usage evidence",async t=>{
 const dir=process.env.CID_MAP_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),"cid-mapping-"));await mkdir(dir,{recursive:true});
 if(!process.env.CID_MAP_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const fixture=(...args)=>promisify(execFile)(java,["-cp",path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),path.resolve("modules/pdf-writer/test/fixtures/CidMapFixture.java"),...args],{env,windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
 const created=await fixture("create",dir,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf"));await writeFile(path.join(dir,"fixture.log"),created.stderr);
 const results=[];
 for(const mode of ["horizontal","vertical","custom-cmap","shared","inherited-form","inherited-no-type","pattern","inactive-appearance"]){
  await t.test(`${mode} retains glyph selection, program bytes, rendering and editable appearances`,async()=>{
   const sourcePdf=path.join(dir,`${mode}.pdf`),outputPdf=path.join(dir,`${mode}-fixed.pdf`),source=await readFile(sourcePdf);
   const report=await repairFonts({sourcePdf,outputPdf});assert.equal(report.verification.status,"pass");
   assert.equal(report.repairLedger.filter(r=>r.ruleId===rule&&r.decision==="apply").length,1,JSON.stringify(report.repairLedger));
   const candidate=await readFile(outputPdf);assert.deepEqual(candidate.subarray(0,source.length),source);assert.deepEqual(await readFile(sourcePdf),source);
   const a=await PDFDocument.load(source),b=await PDFDocument.load(candidate),name=PDFName.of;
   const cid=pdf=>pdf.getPage(0).node.Resources().lookup(name("Font")).lookup(name("F1")).lookup(name("DescendantFonts")).lookup(0);
   assert.equal(cid(a).has(name("CIDToGIDMap")),false);assert.equal(cid(b).lookup(name("CIDToGIDMap")).toString(),"/Identity");
   const program=pdf=>Buffer.from(decodePDFRawStream(cid(pdf).lookup(name("FontDescriptor")).lookup(name("FontFile2"))).decode());
   assert.deepEqual(program(a),program(b));assert.match(report.repairLedger.find(r=>r.ruleId===rule).reason,new RegExp(hash(program(a))));
   if(mode==="pattern") {const pattern=b.getPage(0).node.Resources().lookup(name("Pattern")).lookup(name("P1"));assert.equal(pattern.dict.get(name("Type")).toString(),"/Pattern");assert.equal(pattern.dict.has(name("Subtype")),false);}
   if(mode==="inherited-no-type")assert.equal(b.getPage(0).node.Resources().lookup(name("XObject")).lookup(name("Fm")).dict.has(name("Type")),false);
   if(mode==="inactive-appearance")assert.equal(b.getPage(0).node.Annots().lookup(0).lookup(name("AP")).lookup(name("N")).lookup(name("Hidden")).dict.has(name("Type")),false);
   assert.match((await fixture("verify",sourcePdf,outputPdf)).stdout,/preserved/);
   assert.equal((await repairFonts({sourcePdf,candidatePdf:outputPdf})).verification.status,"pass");
   const repeat=await repairFonts({sourcePdf:outputPdf,outputPdf:path.join(dir,`${mode}-repeat.pdf`)});assert.equal(repeat.sourceHash,repeat.candidateHash);
   results.push({mode,sourceHash:report.sourceHash,candidateHash:report.candidateHash,programHash:hash(program(a)),repairLedger:report.repairLedger,verification:report.verification});
  });
 }
 for(const mode of ["unused","unembedded","out-of-range","notdef","bad-program","bad-loca","bad-units","inactive-out-of-range","pattern-out-of-range","inherited-out-of-range","missing-font","recursive","type3"]){
  await t.test(`${mode} cannot acquire a qualified mapping`,async()=>{
   const sourcePdf=path.join(dir,`${mode}.pdf`),outputPdf=path.join(dir,`${mode}-fixed.pdf`),report=await repairFonts({sourcePdf,outputPdf});
   assert.equal(report.repairLedger.filter(r=>r.ruleId===rule&&r.decision==="apply").length,0);
   assert.ok(report.repairLedger.some(r=>r.ruleId===rule&&r.decision==="review"),JSON.stringify(report.repairLedger));
   assert.equal(report.sourceHash,report.candidateHash);
  });
 }
 for(const mode of ["existing","null-map"])await t.test(`${mode} does not overwrite an authored mapping`,async()=>{
  const report=await repairFonts({sourcePdf:path.join(dir,`${mode}.pdf`),outputPdf:path.join(dir,`${mode}-fixed.pdf`)});
  assert.equal(report.repairLedger.filter(r=>r.ruleId===rule&&r.decision==="apply").length,0);assert.equal(report.sourceHash,report.candidateHash);
 });
 await t.test("an altered saved CIDToGIDMap fails independent source replay",async()=>{
  const sourcePdf=path.join(dir,"horizontal.pdf"),candidate=path.join(dir,"horizontal-fixed.pdf"),bad=path.join(dir,"mutated-map.pdf");
  await fixture("mutate",sourcePdf,candidate,bad);
  const report=await repairFonts({sourcePdf,candidatePdf:bad});assert.equal(report.verification.status,"fail");assert.match(report.verification.reason,/Unexpected saved-object/);
 });
 await writeFile(path.join(dir,"evidence.json"),JSON.stringify(results,null,2));
});
