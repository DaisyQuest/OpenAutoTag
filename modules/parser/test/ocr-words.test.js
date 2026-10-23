import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecognizedTextBlocks } from "../ocr-pipeline.js";
const variant = {coordinateSpace:"crop-display-points",imageWidth:1000,imageHeight:500,pdfWidth:500,pdfHeight:250,pixelToDisplay:[.5,0,0,.5,0,0],name:"test"};
const box={x0:20,y0:20,x1:800,y1:50};
const word=(text,confidence=90,bbox=box)=>({text,confidence,bbox});
const recognize=(text,words,rotation=0)=>normalizeRecognizedTextBlocks({rotateRadians:rotation,blocks:[{lines:[{text,words,bbox:box}]}]},variant,1,"test")[0].ocrRecognition;
test("word confidence, repeated-token offsets and mapped deskew geometry survive normalization",()=>{
 const r=recognize("  café  café ★ ", [word("café",99),word("café",42),word("★",undefined)],.01);
 assert.equal(r.originalText,"café café ★");assert.equal(r.alignment,"complete");assert.deepEqual(r.range,[0,11]);
 assert.deepEqual(r.words.map(w=>[w.start,w.end]),[[0,4],[5,9],[10,11]]);
 assert.equal(r.words[1].confidence,42);assert.equal(r.words[0].geometryStatus,"mapped");assert.notEqual(r.words[0].quad[1],10);
});
test("missing, unmatched or incomplete word evidence never invents aligned ranges",()=>{
 for(const [words,state] of [[undefined,"unavailable"],[[],"unavailable"],[[word("unrelated")],"unresolved"],[[word("first")],"unresolved"],[[word("first"),word("")],"unresolved"]]){
  const r=recognize("first second",words);assert.equal(r.alignment,state);assert.ok(r.words.every(w=>w.start===undefined&&w.end===undefined));
 }
});
test("invalid word confidence and geometry remain explicitly unknown",()=>{
 for(const confidence of [undefined,null,NaN,-1,101,"99"]){
  const w={text:"word",confidence,bbox:{...box,x1:1001}},r=recognize("word",[w]);
  assert.equal(r.words[0].confidence,undefined);assert.equal(r.words[0].geometryStatus,"unavailable");assert.equal(r.words[0].quad,undefined);
 }
});
test("word alignment preserves punctuation and UTF-16 offsets without normalizing ligatures",()=>{
 const r=recognize("😀 fi ﬁ",[word("😀"),word("fi"),word("ﬁ")]);
 assert.deepEqual(r.words.map(w=>[w.start,w.end]),[[0,2],[3,5],[6,7]]);
 assert.equal(recognize("ﬁ",[word("fi")]).alignment,"unresolved");
 assert.throws(()=>recognize("x".repeat(32769),[]),/bounded/);
 assert.throws(()=>recognize("x",Array(4097).fill(word("x"))),/bounded/);
});
