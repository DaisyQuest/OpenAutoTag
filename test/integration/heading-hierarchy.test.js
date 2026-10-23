import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {assignReadingOrder} from "../../modules/reading-order/index.js";
import {buildTagTree} from "../../modules/tag-builder/index.js";
test("final reading order and semantic roles determine outline and section ancestry despite stale metadata",async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"heading-hierarchy-"));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,"semantic.json");
 const n=(id,role,y,headingLevel)=>({id,sourceBlockId:id,role,headingLevel,text:id,pageNumber:1,bbox:[50,y,200,12],confidence:1});
 const nodes=[n("child","H3",140,2),n("root","H1",60,1),n("demoted","P",100,4),n("section","H2",120,6),n("sibling","H2",180,2)];
 const outline=nodes.filter(n=>n.role!=="P").map(n=>({nodeId:n.id,parentNodeId:null,level:n.headingLevel,evidence:"outdated-inference",status:"requires-review"}));
 await writeFile(file,JSON.stringify({schemaVersion:"1.0.0",documentId:"hierarchy",source:{layoutDocumentId:"hierarchy"},nodes,outline,
 semanticReviewTasks:[{code:"HEADING_OUTLINE_GAP",nodeId:"child"}]}));
 const ordered=await assignReadingOrder(file);
 assert.deepEqual(ordered.outline.map(h=>[h.nodeId,h.parentNodeId,h.level]),[["root",null,1],["section","root",2],["child","section",3],["sibling","root",2]]);
 assert.ok(!ordered.semanticReviewTasks.some(t=>t.code==="HEADING_OUTLINE_GAP"));
 assert.equal(ordered.nodes.find(n=>n.id==="demoted").headingLevel,undefined);
 assert.equal(ordered.nodes.find(n=>n.id==="child").headingLevel,3);
 await writeFile(file,JSON.stringify(ordered));const tags=await buildTagTree(file),flat=[];
 const walk=(n,parent)=>{flat.push({id:n.id,type:n.type,parent});for(const c of n.children||[])walk(c,n.id);};walk(tags.root,null);
 assert.equal(flat.find(n=>n.id==="tag:demoted").type,"P");
 assert.deepEqual(["section","child","sibling"].map(id=>flat.find(n=>n.id===`tag:section:${id}`).parent),["tag:section:root","tag:section:section","tag:section:root"]);
 assert.deepEqual(["root","section","child","sibling"].map(id=>flat.find(n=>n.id===`tag:${id}`).type),["H1","H2","H3","H2"]);
});
