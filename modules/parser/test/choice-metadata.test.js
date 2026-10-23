import test from 'node:test';import assert from 'node:assert/strict';import {PDFDocument,PDFName,PDFString,PDFHexString} from 'pdf-lib';import Ajv2020 from'ajv/dist/2020.js';
import {choiceMetadata} from'../choice-metadata.js';import schema from'../../../contracts/form-choice.schema.json' with {type:'json'};
const valid=new Ajv2020().compile(schema),key=PDFName.of,str=PDFString.of;
function fixture(kind='radio') {
 const doc=PDFDocument.create();return doc.then(d=>{
  const c=d.context,field=c.obj({FT:kind==='radio'?'Btn':'Ch',Ff:kind==='radio'?32768:131072,T:str('contact'),TU:PDFHexString.fromText('Contact method')}),ref=c.register(field),refs=new Map([[field,ref.toString()]]),widgets=[];
  for(let i=0;i<2;i++){const w=c.obj({Subtype:'Widget',Parent:ref}),r=c.register(w);refs.set(w,r.toString());widgets.push(w);if(kind==='radio'){w.set(key('AP'),c.obj({N:{Off:c.register(c.stream('')),['s'+i]:c.register(c.stream(''))}}));w.set(key('AS'),key(i?'Off':'s0'));}}
  field.set(key('Kids'),c.obj(widgets.map(w=>c.getObjectRef(w))));field.set(key('V'),kind==='radio'?key('s0'):str('e'));if(kind==='choice')field.set(key('Opt'),c.obj([[str('e'),str('Email')],[str('p'),str('Phone')]]));
  const read=(i=0)=>choiceMetadata(widgets[i],field,refs);return {d,c,field,refs,widgets,read};
 });
}
test('radio semantics distinguish group name, native on-state and Unicode export value',async()=>{
 const f=await fixture();f.field.set(key('Opt'),f.c.obj([PDFHexString.fromText('Courriel'),PDFHexString.fromText('Téléphone')]));
 const one=f.read().choiceControl,two=f.read(1).choiceControl;assert.ok(valid(one),JSON.stringify(valid.errors));assert.equal(one.groupName,'Contact method');assert.equal(one.onState,'s0');assert.equal(one.exportValue,'Courriel');assert.equal(two.exportValue,'Téléphone');assert.equal(one.selected,true);assert.equal(two.selected,false);assert.deepEqual(one.stateIssues,[]);assert.equal(one.widgetIndex,0);assert.equal(two.widgetIndex,1);assert.equal(one.fieldRef,two.fieldRef);
 f.field.delete(key('Opt'));assert.equal(f.read().choiceControl.exportSource,'AP-N');assert.equal(f.read().choiceControl.exportValue,'s0');
});
test('choice display/export pairs, inherited values and duplicate exports retain exact indices',async()=>{
 const f=await fixture('choice');let value=f.read().choiceControl;assert.ok(valid(value));assert.deepEqual(value.options,[{exportValue:'e',displayValue:'Email'},{exportValue:'p',displayValue:'Phone'}]);assert.deepEqual(value.selectedIndices,[0]);
 f.field.set(key('Opt'),f.c.obj([[str('e'),str('Email home')],[str('e'),str('Email work')]]));assert.deepEqual(f.read().choiceControl.stateIssues,['AMBIGUOUS_EXPORT_VALUE']);f.field.set(key('I'),f.c.obj([1]));value=f.read().choiceControl;assert.deepEqual(value.selectedIndices,[1]);assert.deepEqual(value.stateIssues,[]);
 f.field.set(key('V'),str('p'));assert.deepEqual(f.read().choiceControl.stateIssues,['VALUE_INDEX_MISMATCH']);f.field.delete(key('I'));f.field.set(key('Ff'),f.c.obj(131072|262144));assert.deepEqual(f.read().choiceControl.stateIssues,[]);
 f.field.set(key('Opt'),f.c.obj([str('a'),str('b')]));f.field.set(key('V'),f.c.obj([str('a'),str('b')]));f.field.set(key('Ff'),f.c.obj(2097152));assert.deepEqual(f.read().choiceControl.selectedIndices,[0,1]);assert.deepEqual(f.read().choiceControl.stateIssues,[]);
 f.field.set(key('Ff'),f.c.obj(0));assert.deepEqual(f.read().choiceControl.stateIssues,['MULTIPLE_SINGLE_CHOICE_VALUES']);
 const parent=f.c.obj({V:str('a')});f.field.set(key('Parent'),parent);f.field.delete(key('V'));assert.deepEqual(f.read().choiceControl.values,['a']);
});
for(const [title,mutate,issue]of[
 ['unknown group value',f=>f.field.set(key('V'),key('missing')),'UNKNOWN_GROUP_VALUE'],
 ['missing AS',f=>f.widgets[0].delete(key('AS')),'MISSING_APPEARANCE_STATE'],
 ['unknown AS',f=>f.widgets[0].set(key('AS'),key('missing')),'UNKNOWN_APPEARANCE_STATE'],
 ['wrong selected state',f=>f.widgets[1].set(key('AS'),key('s1')),'VALUE_APPEARANCE_MISMATCH'],
 ['multiple selections',f=>f.widgets[1].set(key('AS'),key('s1')),'MULTIPLE_RADIO_SELECTIONS'],
 ['unison inconsistent',f=>{f.field.set(key('Ff'),f.c.obj(32768|33554432));const n=f.widgets[1].lookup(key('AP')).lookup(key('N'));n.set(key('s0'),n.get(key('s1')));n.delete(key('s1'));},'UNISON_STATE_MISMATCH']
])test(`radio ${title} remains an explicit state issue`,async()=>{const f=await fixture();mutate(f);assert.ok(f.read().choiceControl.stateIssues.includes(issue));});
for(const [title,kind,mutate]of[
 ['two on-states','radio',f=>{const n=f.widgets[0].lookup(key('AP')).lookup(key('N'));n.set(key('extra'),n.get(key('s0')));}],
 ['missing on stream','radio',f=>f.widgets[0].lookup(key('AP')).lookup(key('N')).set(key('s0'),str('bad'))],
 ['bad off stream','radio',f=>f.widgets[0].lookup(key('AP')).lookup(key('N')).set(key('Off'),str('bad'))],
 ['Opt wrong length','radio',f=>f.field.set(key('Opt'),f.c.obj([str('Email')]))],
 ['nonstring export','radio',f=>f.field.set(key('Opt'),f.c.obj([1,2]))],
 ['duplicate widgets','radio',f=>f.field.set(key('Kids'),f.c.obj([f.c.getObjectRef(f.widgets[0]),f.c.getObjectRef(f.widgets[0])]))],
 ['wrong parent','radio',f=>f.widgets[0].delete(key('Parent'))],
 ['unsupported state name','radio',f=>f.field.set(key('V'),key('é'))],
 ['invalid flags','radio',f=>f.field.set(key('Ff'),f.c.obj(-1))],
 ['fractional flags','radio',f=>f.field.set(key('Ff'),f.c.obj(3.5))],
 ['bad option pair','choice',f=>f.field.set(key('Opt'),f.c.obj([[str('a'),str('b'),str('c')]]))],
 ['invalid option text','choice',f=>f.field.set(key('Opt'),f.c.obj([str('bad\x00text')]))],
 ['oversized option text','choice',f=>f.field.set(key('Opt'),f.c.obj([str('x'.repeat(4097))]))],
 ['out-of-range I','choice',f=>f.field.set(key('I'),f.c.obj([2]))],
 ['duplicate I','choice',f=>f.field.set(key('I'),f.c.obj([0,0]))],
 ['unsorted I','choice',f=>f.field.set(key('I'),f.c.obj([1,0]))],
 ['missing options','choice',f=>f.field.delete(key('Opt'))],
 ['cyclic inheritance','choice',f=>{f.field.delete(key('Opt'));f.field.set(key('Parent'),f.field);}]
])test(`malformed ${title} is reported without invented metadata`,async()=>{const f=await fixture(kind);mutate(f);const result=f.read();assert.ok(result.choiceMetadataError);assert.equal(result.choiceControl,undefined);});
test('unison, absent values and non-choice controls retain their distinct meaning',async()=>{
 const f=await fixture();f.field.set(key('Ff'),f.c.obj(32768|33554432));const n=f.widgets[1].lookup(key('AP')).lookup(key('N'));n.set(key('s0'),n.get(key('s1')));n.delete(key('s1'));f.widgets[1].set(key('AS'),key('s0'));assert.deepEqual(f.read().choiceControl.stateIssues,[]);
 f.field.delete(key('V'));for(const w of f.widgets)w.set(key('AS'),key('Off'));assert.equal(f.read().choiceControl.value,'Off');assert.deepEqual(f.read().choiceControl.stateIssues,[]);
 const cache=new Map();assert.equal(choiceMetadata(f.widgets[0],f.field,f.refs,cache).choiceControl.widgetIndex,0);assert.equal(choiceMetadata(f.widgets[1],f.field,f.refs,cache).choiceControl.widgetIndex,1);assert.equal(cache.size,1);
 f.field.set(key('FT'),key('Tx'));assert.deepEqual(f.read(),{});f.field.set(key('FT'),key('Btn'));f.field.set(key('Ff'),f.c.obj(65536));assert.deepEqual(f.read(),{});
});
