import test from "node:test";
import assert from "node:assert/strict";
import { textEvidence, alignOcrText, imageEvidence } from "../content-evidence.js";
test("raw ligatures and discretionary hyphens stay intact while comparison text is separate",()=>{
 const text="ofﬁce\u00ad  text";const b=textEvidence({text,bbox:[0,0,100,12]},"native");assert.equal(b.rawText,text);assert.equal(b.text,text);assert.equal(b.comparisonText,"office\u00ad text");
});
test("OCR overlap preserves native text, exposes conflict, and adds only separate regions",()=>{
 const native=[{id:"a",text:"Native",bbox:[0,0,100,12]}];
 const ocr=[{text:"Native",bbox:[0,0,100,12]},{text:"Wrong",bbox:[0,0,100,12]},{text:"New",bbox:[0,50,100,12]}];
 const r=alignOcrText(native,ocr);assert.deepEqual(r.blocks.map(b=>b.text),["Native","New"]);assert.equal(r.suppressed,2);assert.equal(r.conflicts.length,1);assert.equal(r.blocks[1].textProvenance,"ocr");
 assert.equal(alignOcrText(Array(1500).fill(native[0]),Array(1500).fill(ocr[0])).conflicts[0].code,"OCR_ALIGNMENT_LIMIT");
});
test("image evidence handles transforms, forms, masks and bounded graphics stacks",()=>{
 const OPS={save:1,restore:2,transform:3,paintImageXObject:4,paintFormXObjectBegin:5,paintFormXObjectEnd:6,paintInlineImageXObject:7,paintImageMaskXObject:8};
 const viewport={width:600,height:800,transform:[1,0,0,-1,0,800]};
 const r=imageEvidence({fnArray:[1,3,4,2,5,8,6],argsArray:[[],[100,0,0,50,20,600],["i"],[],[[20,0,0,10,40,500]],[],[]]},OPS,viewport,1);
 assert.deepEqual(r.map(r=>r.bbox),[[20,150,100,50],[40,290,20,10]]);
 assert.throws(()=>imageEvidence({fnArray:[2],argsArray:[[]]},OPS,viewport,1),/Unbalanced/);
 assert.throws(()=>imageEvidence({fnArray:Array(129).fill(1),argsArray:Array(129).fill([])},OPS,viewport,1),/limit/);
});
