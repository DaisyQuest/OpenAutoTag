import test from "node:test";
import assert from "node:assert/strict";
import { detectProseColumns } from "../prose-columns.js";
const page={width:612,height:792};
const lines=()=>Array.from({length:6},(_,i)=>({id:String(i),blockType:"paragraph",text:"Long prose across a full line in this narrow column.",bbox:[i%2?318:63,270+Math.floor(i/2)*14,231,10]}));
test("repeated prose gutter survives centered title and input permutations",()=>{
  const blocks=[...lines(),{blockType:"heading",text:"Title",bbox:[264,190,84,21]}];
  const found=detectProseColumns(page,blocks);
  assert.equal(found.count,2);assert.equal(found.splitX,306);
  assert.deepEqual(detectProseColumns(page,[...blocks].reverse()),found);
});
test("gutter inference abstains for forms, sparse pairs, narrow cells and crossing prose",()=>{
  assert.equal(detectProseColumns({...page,formFields:[{}]},lines()),null);
  assert.equal(detectProseColumns(page,lines().slice(0,4)),null);
  assert.equal(detectProseColumns(page,lines().map(b=>({...b,bbox:[...b.bbox.slice(0,2),60,10]}))),null);
  assert.equal(detectProseColumns(page,[...lines(),{blockType:"paragraph",text:"Across",bbox:[63,285,486,10]}]),null);
  assert.equal(detectProseColumns(page,lines().map(b=>({...b,blockType:"table-cell"}))),null);
});
