export function navigationExclusion(state) {
  if(!state)return null;
  if(state.annotationFlags&2)return 'hidden';
  if(state.annotationFlags&32)return 'no-view';
  if(!state.hasArea)return 'empty-rectangle';
  return null;
}

export function orderWidgetEntries(widgets) {
  const entries=[...widgets].sort((a,b)=>a.pageNumber-b.pageNumber||(a.bbox?.[1]||0)-(b.bbox?.[1]||0)||(a.bbox?.[0]||0)-(b.bbox?.[0]||0)||a.id.localeCompare(b.id)),groups=new Map();
  for(const [index,w]of entries.entries()){
    const labels=w.labelStatus==='associated'?w.labelNodeIds:w.labelStatus==='associated-context'?w.contextNodeIds:null;
    if(!labels?.length||!w.bbox?.every(Number.isFinite)||w.bbox[3]<=0)continue;
    const key=JSON.stringify([w.pageNumber,[...labels].sort()]),group=groups.get(key)||[];group.push({w,index});groups.set(key,group);
  }
  for(const group of groups.values()){
    const rows=[];
    for(const item of group){const y=item.w.bbox[1]+item.w.bbox[3]/2,last=rows.at(-1),first=last?.[0].w;
      // Compare with a fixed row anchor; a tolerance comparator passed to sort
      // would be non-transitive and could reorder controls unpredictably.
      if(first&&Math.abs(y-first.bbox[1]-first.bbox[3]/2)<=Math.min(item.w.bbox[3],first.bbox[3])*0.35)last.push(item);else rows.push([item]);
    }
    const ordered=rows.flatMap(row=>row.sort((a,b)=>a.w.bbox[0]-b.w.bbox[0]||a.w.bbox[1]-b.w.bbox[1]||a.w.id.localeCompare(b.w.id)));
    group.forEach(({index},i)=>{entries[index]=ordered[i].w;});
  }
  return entries;
}

/** Enumerate final logical widget order, never field-name order or Annots order.
 * Saved checking independently recomputes visibility from the original PDF. */
export function widgetNavigationPlan(root) {
  const order=[],excluded=[],unresolved=[],inventory=[];
  const walk=n=>{
    const w=n.nativeWidget;
    if(w){
      inventory.push(w.sourceRef);const reason=navigationExclusion(w.navigationState);
      if(reason){excluded.push({sourceRef:w.sourceRef,reason});if(w.navigationState.optionalContent||(w.navigationState.annotationFlags&256))unresolved.push(w.sourceRef);}
      else {
        order.push(w.sourceRef);
        if(!w.navigationState||w.placement!=='label-context'||w.navigationState.optionalContent||(w.navigationState.annotationFlags&256))unresolved.push(w.sourceRef);
      }
    }
    for(const child of n.children)walk(child);
  };walk(root);
  return {schemaVersion:'1.0.0',policy:'structure-visible-widgets-v1',order,excluded,unresolved,inventory,status:'requires-reader-test'};
}
