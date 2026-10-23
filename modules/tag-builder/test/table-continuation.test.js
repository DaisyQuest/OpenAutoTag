import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {buildTagTree} from "../index.js";
import {appendTableCell,partitionTableSections,markRepeatedTableHeaders} from "../table-continuation.js";
import {continuedTableFixture} from "../../../test/fixtures/continued-table.js";
const all=n=>[n,...(n.children||[]).flatMap(all)];
async function build(t,nodes){const dir=await mkdtemp(path.join(os.tmpdir(),"continued-tables-"));t.after(()=>rm(dir,{recursive:true,force:true}));const p=path.join(dir,"semantic.json");await writeFile(p,JSON.stringify({schemaVersion:"1.0.0",documentId:"continued",source:{layoutDocumentId:"continued"},nodes,orderedNodeIds:nodes.map(n=>n.id)}));return buildTagTree(p);}
const state=()=>({node:{id:"table",children:[]},rows:new Map()});
const cell=(id,type="TD",col=0,extra={})=>({id,type,tableColumnIndex:col,label:id,children:[],...extra});

test("three-page headers preserve all occurrences, row order and current-page targets",async t=>{
  const {nodes,headers,repeats}=continuedTableFixture(),tags=await build(t,nodes),flat=all(tags.root),map=new Map(flat.map(n=>[n.id,n]));
  assert.deepEqual(tags,await build(t,nodes));assert.equal(flat.filter(n=>n.type==="Table").length,2);
  assert.deepEqual(flat.flatMap(n=>n.sourceNodeIds||[]),nodes.map(n=>n.id));assert.equal(tags.source.repeatedHeaderRows,4);
  assert.deepEqual(flat.filter(n=>n.type==="TR").map(n=>n.tableRowIndex),[0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3]);
  for(const[id,targets]of Object.entries(headers))assert.deepEqual(map.get(`tag:${id}`).tableAttrs?.Headers||[],targets.map(h=>map.get(`tag:${h}`).headerId),id);
  for(const[id,original]of Object.entries(repeats)){const c=map.get(`tag:${id}`);assert.equal(c.repeatedHeaderOf,`tag:${original}`);assert.notEqual(c.headerId,map.get(`tag:${original}`).headerId);assert.equal(c.scope,"Column");assert.equal(c.tableHeaderEvidence.scopeSource,"continued-head");}
  assert.deepEqual(map.get("tag:p2-count").tableRowOrigin,{pageNumber:2,rowIndex:1});assert.deepEqual(map.get("tag:p3-count").tableRowOrigin,{pageNumber:3,rowIndex:9});
});
test("global row numbering is retained and absent repeats inherit the last existing header",async t=>{
  const {nodes}=continuedTableFixture();const input=nodes.filter(n=>n.pageNumber<=2&&!(n.pageNumber===2&&n.tableRowIndex<2)).map(n=>n.pageNumber===2?{...n,tableRowIndex:n.tableRowIndex+2}:n);
  const flat=all((await build(t,input)).root),h=flat.find(n=>n.id==="tag:p1-count"),v=flat.find(n=>n.id==="tag:p2-n1");assert.ok(v.tableAttrs.Headers.includes(h.headerId));assert.equal(v.tableRowIndex,4);
});
test("changed labels and scopes remain distinct bands without false repeat evidence",async t=>{
  for(const change of ["text","scope","span"]){const{nodes}=continuedTableFixture();const target=nodes.find(n=>n.id==="p2-volume");if(change==="text")target.text="Different group";if(change==="scope")target.scope="Row";if(change==="span")target.tableColumnSpan=1;
    const flat=all((await build(t,nodes)).root);assert.ok(flat.filter(n=>n.id.startsWith("tag:p2-")).every(n=>!n.repeatedHeaderOf));assert.ok(flat.filter(n=>n.id.startsWith("tag:p3-")).some(n=>n.repeatedHeaderOf));}
});
test("interrupting content creates independent table fragments with original source order",async t=>{
  const {nodes}=continuedTableFixture();nodes.splice(10,0,{id:"break",sourceBlockId:"break",role:"P",text:"Interlude",pageNumber:2,bbox:[50,20,100,14],confidence:1});
  const flat=all((await build(t,nodes)).root);assert.equal(flat.filter(n=>n.type==="Table").length,3);assert.deepEqual(flat.flatMap(n=>n.sourceNodeIds||[]),nodes.map(n=>n.id));assert.equal(flat.find(n=>n.id==="tag:p2-count").repeatedHeaderOf,undefined);
});
test("running artifacts between pages do not split a declared continued table",async t=>{
  const{nodes}=continuedTableFixture();nodes.splice(10,0,{id:"footer",sourceBlockId:"footer",pageNumber:1,role:"Artifact",text:"Page 1",bbox:[50,750,100,14],confidence:1,artifactType:"footer"});
  const tags=await build(t,nodes),flat=all(tags.root);assert.equal(flat.filter(n=>n.type==="Table").length,2);assert.equal(tags.source.repeatedHeaderRows,4);assert.deepEqual(flat.flatMap(n=>n.sourceNodeIds||[]),nodes.filter(n=>n.role!=="Artifact").map(n=>n.id));
});
test("rowspan collisions with a repeated page header remain explicit review",async t=>{
  const{nodes}=continuedTableFixture();nodes.find(n=>n.id==="p1-south").tableRowSpan=2;const tags=await build(t,nodes);assert.ok(all(tags.root).some(n=>n.tableGridReview?.issues.some(i=>i.code==="OVERLAPPING_SPANS")));
});
test("a valid data rowspan can continue across a page boundary without a repeated header",async t=>{
  const n=(id,page,row,col,role="TD",extra={})=>({id,sourceBlockId:id,pageNumber:page,role,text:id+" 100",bbox:[50+col*100,80+row*40,90,14],confidence:1,tableId:"span",tableRowIndex:row,tableColumnIndex:col,...extra});
  const tags=await build(t,[n("h1",1,0,0,"TH",{tableSection:"head"}),n("h2",1,0,1,"TH",{tableSection:"head"}),n("carry",1,1,0,"TD",{tableRowSpan:2}),n("first",1,1,1),n("last",2,0,1)]),flat=all(tags.root);
  assert.ok(flat.every(n=>!n.tableGridReview));assert.equal(flat.find(n=>n.id==="tag:carry").rowSpan,2);assert.deepEqual(flat.filter(n=>n.type==="TR").map(n=>n.tableRowIndex),[0,1,2]);
});
test("page-local rows stay separate and original coordinates are recorded only when needed",()=>{
  const s=state(),a=cell("a"),b=cell("b");appendTableCell(s,a,1,0);appendTableCell(s,b,1,0);assert.equal(s.node.children.length,1);assert.equal(a.tableRowOrigin,undefined);
  const c=cell("c");appendTableCell(s,c,2,0);assert.equal(c.tableRowIndex,1);assert.deepEqual(a.tableRowOrigin,{pageNumber:1,rowIndex:0});assert.deepEqual(c.tableRowOrigin,{pageNumber:2,rowIndex:0});
  appendTableCell(s,cell("d"),3,8);assert.equal(s.node.children.at(-1).tableRowIndex,8);
});
test("unsafe, reversed or out-of-order continuation coordinates fail within bounds",()=>{
  for(const index of [-1,1.5,"0"]){const s=state();appendTableCell(s,cell("a"),1,0);assert.throws(()=>appendTableCell(s,cell("b"),2,index),/identity requires review/);}
  const invalid=state();appendTableCell(invalid,cell("a"),1,-1);assert.throws(()=>appendTableCell(invalid,cell("b"),2,0),/identity requires review/);
  const huge=state();appendTableCell(huge,cell("a"),1,Number.MAX_SAFE_INTEGER);assert.throws(()=>appendTableCell(huge,cell("b"),2,0),/safe range/);
  const reverse=state();appendTableCell(reverse,cell("a"),2,0);assert.throws(()=>appendTableCell(reverse,cell("b"),1,1),/page order/);
  const order=state();appendTableCell(order,cell("a"),1,0);appendTableCell(order,cell("b"),2,1);assert.throws(()=>appendTableCell(order,cell("c"),2,0),/out of order/);
  const limit=state();for(let r=0;r<4096;r++)appendTableCell(limit,cell(String(r)),1,r);assert.throws(()=>appendTableCell(limit,cell("limit"),1,4096),/4096/);
});
test("section partitions retain late headers and intermediate footers in place",()=>{
  const e=["head","body","foot","head","body","foot"].map((assignedSectionKey,i)=>({assignedSectionKey,rowNode:{id:String(i)}})),p=partitionTableSections(e);
  assert.deepEqual([...p.headRows,...p.bodyRows,...p.footRows].map(r=>r.rowNode.id),["0","1","2","3","4","5"]);assert.equal(p.bodyRows[1].rowNode.tableSectionOrigin,"foot");assert.equal(p.bodyRows[2].rowNode.tableSectionOrigin,"head");
  assert.deepEqual(partitionTableSections([]),{headRows:[],bodyRows:[],footRows:[]});
});
test("repetition needs a complete matching band and cannot span page boundaries",()=>{
  const row=(type,cells,page)=>({sectionNode:{type},rowNode:{children:cells,...(page?{tableRowOrigin:{pageNumber:page,rowIndex:0}}:{})}});
  assert.equal(markRepeatedTableHeaders([]),0);assert.equal(markRepeatedTableHeaders([row("THead",[cell("a")])]),0);assert.equal(markRepeatedTableHeaders([row("THead",[cell("a")]),row("TBody",[cell("a")])]),0);
  const heads=[row("THead",[cell("a","TH")],1),row("THead",[cell("b","TH")],1)];
  assert.equal(markRepeatedTableHeaders([...heads,row("TBody",[cell("a","TH")],2),row("TBody",[cell("b","TH")],3)]),0);
  assert.equal(markRepeatedTableHeaders([...heads,row("TBody",[],2),row("TBody",[cell("b","TH")],2)]),0);
  assert.equal(markRepeatedTableHeaders([...heads,row("TBody",[cell("a","TH")],2),row("TBody",[cell("b","TH")],2)]),2);
});
test("repeated-header search is bounded without applying partial matches",()=>{
  const row=(type,last=false)=>({sectionNode:{type},rowNode:{children:[cell("A","TH"),cell(last?"Z":"B","TH",1)]}});
  const rows=[...Array.from({length:1000},(_,i)=>row("THead",i===999)),...Array.from({length:3096},()=>row("TBody"))];
  assert.throws(()=>markRepeatedTableHeaders(rows),/bounded work limit/);assert.ok(rows.every(r=>!r.rowNode.repeatedHeader));
});
