import test from "node:test";
import assert from "node:assert/strict";
import {inferRunningContent} from "../running-content.js";
const pages=Array.from({length:4},(_,i)=>({pageNumber:i+1,width:600,height:800}));
const node=(page,id,text,y,extra={})=>({id:`${page}-${id}`,text,pageNumber:page,role:"P",fontSize:10,fontName:"ABCDEF+Helvetica",bbox:[50,y,100,10],...extra});
const body=page=>node(page,"body","Repeated body text is meaningful.",100,{fontSize:12,bbox:[50,100,450,620]});
test("pagination follows decimal/Roman sequences across varying left/right positions and baselines",()=>{
 for(const labels of [["1","2","3","4"],["i","ii","iii","iv"],["IX","X","XI","XII"],["Page 1 of 4","Page 2 of 4","Page 3 of 4","Page 4 of 4"]]) {
  const nodes=pages.flatMap((p,i)=>[body(p.pageNumber),node(p.pageNumber,"counter",labels[i],760+i,{bbox:[i%2?530:50,760+i,40,10]})]);
  const before=nodes.map(n=>[n.id,n.text,n.bbox]);const r=inferRunningContent(nodes,pages);
  assert.equal(r.marked,4);assert.ok(nodes.filter(n=>n.role==="Artifact").every(n=>n.artifactType==="footer"));
  assert.deepEqual(nodes.map(n=>[n.id,n.text,n.bbox]),before);assert.equal(r.tasks.length,4);
  assert.equal(inferRunningContent(nodes,pages).marked,0);
 }
});
test("repeated detached margin strings become artifacts while repeated headings and body remain",()=>{
 const nodes=pages.flatMap(p=>[body(p.pageNumber),node(p.pageNumber,"header","Technical Report",5),
  node(p.pageNumber,"heading","Results",70,{role:"H2",fontSize:14}),node(p.pageNumber,"section","OBJECTIVES",40,{fontName:"Helvetica-Bold",fontSize:12})]);
 const r=inferRunningContent(nodes,pages);assert.equal(r.marked,4);
 assert.ok(nodes.filter(n=>n.id.endsWith("body")).every(n=>n.role==="P"));assert.ok(nodes.filter(n=>n.id.endsWith("heading")).every(n=>n.role==="H2"));
 assert.ok(nodes.filter(n=>n.id.endsWith("section")).every(n=>n.role==="P"));
});
test("constant years, sequence outliers, invalid Roman and insufficient pages remain content",()=>{
 for(const labels of [["2026","2026","2026","2026"],["1","3","5","7"],["IC","IC","IC","IC"],["Page 5 of 4","Page 6 of 4","Page 7 of 4","Page 8 of 4"]]) {
  const nodes=pages.flatMap((p,i)=>[body(p.pageNumber),node(p.pageNumber,"counter",labels[i],760)]);
  // Invalid numeric tokens must not fall back to repeated ordinary margin text.
  assert.equal(inferRunningContent(nodes,pages).marked,0,labels.join(","));
 }
 const nodes=pages.slice(0,2).flatMap(p=>[body(p.pageNumber),node(p.pageNumber,"counter",String(p.pageNumber),760)]);
 assert.equal(inferRunningContent(nodes,pages).marked,0);
 const crowded=Array.from({length:10001},(_,i)=>node(1,String(i),"text",100));
 assert.deepEqual(inferRunningContent(crowded,[pages[0]]),{tasks:[{code:"RUNNING_CONTENT_INFERENCE_LIMIT",pageNumber:1}],marked:0});
 const blank=pages.flatMap((p,i)=>[...(i<3?[body(p.pageNumber)]:[]),node(p.pageNumber,"counter",String(p.pageNumber),760)]);
 assert.equal(inferRunningContent(blank,pages).marked,4,"blank separator inherits an established sequence");
 const cards=pages.map(p=>node(p.pageNumber,"counter",String(p.pageNumber),760));
 assert.equal(inferRunningContent(cards,pages).marked,0,"number-only cards are real content");
 const large=pages.flatMap(p=>[body(p.pageNumber),node(p.pageNumber,"numbered-heading",String(p.pageNumber),20,{role:"H1",fontSize:24,bbox:[50,20,50,24]})]);
 assert.equal(inferRunningContent(large,pages).marked,0);
});
test("protect forms, tables, semantic groups, links, OCR and adjacent footnote text",()=>{
 for(const patch of [{formFieldIds:["w"]},{tableId:"t"},{semanticRole:"Footnote"},{footnoteGroupId:"f"},{labelValuePairId:"pair"},
  {paragraphGroupId:"p"},{textProvenance:"ocr"},{textRotation:90},{writingMode:"vertical"},{text:"www.example.gov"},{text:"Contact us"}]) {
  const nodes=pages.flatMap(p=>[body(p.pageNumber),node(p.pageNumber,"counter",String(p.pageNumber),760,patch)]);
  assert.equal(inferRunningContent(nodes,pages).marked,0,JSON.stringify(patch));
 }
 const nodes=pages.flatMap(p=>[body(p.pageNumber),node(p.pageNumber,"marker",String(p.pageNumber),760,{bbox:[50,760,6,10]}),node(p.pageNumber,"note","Footnote explanation",760,{bbox:[60,760,300,10]})]);
 assert.equal(inferRunningContent(nodes,pages).marked,0);
 const prompts=pages.flatMap(p=>[body(p.pageNumber),node(p.pageNumber,"prompt","Required name",760)]);
 assert.equal(inferRunningContent(prompts,pages.map(p=>({...p,formFields:[{id:'field',bbox:[160,755,160,20]}]}))).marked,0);
});
