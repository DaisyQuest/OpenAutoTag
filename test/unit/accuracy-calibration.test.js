import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calibrateAccuracy } from "../../scripts/accuracy-calibration.js";
import { validateAccuracyManifest, scoreAccuracyExpectations } from "../../scripts/real-pdf-accuracy-benchmark.js";
const decision=(id,extra={})=>({id,rule:"label",documentId:"d",lineage:"family",split:"holdout",reviewStatus:"adjudicated",expected:true,predicted:true,...extra});
test("calibration separates precision, recall, coverage and abstention",()=>{
 const r=calibrateAccuracy([decision("a"),decision("b",{expected:false}),decision("c",{predicted:null}),decision("d",{predicted:false}),decision("ignored",{split:"development"})])[0];
 assert.equal(r.precision,.5);assert.equal(r.recall,1/3);assert.equal(r.coverage,.75);assert.equal(r.abstentions,1);assert.equal(r.status,"review-only");assert.equal(r.lineages,1);
 assert.deepEqual(calibrateAccuracy([decision("pending",{reviewStatus:"pending"})]),[]);
 assert.throws(()=>calibrateAccuracy([decision("bad",{predicted:.99})]),/Invalid/);
 assert.throws(()=>calibrateAccuracy([decision("same"),decision("same")]),/Duplicate/);
});
test("thousands of correlated decisions cannot qualify a rule from one document family",()=>{
 const r=calibrateAccuracy(Array.from({length:1000},(_,i)=>decision(String(i))))[0];assert.equal(r.precision,1);assert.equal(r.status,"review-only");assert.ok(r.perfectLineageLower95<.3);
 const varied=calibrateAccuracy(Array.from({length:200},(_,i)=>decision(String(i),{documentId:`d${i}`,lineage:`f${i}`})))[0];assert.equal(varied.status,"eligible-for-release-review");
});
test("pilot corpus is hash bound and rejects split leakage and fabricated adjudication metadata",async()=>{
 const m=JSON.parse(await readFile(new URL("../fixtures/accuracy-corpus.json",import.meta.url)));assert.equal(validateAccuracyManifest(m).documents.length,12);
 const leak=structuredClone(m);leak.documents[1].lineage=leak.documents[0].lineage;leak.documents[1].split=leak.documents[0].split==="holdout"?"development":"holdout";assert.throws(()=>validateAccuracyManifest(leak),/leaks/);
 const fake=structuredClone(m);fake.documents[0].review.status="adjudicated";assert.throws(()=>validateAccuracyManifest(fake),/Adjudication/);
 const frozen=structuredClone(m);frozen.holdoutState="frozen";assert.throws(()=>validateAccuracyManifest(frozen),/Frozen/);
 const duplicate=structuredClone(m);duplicate.documents[1].sha256=duplicate.documents[0].sha256;assert.throws(()=>validateAccuracyManifest(duplicate),/Duplicate/);
});
test("expectation scoring uses source identities and keeps missing sources as abstentions",()=>{
 const d={id:"d",lineage:"l",split:"holdout",review:{status:"adjudicated"},expectations:[{id:"h",kind:"role",source:"source1",value:"H1",expected:true,rule:"heading"},{id:"missing",kind:"precedence",source:"missing",target:"source1",expected:true,rule:"order"}]};
 const result=scoreAccuracyExpectations(d,{nodes:[{id:"n",sourceBlockId:"source1",role:"H1"}],orderedNodeIds:["n"],relations:[]},{root:{id:"root",children:[]}});
 assert.equal(result[0].predicted,true);assert.equal(result[1].predicted,null);
});
