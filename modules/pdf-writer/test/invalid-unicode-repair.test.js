import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,PDFName,decodePDFRawStream} from 'pdf-lib';
import {getDocument,VerbosityLevel} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {repairFonts} from '../font-repair.js';
import {runFontAuditCli} from '../../validator/index.js';
import {checkPdfPreservation} from '../../../scripts/check-pdf-preservation.js';
import {resolveJavaTool,buildJavaExecEnv} from '../../../scripts/java-runtime.js';
const n=PDFName.of,sha=b=>createHash('sha256').update(b).digest('hex');

test('invalid Unicode is diagnosed directly and repaired only with independent glyph evidence',async t=>{
 const dir=process.env.INVALID_UNICODE_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'invalid-unicode-'));await mkdir(dir,{recursive:true});
 if(!process.env.INVALID_UNICODE_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const fixture=(file,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${file}.java`),...args],{env,windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
 await fixture('InvalidUnicodeFixture','create',dir,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'));
 const evidence=[],rule='verified-invalid-unicode';
 const font=p=>p.getPage(0).node.Resources().lookup(n('Font')).lookup(n('F1'));
 const program=f=>{const descendant=f.has(n('DescendantFonts'))?f.lookup(n('DescendantFonts')).lookup(0):f;return Buffer.from(decodePDFRawStream(descendant.lookup(n('FontDescriptor')).lookup(n('FontFile2'))).decode());};
 for(const mode of ['partial','surrogate','odd','empty-value','null','empty-stream','absent','simple','vertical','array','form','pattern','appearance','shared','late-invalid'])await t.test(`${mode} recovers exact Unicode without changing glyphs or forms`,async()=>{
  const sourcePdf=path.join(dir,`${mode}.pdf`),outputPdf=path.join(dir,`${mode}-fixed.pdf`),report=await repairFonts({sourcePdf,outputPdf,repairUnicode:true});
  const changes=report.repairLedger.filter(r=>r.ruleId===rule&&r.decision==='apply');assert.equal(changes.length,1,JSON.stringify(report));
  const diagnostic=report.unicodeDiagnostics.find(d=>d.repaired);assert.equal(diagnostic.codes.length,3);assert.equal(report.verification.status,'pass');
  const source=await readFile(sourcePdf),saved=await readFile(outputPdf);assert.deepEqual(saved.subarray(0,source.length),source);
  const a=await PDFDocument.load(source),b=await PDFDocument.load(saved);assert.deepEqual(program(font(a)),program(font(b)));
  const codes=diagnostic.codes.map(c=>c.code);assert.equal((await fixture('InvalidUnicodeFixture','read',outputPdf,...codes.map(String))).stdout.trim(),'ABC');
  if(!['appearance','pattern'].includes(mode)){const pdf=await getDocument({data:new Uint8Array(saved),verbosity:VerbosityLevel.ERRORS,useSystemFonts:false}).promise;try{const text=await(await pdf.getPage(1)).getTextContent();assert.ok(text.items.map(i=>i.str||'').join('').includes('ABC'));}finally{await pdf.destroy();}}
  if(mode==='partial'){const stream=decodePDFRawStream(font(b).lookup(n('ToUnicode'))).decode();assert.match(Buffer.from(stream).toString(),/006600660069/);}
  if(mode==='shared'){const other=p=>p.getPage(0).node.Resources().lookup(n('Font')).lookup(n('F2')).get(n('ToUnicode')).toString();assert.equal(other(a),other(b));assert.notEqual(other(b),font(b).get(n('ToUnicode')).toString());}
  assert.match((await fixture('CidMapFixture','verify',sourcePdf,outputPdf)).stdout,/preserved/);
  assert.equal((await repairFonts({sourcePdf,candidatePdf:outputPdf,repairUnicode:true})).verification.status,'pass');
  const repeat=await repairFonts({sourcePdf:outputPdf,outputPdf:path.join(dir,`${mode}-repeat.pdf`),repairUnicode:true});assert.equal(repeat.sourceHash,repeat.candidateHash);
  evidence.push({mode,sourcePdf,outputPdf,...report});
 });
 for(const mode of ['conflict','sequence','duplicate','count','truncated','usecmap','inherited','invalid-unused','actualtext','editable','missing-font','unembedded'])await t.test(`${mode} remains unchanged with an explicit diagnostic`,async()=>{
  const report=await repairFonts({sourcePdf:path.join(dir,`${mode}.pdf`),outputPdf:path.join(dir,`${mode}-fixed.pdf`),repairUnicode:true});
  assert.equal(report.sourceHash,report.candidateHash,JSON.stringify(report));assert.ok(report.repairLedger.some(r=>r.ruleId===rule&&r.decision==='review'));
  if(['conflict','sequence','duplicate'].includes(mode))assert.equal(report.unicodeDiagnostics[0].state,'contradictory');
 });
 for(const mode of ['valid-range','valid-array','valid-sequence','override-valid','override-invalid'])await t.test(`${mode} authored maps are retained`,async()=>{
  const report=await repairFonts({sourcePdf:path.join(dir,`${mode}.pdf`),outputPdf:path.join(dir,`${mode}-fixed.pdf`),repairUnicode:true});assert.equal(report.sourceHash,report.candidateHash);assert.equal(report.unicodeDiagnostics[0].state,'valid');
 });
 const header='/CMapType 2 def\nbegincmap\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n',tail='\nendcmap\n',pair='1 beginbfchar\n<41> <0041>\nendbfchar\n';
 const invalidMaps=[
  ['range-overflow','1 beginbfrange\n<41> <43> <00ff>\nendbfrange'],
  ['range-reversed','1 beginbfrange\n<43> <41> <0041>\nendbfrange'],
  ['array-size','1 beginbfrange\n<41> <43> [<0041>]\nendbfrange'],
  ['source-width','1 beginbfchar\n<0041> <0041>\nendbfchar'],
  ['destination-type','1 beginbfchar\n<41> /A\nendbfchar'],
  ['destination-limit',`1 beginbfchar\n<41> <${'0041'.repeat(257)}>\nendbfchar`],
  ['fractional-count','1.5 beginbfchar\n<41> <0041>\nendbfchar'],
  ['zero-count','0 beginbfchar\nendbfchar'],
  ['huge-count','999999999 beginbfchar\nendbfchar'],
  ['overlap','1 begincodespacerange\n<40> <50>\nendcodespacerange'],
  ['repeated-type','/CMapType 2 def'],
  ['repeated-begin','begincmap'],
  ['unknown-operation','arbitraryProcedure'],
  ['token-limit','1 '.repeat(200001)],
  ['byte-limit',' '.repeat(4*1024*1024+1)]
 ];
 for(const [id,body]of invalidMaps)await t.test(`${id} cannot trigger a speculative map replacement`,async()=>{
  const pdf=await PDFDocument.load(await readFile(path.join(dir,'simple.pdf')));font(pdf).set(n('ToUnicode'),pdf.context.register(pdf.context.stream(Buffer.from(header+body+tail))));
  const sourcePdf=path.join(dir,`${id}.pdf`),outputPdf=path.join(dir,`${id}-fixed.pdf`);await writeFile(sourcePdf,await pdf.save());
  const report=await repairFonts({sourcePdf,outputPdf,repairUnicode:true});assert.equal(report.sourceHash,report.candidateHash);assert.ok(['malformed','unsupported'].includes(report.unicodeDiagnostics[0].state));
 });
 await t.test('comments, literal strings and unused supplementary sequences retain their meanings',async()=>{
  const pdf=await PDFDocument.load(await readFile(path.join(dir,'simple.pdf')));
  const body=pair+'% 1 beginbfchar <42> <0058> endbfchar\n1 beginbfchar\n<43> (\\000C)\nendbfchar\n1 beginbfchar\n<44> <d83dde80>\nendbfchar\n';
  font(pdf).set(n('ToUnicode'),pdf.context.register(pdf.context.stream(Buffer.from(header+body+tail))));
  const sourcePdf=path.join(dir,'supplementary.pdf'),outputPdf=path.join(dir,'supplementary-fixed.pdf');await writeFile(sourcePdf,await pdf.save());
  const report=await repairFonts({sourcePdf,outputPdf,repairUnicode:true});assert.equal(report.unicodeDiagnostics[0].repaired,true);
  const output=await PDFDocument.load(await readFile(outputPdf));assert.match(Buffer.from(decodePDFRawStream(font(output).lookup(n('ToUnicode'))).decode()).toString(),/d83dde80/);
  assert.equal((await fixture('InvalidUnicodeFixture','read-hex',outputPdf,'65','66','67','68')).stdout.trim(),'41,42,43,1f680');
 });
 await t.test('codespaces constrain each byte rather than a flat integer interval',async()=>{
  const pdf=await PDFDocument.load(await readFile(path.join(dir,'partial.pdf')));
  const map=header.replace('<00> <ff>','<0101> <02fe>')+'1 beginbfchar\n<0200> <0041>\nendbfchar'+tail;
  font(pdf).set(n('ToUnicode'),pdf.context.register(pdf.context.stream(Buffer.from(map))));
  const sourcePdf=path.join(dir,'multidimensional.pdf'),outputPdf=path.join(dir,'multidimensional-fixed.pdf');await writeFile(sourcePdf,await pdf.save());
  const report=await repairFonts({sourcePdf,outputPdf,repairUnicode:true});assert.equal(report.sourceHash,report.candidateHash);assert.ok(report.unicodeDiagnostics.some(d=>d.reason.includes('outside codespace')));
 });
 await t.test('replacement of an existing map requires explicit opt-in',async()=>{const report=await repairFonts({sourcePdf:path.join(dir,'partial.pdf'),outputPdf:path.join(dir,'no-opt-in.pdf')});assert.equal(report.sourceHash,report.candidateHash);assert.equal(report.unicodeDiagnostics,undefined);});
 await t.test('independent audit counts direct mappings rather than fallback extraction',async()=>{
  const before=await runFontAuditCli(path.join(dir,'partial.pdf')),after=await runFontAuditCli(path.join(dir,'partial-fixed.pdf'));
  const a=before.fonts.find(f=>f.usedGlyphCount===3),b=after.fonts.find(f=>f.usedGlyphCount===3);assert.equal(a.mappedGlyphCount,2);assert.equal(a.unmappedCodes.length,1);assert.equal(b.mappedGlyphCount,3);assert.deepEqual(b.unmappedCodes,[]);
  assert.ok(before.findings.some(f=>f.code==='TO_UNICODE_INCOMPLETE'));assert.ok(!after.findings.some(f=>f.code==='TO_UNICODE_INCOMPLETE'));
  await writeFile(path.join(dir,'direct-audit.json'),JSON.stringify({before,after},null,2));
 });
 await t.test('one missing code out of 200 remains an audit error',async()=>{
  const pdf=await PDFDocument.load(await readFile(path.join(dir,'partial.pdf'))),codes=Array.from({length:200},(_,i)=>i+32),hex=c=>c.toString(16).padStart(4,'0');
  font(pdf).set(n('ToUnicode'),pdf.context.register(pdf.context.stream(Buffer.from(header.replace('<00> <ff>','<0000> <ffff>')+codes.filter(c=>c!==66).map(c=>`1 beginbfchar\n<${hex(c)}> <${hex(c)}>\nendbfchar\n`).join('')+tail))));
  pdf.getPage(0).node.set(n('Contents'),pdf.context.register(pdf.context.stream(Buffer.from(`BT /F1 12 Tf <${codes.map(hex).join('')}> Tj ET`))));
  const sourcePdf=path.join(dir,'near-complete.pdf');await writeFile(sourcePdf,await pdf.save());const audit=await runFontAuditCli(sourcePdf),entry=audit.fonts.find(f=>f.usedGlyphCount===200);
  assert.equal(entry.mappedGlyphCount,199);assert.deepEqual(entry.unmappedCodes,[66]);assert.equal(audit.findings.find(f=>f.code==='TO_UNICODE_INCOMPLETE').severity,'error');
 });
 await t.test('standard fallback is distinguished from direct map coverage',async()=>{
  const audit=await runFontAuditCli(path.join(dir,'simple.pdf')),entry=audit.fonts.find(f=>f.usedGlyphCount===3);assert.equal(entry.mappedGlyphCount,2);assert.deepEqual(entry.unmappedCodes,[66]);assert.deepEqual(entry.standardFallbackCodes,[66]);assert.equal(audit.findings.find(f=>f.code==='TO_UNICODE_INCOMPLETE').severity,'warning');
 });
 await t.test('an empty direct map is reported as malformed even when fallback text exists',async()=>{
  const audit=await runFontAuditCli(path.join(dir,'empty-stream.pdf')),font=audit.fonts.find(f=>f.usedGlyphCount===3);assert.equal(font.toUnicodeStatus,'malformed');assert.equal(font.mappedGlyphCount,0);assert.equal(font.unmappedCodes.length,3);assert.ok(audit.findings.some(f=>f.code==='TO_UNICODE_MALFORMED'));
 });
 await t.test('saved map tampering fails source replay',async()=>{const candidatePdf=path.join(dir,'tampered.pdf');await fixture('InvalidUnicodeFixture','mutate',path.join(dir,'partial-fixed.pdf'),candidatePdf);assert.equal((await repairFonts({sourcePdf:path.join(dir,'partial.pdf'),candidatePdf,repairUnicode:true})).verification.status,'fail');});
 await t.test('preservation proof must explicitly replay Unicode repairs',async()=>{
  const sourcePdf=path.join(dir,'partial.pdf'),candidatePdf=path.join(dir,'partial-fixed.pdf'),validationReport=path.join(dir,'controlled-validation.json');
  // Only isolates the preservation gate. This artificial input is not conformance evidence.
  await writeFile(validationReport,JSON.stringify({status:'completed',pdfSha256:sha(await readFile(candidatePdf)),isCompliant:true,overall:{status:'pass'},findings:[],fontAudit:{status:'ok'}}));
  const options={sourcePdf,candidatePdf,validationReport,outputPath:path.join(dir,'quality.json')};await assert.rejects(checkPdfPreservation({...options,repairUnicode:true}),/require font repair/);
  await assert.rejects(checkPdfPreservation({...options,repairUnicode:'false'}),/must be a boolean/);
  await assert.rejects(repairFonts({sourcePdf,candidatePdf,repairUnicode:'false'}),/must be a boolean/);
  assert.equal((await checkPdfPreservation({...options,fontRepairs:true})).disposition,'error');assert.equal((await checkPdfPreservation({...options,fontRepairs:true,repairUnicode:true})).disposition,'review_required');
 });
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));
});
