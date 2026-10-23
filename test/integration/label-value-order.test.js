import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {buildSemanticDocument} from "../../modules/semantic-engine/index.js";
import {mergeWithStrategy} from "../../modules/paragraph-merger/index.js";
import {assignReadingOrder} from "../../modules/reading-order/index.js";
import {buildTagTree} from "../../modules/tag-builder/index.js";

test("semantic inference through final tags keeps acronym pairs in row order without false quotations",async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"label-values-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,"stage.json");
 const b=(id,text,x,y,w=60)=>({id,text,bbox:[x,y,w,12],fontSize:12,fontName:"Helvetica",blockType:"paragraph",columnHint:0});
 const blocks=[b("title","Acronyms",40,40,120),b("definition","In-situ measurement",130,90,170),b("label","IMPACT",40,90,45),
  b("wrap","Transients",130,105,80),b("fragment","U",52,120,6),b("value","Inertial Measurement Unit",130,120,170),b("label2","IM",40,120.00001,12),
  b("label3","bps",40,135,18),b("value3","Bits per second",130,135,100),b("last","End of definitions.",40,170,180)];
 blocks[0].blockType="heading";blocks[0].headingLevel=1;
 await writeFile(file,JSON.stringify({schemaVersion:"1.0.0",documentId:"pairs",source:{filePath:"source.pdf"},pages:[{pageNumber:1,width:612,height:792,textBlocks:blocks}]}));
 const source=await buildSemanticDocument(file);
 assert.ok(source.nodes.filter(n=>n.labelValuePairId).every(n=>!n.blockQuoteGroupId));
 for(const strategy of ["pairwise","text-structure"]) {
  const {document:merged}=mergeWithStrategy(structuredClone(source),{strategy});await writeFile(file,JSON.stringify(merged));
  const ordered=await assignReadingOrder(file),byId=new Map(ordered.nodes.map(n=>[n.id,n]));
  assert.deepEqual(ordered.orderedNodeIds.map(id=>byId.get(id).text),["Acronyms","IMPACT","In-situ measurement Transients","IMU","Inertial Measurement Unit","bps","Bits per second","End of definitions."]);
  await writeFile(file,JSON.stringify(ordered));const tags=await buildTagTree(file);
  const leaves=[],walk=n=>{if(n.type==="P")leaves.push(n.label);for(const c of n.children||[])walk(c);};walk(tags.root);
  assert.deepEqual(leaves,ordered.orderedNodeIds.slice(1).map(id=>byId.get(id).text));
  assert.equal(JSON.stringify(tags).includes('"BlockQuote"'),false);
 }
 for(const missing of ["labelValuePairId","labelValuePart"]) {
  const malformed=structuredClone(source);delete malformed.nodes.find(n=>n.labelValuePairId)[missing];
  await writeFile(file,JSON.stringify(malformed));await assert.rejects(assignReadingOrder(file),/schema validation/);
 }
});
