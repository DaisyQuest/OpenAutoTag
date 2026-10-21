import test from "node:test";
import assert from "node:assert/strict";
import { inferDocumentHeadings, inferRegionsAndAnchors, refineTableTopology, refineFigures, refineSequenceBoundaries } from "../document-inference.js";
import { enrichDocumentRelations } from "../document-relations.js";
import { buildSemanticDocument } from "../index.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const n=(id,extra={})=>({id,text:id,role:"P",pageNumber:1,bbox:[50,100,180,12],fontName:"Helvetica",fontSize:12,columnHint:0,...extra});
const page=(pageNumber=1)=>({pageNumber,width:600,height:800});
test("heading style anchors require independent pages and retain membership",()=>{
 const nodes=[n("a",{role:"H2",text:"1.1 First"}),n("b",{role:"H2",text:"2.1 Second",pageNumber:2}),n("c",{role:"H3",text:"Unnumbered",pageNumber:3}),n("body")];
 const result=inferDocumentHeadings(nodes);assert.equal(nodes[2].role,"H2");assert.equal(nodes[3].role,"P");assert.ok(result.tasks.some(t=>t.code==="HEADING_OUTLINE_GAP"));
 const ambiguous=[n("a",{role:"H2",text:"1.1 First"}),n("b",{role:"H3",text:"1.1.1 Second",pageNumber:2}),n("c",{role:"H4"})];
 assert.ok(inferDocumentHeadings(ambiguous).tasks.some(t=>t.code==="HEADING_ANCHOR_CONFLICT"));assert.equal(ambiguous[2].role,"H4");
});
test("regions cover every node and constrain a middle spanning heading",()=>{
 const nodes=[n("left"),n("right",{columnHint:1,bbox:[320,100,180,12]}),n("h",{role:"H1",bbox:[50,200,500,18]}),n("bottom",{bbox:[50,240,180,12]}),n("note",{footnoteGroupId:"note",footnoteMarker:"1",bbox:[50,740,180,12]})];
 nodes[0].referenceMarkers=["1"];
 const r=inferRegionsAndAnchors(nodes,[page()]);assert.ok(nodes.every(n=>r.regions.some(r=>r.id===n.regionId&&r.nodeIds.includes(n.id))));
 assert.ok(r.relations.some(r=>r.from==="right"&&r.to==="h"));assert.ok(r.relations.some(r=>r.from==="h"&&r.to==="bottom"));assert.equal(nodes[4].footnoteReferenceId,"left");
 nodes[1].referenceMarkers=["1"];delete nodes[4].footnoteReferenceId;
 assert.ok(inferRegionsAndAnchors(nodes,[page()]).tasks.some(t=>t.code==="FOOTNOTE_ANCHOR_AMBIGUOUS"));
});
test("table grids detect overlap and continuation requires headers and boundary context",()=>{
 const cells=[1,2].flatMap(p=>[0,1].map(c=>n(`${p}-${c}`,{pageNumber:p,tableId:`t${p}`,tableRowIndex:0,tableColumnIndex:c,role:"TH",text:`Heading ${c}`,bbox:[50+c*200,p===1?700:50,180,12]})));
 assert.equal(refineTableTopology(cells,[page(),page(2)]).fragments[1].continuesFrom,"1:t1");
 cells[2].text="Different";assert.equal(refineTableTopology(cells,[page(),page(2)]).fragments[1].continuesFrom,null);
 cells[0].tableColumnSpan=2;assert.ok(refineTableTopology(cells,[page(),page(2)]).tasks.some(t=>t.code==="TABLE_GRID_OVERLAP"));
 cells[0].tableRowSpan=1000000;assert.ok(refineTableTopology(cells,[page(),page(2)]).tasks.some(t=>t.code==="TABLE_GRID_UNRESOLVED"));
 const gap=[n("a",{tableId:"gap",tableRowIndex:0,tableColumnIndex:0}),n("b",{tableId:"gap",tableRowIndex:1,tableColumnIndex:1})];
 assert.ok(refineTableTopology(gap,[page()]).tasks.some(t=>t.code==="TABLE_GRID_GAP"));
});
test("a caption shared by images stays ambiguous and never supplies invented alt text",()=>{
 const caption=n("caption",{text:"Figure 1. Results",bbox:[50,220,180,12]}),image={id:"i",bbox:[50,100,180,100]};
 const r=refineFigures([caption],[{...page(),figures:[image]}]);assert.equal(caption.semanticRole,"Caption");assert.deepEqual(r.figures[0].captionNodeIds,["caption"]);assert.equal(r.figures[0].alt,undefined);
 delete caption.semanticRole;
 const ambiguous=refineFigures([caption],[{...page(),figures:[image,{...image,id:"j"}]}]);assert.equal(caption.semanticRole,undefined);assert.ok(ambiguous.tasks.every(t=>t.code==="FIGURE_CAPTION_AMBIGUOUS"));
});
test("tight paragraph lines join; form/column boundaries and list restarts survive",()=>{
 const a=n("a",{text:"This sentence continues"}),b=n("b",{text:"on this line.",bbox:[50,116,180,12]});
 assert.equal(refineSequenceBoundaries([a,b]).relations.length,1);assert.equal(a.paragraphGroupId,b.paragraphGroupId);
 for(const extra of [{formFieldIds:["w"]},{columnHint:1},{bbox:[50,150,180,12]},{text:"New paragraph."}]) {
  const c=n("c",{...b,...extra,id:"c"});delete c.paragraphGroupId;delete c.continuesFrom;assert.equal(refineSequenceBoundaries([a,c]).relations.length,0);
 }
 const list=["4. Old","1. Restart","2. Continue"].map((text,i)=>n(`l${i}`,{role:"LI",text,bbox:[50,100+i*20,180,12],listGroupId:"old",listLevel:1}));
 refineSequenceBoundaries(list);assert.notEqual(list[0].listGroupId,list[1].listGroupId);assert.equal(list[1].listGroupId,list[2].listGroupId);
});
test("form labels allow hanging checkboxes and unique above prompts but abstain on shared prompts",()=>{
 const nodes=[n("line1",{text:"I request this",bbox:[50,100,180,12]}),n("line2",{text:"additional relief",bbox:[68,115,180,12]})];
 const widget={id:"w",fieldType:"Btn",checkBox:true,tooltip:"I request this additional relief",bbox:[34,100,12,12]};
 assert.deepEqual(enrichDocumentRelations(nodes,[{...page(),formFields:[widget]}]).formRelationships[0].widgets[0].labelNodeIds,["line1","line2"]);
 const label=n("index",{text:"Index #:",bbox:[50,100,90,12]});
 const w={id:"index",bbox:[50,126,100,14]};
 assert.deepEqual(enrichDocumentRelations([label],[{...page(),formFields:[w]}]).formRelationships[0].widgets[0].labelNodeIds,["index"]);
 delete label.formFieldIds;
 assert.equal(enrichDocumentRelations([label],[{...page(),formFields:[w,{...w,id:"other"}]}]).formRelationships[0].widgets[0].labelStatus,"accessible-name-review-required");
});
test("inference output validates through the semantic CLI contract",async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"inference-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,"layout.json");await writeFile(file,JSON.stringify({schemaVersion:"1.0.0",documentId:"fixture",source:{filePath:"fixture.pdf"},pages:[{...page(),textBlocks:[{id:"a",text:"Figure 1. Results",fontSize:12,bbox:[50,220,180,12],blockType:"paragraph"}],figures:[{id:"i",bbox:[50,100,180,100],source:"image-operator",operatorIndex:1}]}]}));
 const result=await buildSemanticDocument(file);assert.equal(result.figures.length,1);assert.equal(result.nodes[0].semanticRole,"Caption");assert.equal(result.inferenceStatus,"uncalibrated-requires-review");
});
