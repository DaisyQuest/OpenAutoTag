import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {applyOcrReview} from "../../modules/tag-builder/ocr-review.js";
import {inspectOcrReview} from "../../modules/validator/ocr-review.js";
import {appendOcrReviewTask} from "../../orchestrator/ocr-review-quality.js";
const hash=v=>createHash("sha256").update(v).digest("hex"),sourceHash="a".repeat(64);
test("module-local OCR contract copies remain identical across public boundaries",()=>{
 const schema=name=>JSON.parse(readFileSync(new URL(`../../contracts/${name}.schema.json`,import.meta.url)));
 const layout=schema("layout").properties.pages.items.properties.textBlocks.items.properties.ocrRecognition;
 const semantic=schema("semantic").properties.nodes.items.properties.ocrSegments.items.properties.recognition;
 const tags=schema("tagging"),recognition=tags.$defs.tagNode.properties.ocrSegments.items.properties.recognition;
 const saved=schema("saved-semantics").properties.ocrReview.properties.segments.items.properties.recognition;
 assert.deepEqual(layout,semantic);assert.deepEqual(semantic,recognition);assert.deepEqual(recognition,saved);
 const {$schema,$id,title,description,...review}=schema("ocr-review");assert.deepEqual(tags.properties.ocrReview.properties.review,review);
});
const entry=(text="first word",extra={})=>({pageNumber:1,sourceBlockId:"line-1",text,quad:[10,10,100,10,100,20,10,20],...extra});
function fixture(){
 const tagging={schemaVersion:"1.0.0",documentId:"test",source:{semanticDocumentId:"test"},root:{id:"root",type:"Document",children:[{id:"p",type:"P",label:"first word first word",children:[{id:"span",type:"Span",label:"first word first word",actualText:"first word\nfirst word",ocrSegments:[entry(),entry("first word",{sourceBlockId:"line-2"})],children:[]}]}]}};
 const tagsBytes=JSON.stringify(tagging),review={schemaVersion:"1.0.0",sourceHash,intentHash:hash(tagsBytes),reviewer:"Fixture reviewer",evidence:"Authored test evidence, not a real approval",decisions:[{tagId:"span",segmentIndex:1,pageNumber:1,sourceBlockId:"line-2",expectedText:"first word",text:"second word",decision:"correct"}]};
 return {tagging,tagsBytes,review};
}
const apply=({tagsBytes,review})=>applyOcrReview({tagsBytes,sourceHash,reviewBytes:JSON.stringify(review)});
const inspect=(tagging,extra={})=>{const checks=[];const report=inspectOcrReview({tagging,sourceHash,ownershipStatus:"verified",add:(...c)=>checks.push(c),...extra});return{report,checks};};
test("review corrects only the exact line occurrence and matching replacement metadata",()=>{
 const f=fixture(),out=apply(f),span=out.root.children[0].children[0];
 assert.equal(span.actualText,"first word\nsecond word");assert.equal(span.label,"first word second word");assert.equal(out.root.children[0].label,span.label);
 assert.equal(span.ocrSegments[0].text,"first word");assert.equal(span.ocrSegments[1].text,"second word");
 assert.deepEqual(span.ocrSegments.map(s=>s.quad),f.tagging.root.children[0].children[0].ocrSegments.map(s=>s.quad));
 assert.equal(f.tagging.root.children[0].children[0].actualText,"first word\nfirst word");
 const {report,checks}=inspect(out);assert.equal(report.pending,1);assert.equal(report.recorded,1);assert.ok(checks.every(c=>c[2]===c[3]));
});
test("stale hashes, identity, expected text, duplicates and inconsistent decisions reject",()=>{
 for(const mutate of [f=>f.review.sourceHash="b".repeat(64),f=>f.review.intentHash="b".repeat(64),f=>f.review.decisions[0].tagId="missing",f=>f.review.decisions[0].pageNumber=2,f=>f.review.decisions[0].sourceBlockId="other",f=>f.review.decisions[0].expectedText="changed",f=>f.review.decisions.push({...f.review.decisions[0]}),f=>f.review.decisions[0].decision="confirm",f=>f.review.decisions[0].text=" ",f=>f.review.decisions[0].text="bad\u0000",f=>f.review.reviewer=" ",f=>f.review.decisions[0].quad=[]]){
  const f=fixture();mutate(f);assert.throws(()=>apply(f),/OCR|contract/);
 }
});
test("ambiguous ActualText cannot be rewritten and reviews cannot silently chain",()=>{
 const f=fixture();f.tagging.root.actualText="Unrelated replacement";f.tagsBytes=JSON.stringify(f.tagging);f.review.intentHash=hash(f.tagsBytes);
 assert.throws(()=>apply(f),/safely map/);
 const g=fixture(),out=apply(g);assert.throws(()=>apply({...g,tagsBytes:JSON.stringify(out)}),/already attached/);
});
test("high confidence never closes review, unknown evidence remains open and recorded decisions stay source-bound",()=>{
 const f=fixture(),span=f.tagging.root.children[0].children[0];span.ocrSegments[0].confidence=100;
 let r=inspect(f.tagging).report;assert.equal(r.pending,2);assert.equal(r.recorded,0);assert.ok(r.segments[0].reasons.includes("word_confidence_unknown"));
 const out=apply(fixture());r=inspect(out,{ownershipStatus:"not_provided"}).report;assert.equal(r.pending,2);
 for(const mutate of [t=>t.root.children[0].children[0].ocrSegments[1].text="tampered",t=>t.ocrReview.review.sourceHash="b".repeat(64),t=>t.ocrReview.review.reviewer="altered",t=>t.ocrReview.review.decisions.push({...t.ocrReview.review.decisions[0]})]){
  const bad=structuredClone(out);mutate(bad);const result=inspect(bad);assert.equal(result.report.recorded,0);assert.ok(result.checks.some(c=>c[2]!==c[3]));
 }
});

