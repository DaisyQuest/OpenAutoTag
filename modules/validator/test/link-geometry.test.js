import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLinkGeometry,containsLinkGlyph} from '../link-geometry.js';
const rectangle=[-10,-10,30,30],quad=[0,0,10,0,10,10,0,10];
const shape=points=>inspectLinkGeometry({rectangle,quadPointsPresent:true,quadPoints:points});
const point=(x,y)=>[1,0,0,1,x,y,0,0];
test('independent link geometry excludes rectangle-only neighbors and unions disjoint quads',()=>{
 const region=shape([...quad,...quad.map((v,i)=>v+(i%2===0?15:0))]);assert.equal(region.valid,true);
 assert.equal(containsLinkGlyph(region,point(5,5)),true);assert.equal(containsLinkGlyph(region,point(20,5)),true);
 assert.equal(containsLinkGlyph(region,point(12.5,5)),false);assert.equal(containsLinkGlyph(region,point(-5,5)),false);
 const rotated=shape([0,0,10,10,0,20,-10,10]);assert.equal(rotated.valid,true);
 assert.equal(containsLinkGlyph(rotated,[0,1,-1,0,0,5,10,0]),true);assert.equal(containsLinkGlyph(rotated,point(9,1)),false);
 assert.equal(containsLinkGlyph(rotated,point(100,100)),false);assert.equal(containsLinkGlyph(rotated,[]),false);assert.equal(containsLinkGlyph(rotated,point(NaN,0)),false);
 const concave=shape([0,0,10,0,3,3,0,10]);assert.equal(concave.valid,true);assert.equal(containsLinkGlyph(concave,point(2,2)),true);assert.equal(containsLinkGlyph(concave,point(5,5)),false);
});
test('malformed quads cannot qualify, while their rectangle still blocks a competitor',()=>{
 const bad=[null,[],quad.slice(0,7),[NaN,...quad.slice(1)],[...quad.slice(0,6),0,0],[0,0,0,10,10,10,10,0],[0,10,10,10,0,0,10,0],[0,0,10,0,5,5,0,10],[-11,0,10,0,10,10,0,10],Array(1025).fill(quad).flat()];
 for(const data of bad){const region=shape(data);assert.equal(region.valid,false);assert.equal(containsLinkGlyph(region,point(5,5)),true);}
 const custom=inspectLinkGeometry({rectangle,linkPathPresent:true});assert.equal(custom.valid,false);assert.equal(containsLinkGlyph(custom,point(5,5)),true);
 for(const r of [null,[0,0,0,10],[0,0,10,Infinity]]){const region=inspectLinkGeometry({rectangle:r});assert.equal(region.valid,false);assert.equal(containsLinkGlyph(region,point(5,5)),false);}
 const rect=inspectLinkGeometry({rectangle});assert.equal(rect.valid,true);assert.equal(containsLinkGlyph(rect,point(5,5)),true);
});
test('quad work is charged to the verifier budget even when the point misses early regions',()=>{
 const region=shape(Array(1024).fill(quad).flat());assert.equal(region.valid,true);let work=0;
 assert.equal(containsLinkGlyph(region,point(20,20),()=>work++),false);assert.equal(work,1025);
 assert.throws(()=>containsLinkGlyph(region,point(20,20),()=>{throw Error('limit');}),/limit/);
});
