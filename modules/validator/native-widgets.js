// Source annotation identity and reciprocal saved ownership, independent of the
// writer's resolver. Names, values, field topology, actions and AP bytes stay exact.
export function inspectNativeWidgets({source,inspection,ownership,intendedNodes,choiceReview,add}) {
  const intents=new Map(intendedNodes.filter(v=>v.n.nativeWidget).map(v=>[v.n.id,v]));
  if(ownership.nativeWidgets===undefined&&!intents.size)return {valid:true,verified:false};
  let valid=true;
  const check=(code,id,a,b)=>{add(code,id,a,b);const same=JSON.stringify(a)===JSON.stringify(b);valid&&=same;return same;};
  const declarations=ownership.nativeWidgets||[],saved=new Map(Object.entries(inspection.widgets||{}).map(([ref,w])=>[`${w.page}:${w.annotationIndex}`,{ref,...w}]));
  const structures=new Map(inspection.structure.map(n=>[n.objectRef,n])),ids=new Map(inspection.structure.map(n=>[n.identifier,n]));
  check('NATIVE_WIDGET_COUNT','document',Object.keys(source.widgets||{}).length,Object.keys(inspection.widgets||{}).length);
  const seen=new Set(),owners=new Set();
  const accepted=[...intents.values()].filter(v=>v.n.nativeWidget.choiceLabelStatus==='accepted').map(v=>v.n.nativeWidget);
  if(choiceReview||accepted.length){
    check('NATIVE_CHOICE_REVIEW_SOURCE','document',source.sourceHash,choiceReview?.sourceHash||null);
    check('NATIVE_CHOICE_REVIEW_GROUPS','document',[...new Set(accepted.map(w=>w.choiceControl?.fieldRef))].sort(),[...(choiceReview?.fieldRefs||[])].sort());
    for(const ref of choiceReview?.fieldRefs||[])check('NATIVE_CHOICE_REVIEW_COVERAGE',ref,true,Object.entries(source.widgets||{}).filter(([,w])=>w.choiceControl?.fieldRef===ref).every(([id])=>accepted.some(w=>w.sourceRef===id&&w.choiceLabel?.trim()&&w.placement==='label-context')));
  }
  const stateInspected=w=>Boolean(w&&typeof w.fieldName==='string'&&['nativeDigest','fieldStateHash'].every(k=>/^[a-f0-9]{64}$/.test(w[k]||''))&&(w.appearanceHash==='absent'||/^[a-f0-9]{64}$/.test(w.appearanceHash||'')));
  for(const d of declarations) {
    const original=source.widgets?.[d.sourceRef],current=saved.get(`${d.pageNumber}:${d.annotationIndex}`),intent=intents.get(d.tagId),owner=ids.get(`oat:${d.tagId}`);
    if(!check('NATIVE_WIDGET_SOURCE',d.sourceRef,true,Boolean(original&&original.page===d.pageNumber&&original.annotationIndex===d.annotationIndex&&!seen.has(d.sourceRef))))continue;
    seen.add(d.sourceRef);
    check('NATIVE_WIDGET_STATE_INSPECTED',d.sourceRef,true,stateInspected(original)&&stateInspected(current));
    const explicit=Boolean(intent&&intent.n.type==='Form'&&intent.n.nativeWidget.sourceRef===d.sourceRef&&intent.n.nativeWidget.pageNumber===d.pageNumber&&intent.n.nativeWidget.fieldName===d.fieldName&&intent.n.nativeWidget.placement===d.placement);
    const generated=!intent&&d.generated&&d.tagId===`native-widget:${d.pageNumber}:${d.annotationIndex}`&&d.placement==='unresolved'&&owner&&structures.get(owner.parentRef)?.role==='Document';
    check('NATIVE_WIDGET_INTENT',d.sourceRef,true,d.generated?Boolean(generated):explicit);
    check('NATIVE_WIDGET_FIELD_NAME',d.sourceRef,original.fieldName,d.fieldName);
    if(!check('NATIVE_WIDGET_SAVED',d.sourceRef,true,Boolean(current)))continue;
    for(const key of ['fieldName','nativeDigest','fieldStateHash','appearanceHash'])check(`NATIVE_WIDGET_${key.toUpperCase()}`,d.sourceRef,original[key],current[key]);
    const choice=intent?.n.nativeWidget.choiceControl;
    if(choice){
      const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
      check('NATIVE_CHOICE_SOURCE',d.sourceRef,canonical(choice),canonical(original.choiceControl)||null);
      check('NATIVE_CHOICE_SAVED',d.sourceRef,canonical(choice),canonical(current.choiceControl)||null);
      check('NATIVE_CHOICE_STATE',d.sourceRef,[],choice.stateIssues);
    }
    check('NATIVE_WIDGET_PARENT_KEY',d.sourceRef,d.parentTreeKey,current.structParent);
    const exactOwner=Boolean(owner&&owner.role==='Form'&&!owners.has(owner.objectRef)&&owner.page===d.pageNumber&&owner.children.length===0&&owner.contentRefs.length===1&&owner.contentRefs[0]===`obj:${current.ref}`&&current.owners.length===1&&current.owners[0].form===owner.objectRef);
    check('NATIVE_WIDGET_FORM_OWNER',d.sourceRef,true,exactOwner);if(owner)owners.add(owner.objectRef);
  }
  for(const ref of Object.keys(source.widgets||{}))check('NATIVE_WIDGET_COVERAGE',ref,true,seen.has(ref));
  for(const {n} of intents.values())check('NATIVE_WIDGET_DECLARATION',n.id,true,declarations.some(d=>d.tagId===n.id&&!d.generated));
  return {valid,verified:valid};
}
