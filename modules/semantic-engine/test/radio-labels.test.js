import test from'node:test';import assert from'node:assert/strict';import{enrichDocumentRelations}from'../document-relations.js';import{radioChoiceLabel}from'../radio-labels.js';
const widget=(id,index)=>({id,fieldId:'contact',fieldRef:'3 0 R',fieldName:'contact',fieldType:'Btn',pageNumber:1,radioButton:true,tooltip:'Preferred contact method',bbox:[100,100+index*40,16,16],choiceControl:{kind:'radio',fieldRef:'3 0 R',groupName:'Preferred contact method',flags:32768,widgetCount:2,widgetIndex:index,onState:index?'s1':'s0',appearanceState:index?'Off':'s0',value:'s0',exportValue:index?'phone':'email',exportSource:'Opt',selected:!index,stateIssues:[]}});
const node=(id,widgetId,text,y)=>({id,pageNumber:1,role:'P',text,bbox:[120,y,100,16],fontSize:12,formFieldIds:[widgetId]});
test('group tooltip is preserved while distinct radio labels gain structural placement',()=>{
 const ws=[widget('4R',0),widget('5R',1)],nodes=[node('email','4R','Email contact',100),node('phone','5R','Phone contact',140)];
 const r=enrichDocumentRelations(nodes,[{pageNumber:1,formFields:ws}]);assert.equal(r.formRelationships.length,1);assert.equal(r.formRelationships[0].fieldRef,'3 0 R');
 assert.deepEqual(r.formRelationships[0].widgets.map(w=>w.labelNodeIds),[['email'],['phone']]);assert.ok(r.formRelationships[0].widgets.every(w=>w.tooltip==='Preferred contact method'&&w.choiceLabelStatus==='requires-review'));assert.equal(r.semanticReviewTasks.filter(t=>t.code==='FORM_CHOICE_LABEL_REVIEW').length,2);
});
test('equal field names never merge different native field identities',()=>{const a=widget('4R',0),b=widget('5R',1);b.fieldRef='9 0 R';const r=enrichDocumentRelations([],[{pageNumber:1,formFields:[a,b]}]);assert.equal(r.formRelationships.length,2);});
test('ambiguous, artifact, wrong-page and invalid-state choice labels remain unresolved',()=>{
 const w=widget('4R',0),n=node('label','4R','Contact option',100);assert.equal(radioChoiceLabel(w,[n]).label,n.text);
 assert.equal(radioChoiceLabel(w,[n,{...n,id:'other'}]),null);assert.equal(radioChoiceLabel(w,[{...n,role:'Artifact'}]),null);assert.equal(radioChoiceLabel(w,[{...n,pageNumber:2}]),null);assert.equal(radioChoiceLabel(w,[{...n,formFieldIds:['4R','5R']}]),null);assert.equal(radioChoiceLabel({...w,choiceControl:{...w.choiceControl,stateIssues:['UNKNOWN_GROUP_VALUE']}},[n]),null);
 assert.equal(radioChoiceLabel(w,[{...n,text:'Email'},node('other','4R','Instructions',100)]).label,'Email');
});
test('authored number names still match printed number-symbol prompts after parent tooltip extraction',()=>{
 const w={id:'4R',fieldId:'index',fieldRef:'3 0 R',fieldName:'index',fieldType:'Tx',tooltip:'Index number',bbox:[100,120,120,20]};
 for(const text of ['Index #:','Index #: __________']){const n={id:'label',pageNumber:1,role:'P',text,bbox:[100,100,90,14],fontSize:12};const result=enrichDocumentRelations([n],[{pageNumber:1,formFields:[w]}]);assert.deepEqual(result.formRelationships[0].widgets[0].labelNodeIds,['label']);assert.equal(n.text,text);}
 const n={id:'label',pageNumber:1,role:'P',text:'C#:',bbox:[100,100,30,14],fontSize:12};assert.equal(enrichDocumentRelations([n],[{pageNumber:1,formFields:[{...w,tooltip:'C number'}]}]).formRelationships[0].widgets[0].labelStatus,'authored-name-visual-association-unresolved');
});
