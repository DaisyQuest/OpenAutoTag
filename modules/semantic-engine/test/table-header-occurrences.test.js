import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {buildSemanticDocument} from "../index.js";
import {buildTagTree} from "../../tag-builder/index.js";
const all=n=>[n,...n.children.flatMap(all)];
function layout(){return{schemaVersion:"1.0.0",documentId:"header-occurrences",source:{filePath:"test.pdf",pageCount:3},pages:[1,2,3].map(pageNumber=>({pageNumber,width:612,height:792,textBlocks:(pageNumber===1?[600,640,680]:Array.from({length:16},(_,r)=>80+r*40)).flatMap((y,row)=>[0,1].map(col=>({id:`p${pageNumber}r${row}c${col}`,text:row?`${pageNumber}${row}${col}`:col?"Score":"Name",bbox:[50+col*100,y,90,12],fontSize:12,fontName:"Helvetica",blockType:"table-cell",tableRowIndex:row,tableColumnIndex:col,...(row?{}:{tableRole:"header"}),...(pageNumber===1?{tableId:"continued"}:{})})))}))};}
async function build(t,input,options){const dir=await mkdtemp(path.join(os.tmpdir(),"header-occurrences-"));t.after(()=>rm(dir,{recursive:true,force:true}));const p=path.join(dir,"layout.json");await writeFile(p,JSON.stringify(input));const s=await buildSemanticDocument(p,options);const q=path.join(dir,"semantic.json");await writeFile(q,JSON.stringify(s));return{semantic:s,tags:await buildTagTree(q)};}
test("three inferred pages retain the original complete header signature and local row identities",async t=>{
  const {semantic,tags}=await build(t,layout()),flat=all(tags.root);assert.equal(new Set(semantic.nodes.map(n=>n.tableId)).size,1);
  for(const page of [2,3])assert.equal(semantic.nodes.filter(n=>n.pageNumber===page&&n.repeatedHeader).length,2);
  assert.equal(flat.filter(n=>n.type==="Table").length,1);assert.equal(tags.source.repeatedHeaderRows,2);
  const ids=new Map(semantic.nodes.map(n=>[n.sourceBlockId,n.id])),find=id=>flat.find(n=>n.id===`tag:${ids.get(id)}`);
  assert.deepEqual(find("p3r1c1").tableAttrs.Headers,[find("p3r0c1").headerId]);
  assert.deepEqual(flat.flatMap(n=>n.sourceNodeIds||[]),semantic.nodes.map(n=>n.id));
});
test("an explicit different table ID wins even when every header and column matches",async t=>{
  const input=layout();for(const b of input.pages[2].textBlocks)b.tableId="separate";const{semantic,tags}=await build(t,input);
  assert.equal(new Set(semantic.nodes.map(n=>n.tableId)).size,2);assert.ok(semantic.nodes.filter(n=>n.pageNumber===3).every(n=>!n.repeatedHeader));assert.equal(all(tags.root).filter(n=>n.type==="Table").length,2);
});
for(const change of ["text","span","scope","column","partial"])test(`mismatched ${change} evidence cannot infer cross-page identity`,async t=>{
  const input=layout();input.pages=input.pages.slice(0,2);input.source.pageCount=2;const h=input.pages[1].textBlocks[1];
  if(change==="text")h.text="Different";if(change==="span")h.tableRowSpan=2;if(change==="scope")h.scope="Row";if(change==="column")h.tableColumnIndex=2;if(change==="partial")delete h.tableRole;
  const{semantic}=await build(t,input);assert.notEqual(semantic.nodes.find(n=>n.pageNumber===1).tableId,semantic.nodes.find(n=>n.pageNumber===2).tableId);assert.ok(semantic.nodes.filter(n=>n.pageNumber===2).every(n=>!n.repeatedHeader));
});
test("disabling inferred continuation keeps matching page tables distinct",async t=>{
  const{semantic}=await build(t,layout(),{tableContinuationAcrossPages:false});assert.equal(new Set(semantic.nodes.map(n=>n.tableId)).size,3);
});
test("multirow spanning header signatures survive three inferred page occurrences",async t=>{
  const input=layout();input.pages=input.pages.map((page,p)=>{
    const add=(id,text,row,col,y,extra={})=>({id:`p${p}-${id}`,text,bbox:[50+col*100,y,90,12],fontSize:12,fontName:"Helvetica",blockType:"table-cell",tableRowIndex:row,tableColumnIndex:col,...(p===0?{tableId:"multi"}:{}),...extra});
    const y=p===0?600:80;const textBlocks=[add("region","Region",0,0,y,{tableRole:"header",tableRowSpan:2}),add("group","Results",0,1,y,{tableRole:"header",tableColumnSpan:2}),add("count","Count",1,1,y+40,{tableRole:"header"}),add("rate","Rate",1,2,y+40,{tableRole:"header"})];
    for(let row=2,bodyY=y+80;bodyY<=680;row++,bodyY+=40)for(let col=0;col<3;col++)textBlocks.push(add(`r${row}c${col}`,`${p}${row}${col}`,row,col,bodyY));
    return{...page,textBlocks};
  });
  const{semantic,tags}=await build(t,input);assert.equal(new Set(semantic.nodes.map(n=>n.tableId)).size,1);assert.equal(tags.source.repeatedHeaderRows,4);assert.equal(all(tags.root).filter(n=>n.repeatedHeaderOf).length,8);
});
