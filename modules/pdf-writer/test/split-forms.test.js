import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFString } from "pdf-lib";
import { createListFormFixture } from "./fixtures/list-form-fixture.js";
import { repairStructure } from "../structure-repair.js";
import { inspectPdfLowLevel } from "../../../scripts/inspect-pdf-low-level.js";
import { checkPdfPreservation } from "../../../scripts/check-pdf-preservation.js";

const n=PDFName.of;
test("split distinct widgets only with reciprocal ownership; verify all saved changes",async(t)=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"split-forms-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const variant of ["valid","scalar","described","attributed","wrong-slot","duplicate-objr","wrong-page","mixed-content"])await t.test(variant,async()=>{
    const folder=path.join(dir,variant);await mkdir(folder);const input=await createListFormFixture(folder,"multi-widget");
    const doc=await PDFDocument.load(await readFile(input.pdfPath)), form=doc.context.lookup(input.refs.forms[0],PDFDict);
    const tree=doc.catalog.lookup(n("StructTreeRoot"),PDFDict),nums=tree.lookup(n("ParentTree"),PDFDict).lookup(n("Nums"),PDFArray);
    if(variant==="scalar")doc.context.lookup(input.refs.item,PDFDict).set(n("K"),input.refs.forms[0]);
    if(variant==="described")form.set(n("Alt"),PDFString.of("Authored group"));
    if(variant==="attributed")form.set(n("A"),doc.context.obj({O:"PrintField",Role:"cb"}));
    if(variant==="wrong-slot")nums.set(5,input.refs.heading);
    const kids=form.lookup(n("K"),PDFArray);
    if(variant==="duplicate-objr")kids.push(kids.get(0));
    if(variant==="wrong-page")kids.lookup(1,PDFDict).set(n("Pg"),doc.addPage().ref);
    if(variant==="mixed-content")kids.push(doc.context.obj(2));
    await writeFile(input.pdfPath,await doc.save());
    const sourcePdf=input.pdfPath,outputPdf=path.join(folder,"candidate.pdf");
    const audit=await repairStructure({sourcePdf,outputPdf,splitForms:true}), applied=["valid","scalar"].includes(variant);
    assert.equal(audit.repairLedger.some(r=>r.ruleId==="split-independent-form-widgets" && r.decision==="apply"),applied);
    assert.deepEqual(await repairStructure({sourcePdf,candidatePdf:outputPdf,splitForms:true}),audit);
    const source=await inspectPdfLowLevel({pdfPath:sourcePdf,preservation:true}),candidate=await inspectPdfLowLevel({pdfPath:outputPdf,preservation:true});
    for(const key of ["pages","fields","links","headings"])assert.deepEqual(candidate[key],source[key]);
    for(const [key,old] of Object.entries(source.widgets))assert.equal(candidate.widgets[key].digest,old.digest);
    const again=await repairStructure({sourcePdf:outputPdf,outputPdf:path.join(folder,"again.pdf"),splitForms:true});
    assert.equal(again.sourceHash,again.candidateHash);
    if(variant==="valid"){
      assert.equal(Object.values(candidate.widgets).flatMap(w=>w.owners).length,2);
      assert.equal(new Set(Object.values(candidate.widgets).flatMap(w=>w.owners.map(o=>o.form))).size,2);
      const validationReport=path.join(folder,"validation.json");await writeFile(validationReport,JSON.stringify({status:"completed",isCompliant:true,pdfSha256:audit.candidateHash,overall:{status:"pass"},findings:[],fontAudit:{status:"ok"}}));
      const quality=await checkPdfPreservation({sourcePdf,candidatePdf:outputPdf,validationReport,outputPath:path.join(folder,"quality.json"),structureRepairs:true});
      assert.ok(quality.checks.every(c=>c.status==="pass"),JSON.stringify(quality));
      const strict=await checkPdfPreservation({sourcePdf,candidatePdf:outputPdf,validationReport,outputPath:path.join(folder,"strict.json")});
      assert.equal(strict.disposition,"rejected");assert.ok(strict.findings.some(f=>f.code==="WIDGET_OWNER_CHANGED"));
      const changed=await PDFDocument.load(await readFile(outputPdf));changed.getForm().getTextField("details").setText("Unexpected");
      const changedPdf=path.join(folder,"changed.pdf");await writeFile(changedPdf,await changed.save());
      await assert.rejects(repairStructure({sourcePdf,candidatePdf:changedPdf,splitForms:true}),/Unexpected saved-object change/);
      const rejected=await checkPdfPreservation({sourcePdf,candidatePdf:changedPdf,validationReport,outputPath:path.join(folder,"rejected.json"),structureRepairs:true});
      assert.equal(rejected.disposition,"error");
    }
  });
});
