import test from 'node:test';import assert from 'node:assert/strict';import {inspectNativeWidgets} from '../native-widgets.js';
const fixture=()=>{
 const w={page:1,annotationIndex:2,fieldName:'person.name',nativeDigest:'a'.repeat(64),fieldStateHash:'b'.repeat(64),appearanceHash:'c'.repeat(64),structParent:4,owners:[{form:'form'}]};
 const intent={id:'oat:widget',n:{id:'widget',type:'Form',nativeWidget:{sourceRef:'10 0 R',pageNumber:1,fieldName:w.fieldName,placement:'label-context'}}};
 return {source:{widgets:{'10 0 R':w}},inspection:{widgets:{'10 0 R':structuredClone(w)},structure:[{objectRef:'root',role:'Document',children:['form']},{objectRef:'form',parentRef:'root',identifier:intent.id,role:'Form',page:1,children:[],contentRefs:['obj:10 0 R']}]},ownership:{nativeWidgets:[{pageNumber:1,annotationIndex:2,sourceRef:'10 0 R',fieldName:w.fieldName,tagId:'widget',generated:false,placement:'label-context',parentTreeKey:4}]},intendedNodes:[intent]};
};
test('one saved Form per original widget verifies source identity and properties',()=>{assert.deepEqual(inspectNativeWidgets({...fixture(),add(){}}),{valid:true,verified:true});});
for(const mutation of ['missing','duplicate','extra','wrong-source','wrong-page','wrong-name','changed-value','changed-action','changed-appearance','wrong-parent-key','wrong-owner','multiple-owners','wrong-role','wrong-content','extra-child','missing-intent'])test(`widget verification rejects ${mutation}`,()=>{
 const d=fixture(),w=d.inspection.widgets['10 0 R'],f=d.inspection.structure[1],declaration=d.ownership.nativeWidgets[0];
 if(mutation==='missing')d.ownership.nativeWidgets=[];
 if(mutation==='duplicate')d.ownership.nativeWidgets.push({...declaration});
 if(mutation==='extra')d.inspection.widgets['11 0 R']={...w,annotationIndex:3};
 if(mutation==='wrong-source')declaration.sourceRef='11 0 R';
 if(mutation==='wrong-page')declaration.pageNumber=2;
 if(mutation==='wrong-name')declaration.fieldName='other';
 if(mutation==='changed-value')w.fieldStateHash='changed';
 if(mutation==='changed-action')w.nativeDigest='changed';
 if(mutation==='changed-appearance')w.appearanceHash='changed';
 if(mutation==='wrong-parent-key')w.structParent=9;
 if(mutation==='wrong-owner')w.owners=[{form:'other'}];
 if(mutation==='multiple-owners')w.owners.push({form:'form'});
 if(mutation==='wrong-role')f.role='P';
 if(mutation==='wrong-content')f.contentRefs=['obj:11 0 R'];
 if(mutation==='extra-child')f.children=['extra'];
 if(mutation==='missing-intent')d.intendedNodes=[];
 assert.equal(inspectNativeWidgets({...d,add(){}}).valid,false);
});
test('legacy source-derived fallback Forms are verified without certifying placement',()=>{
 const d=fixture();d.intendedNodes=[];const n=d.ownership.nativeWidgets[0];Object.assign(n,{generated:true,tagId:'native-widget:1:2',placement:'unresolved'});d.inspection.structure[1].identifier='oat:'+n.tagId;
 assert.equal(inspectNativeWidgets({...d,add(){}}).verified,true);
});
test('older reports do not gain new widget qualification',()=>{assert.deepEqual(inspectNativeWidgets({intendedNodes:[],ownership:{},add(){}}),{valid:true,verified:false});});
for(const mutation of ['missing-saved','missing-state','missing-owner','missing-report','unbound-fallback'])test(`incomplete widget evidence rejects ${mutation}`,()=>{
 const d=fixture();
 if(mutation==='missing-saved')d.inspection.widgets={};
 if(mutation==='missing-state')delete d.inspection.widgets['10 0 R'].nativeDigest;
 if(mutation==='missing-owner')d.inspection.structure=[];
 if(mutation==='missing-report')delete d.ownership.nativeWidgets;
 if(mutation==='unbound-fallback'){d.intendedNodes=[];d.ownership.nativeWidgets[0].generated=true;}
 assert.equal(inspectNativeWidgets({...d,add(){}}).verified,false);
});
