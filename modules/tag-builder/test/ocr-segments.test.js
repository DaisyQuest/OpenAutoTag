import test from "node:test";
import assert from "node:assert/strict";
import {attachOcrSegments} from "../ocr-segments.js";
const segment=(text="Scanned text")=>({sourceBlockId:"scan-1",text,geometry:{coordinateSpace:"crop-display-points",clipped:false,quad:[10,10,110,10,110,20,10,20]}});
const node=(extra={})=>({id:"n1",pageNumber:1,role:"P",text:"Scanned text",textProvenance:"ocr",ocrSegments:[segment()],...extra});
const document=n=>({source:{coordinateSpace:"crop-display-points"},nodes:[n]});
const tree=()=>({id:"root",type:"Document",children:[{id:"p",type:"P",sourceNodeIds:["n1"],children:[{id:"span",type:"Span",sourceNodeIds:["n1"],children:[]}]}]});
test("OCR uses the deepest source owner and retains line text, geometry and confidence",()=>{
 const root=tree(),n=node();n.ocrSegments[0].confidence=94;
 attachOcrSegments(root,document(n));assert.equal(root.children[0].ocrSegments,undefined);
 assert.deepEqual(root.children[0].children[0].ocrSegments,[{pageNumber:1,sourceBlockId:"scan-1",text:n.text,quad:n.ocrSegments[0].geometry.quad,confidence:94}]);
});
test("OCR rejects stale text, clipped or missing frames, duplicate source lines and ambiguous owners",()=>{
 const clipped=node();clipped.ocrSegments[0].geometry.clipped=true;
 for(const n of [node({text:"Changed"}),clipped,node({ocrSegments:[segment(),segment()],text:"Scanned textScanned text"})])assert.throws(()=>attachOcrSegments(tree(),document(n)),/OCR/);
 const root=tree();root.children.push({id:"other",type:"P",sourceNodeIds:["n1"],children:[]});assert.throws(()=>attachOcrSegments(root,document(node())),/Ambiguous/);
 assert.throws(()=>attachOcrSegments(tree(),{source:{},nodes:[node()]}),/coordinates/);
 assert.throws(()=>attachOcrSegments({id:"root",children:[]},document(node())),/owner/);
});
test("OCR list labels and bodies own disjoint parts of the original line",()=>{
 const root={id:"li",type:"LI",children:[{id:"label",type:"Lbl",actualText:"1.",children:[]},{id:"body",type:"LBody",sourceNodeIds:["n1"],children:[]}]};
 attachOcrSegments(root,document(node({role:"LI",text:"1. First item",ocrSegments:[segment("1. First item")]})));
 assert.equal(root.children[0].ocrSegments[0].text,"1.");assert.equal(root.children[1].ocrSegments[0].text," First item");
 assert.deepEqual(root.children[0].ocrSegments[0].quad.slice(2,4),root.children[1].ocrSegments[0].quad.slice(0,2));
 const bad=structuredClone(root);assert.throws(()=>attachOcrSegments(bad,document(node())),/marker/);
});

test("OCR word evidence retains original offsets through separate list label/body ranges",()=>{
 const text="1. First item",n=node({role:"LI",text,ocrSegments:[segment(text)]});
 const recognition={originalText:text,range:[0,text.length],alignment:"complete",words:[{text:"1.",start:0,end:2,confidence:50,geometryStatus:"unavailable"},{text:"First",start:3,end:8,confidence:100,geometryStatus:"unavailable"},{text:"item",start:9,end:13,geometryStatus:"unavailable"}]};
 n.ocrSegments[0].recognition=recognition;
 const root={id:"li",type:"LI",children:[{id:"label",type:"Lbl",actualText:"1.",children:[]},{id:"body",type:"LBody",sourceNodeIds:["n1"],children:[]}]};
 attachOcrSegments(root,document(n));
 assert.deepEqual(root.children.map(c=>c.ocrSegments[0].recognition.range),[[0,2],[2,13]]);
 assert.deepEqual(root.children[1].ocrSegments[0].recognition.words,recognition.words);assert.deepEqual(recognition.range,[0,13]);
});
