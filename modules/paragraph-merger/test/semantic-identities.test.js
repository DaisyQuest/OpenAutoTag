import test from "node:test";
import assert from "node:assert/strict";
import { mergeWithStrategy } from "../index.js";
const node=(id,text,y,extra={})=>({id,sourceBlockId:`source-${id}`,text,rawText:text,comparisonText:text,role:"P",pageNumber:1,bbox:[72,y,240,12],fontSize:12,...extra});
for(const strategy of ["pairwise","text-structure"]) {
 test(`${strategy} preserves OCR lines and cannot merge them with native text`,()=>{
  const a=node("a","This line continues",100,{textProvenance:"ocr",ocrSegments:[{sourceBlockId:"a",text:"This line continues",geometry:{quad:[1,2,3,4,5,6,7,8]}}]}),
    b=node("b","onto this one",114,{textProvenance:"ocr",ocrSegments:[{sourceBlockId:"b",text:"onto this one",geometry:{quad:[11,12,13,14,15,16,17,18]}}]});
  const merged=mergeWithStrategy({nodes:[a,b]},{strategy}).document.nodes;assert.equal(merged.length,1);
  assert.deepEqual(merged[0].ocrSegments,[...a.ocrSegments,...b.ocrSegments]);
  assert.equal(mergeWithStrategy({nodes:[a,{...b,textProvenance:"native",ocrSegments:undefined}]},{strategy}).document.nodes.length,2);
 });
 test(`${strategy} remaps merged node relationships and retains original text identities`,()=>{
  const source={nodes:[node("a","This line continues",100),node("b","onto this one",114),node("h","Next heading",150,{role:"H2"})],
   relations:[{type:"continues",from:"a",to:"b",evidence:"explicit"},{type:"precedes",from:"b",to:"h",evidence:"explicit"}],
   orderedNodeIds:["a","b","h"],regions:[{nodeIds:["a","b","h"]}],formRelationships:[{id:"field",labels:["b"],widgets:[{id:"w",labelNodeIds:["b"],instructionNodeIds:["a","b"],contextNodeIds:["b"],labelAssociation:{kind:"compound-date",component:"day",groupWidgetIds:["w","m","y"],evidence:"fixture"}}]}],semanticReviewTasks:[{code:"REVIEW",nodeId:"b",candidates:["b"]}]};
  const {document:d}=mergeWithStrategy(source,{strategy});assert.equal(d.nodes.length,2);
  const merged=d.nodes.find(n=>n.id==="a");assert.deepEqual(merged.sourceBlockIds,["source-a","source-b"]);assert.equal(merged.rawText,"This line continues\nonto this one");
  assert.deepEqual(d.orderedNodeIds,["a","h"]);assert.deepEqual(d.relations,[{type:"precedes",from:"a",to:"h",evidence:"explicit"}]);assert.deepEqual(d.regions[0].nodeIds,["a","h"]);assert.deepEqual(d.formRelationships[0].widgets[0].labelNodeIds,["a"]);assert.equal(d.semanticReviewTasks[0].nodeId,"a");
  assert.deepEqual(d.formRelationships[0].widgets[0].instructionNodeIds,["a"]);
  assert.deepEqual(d.formRelationships[0].widgets[0].contextNodeIds,["a"]);
  assert.deepEqual(d.formRelationships[0].widgets[0].labelAssociation.groupWidgetIds,["w","m","y"]);
 });
 test(`${strategy} respects tables, regions, forms, columns, quotes and explicit paragraphs`,()=>{
  for(const patch of [{tableId:"table"},{regionId:"other"},{formFieldIds:["w"]},{columnHint:1},{semanticRole:"Caption"},{blockQuoteGroupId:"quote"},{paragraphGroupId:"other"}]) {
   const a=node("a","First line continues",100,{regionId:"one",paragraphGroupId:"p"}),b=node("b","on next line",114,{regionId:"one",paragraphGroupId:"p",...patch});
   assert.equal(mergeWithStrategy({nodes:[a,b]},{strategy}).document.nodes.length,2,JSON.stringify(patch));
  }
  assert.equal(mergeWithStrategy({nodes:[node("a","Text",100),node("h","Heading",114,{role:"H2"}),node("b","next",128)]},{strategy}).document.nodes.length,3);
  assert.equal(mergeWithStrategy({nodes:[node("a","Page 1 of 2",100),node("b","Other text",114)]},{strategy}).document.nodes.length,2);
 });
}

test('different explicit caption targets are protected semantic boundaries', async () => {
  const {protectedBoundary}=await import('../lib/semantic-identities.js');
  assert.equal(protectedBoundary({captionForId:'table1'},{captionForId:'table2'}),'caption target boundary');
  assert.equal(protectedBoundary({captionForId:'table1'},{}),'caption target boundary');
});
