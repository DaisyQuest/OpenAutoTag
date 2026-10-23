import test from "node:test";
import assert from "node:assert/strict";
import {inferLabelValuePairs, visualRows} from "../label-value-pairs.js";
const n=(id,text,x,y,w=40,extra={})=>({id,text,role:"P",pageNumber:1,bbox:[x,y,w,12],fontSize:12,columnHint:0,...extra});
const pairs=()=>[n("a","IMPACT",40,90,42),n("b","In-situ measurement",130,90,170),n("c","Transients",130,105,80),
 n("d","U",52,120,6),n("e","Inertial Measurement Unit",130,120,180),n("f","IM",40,120.00001,12)];

test("repeated aligned labels protect wrapped values and split acronyms before quotation inference",()=>{
 const nodes=pairs(), result=inferLabelValuePairs(nodes);
 assert.equal(result.pairs,2);assert.equal(nodes[0].labelValuePart,"label");assert.equal(nodes[2].labelValuePart,"value");
 assert.equal(nodes[1].paragraphGroupId,nodes[2].paragraphGroupId);assert.equal(nodes[3].paragraphGroupId,nodes[5].paragraphGroupId);
 assert.notEqual(nodes[1].paragraphGroupId,nodes[3].paragraphGroupId);
 assert.ok(result.relations.some(r=>r.from==="c"&&r.to==="f"));assert.ok(result.relations.some(r=>r.from==="f"&&r.to==="d"));
 assert.deepEqual(nodes.map(n=>n.role),Array(6).fill("P"));
});
test("a colon qualifies one pair; mixed case abbreviations need nearby independent anchors",()=>{
 assert.equal(inferLabelValuePairs([n("a","Mass:",40,90),n("b","100 kg",130,90)]).pairs,1);
 const weak=[n("a","bps",40,90),n("b","Bits per second",130,90),n("c","CalTech",40,105,55),n("d","California Institute",130,105,170)];
 assert.equal(inferLabelValuePairs(weak).pairs,0);
 const nodes=[...weak,...pairs().map(n=>({...n,id:`z${n.id}`,bbox:[n.bbox[0],n.bbox[1]+50,...n.bbox.slice(2)]}))];
 assert.equal(inferLabelValuePairs(nodes).pairs,4);
});
test("tables, forms, quotes, explicit paragraphs and unsupported geometry are excluded",()=>{
 for(const patch of [{tableId:"t"},{formFieldIds:["w"]},{semanticRole:"Code"},{footnoteGroupId:"f"},{blockQuoteGroupId:"q"},
  {paragraphGroupId:"authored"},{artifactType:"Header"},{role:"H2"},{writingMode:"vertical"},{textRotation:90},{textProvenance:"ocr"},{direction:"rtl"}]) {
  const nodes=pairs().map(n=>({...n,...patch}));assert.equal(inferLabelValuePairs(nodes).pairs,0,JSON.stringify(patch));
 }
 for(const patch of [{columnHint:1},{regionId:"different"},{fontSize:30},{bbox:[85,90,80,12]}]) {
  const nodes=[n("a","Mass:",40,90,40,{regionId:"one"}),n("b","100 kg",130,90,80,patch)];
  assert.equal(inferLabelValuePairs(nodes).pairs,0,JSON.stringify(patch));
 }
 assert.equal(inferLabelValuePairs([n("a","Ordinary",40,90),n("b","prose",130,90),n("c","Another",40,105),n("d","column",130,105)]).pairs,0);
 assert.equal(inferLabelValuePairs([n("a","ABC",40,90),n("b","Definition",130,90)]).pairs,0);
});
test("continuations stop at intervening roles, distant lines and conflicting geometry",()=>{
 for(const patch of [{role:"H2"},{columnHint:1},{fontSize:24},{bbox:[130,200,80,12]},{bbox:[40,105,80,12]}]) {
  const nodes=[n("a","Mass:",40,90),n("b","100 kg",130,90),n("c","continuation",130,105,80,patch)];
  assert.equal(inferLabelValuePairs(nodes).pairs,1);assert.equal(nodes[2].labelValuePairId,undefined);
 }
});
test("baseline clustering is anchored rather than chained and bounds crowded pages",()=>{
 assert.deepEqual(visualRows([n("a","a",40,90),n("b","b",70,93),n("c","c",90,96)]).map(r=>r.map(n=>n.id)),[["a","b"],["c"]]);
 const nodes=Array.from({length:10001},(_,i)=>n(String(i),"X",40,i));
 assert.deepEqual(inferLabelValuePairs(nodes),{relations:[],pairs:0,limited:true});assert.equal(nodes[0].labelValuePairId,undefined);
});
