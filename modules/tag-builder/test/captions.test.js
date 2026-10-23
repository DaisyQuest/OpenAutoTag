import test from 'node:test';import assert from 'node:assert/strict';
import {associateCaptions} from '../captions.js';
const data=()=>{
 const nodes=[{id:'cell',sourceBlockId:'block',role:'TD',text:'100',pageNumber:1,bbox:[10,50,200,60],tableId:'table'},
 {id:'caption',role:'P',text:'Table 1: Inventory',pageNumber:1,bbox:[10,120,200,12]}];
 const table={id:'tag:table',type:'Table',children:[{id:'tag:cell',type:'TD',sourceNodeIds:['cell'],children:[]}]};
 const caption={id:'tag:caption',type:'Caption',label:nodes[1].text,children:[{id:'span',type:'Span',sourceNodeIds:['caption'],children:[]}]};
 return {source:{coordinateSpace:"crop-display-points"},nodes,table,caption,root:{id:'root',type:'Document',children:[table,caption]}};
};
for(const position of ['before','after'])test(`Table caption stays at its ${position} boundary`,()=>{
 const d=data();if(position==='before'){d.root.children.reverse();d.nodes[1].bbox[1]=28;}
 const r=associateCaptions(d.root,d,{enableCaptionDetection:true});assert.equal(r.associated,1);assert.equal(d.root.children.length,1);assert.equal(d.table.children.at(position==='before'?0:-1),d.caption);assert.equal(d.caption.captionAssociation.position,position);
});
for(const target of ['cell','block','table','tag:table'])test(`explicit caption resolves ${target} without inference flag`,()=>{
 const d=data();d.nodes[1].captionForId=target;d.caption.type='P';assert.equal(associateCaptions(d.root,d).associated,1);
});
for(const mutation of ['missing','intervening','wrong-page','wrong-kind','too-far','no-overlap','conflict','ambiguous','duplicate'])test(`caption declines ${mutation} without reordering source text`,()=>{
 const d=data();d.nodes[1].captionForId='table';
 if(mutation==='missing')d.nodes[1].captionForId='unknown';
 if(mutation==='intervening')d.root.children.splice(1,0,{id:'prose',type:'P',children:[]});
 if(mutation==='wrong-page')d.nodes[1].pageNumber=2;
 if(mutation==='wrong-kind')d.caption.label='Figure 1: Inventory';
 if(mutation==='too-far')d.nodes[1].bbox[1]=200;
 if(mutation==='no-overlap')d.nodes[1].bbox[0]=300;
 if(mutation==='conflict'){d.figures=[{id:'image',pageNumber:1,bbox:[10,50,200,60],captionNodeIds:['caption']}];}
 if(mutation==='ambiguous'){d.root.children.unshift({...structuredClone(d.table),id:'other'});}
 if(mutation==='duplicate'){const n={...d.nodes[1],id:'second'};d.nodes.push(n);d.root.children.push({...structuredClone(d.caption),id:'second-caption',children:[{id:'second-span',type:'Span',sourceNodeIds:['second'],children:[]}]});}
 const before=d.root.children.map(n=>n.id),r=associateCaptions(d.root,d,{enableCaptionDetection:true});
 if(mutation==='duplicate'){assert.equal(r.associated,1);assert.equal(r.reviews[0].code,'CAPTION_TARGET_ALREADY_CLAIMED');}
 else {assert.equal(r.associated,0);assert.deepEqual(d.root.children.map(n=>n.id),before);}
 assert.equal(r.reviews.length,1);
});
for(const position of ['before','after'])test(`Figure caption is an adjacent ${position} sibling with image intent`,()=>{
 const d=data();d.root.children=[d.caption];d.nodes=d.nodes.slice(1);d.nodes[0].captionForId='figure:image';d.caption.label='Figure 1: Image';
 d.figures=[{id:'image',pageNumber:1,bbox:[10,50,200,60],captionNodeIds:['caption']}];if(position==='before')d.nodes[0].bbox[1]=28;
 const r=associateCaptions(d.root,d);assert.equal(r.associated,1);assert.deepEqual(d.root.children.map(n=>n.type),position==='before'?['Caption','Figure']:['Figure','Caption']);assert.deepEqual(d.root.children.find(n=>n.type==='Figure').children,[]);
});
test('Figure labels or prose between image and caption require review',()=>{
 const d=data();d.root.children=[d.caption];d.caption.label='Figure 1: Image';d.nodes[1].captionForId='figure:image';d.figures=[{id:'image',pageNumber:1,bbox:[10,50,200,60],captionNodeIds:[]}];
 const r=associateCaptions(d.root,d);assert.equal(r.associated,0);assert.equal(r.reviews[0].code,'CAPTION_FIGURE_CONTENT_INTERVENES');
});
for(const position of ['before','after'])test(`continued table accepts its ${position} caption on the boundary page`,()=>{
 const d=data();d.nodes.push({...d.nodes[0],id:'next',pageNumber:2,bbox:[10,20,200,70]});d.table.children.push({id:'next-cell',type:'TD',sourceNodeIds:['next'],children:[]});
 if(position==='before'){d.root.children.reverse();d.nodes[1].bbox[1]=28;}else{d.nodes[1].pageNumber=2;d.nodes[1].bbox[1]=100;}
 assert.equal(associateCaptions(d.root,d,{enableCaptionDetection:true}).associated,1);
});
test('figure caption with undeclared coordinate frame remains a review task',()=>{
 const d=data();delete d.source.coordinateSpace;d.root.children=[d.caption];d.nodes=d.nodes.slice(1);d.caption.label='Figure 1: Image';d.figures=[{id:'image',pageNumber:1,bbox:[10,50,200,60],captionNodeIds:['caption']}];
 const result=associateCaptions(d.root,d);assert.equal(result.associated,0);assert.equal(result.reviews[0].code,'CAPTION_FIGURE_COORDINATES_UNQUALIFIED');
});