test("explicit confirmations record transcription evidence without changing the tag tree",()=>{
 const f=fixture();f.review.decisions=[0,1].map(segmentIndex=>({tagId:"span",segmentIndex,pageNumber:1,sourceBlockId:`line-${segmentIndex+1}`,expectedText:"first word",text:"first word",decision:"confirm"}));
 const out=apply(f);assert.deepEqual(out.root,f.tagging.root);
 const r=inspect(out);assert.equal(r.report.status,"recorded");assert.equal(r.report.recorded,2);assert.equal(r.report.pending,0);
 assert.deepEqual(inspect({...f.tagging,root:{id:"root",type:"Document",children:[]}}).report,{status:"none",pending:0,recorded:0,segments:[]});
});

test("malformed recognition coverage cannot qualify even with a review decision",()=>{
 for(const patch of [{range:[0,50]},{range:[4,4]},{alignment:"complete",words:[]},{alignment:"unresolved",words:[{text:"first",start:0,end:5,geometryStatus:"unavailable"}]},{alignment:"complete",words:[{text:"first",start:0,end:5,geometryStatus:"unavailable"}]}]){
  const f=fixture();f.tagging.root.children[0].children[0].ocrSegments[0].recognition={originalText:"first word",range:[0,10],alignment:"unavailable",words:[],...patch};
  const r=inspect(f.tagging);assert.ok(r.checks.some(c=>c[0]==="OCR_RECOGNITION_EVIDENCE"&&c[3]===false));
 }
});
test("word uncertainty and stale recognition ranges are independently checked",()=>{
 const f=fixture(),e=f.tagging.root.children[0].children[0].ocrSegments[0];
 e.recognition={originalText:e.text,range:[0,e.text.length],alignment:"complete",words:[{text:"first",start:0,end:5,confidence:20,geometryStatus:"unavailable"},{text:"word",start:6,end:10,geometryStatus:"unavailable"}]};
 let r=inspect(f.tagging);assert.ok(r.checks.every(c=>c[2]===c[3]));assert.ok(r.report.segments[0].reasons.includes("word_confidence_below_85"));
 e.recognition.words[1].start=5;r=inspect(f.tagging);assert.ok(r.checks.some(c=>c[0]==="OCR_RECOGNITION_EVIDENCE"&&c[3]===false));
});
test("production quality reports expose pending transcription with candidate-bound tasks",()=>{
 const report={candidateHash:sourceHash,findings:[]},saved={candidateHash:sourceHash,ocrReview:{pending:2}};
 appendOcrReviewTask(report,saved,"saved.json");assert.equal(report.reviewTasks[0].status,"open");assert.equal(report.reviewTasks[0].candidateHash,sourceHash);assert.match(report.reviewTasks[0].evidence,/2 OCR/);
 assert.throws(()=>appendOcrReviewTask(report,{...saved,candidateHash:"b".repeat(64)},"saved.json"),/hash/);
 const empty={candidateHash:sourceHash,findings:[]};appendOcrReviewTask(empty,{candidateHash:sourceHash,ocrReview:{pending:0}},"saved.json");assert.equal(empty.reviewTasks,undefined);
});
