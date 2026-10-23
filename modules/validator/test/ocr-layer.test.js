import test from "node:test";
import assert from "node:assert/strict";
import {matchesOcrGeometry,inspectOcrLayer} from "../ocr-layer.js";
const geometry=[0,0,612,792,0,0,612,792,0,1],quad=[10,10,110,10,110,20,10,20];
const run=()=>({pageNumber:1,operatorIndex:0,glyphStart:0,glyphEnd:2,glyphs:[[1,"A"],[2,"B"]],positions:[[100,0,0,10,10,772,.5,0],[100,0,0,10,60,772,.5,0]],renderingMode:3,fontEmbedded:true,glyphProgramsPresent:true,artifact:false});
test("OCR geometry verifies the full line and each advance, not just its endpoints",()=>{
 assert.equal(matchesOcrGeometry(run(),quad,geometry),true);
 for(const mutate of [r=>r.positions.pop(),r=>r.positions[1][4]++,r=>r.positions[1][2]++,r=>r.positions[0][7]=1,r=>r.positions[0][6]=-.5,r=>r.positions[0][0]=NaN]){
  const r=run();mutate(r);assert.equal(matchesOcrGeometry(r,quad,geometry),false);
 }
 assert.equal(matchesOcrGeometry(run(),quad),false);assert.equal(matchesOcrGeometry(run(),quad,[...geometry.slice(0,8),45,1]),false);
});
test("OCR suffix validation requires every declared line, exact Unicode, invisibility and an embedded font",()=>{
 const source={pages:[{geometry}],textRuns:[]},intendedNodes=[{id:"tag",n:{ocrSegments:[{pageNumber:1,sourceBlockId:"scan",text:"AB",quad}]}}];
 const check=inspection=>{const checks=[];const r=inspectOcrLayer({inspection,source,intendedNodes,add:(...v)=>checks.push(v)});return {...r,checks};};
 const inspection={pages:[{geometry}],textRuns:[run()]};const good=check(inspection);assert.equal(good.valid,true);assert.equal(good.owners.get("1:1"),"tag");assert.equal(good.nativeRuns.length,0);
 for(const mutate of [r=>r.glyphs[0][1]="a",r=>r.renderingMode=7,r=>r.fontEmbedded=false,r=>r.artifact=true,r=>r.glyphStart=1]) {
  const bad=structuredClone(inspection);mutate(bad.textRuns[0]);assert.equal(check(bad).valid,false);
 }
 assert.equal(check({...inspection,textRuns:[]}).valid,false);
 assert.equal(check({...inspection,textRuns:[run(),{...run(),glyphStart:2,glyphEnd:4}]}).valid,false);
 const bad=structuredClone(inspection);bad.pages[0].geometry[9]=2;assert.equal(check(bad).valid,false);
});
test("OCR font runs coalesce only inside one continuous and uniquely declared MCID",()=>{
 const source={pages:[{geometry}],textRuns:[]},intendedNodes=[{id:"tag",n:{ocrSegments:[{pageNumber:1,sourceBlockId:"scan",text:"AB",quad}]}}];
 const all=run(),first={...all,glyphEnd:1,glyphs:all.glyphs.slice(0,1),positions:all.positions.slice(0,1),owners:["one"]},
   second={...all,glyphStart:1,glyphs:all.glyphs.slice(1),positions:all.positions.slice(1),owners:["one"]};
 const inspection={pages:[{geometry}],markedContent:[{contentRef:"one",sequenceCount:1}],textRuns:[first,second]};
 const check=p=>inspectOcrLayer({inspection:p,source,intendedNodes,add:()=>{}}).valid;
 const snapshot=structuredClone(inspection);assert.equal(check(inspection),true);assert.deepEqual(inspection,snapshot);
 for(const patch of [{renderingMode:0},{fontEmbedded:false},{glyphProgramsPresent:false},{owners:["other"]},{glyphStart:2},{artifact:true}]){
   const bad=structuredClone(inspection);Object.assign(bad.textRuns[1],patch);assert.equal(check(bad),false);
 }
 for(const count of [0,2]){const bad=structuredClone(inspection);bad.markedContent[0].sequenceCount=count;assert.equal(check(bad),false);}
});
