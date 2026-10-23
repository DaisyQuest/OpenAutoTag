import test from "node:test";
import assert from "node:assert/strict";
import { recognitionTransform, mapRecognitionBox } from "../ocr-geometry.js";
import { normalizeRecognizedTextBlocks } from "../ocr-pipeline.js";

const variant = () => ({ coordinateSpace:"crop-display-points", imageWidth:101, imageHeight:81, pdfWidth:50.7, pdfHeight:40.9, pixelToDisplay:[.5,0,0,.5,0,0],name:"test" });
const box = {x0:70,y0:10,x1:80,y1:20};
const close = (actual, expected) => actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<.00001,`${v} != ${expected[i]}`));

test("OCR pixels use the renderer scale without stretching fractional page edges", () => {
  const v=variant(), t=recognitionTransform(v), result=mapRecognitionBox(box,v,t);
  assert.deepEqual(result.bbox,[35,5,5,5]);
  assert.deepEqual(result.evidence.quad,[35,5,40,5,40,10,35,10]);
  assert.equal(result.evidence.clipped,false);
  assert.notEqual(result.bbox[0],box.x0*v.pdfWidth/v.imageWidth);
});

test("recognizer rotation is inverted about the integer image center exactly once", () => {
  const v=variant();
  close(mapRecognitionBox(box,v,recognitionTransform(v,Math.PI/2)).bbox,[10,5,5,5]);
  close(mapRecognitionBox(box,v,recognitionTransform(v,-Math.PI/2)).bbox,[35,30,5,5]);
  close(recognitionTransform(v,.0005).matrix,[.5,0,0,.5,0,0]);
  assert.equal(recognitionTransform(v,.0005).angle,0);
});

test("inverse deskew retains quadrilateral evidence and explicitly marks page clipping", () => {
  const v=variant(), result=mapRecognitionBox({x0:0,y0:0,x1:12,y1:12},v,recognitionTransform(v,.1));
  assert.equal(result.evidence.clipped,true);assert.equal(result.bbox[0],0);
  assert.ok(result.evidence.quad.some(v=>v<0));
  assert.throws(()=>mapRecognitionBox({x0:0,y0:0,x1:1,y1:1},v,recognitionTransform(v,.7)),/outside/);
});

test("missing, invalid or mismatched frame metadata cannot invent an OCR location", () => {
  for(const patch of [{coordinateSpace:undefined},{coordinateSpace:"page-user-units"},{imageWidth:0},{imageHeight:Infinity},{pdfWidth:0},{pdfHeight:NaN},{pixelToDisplay:undefined},{pixelToDisplay:[1,0,0,1,0]},{pixelToDisplay:[NaN,0,0,NaN,0,0]},{pixelToDisplay:[0,0,0,0,0,0]},{pixelToDisplay:[.5,1,0,.5,0,0]},{pixelToDisplay:[.5,0,0,.6,0,0]},{pdfWidth:60}])
    assert.throws(()=>recognitionTransform({...variant(),...patch}),/transform|dimensions/);
  for(const rotation of [NaN,Infinity,4,".1"])assert.throws(()=>recognitionTransform(variant(),rotation),/rotation/);
});

test("malformed or out-of-image OCR boxes fail rather than becoming zero-sized text", () => {
  const v=variant(),t=recognitionTransform(v);
  for(const b of [undefined,{}, {...box,x0:NaN},{...box,x0:-1},{...box,y0:-1},{...box,x1:102},{...box,y1:82},{...box,x1:70},{...box,y1:10}])
    assert.throws(()=>mapRecognitionBox(b,v,t),/pixel bounding box/);
});

test("float rounding at an exact rendered page edge is not a clipping finding", () => {
  const scale=.24000000915527378,v={coordinateSpace:"crop-display-points",imageWidth:3374,imageHeight:2625,pdfWidth:810,pdfHeight:630,pixelToDisplay:[scale,0,0,scale,0,0]};
  const result=mapRecognitionBox({x0:19,y0:2558,x1:3249,y1:2625},v,recognitionTransform(v));
  assert.equal(result.evidence.clipped,false);
  assert.ok(Math.abs(result.bbox[1]+result.bbox[3]-630)<.000001);
});

test("line normalization keeps unrotated font height and the recognition transform", () => {
  const v=variant(),data={rotateRadians:.1,blocks:[{lines:[{text:"Image text",confidence:93,bbox:box,rowAttributes:{rowHeight:12}}]}]};
  const [block]=normalizeRecognizedTextBlocks(data,v,1,"test/auto");
  assert.equal(block.fontSize,6);assert.equal(block.ocrConfidence,93);
  assert.equal(block.ocrGeometry.recognitionRotationRadians,Math.fround(.1));
  assert.deepEqual(block.bbox,mapRecognitionBox(box,v,recognitionTransform(v,.1)).bbox);
  delete data.blocks[0].lines[0].rowAttributes;
  assert.equal(normalizeRecognizedTextBlocks(data,v,1,"test/auto")[0].fontSize,5);
  assert.deepEqual(normalizeRecognizedTextBlocks({blocks:[]},v,1,"test/auto"),[]);
});
