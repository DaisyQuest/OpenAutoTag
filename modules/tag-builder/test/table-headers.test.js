import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assignTableHeaders } from "../table-headers.js";
import { buildTagTree } from "../index.js";
import fixture from "../../../test/fixtures/mixed-table-headers.json" with {type:"json"};
const all = n => [n,...(n.children || []).flatMap(all)];
const cell=(id,col,type="TD",extra={})=>({id,type,tableColumnIndex:col,children:[],...extra});
const rows=(values,headRows=0)=>values.map((children,rowIndex)=>({rowIndex,sectionNode:rowIndex<headRows?{type:"THead"}:null,rowNode:{id:`r${rowIndex}`,children}}));
const headers=n=>n.tableAttrs?.Headers || [];

for(const table of fixture.tables)test(`${table.id}: every relationship matches the independent fixture oracle`,async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"table-headers-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const nodes=table.cells.map(([id,role,text,row,col,extra={}])=>({id,sourceBlockId:id,pageNumber:1,role,text,confidence:1,bbox:[50+col*100,80+row*38,90,14],tableId:table.id,tableRowIndex:row,tableColumnIndex:col,...extra}));
  const file=path.join(dir,"semantic.json");await writeFile(file,JSON.stringify({schemaVersion:"1.0.0",documentId:table.id,source:{layoutDocumentId:table.id},nodes,orderedNodeIds:nodes.map(n=>n.id)}));
  const tagged=await buildTagTree(file),flat=all(tagged.root),byId=new Map(flat.map(n=>[n.id,n]));
  assert.deepEqual(await buildTagTree(file),tagged);
  for(const [id,expected]of Object.entries(table.headers))assert.deepEqual(headers(byId.get(`tag:${id}`)),expected.map(h=>byId.get(`tag:${h}`).headerId),id);
  for(const n of nodes){const tagged=byId.get(`tag:${n.id}`);assert.equal(tagged.type,n.role);if(n.scope){assert.equal(tagged.scope,n.scope);assert.equal(tagged.tableHeaderEvidence.scopeSource,"explicit");}}
});

test("opposite-axis headers do not terminate a search; same labels remain distinct",()=>{
  const a=cell("a",0,"TH",{scope:"Row",label:"Same"}),b=cell("b",1,"TH",{scope:"Column"}),c=cell("c",2,"TH",{scope:"Row",label:"Same"}),d=cell("d",3);
  assignTableHeaders({id:"t"},rows([[a,b,c,d]]));assert.deepEqual(headers(d),[c.headerId,a.headerId]);assert.deepEqual(headers(c),[a.headerId]);
});
test("data separates row header bands and empty corners remain TD",()=>{
  const a=cell("a",0,"TH",{scope:"Row"}),gap=cell("gap",1),b=cell("b",2,"TH",{scope:"Row"}),v=cell("v",3),corner=cell("corner",0);
  assignTableHeaders({id:"t"},rows([[a,gap,b,v],[corner]],1));assert.deepEqual(headers(v),[b.headerId]);assert.deepEqual(headers(b),[]);assert.equal(corner.scope,undefined);assert.equal(corner.headerId,undefined);
});
test("section fallback evidence distinguishes head, unwrapped head and body",()=>{
  const a=cell("a",0,"TH"),b=cell("b",1,"TH",{tableSection:"head"}),c=cell("c",0,"TH");
  assignTableHeaders({id:"t"},rows([[a],[c,b]],1));assert.equal(a.scope,"Column");assert.equal(b.scope,"Column");assert.equal(c.scope,"Row");assert.equal(a.tableHeaderEvidence.scopeSource,"thead");assert.equal(c.tableHeaderEvidence.scopeSource,"body-default");
});
test("merged columns order all specific heads before a common parent without duplicates",()=>{
  const group=cell("g",0,"TH",{columnSpan:2}),a=cell("a",0,"TH"),b=cell("b",1,"TH"),v=cell("v",0,"TD",{columnSpan:2});
  assignTableHeaders({id:"t"},rows([[group],[a,b],[v]],2));assert.deepEqual(headers(v),[a.headerId,b.headerId,group.headerId]);
});
test("unresolved grids stay untouched and invalid grids receive review",()=>{
  const a=cell("a",0),b=cell("b",0),table={id:"t",tableGridReview:{status:"review_required"}};const before=structuredClone(a);
  assignTableHeaders(table,rows([[a]]));assert.deepEqual(a,before);
  const fresh={id:"new"};assignTableHeaders(fresh,rows([[a,b]]));assert.equal(fresh.tableGridReview.issues[0].code,"OVERLAPPING_SPANS");assert.deepEqual(a,before);
});
test("nested cell content and neighboring tables never supply header targets",()=>{
  const a=cell("a",0,"TH",{scope:"Column"}),nested=cell("nested",0,"TH",{headerId:"foreign"}),v=cell("v",0);a.children.push({id:"inner",type:"Table",children:[nested]});
  assignTableHeaders({id:"outer"},rows([[a],[v]],1));const other=cell("other",0);assignTableHeaders({id:"other-table"},rows([[other]]));assert.deepEqual(headers(v),[a.headerId]);assert.deepEqual(headers(other),[]);assert.equal(nested.headerId,"foreign");
});
test("stale header and scope attributes on data cells are cleared",()=>{
  const a=cell("a",0,"TD",{scope:"Both",headerId:"stale",tableAttrs:{O:"Table",Headers:["stale"]}});assignTableHeaders({id:"t"},rows([[a]]));assert.equal(a.scope,undefined);assert.equal(a.headerId,undefined);assert.equal(a.tableAttrs,undefined);
});
test("header work limit rejects without partial mutation",()=>{
  const grid=rows(Array.from({length:4096},(_,r)=>[cell(`a${r}`,0,r?"TD":"TH"),cell(`b${r}`,1,r?"TD":"TH")]));const before=structuredClone(grid);
  assert.throws(()=>assignTableHeaders({id:"t"},grid),/bounded work limit/);assert.deepEqual(grid,before);
});

test("reordered sections cannot assign a declared future header to earlier data",()=>{
  const old=cell("old",0,"TH",{scope:"Column"}),future=cell("future",0,"TH",{scope:"Column"}),early=cell("early",0),late=cell("late",0);
  const input=rows([[old],[future],[early],[late]],2);input[1].rowIndex=2;input[2].rowIndex=1;
  assignTableHeaders({id:"t"},input);assert.deepEqual(headers(early),[old.headerId]);assert.ok(!headers(early).includes(future.headerId));
});
