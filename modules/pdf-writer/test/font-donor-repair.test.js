import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,writeFile,access} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import os from "node:os";import path from "node:path";
import {PDFDocument,PDFName,decodePDFRawStream} from "pdf-lib";
import {repairFonts} from "../font-repair.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../../scripts/java-runtime.js";
import {checkPdfPreservation} from "../../../scripts/check-pdf-preservation.js";
const sha=b=>createHash("sha256").update(b).digest("hex"),n=PDFName.of,rule="exact-truetype-program-recovery";

test("exact font donors are source-bound, preserve paint and reject substitutions",async t=>{
 const dir=process.env.FONT_DONOR_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),"font-donors-"));await mkdir(dir,{recursive:true});
 if(!process.env.FONT_DONOR_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const fixture=(file,...args)=>promisify(execFile)(java,["-XX:TieredStopAtLevel=1","-cp",path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),path.resolve(`modules/pdf-writer/test/fixtures/${file}.java`),...args],{env,windowsHide:true,maxBuffer:8*1024*1024,timeout:60000});
 await fixture("FontDonorFixture","create",dir,path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf"));
 const donorBytes=await readFile(path.join(dir,"donor.ttf")),results=[];
 async function manifest(mode,{programPath="donor.ttf",suffix=""}={}){
  const sourcePdf=path.join(dir,`${mode}.pdf`),bytes=await readFile(sourcePdf),pdf=await PDFDocument.load(bytes),fontRef=pdf.getPage(0).node.Resources().lookup(n("Font")).get(n("F1")).toString();
  const value={schemaVersion:"1.0.0",sourceHash:sha(bytes),donors:[{fontRef,programPath,programSha256:sha(await readFile(path.resolve(dir,programPath)))}]},donorsPath=path.join(dir,`${mode}${suffix}-donors.json`);
  await writeFile(donorsPath,JSON.stringify(value,null,2));return{sourcePdf,donorsPath,value};
 }
 for(const mode of ["exact","shared","form","pattern","appearance","clipping"])await t.test(`${mode} embeds only the exact program and retains glyphs, fields and rendering`,async()=>{
  const {sourcePdf,donorsPath}=await manifest(mode),outputPdf=path.join(dir,`${mode}-fixed.pdf`),report=await repairFonts({sourcePdf,outputPdf,donorsPath});
  assert.equal(report.verification.status,"pass");assert.equal(report.repairLedger.filter(r=>r.ruleId===rule&&r.decision==="apply").length,1,JSON.stringify(report.repairLedger));
  assert.equal(report.donorManifestHash,sha(await readFile(donorsPath)));const source=await readFile(sourcePdf),candidate=await readFile(outputPdf);assert.deepEqual(candidate.subarray(0,source.length),source);
  const a=await PDFDocument.load(source),b=await PDFDocument.load(candidate),font=(p,k="F1")=>p.getPage(0).node.Resources().lookup(n("Font")).lookup(n(k)),fd=(p,k)=>font(p,k).lookup(n("FontDescriptor"));
  assert.equal(fd(a).has(n("FontFile2")),false);assert.deepEqual(Buffer.from(decodePDFRawStream(fd(b).lookup(n("FontFile2"))).decode()),donorBytes);
  assert.equal(font(a).lookup(n("Widths")).toString(),font(b).lookup(n("Widths")).toString());assert.equal(font(a).lookup(n("Encoding")).toString(),font(b).lookup(n("Encoding")).toString());
  if(mode==="shared"){assert.equal(fd(b,"F2").has(n("FontFile2")),false);assert.notEqual(font(b).get(n("FontDescriptor")).toString(),font(b,"F2").get(n("FontDescriptor")).toString());}
  assert.match((await fixture("CidMapFixture","verify",sourcePdf,outputPdf)).stdout,/preserved/);
  assert.equal((await repairFonts({sourcePdf,candidatePdf:outputPdf,donorsPath})).verification.status,"pass");
  const repeatPath=path.join(dir,`${mode}-repeat-donors.json`),repeat=JSON.parse(await readFile(donorsPath));repeat.sourceHash=report.candidateHash;await writeFile(repeatPath,JSON.stringify(repeat));
  const again=await repairFonts({sourcePdf:outputPdf,outputPdf:path.join(dir,`${mode}-repeat.pdf`),donorsPath:repeatPath});assert.equal(again.sourceHash,again.candidateHash);
  results.push({mode,sourcePdf,outputPdf,donorsPath,...report});
 });
 for(const mode of ["width-mismatch","fractional-width","unused","notdef","editable","missing-font","wrong-name","existing","null-program"])await t.test(`${mode} cannot qualify a donor`,async()=>{
  const {sourcePdf,donorsPath}=await manifest(mode),report=await repairFonts({sourcePdf,outputPdf:path.join(dir,`${mode}-fixed.pdf`),donorsPath});
  assert.equal(report.sourceHash,report.candidateHash,JSON.stringify(report.repairLedger));assert.ok(report.repairLedger.some(r=>r.ruleId===rule&&r.decision==="review"));
  if(mode==="fractional-width")assert.match(report.repairLedger.find(r=>r.ruleId===rule).reason,/source glyph scaling/);
 });
 for(const programPath of ["changed-program.ttf","restricted.ttf","preview-only.ttf","bitmap-only.ttf","broken.ttf",path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf")])await t.test(`${path.basename(programPath)} is not an exact admissible donor`,async()=>{
  const suffix=`-${path.basename(programPath)}`,{sourcePdf,donorsPath}=await manifest("exact",{programPath,suffix}),report=await repairFonts({sourcePdf,outputPdf:path.join(dir,`${suffix}-fixed.pdf`),donorsPath});
  assert.equal(report.sourceHash,report.candidateHash);assert.ok(report.repairLedger.some(r=>r.ruleId===rule&&r.decision==="review"));
 });
 for(const kind of ["stale-source","wrong-program-hash","duplicate-target","unreachable-target","unknown-property","empty-donors"])await t.test(`${kind} fails before saving output`,async()=>{
  const {sourcePdf,donorsPath,value}=await manifest("exact",{suffix:`-${kind}`});
  if(kind==="stale-source")value.sourceHash="0".repeat(64);if(kind==="wrong-program-hash")value.donors[0].programSha256="0".repeat(64);if(kind==="duplicate-target")value.donors.push(value.donors[0]);if(kind==="unreachable-target")value.donors[0].fontRef="999999 0 R";if(kind==="unknown-property")value.unsafe=true;if(kind==="empty-donors")value.donors=[];
  await writeFile(donorsPath,JSON.stringify(value));const outputPdf=path.join(dir,`${kind}.pdf`);await assert.rejects(repairFonts({sourcePdf,outputPdf,donorsPath}));await assert.rejects(access(outputPdf));
 });
 await t.test("font recovery is opt-in",async()=>{const report=await repairFonts({sourcePdf:path.join(dir,"exact.pdf"),outputPdf:path.join(dir,"without-donors.pdf")});assert.equal(report.sourceHash,report.candidateHash);assert.equal(report.donorManifestHash,undefined);});
 await t.test("tampering even an unused donor metric fails saved-object replay",async()=>{
  const candidatePdf=path.join(dir,"mutated-program.pdf");await fixture("FontDonorFixture","mutate",path.join(dir,"exact-fixed.pdf"),candidatePdf);
  const {sourcePdf,donorsPath}=await manifest("exact",{suffix:"-replay"});assert.equal((await repairFonts({sourcePdf,candidatePdf,donorsPath})).verification.status,"fail");
 });
 await t.test("preservation qualification must replay the explicit donor manifest",async()=>{
  const sourcePdf=path.join(dir,"exact.pdf"),candidatePdf=path.join(dir,"exact-fixed.pdf"),fontDonorsPath=path.join(dir,"exact-donors.json"),validationReport=path.join(dir,"validation.json"),outputPath=path.join(dir,"quality.json");
  // Controlled validation input isolates this preservation gate; it is not a conformance claim.
  await writeFile(validationReport,JSON.stringify({status:"completed",pdfSha256:sha(await readFile(candidatePdf)),isCompliant:true,overall:{status:"pass"},findings:[],fontAudit:{status:"ok"}}));
  const options={sourcePdf,candidatePdf,validationReport,outputPath};await assert.rejects(checkPdfPreservation({...options,fontDonorsPath}),/require font repair/);
  await assert.rejects(checkPdfPreservation({...options,fontRepairs:true,fontDonorsPath,outputPath:path.join(dir,"donor.ttf")}),/must not overwrite an input/);
  assert.deepEqual(await readFile(path.join(dir,"donor.ttf")),donorBytes);
  assert.equal((await checkPdfPreservation({...options,fontRepairs:true})).disposition,"error");
  const report=await checkPdfPreservation({...options,fontRepairs:true,fontDonorsPath});assert.equal(report.disposition,"review_required");assert.equal(report.checks.find(c=>c.id==="qualifiedFontChanges").status,"pass");
 });
 await writeFile(path.join(dir,"evidence.json"),JSON.stringify(results,null,2));
});
