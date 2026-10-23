import {PDFArray,PDFDict,PDFName,PDFNumber,PDFString,PDFHexString,PDFStream} from 'pdf-lib';
const key=PDFName.of;
const require=(ok,why)=>{if(!ok)throw Error(why);};
const text=value=>{
  require(value instanceof PDFString||value instanceof PDFHexString,'Choice text must be a PDF string');
  const result=value.decodeText();require(result.length<=4096&&result.isWellFormed()&&!/[\x00-\x1f\x7f-\x9f\ufffd]/u.test(result),'Invalid choice text');return result;
};
const name=(value,fallback)=>{
  if(value===undefined&&fallback!==undefined)return fallback;
  require(value instanceof PDFName,'Choice state must be a name');const result=value.decodeText();
  // Name bytes and human strings are distinct. Unsupported name encodings stay
  // explicit instead of being conflated with Unicode Opt text.
  require(result.length>0&&result.length<=256&&!/[^\x20-\x7e]/u.test(result),'Unsupported choice state encoding');return result;
};
function inherited(field,property) {
  const seen=new Set();let node=field;
  while(node){require(node instanceof PDFDict&&!seen.has(node)&&seen.size<128,'Invalid choice field ancestry');seen.add(node);const value=node.lookup(key(property));if(value!==undefined)return value;node=node.lookup(key('Parent'));}
}
const integer=value=>{require(value instanceof PDFNumber&&Number.isSafeInteger(value.asNumber()),'Choice index/flags must be an integer');return value.asNumber();};
function widgets(field,refs) {
  const kids=field.lookup(key('Kids')),items=kids===undefined?[field]:kids instanceof PDFArray&&kids.size()<=1024?Array.from({length:kids.size()},(_,i)=>kids.lookup(i)):[];
  require(items.length&&new Set(items).size===items.length&&items.every(w=>w instanceof PDFDict&&w.lookup(key('Subtype'))===key('Widget')&&refs.has(w)),'Invalid choice widget inventory');
  require(items.every(w=>w===field||w.lookup(key('Parent'))===field),'Choice widget parent mismatch');return items;
}
function inspect(field,refs) {
  const ft=inherited(field,'FT');if(ft!==key('Btn')&&ft!==key('Ch'))return new Map();
  const rawFlags=inherited(field,'Ff'),flags=rawFlags===undefined?0:integer(rawFlags);require(flags>=0&&flags<=0x7fffffff,'Invalid choice flags');
  if(ft===key('Btn')&&(!(flags&32768)||flags&65536))return new Map();
  const controls=widgets(field,refs),fieldRef=refs.get(field);require(fieldRef,'Choice field must have an indirect identity');
  const tu=field.lookup(key('TU')),groupName=tu===undefined?'':text(tu),result=new Map(),base={fieldRef,groupName,flags,widgetCount:controls.length};
  if(ft===key('Btn')) {
    const value=name(inherited(field,'V'),'Off'),opt=field.lookup(key('Opt'));
    require(opt===undefined||opt instanceof PDFArray&&opt.size()===controls.length,'Radio Opt must match Kids exactly');
    const entries=controls.map((widget,index)=>{
      const ap=widget.lookup(key('AP')),normal=ap instanceof PDFDict?ap.lookup(key('N')):null;
      require(normal instanceof PDFDict,'Radio requires a normal appearance state dictionary');
      const on=normal.keys().filter(k=>k!==key('Off'));require(on.length===1&&normal.lookup(on[0]) instanceof PDFStream,'Radio requires one on-state stream');
      const off=normal.lookup(key('Off'));require(off===undefined||off instanceof PDFStream,'Invalid radio off appearance');
      const onState=name(on[0]),rawAs=widget.lookup(key('AS')),appearanceState=name(rawAs,'Off'),stateIssues=[];
      if(rawAs===undefined)stateIssues.push('MISSING_APPEARANCE_STATE');
      if(![onState,'Off'].includes(appearanceState))stateIssues.push('UNKNOWN_APPEARANCE_STATE');
      return {...base,kind:'radio',widgetIndex:index,onState,appearanceState,value,exportValue:opt?text(opt.lookup(index)):onState,exportSource:opt?'Opt':'AP-N',selected:appearanceState===onState,stateIssues};
    });
    const selected=entries.filter(e=>e.selected),unison=Boolean(flags&33554432),groupIssues=[];
    if(value!=='Off'&&!entries.some(e=>e.onState===value))groupIssues.push('UNKNOWN_GROUP_VALUE');
    if(selected.some(e=>e.onState!==value)||value!=='Off'&&!selected.length||value==='Off'&&selected.length)groupIssues.push('VALUE_APPEARANCE_MISMATCH');
    if(!unison&&selected.length>1)groupIssues.push('MULTIPLE_RADIO_SELECTIONS');
    if(unison&&entries.some(e=>(e.onState===value&&value!=='Off')!==e.selected))groupIssues.push('UNISON_STATE_MISMATCH');
    entries.forEach((entry,i)=>result.set(controls[i],{...entry,stateIssues:[...entry.stateIssues,...groupIssues]}));
  } else {
    const opt=inherited(field,'Opt');require(opt instanceof PDFArray&&opt.size()<=4096,'Choice options are missing or excessive');
    const options=Array.from({length:opt.size()},(_,i)=>{const item=opt.lookup(i);if(item instanceof PDFArray){require(item.size()===2,'Invalid choice option pair');return {exportValue:text(item.lookup(0)),displayValue:text(item.lookup(1))};}const value=text(item);return {exportValue:value,displayValue:value};});
    const rawValue=inherited(field,'V'),values=rawValue===undefined?[]:rawValue instanceof PDFArray?(require(rawValue.size()<=4096,'Excessive choice values'),Array.from({length:rawValue.size()},(_,i)=>text(rawValue.lookup(i)))):[text(rawValue)];
    const index=field.lookup(key('I')),stateIssues=[];let selectedIndices=[];
    if(index!==undefined){require(index instanceof PDFArray&&index.size()<=options.length,'Invalid choice selection indices');selectedIndices=Array.from({length:index.size()},(_,i)=>integer(index.lookup(i)));require(selectedIndices.every((v,i)=>v>=0&&v<options.length&&(!i||selectedIndices[i-1]<v)),'Invalid choice selection order');
      const indexed=[...new Set(selectedIndices.map(i=>options[i].exportValue))].sort();if(JSON.stringify(indexed)!==JSON.stringify([...new Set(values)].sort()))stateIssues.push('VALUE_INDEX_MISMATCH');
    } else for(const value of values){const found=options.flatMap((option,i)=>option.exportValue===value?[i]:[]);if(found.length>1)stateIssues.push('AMBIGUOUS_EXPORT_VALUE');else if(!found.length&&!(flags&131072&&flags&262144))stateIssues.push('UNKNOWN_CHOICE_VALUE');else selectedIndices.push(...found);}
    selectedIndices=[...new Set(selectedIndices)].sort((a,b)=>a-b);
    if(!(flags&2097152)&&(values.length>1||selectedIndices.length>1))stateIssues.push('MULTIPLE_SINGLE_CHOICE_VALUES');
    controls.forEach((widget,i)=>result.set(widget,{...base,kind:'choice',widgetIndex:i,options,values,selectedIndices,stateIssues:[...new Set(stateIssues)]}));
  }
  return result;
}

/** Read source values without using form APIs that can regenerate appearances.
 * Cache per terminal field so large repeated groups are inspected only once. */
export function choiceMetadata(widget,field,refs,cache=new Map()) {
  if(!cache.has(field)){
    try{cache.set(field,{entries:inspect(field,refs)});}catch(error){cache.set(field,{error:error.message});}
  }
  const saved=cache.get(field);if(saved.error)return {choiceMetadataError:saved.error};
  const choiceControl=saved.entries.get(widget);return choiceControl?{choiceControl}:{};
}
