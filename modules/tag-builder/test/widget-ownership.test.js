import test from 'node:test';import assert from 'node:assert/strict';import {attachWidgetOwnership} from '../widget-ownership.js';
const fixture=()=>({root:{id:'root',type:'Document',children:[{id:'p',type:'P',children:[{id:'s',type:'Span',sourceNodeIds:['label'],children:[]}]}]},semantic:{formRelationships:[{id:'field',labels:['label'],widgets:[{id:'10R',fieldName:'person.name',pageNumber:1,labelStatus:'associated',labelNodeIds:['label'],bbox:[10,10,100,20]}]}]}});
test('each repeated field widget gets a distinct Form under its source label',()=>{
 const d=fixture();d.semantic.formRelationships[0].widgets.push({...d.semantic.formRelationships[0].widgets[0],id:'11R2'});
 const r=attachWidgetOwnership(d.root,d.semantic);assert.equal(r.widgets.length,2);assert.deepEqual(r.reviews,[]);
 assert.deepEqual(d.root.children[0].children.map(n=>n.type),['Span','Form','Form']);assert.equal(d.root.children[0].children[2].nativeWidget.sourceRef,'11 2 R');
});
test('heading labels retain heading membership and Form siblings',()=>{
 const d=fixture();d.root.children[0].type='H2';d.semantic.formRelationships[0].widgets.push({...d.semantic.formRelationships[0].widgets[0],id:'11R'});
 attachWidgetOwnership(d.root,d.semantic);assert.deepEqual(d.root.children.map(n=>n.type),['H2','Form','Form']);
});
test('merged label fragments retain a unique shared label container',()=>{
 const d=fixture();d.root.children[0].children[0].sourceNodeIds.push('second-label');d.semantic.formRelationships[0].widgets[0].labelNodeIds.push('second-label');
 const result=attachWidgetOwnership(d.root,d.semantic);assert.deepEqual(result.reviews,[]);assert.equal(d.root.children[0].children[1].nativeWidget.placement,'label-context');
});
for(const kind of ['missing-label','ambiguous-label','unassociated','context'])test(`widget placement handles ${kind} explicitly`,()=>{
 const d=fixture(),w=d.semantic.formRelationships[0].widgets[0];
 if(kind==='missing-label')w.labelNodeIds=['missing'];
 if(kind==='ambiguous-label')d.root.children[0].children.push({id:'s2',type:'Span',sourceNodeIds:['label'],children:[]});
 if(kind==='unassociated')w.labelStatus='unresolved';
 if(kind==='context'){w.labelStatus='associated-context';w.contextNodeIds=['label'];}
 const r=attachWidgetOwnership(d.root,d.semantic);assert.equal(r.widgets.length,1);assert.equal(r.reviews.length,kind==='context'?0:1);
});
test('unresolvable source references remain review work instead of field-name matching',()=>{
 for(const id of ['name','0R','9007199254740992R','10R65536']){const d=fixture();d.semantic.formRelationships[0].widgets[0].id=id;const r=attachWidgetOwnership(d.root,d.semantic);assert.equal(r.widgets.length,0);assert.equal(r.reviews[0].code,'WIDGET_SOURCE_ID_UNRESOLVED');}
});
test('duplicate source and tag identities reject',()=>{
 const d=fixture();d.semantic.formRelationships[0].widgets.push({...d.semantic.formRelationships[0].widgets[0]});assert.throws(()=>attachWidgetOwnership(d.root,d.semantic),/Duplicate semantic widget/);
 const c=fixture();c.root.children[0].id='tag:widget:10R';assert.throws(()=>attachWidgetOwnership(c.root,c.semantic),/Duplicate widget tag/);
});
test('excessive or cyclic trees fail before widget placement',()=>{
 const d=fixture();d.root.children[0].children.push(d.root);assert.throws(()=>attachWidgetOwnership(d.root,d.semantic),/Invalid widget intent tree/);
 const deep=fixture();let node=deep.root;for(let i=0;i<130;i++){const child={id:`deep${i}`,type:'Div',children:[]};node.children=[child];node=child;}assert.throws(()=>attachWidgetOwnership(deep.root,deep.semantic),/Invalid widget intent tree/);
});
test('labels separated by unrelated prose require placement review',()=>{
 const d=fixture();d.root.children.push({id:'prose',type:'P',children:[]},{id:'other',type:'P',sourceNodeIds:['other-label'],children:[]});d.semantic.formRelationships[0].widgets[0].labelNodeIds.push('other-label');
 const result=attachWidgetOwnership(d.root,d.semantic);assert.equal(result.reviews[0].code,'WIDGET_PLACEMENT_REVIEW');
});
