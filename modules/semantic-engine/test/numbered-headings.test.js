import test from "node:test";
import assert from "node:assert/strict";
import {numberedSectionLevel} from "../numbered-headings.js";
import {refineHeadingMembership} from "../semantic-quality.js";
import {enrichDocumentRelations} from "../document-relations.js";
import {inferDocumentHeadings} from "../document-inference.js";
const n=(id,text,extra={})=>({id,text,role:"H1",headingLevel:1,pageNumber:1,fontName:"Sans",fontSize:12,bbox:[50,100,220,12],...extra});
test("decimal measurements, dates and versions cannot anchor section-number depth",()=>{
 for(const text of ["3.14 meters","1.5 kg of material","1.25% growth","2026.10.23 Release notes","23.10.2026","12.10.26","1.2.3 Version notes","01.2 Overview"])
  assert.equal(numberedSectionLevel(text),null,text);
 for(const [text,level] of [["1.2 Methods",2],["2.1.3) Results",3],["0.1 Scope",2],["1.2.3.4.5.6 Annex",6]])assert.equal(numberedSectionLevel(text),level);
 const nodes=[n("a","3.14 meters"),n("b","2026.10.23 Release notes",{pageNumber:2}),n("c","Another heading",{pageNumber:3})];
 enrichDocumentRelations(nodes,[]);inferDocumentHeadings(nodes);assert.ok(nodes.every(n=>n.role==="H1"));
});
test("body-sized numeric lines and explicit list membership are demoted without changing large numeric headings",()=>{
 const nodes=[n("a","3.14 meters"),n("b","2026-10-23"),n("c","1.1 First item",{listGroupId:"list",listMarker:"1.1"}),
  n("large","2026-10-23",{fontSize:24}),n("heading","1.2 Methods"),n("body","Ordinary body prose",{role:"P"})];
 refineHeadingMembership(nodes,[{pageNumber:1,height:800}]);
 assert.deepEqual(nodes.map(n=>n.role),["P","P","LI","H1","H1","P"]);
 assert.ok(nodes.slice(0,3).every(n=>n.headingLevel===undefined));
 enrichDocumentRelations(nodes,[]);assert.equal(nodes[4].role,"H2");assert.equal(nodes[2].role,"LI");
});
test("genuine numbered headings still establish style anchors across pages",()=>{
 const nodes=[n("a","1.2 Methods",{pageNumber:1}),n("b","2.2 Results",{pageNumber:2}),n("c","Conclusions",{pageNumber:3})];
 enrichDocumentRelations(nodes,[]);inferDocumentHeadings(nodes);assert.ok(nodes.every(n=>n.role==="H2"));
});
