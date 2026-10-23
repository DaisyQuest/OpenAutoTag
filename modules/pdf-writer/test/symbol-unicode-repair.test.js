import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";
import {PDFDocument,PDFName,decodePDFRawStream} from "pdf-lib";
import {getDocument,VerbosityLevel} from "pdfjs-dist/legacy/build/pdf.mjs";
import {repairFonts} from "../font-repair.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../../scripts/java-runtime.js";

test("symbol Unicode requires exact embedded glyph evidence and preserves source appearance",async t=>{
 const dir=process.env.SYMBOL_UNICODE_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),"symbol-unicode-"));await mkdir(dir,{recursive:true});
 if(!process.env.SYMBOL_UNICODE_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const fixture=(file,...args)=>promisify(execFile)(java,["-cp",path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),path.resolve(`modules/pdf-writer/test/fixtures/${file}.java`),...args],{env,windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
 await fixture("SymbolUnicodeFixture","create",dir,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf"));
 const rule="verified-symbol-unicode",evidence=[];
 for(const [mode,expected,code] of [["fingerprint","❖",1],["vertical","❖",1],["renamed","❖",1],["unicode-bmp","△",2],["unicode-supplementary","🚀",2]])await t.test(`${mode} saves exact Unicode while retaining programs, metrics, content and fields`,async()=>{
  const sourcePdf=path.join(dir,`${mode}.pdf`),outputPdf=path.join(dir,`${mode}-fixed.pdf`),source=await readFile(sourcePdf),report=await repairFonts({sourcePdf,outputPdf});
  assert.equal(report.verification.status,"pass");assert.equal(report.repairLedger.filter(r=>r.ruleId===rule&&r.decision==="apply").length,1,JSON.stringify(report.repairLedger));
  const candidate=await readFile(outputPdf);assert.deepEqual(candidate.subarray(0,source.length),source);
  const a=await PDFDocument.load(source),b=await PDFDocument.load(candidate),name=PDFName.of;
  const font=p=>p.getPage(0).node.Resources().lookup(name("Font")).lookup(name("F1"));
  assert.equal(font(a).has(name("ToUnicode")),false);assert.equal(font(b).has(name("ToUnicode")),true);
  const descendant=p=>font(p).lookup(name("DescendantFonts")).lookup(0),program=p=>Buffer.from(decodePDFRawStream(descendant(p).lookup(name("FontDescriptor")).lookup(name("FontFile2"))).decode());
  assert.deepEqual(program(a),program(b));assert.equal(descendant(a).toString(),descendant(b).toString());
  assert.equal((await fixture("SymbolUnicodeFixture","read",outputPdf,String(code))).stdout.trim(),expected.codePointAt(0).toString(16));
  const parsed=await getDocument({data:new Uint8Array(candidate),verbosity:VerbosityLevel.ERRORS,useSystemFonts:false}).promise;
  try{const text=await(await parsed.getPage(1)).getTextContent();assert.ok(text.items.map(i=>i.str||"").join("").includes(expected));}finally{await parsed.destroy();}
  assert.match((await fixture("CidMapFixture","verify",sourcePdf,outputPdf)).stdout,/preserved/);
  assert.equal((await repairFonts({sourcePdf,candidatePdf:outputPdf})).verification.status,"pass");
  const repeat=await repairFonts({sourcePdf:outputPdf,outputPdf:path.join(dir,`${mode}-repeat.pdf`)});assert.equal(repeat.sourceHash,repeat.candidateHash);
  evidence.push({mode,expected,sourcePdf,outputPdf,...report});
 });
 for(const mode of ["changed-shape","wrong-units","wrong-advance","ambiguous","conflict","private","symbol-cmap","control","unknown","mixed-unknown","unused","notdef","out-of-range","editable","actualtext","inline-actualtext","unembedded","custom-encoding","missing-font"])await t.test(`${mode} leaves unsupported or conflicting evidence unchanged`,async()=>{
  const report=await repairFonts({sourcePdf:path.join(dir,`${mode}.pdf`),outputPdf:path.join(dir,`${mode}-fixed.pdf`)});
  assert.equal(report.sourceHash,report.candidateHash,JSON.stringify(report.repairLedger));assert.ok(report.repairLedger.some(r=>r.ruleId===rule&&r.decision==="review"));
 });
 for(const mode of ["existing","empty-map","null-map"])await t.test(`${mode} retains the authored ToUnicode entry`,async()=>{
  const report=await repairFonts({sourcePdf:path.join(dir,`${mode}.pdf`),outputPdf:path.join(dir,`${mode}-fixed.pdf`)});assert.equal(report.sourceHash,report.candidateHash);
 });
 await t.test("altering the saved symbol Unicode fails fresh source replay",async()=>{
  const bad=path.join(dir,"mutated-unicode.pdf");await fixture("SymbolUnicodeFixture","mutate",path.join(dir,"fingerprint-fixed.pdf"),bad);
  const report=await repairFonts({sourcePdf:path.join(dir,"fingerprint.pdf"),candidatePdf:bad});assert.equal(report.verification.status,"fail");
 });
 await writeFile(path.join(dir,"evidence.json"),JSON.stringify(evidence,null,2));
});
