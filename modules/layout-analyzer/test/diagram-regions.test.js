import test from 'node:test';
import assert from 'node:assert/strict';
import {detectDiagramRegions,diagramLabel} from '../diagram-regions.js';
import {analyzeLayout} from '../index.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
const title={id:'title',text:'System block diagram',bbox:[80,40,300,20],fontSize:20,blockType:'heading'};
const labels=Array.from({length:8},(_,i)=>({id:`label-${i}`,text:`Component ${i}`,bbox:[100+(i%2)*220+(i%3)*4,110+Math.floor(i/2)*60,90,12],fontSize:12}));
const page={pageNumber:1,width:612,height:792,figures:[{id:'image',bbox:[60,80,460,300],source:'image-operator',operatorIndex:1}]};
const lines=[[120,130,400,200],[120,200,400,270],[120,270,400,340],[120,340,400,130]];
const graph={graphicEvidence:{status:'available',obliqueSegments:lines}};
test('image title and scattered labels retain exact deterministic region membership',()=>{
 const blocks=[title,...labels],r=detectDiagramRegions(page,blocks);assert.equal(r.length,1);assert.deepEqual(r[0].blockIds,labels.map(b=>b.id));assert.equal(r[0].evidence,'image-with-diagram-title');assert.deepEqual(detectDiagramRegions(page,blocks),r);assert.equal(blocks[1].diagramRegionId,undefined);
});
test('connector evidence works without an image and rejects duplicated or short edges',()=>{
 const p={...page,figures:[]},r=detectDiagramRegions(p,[title,...labels],graph);assert.equal(r.length,1);assert.equal(r[0].evidence,'connectors-with-diagram-title');
 for(const obliqueSegments of [Array(8).fill(lines[0]),[lines[0],lines[0].slice(2).concat(lines[0].slice(0,2))],Array(8).fill([10,10,11,12]),Array(8).fill([100,100,100,300])])assert.deepEqual(detectDiagramRegions(p,[title,...labels],{graphicEvidence:{status:'available',obliqueSegments}}),[]);
});
for(const [name,change]of Object.entries({noTitle:bs=>bs.slice(1),ordinaryHeading:bs=>[{...title,text:'Service components'},...bs.slice(1)],ambiguousHeading:bs=>[...bs,{...title,id:'second'}],tooFewLabels:bs=>bs.slice(0,6),prose:bs=>bs.map((b,i)=>i===2?{...b,text:'A'.repeat(81)}:b),field:bs=>bs.map((b,i)=>i===2?{...b,formFieldIds:['widget']}:b),outsideTitle:bs=>[{...title,bbox:[80,500,300,20]},...bs.slice(1)]}))test(`insufficient diagram evidence: ${name}`,()=>assert.deepEqual(detectDiagramRegions(page,change([title,...labels])),[]));
test('regular data and text grids remain tables even inside a diagram-titled image',()=>{
 for(const numeric of [true,false]){const blocks=Array.from({length:8},(_,i)=>({id:`cell-${i}`,text:numeric&&i>1?String(i*12):`Cell ${i}`,bbox:[100+(i%2)*200,110+Math.floor(i/2)*50,80,12],fontSize:12}));assert.deepEqual(detectDiagramRegions(page,[title,...blocks]),[]);}
 const shortTable=Array.from({length:6},(_,i)=>({id:`short-${i}`,text:`Cell ${i}`,bbox:[100+(i%3)*120,110+Math.floor(i/3)*50,80,12],fontSize:12}));assert.deepEqual(detectDiagramRegions(page,[title,...shortTable]),[]);
});
test('small graphics, exhausted evidence, invalid boxes and oversized pages cannot suppress tables',()=>{
 for(const p of [{...page,figures:[{bbox:[0,0,10,10]}]},{...page,figures:[{bbox:[0,0,-1,20]}]},{...page,figures:Array(257).fill(page.figures[0])}])assert.deepEqual(detectDiagramRegions(p,[title,...labels]),[]);
 for(const evidence of [{status:'limit-exceeded',obliqueSegments:lines},{status:'available',obliqueSegments:Array(4097).fill(lines[0])}])assert.deepEqual(detectDiagramRegions({...page,figures:[]},[title,...labels],{graphicEvidence:evidence}),[]);
 assert.deepEqual(detectDiagramRegions(page,[title,...Array(4096).fill(labels[0])]),[]);
});
test('overlapping graphic proposals cannot claim the same label twice',()=>{
 const r=detectDiagramRegions({...page,figures:[...page.figures,{...page.figures[0],id:'duplicate'}]},[title,...labels],graph);assert.equal(r.length,1);
});
test('diagram text retains content, OCR and geometry but drops inferred table/list/heading hints',()=>{
 const b={...labels[0],textProvenance:'ocr',ocrSegments:[{text:'Component'}],tableId:'bad',tableRowIndex:0,headingLevel:2,listStyle:'ordered',rowIndex:0,columnIndex:0,cellRole:'header'};
 const result=diagramLabel(b,'d');assert.equal(result.blockType,'paragraph');assert.equal(result.diagramRegionId,'d');assert.equal(result.text,b.text);assert.equal(result.ocrSegments,b.ocrSegments);for(const k of ['tableId','headingLevel','listStyle','rowIndex','columnIndex','cellRole'])assert.equal(result[k],undefined);assert.equal(b.tableId,'bad');
});
test('reanalyzing layout clears stale diagram proposals when their evidence is removed',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'diagram-replay-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'layout.json');
 const input={schemaVersion:'1.0.0',documentId:'d',source:{filePath:'source.pdf'},pages:[{...page,textBlocks:[title,...labels]}]};await writeFile(file,JSON.stringify(input));const first=await analyzeLayout(file);assert.equal(first.pages[0].diagramRegions.length,1);
 first.pages[0].figures=[];await writeFile(file,JSON.stringify(first));const second=await analyzeLayout(file);assert.equal(second.pages[0].diagramRegions.length,0);assert.ok(second.pages[0].textBlocks.every(b=>!b.diagramRegionId));
});
