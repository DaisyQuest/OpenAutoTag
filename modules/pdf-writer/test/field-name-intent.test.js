import test from 'node:test';import assert from 'node:assert/strict';import {validateFieldNameIntent} from '../field-name-intent.js';
const data=()=>({review:{fields:[{fieldRef:'20 0 R',fieldName:'name',widgetRefs:['21 0 R','22 0 R'],label:'Full name',labelNodeIds:['a','b']}]},semantic:{nodes:[{id:'a',text:'Full name:',pageNumber:1,role:'P'},{id:'b',text:'Full name:',pageNumber:2,role:'P'}],formRelationships:[{widgets:[{id:'21R',fieldRef:'20 0 R',fieldName:'name',pageNumber:1,labelStatus:'associated',labelNodeIds:['a']},{id:'22R',fieldRef:'20 0 R',fieldName:'name',pageNumber:2,labelStatus:'associated',labelNodeIds:['b']}]}]}});
test('review binds every repeated widget to visible label text',()=>{const d=data();assert.doesNotThrow(()=>validateFieldNameIntent(d.review,d.semantic));});
for(const kind of ['duplicate-field','duplicate-widget','duplicate-node','wrong-ref','wrong-name','missing-widget','unrelated-label','missing-label','wrong-page','artifact-label','changed-label','unresolved','control-text','blank-name'])test(`field-name intent rejects ${kind}`,()=>{
 const d=data(),entry=d.review.fields[0],group=d.semantic.formRelationships[0].widgets;
 if(kind==='duplicate-field')d.review.fields.push(entry);
 if(kind==='duplicate-widget')group.push(group[0]);
 if(kind==='duplicate-node')d.semantic.nodes.push(d.semantic.nodes[0]);
 if(kind==='wrong-ref')entry.fieldRef='99 0 R';
 if(kind==='wrong-name')entry.fieldName='wrong';
 if(kind==='missing-widget')entry.widgetRefs.pop();
 if(kind==='unrelated-label')entry.labelNodeIds.push('other');
 if(kind==='missing-label')entry.labelNodeIds.pop();
 if(kind==='wrong-page')d.semantic.nodes[0].pageNumber=2;
 if(kind==='artifact-label')d.semantic.nodes[0].role='Artifact';
 if(kind==='changed-label')entry.label='Other person';
 if(kind==='unresolved')group[0].labelStatus='unresolved';
 if(kind==='control-text')entry.label='Full\nname';
 if(kind==='blank-name')entry.label=' ';assert.throws(()=>validateFieldNameIntent(d.review,d.semantic));
});
test('button-owned appearance text can support an accepted name without page labels',()=>{
 const d=data();d.semantic.formRelationships[0].widgets.pop();d.review.fields[0].widgetRefs.pop();d.review.fields[0].labelNodeIds=[];
 Object.assign(d.semantic.formRelationships[0].widgets[0],{pushButton:true,labelStatus:'associated-appearance',appearanceTextSource:'normal-widget-appearance',appearanceText:'Full name'});
 assert.doesNotThrow(()=>validateFieldNameIntent(d.review,d.semantic));
});
test('a reviewed name cannot omit or reorder wrapped label fragments',()=>{
 const d=data();d.semantic.nodes.push({id:'c',text:'required',pageNumber:1,role:'P'});d.semantic.formRelationships[0].widgets[0].labelNodeIds.push('c');
 assert.throws(()=>validateFieldNameIntent(d.review,d.semantic),/complete accepted/);
 d.review.fields[0].labelNodeIds.push('c');d.review.fields[0].label='required Full name';assert.throws(()=>validateFieldNameIntent(d.review,d.semantic),/complete visible label in order/);
 d.review.fields[0].label='Full name required';assert.doesNotThrow(()=>validateFieldNameIntent(d.review,d.semantic));
});
