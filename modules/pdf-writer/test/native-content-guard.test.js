import test from "node:test";
import assert from "node:assert/strict";
import {requireNativeTextOperators} from "../native-content-guard.js";
import {writeTaggedArtifacts} from "../index.js";
import {PDFDocument} from "pdf-lib";
import {mkdtemp,writeFile,readFile,access,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const node=(page,role="P",text="Recognized words")=>({pageNumber:page,role,text});
test("native writer requires operators on every intended text page, including mixed documents",()=>{
  const plan={pages:[{pageNumber:1,summary:{totalOperators:3}},{pageNumber:2,summary:{totalOperators:0}}]};
  assert.doesNotThrow(()=>requireNativeTextOperators(plan,{nodes:[node(1),node(2,"Artifact"),node(2,"Figure"),node(2,"Form"),node(2,"P","")]}));
  assert.throws(()=>requireNativeTextOperators(plan,{nodes:[node(1),node(2)]}),/page\(s\) 2.*OCR text layer/);
  assert.throws(()=>requireNativeTextOperators({pages:[]},{nodes:[node(3)]}),/page\(s\) 3/);
});
test("OCR needs its own declared line even when the page contains native operators",()=>{
 const semantic={nodes:[{...node(1),id:"ocr",textProvenance:"ocr",ocrSegments:[{sourceBlockId:"scan"}]}]},plan={pages:[{pageNumber:1,summary:{totalOperators:1}}]};
 assert.throws(()=>requireNativeTextOperators(plan,semantic),/explicit line geometry/);
 assert.doesNotThrow(()=>requireNativeTextOperators(plan,semantic,{root:{ocrSegments:[{pageNumber:1,sourceBlockId:"scan"}]}}));
});
test("auto and explicit native modes refuse empty text attachment without producing a candidate",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"native-no-text-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const pdf=await PDFDocument.create();pdf.addPage([612,792]).drawRectangle({x:40,y:100,width:200,height:50});
  const pdfPath=path.join(dir,"source.pdf"),semanticPath=path.join(dir,"semantic.json"),tagsPath=path.join(dir,"tags.json");
  const bytes=Buffer.from(await pdf.save());await writeFile(pdfPath,bytes);
  await writeFile(semanticPath,JSON.stringify({schemaVersion:"1.0.0",documentId:"ocr",source:{layoutDocumentId:"ocr"},nodes:[{id:"text",sourceBlockId:"b",pageNumber:1,role:"P",text:"Recognized words",textProvenance:"ocr",bbox:[40,642,200,20],confidence:.9}]}));
  await writeFile(tagsPath,JSON.stringify({schemaVersion:"1.0.0",documentId:"tags",source:{semanticDocumentId:"ocr"},root:{id:"root",type:"Document",children:[{id:"text",type:"P",sourceNodeIds:["text"],children:[]}]}}));
  for (const mode of ["auto","native"]) {
    const outputPath=path.join(dir,mode+".pdf");
    await assert.rejects(writeTaggedArtifacts({pdfPath,semanticPath,tagsPath,outputPath,mode}),/no text operators.*OCR text layer/);
    await assert.rejects(access(outputPath));
  }
  assert.deepEqual(await readFile(pdfPath),bytes);
});
