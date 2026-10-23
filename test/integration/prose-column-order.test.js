import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {analyzeLayout} from "../../modules/layout-analyzer/index.js";
import {buildSemanticDocument} from "../../modules/semantic-engine/index.js";
import {assignReadingOrder} from "../../modules/reading-order/index.js";
test("dense columns flow below a narrow centered title and subtitle",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"prose-order-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"stage.json");
  const block=(id,text,x,y,w,h=10)=>({id,text,bbox:[x,y,w,h],fontSize:h,fontName:"Helvetica"});
  const textBlocks=[block("title","SATELLITE",264,190,84,21),block("subtitle","Observing the magnetic Sun",217,246,178,14),
    ...Array.from({length:8},(_,i)=>block(`body${i}`,`${i%2?'Right':'Left'} column has a long line of continuous prose.`,i%2?318:63,271+Math.floor(i/2)*13,231)),
    block("footer-left","www.example.gov",63,737,90,9),block("footer-right","Publication 001",480,738,70,9)];
  await writeFile(file,JSON.stringify({schemaVersion:"1.0.0",documentId:"columns",source:{filePath:"source.pdf",pageCount:1},pages:[{pageNumber:1,width:612,height:792,textBlocks}]}));
  const layout=await analyzeLayout(file);assert.equal(layout.pages[0].columns,2);
  await writeFile(file,JSON.stringify(layout));const semantic=await buildSemanticDocument(file);
  await writeFile(file,JSON.stringify(semantic));const ordered=await assignReadingOrder(file);
  const byId=new Map(ordered.nodes.map(n=>[n.id,n]));
  assert.deepEqual(ordered.orderedNodeIds.map(id=>byId.get(id).sourceBlockId),["title","subtitle","body0","body2","body4","body6","body1","body3","body5","body7","footer-left","footer-right"]);
});
