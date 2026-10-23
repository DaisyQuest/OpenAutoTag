import test from "node:test";
import assert from "node:assert/strict";
import {mergeWithStrategy} from "../index.js";
const n=(id,text,x,y,w,part,pair="a")=>({id,sourceBlockId:`b-${id}`,text,rawText:text,comparisonText:text,role:"P",pageNumber:1,bbox:[x,y,w,12],fontSize:12,
 ...(part?{labelValuePairId:pair,labelValuePart:part,paragraphGroupId:`paired:${pair}:${part}`}:{})});
for(const strategy of ["pairwise","text-structure"]) {
 test(`${strategy} keeps pair identities, word fragments, wrapped values and relationship targets`,()=>{
  const nodes=[n("a","IM",40,90.00001,12,"label"),n("b","U",52,89.99999,6,"label"),
   n("c","Inertial Measure",130,90,90,"value"),n("d","ment",220,90,24,"value"),n("e","Unit",130,105,24,"value"),
   n("f","IPS",40,120,18,"label","f"),n("g","Interplanetary Shock",130,120,180,"value","f"),n("h","unrelated paragraph",40,135,210)];
  const d=mergeWithStrategy({nodes,relations:[{type:"precedes",from:"b",to:"c"},{type:"precedes",from:"e",to:"f"}]},{strategy}).document;
  assert.deepEqual(d.nodes.map(n=>n.text),["IMU","Inertial Measurement Unit","IPS","Interplanetary Shock","unrelated paragraph"]);
  assert.deepEqual(d.relations.map(r=>[r.from,r.to]),[["a","c"],["c","f"]]);
  assert.equal(d.nodes[1].comparisonText,"Inertial Measurement Unit");assert.equal(d.nodes[1].rawText,"Inertial Measure\nment\nUnit");
  assert.deepEqual(d.nodes.flatMap(n=>n._mergedFrom||[n.id]).sort(),nodes.map(n=>n.id).sort());
  assert.equal(d.nodes[0].paragraphGroupId,"paired:a:label");
 });
 test(`${strategy} preserves authored whitespace and explicit groups across three lines`,()=>{
  const parts=[n("a","Space ",130,90,36,"value"),n("b","Launch",166,90,36,"value"),n("c","Complex",130,105,42,"value")];
  assert.equal(mergeWithStrategy({nodes:parts},{strategy}).document.nodes[0].text,"Space Launch Complex");
  const partial=[{...n("a","Space Launch",130,90,72,"value"),_mergedFrom:["a","absorbed"]},n("c","Complex",130,105,42,"value")];
  assert.equal(mergeWithStrategy({nodes:partial},{strategy}).document.nodes[0].text,"Space Launch Complex");
  const lines=[0,1,2].map(i=>({...n(`${i}`,"continuing",40,90+i*15,120),paragraphGroupId:"explicit"}));
  const d=mergeWithStrategy({nodes:lines},{strategy}).document;assert.equal(d.nodes.length,1);assert.equal(d.nodes[0].paragraphGroupId,"explicit");
 });
}
