// This module deliberately derives eligibility from the independently inspected
// original widget dictionaries, not from the tag builder's classification.
export function inspectWidgetNavigation({inspection,source,intendedNodes,plan,widgetsVerified,add}) {
  if(!plan)return {status:'not_provided',order:[],excluded:[],unresolved:[],readerStatus:'required'};
  let valid=Boolean(widgetsVerified);
  const check=(code,id,a,b)=>{add(code,id,a,b);valid&&=JSON.stringify(a)===JSON.stringify(b);};
  const intents=intendedNodes.filter(v=>v.n.nativeWidget).map(v=>v.n.nativeWidget),original=source?.widgets||{},saved=inspection.widgets||{};
  const byPosition=new Map(Object.entries(saved).map(entry=>[`${entry[1].page}:${entry[1].annotationIndex}`,entry]));
  check('WIDGET_NAVIGATION_SOURCE','document',true,Boolean(source&&widgetsVerified));
  check('WIDGET_NAVIGATION_POLICY','document','structure-visible-widgets-v1',plan.policy);
  check('WIDGET_NAVIGATION_INVENTORY','document',Object.keys(original).sort(),[...plan.inventory].sort());
  check('WIDGET_NAVIGATION_INTENT','document',intents.map(w=>w.sourceRef),plan.inventory);
  const excluded=[],unresolved=[],eligible=[],savedToSource=new Map(),pages=new Set();
  const stable=v=>v?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):null;
  for(const w of intents){
    const sourceWidget=original[w.sourceRef],s=sourceWidget?.navigationState;
    const current=sourceWidget?byPosition.get(`${sourceWidget.page}:${sourceWidget.annotationIndex}`):undefined;
    if(current)savedToSource.set(current[0],w.sourceRef);
    check('WIDGET_NAVIGATION_STATE_PRESERVED',w.sourceRef,stable(s),stable(current?.[1].navigationState));
    if(w.navigationState)check('WIDGET_NAVIGATION_STATE_INTENT',w.sourceRef,stable(s),stable(w.navigationState));
    const reason=s?.annotationFlags&2?'hidden':s?.annotationFlags&32?'no-view':s&&!s.hasArea?'empty-rectangle':null;
    if(reason){excluded.push({sourceRef:w.sourceRef,reason});if(s.optionalContent||(s.annotationFlags&256))unresolved.push(w.sourceRef);}
    else{
      eligible.push(w.sourceRef);if(sourceWidget)pages.add(sourceWidget.page);
      if(!s||!w.navigationState||w.placement!=='label-context'||s.optionalContent||(s.annotationFlags&256))unresolved.push(w.sourceRef);
    }
  }
  check('WIDGET_NAVIGATION_EXCLUDED','document',excluded,plan.excluded);
  check('WIDGET_NAVIGATION_UNRESOLVED','document',unresolved,plan.unresolved);
  check('WIDGET_NAVIGATION_EXPECTED_ORDER','document',eligible,plan.order);
  const eligibleSet=new Set(eligible),actual=(inspection.contentOrder||[]).filter(r=>r.startsWith('obj:')).map(r=>savedToSource.get(r.slice(4))).filter(r=>eligibleSet.has(r));
  check('WIDGET_NAVIGATION_SAVED_ORDER','document',eligible,actual);
  for(const page of pages)check('WIDGET_NAVIGATION_TABS',`page:${page}`,'S',inspection.pages?.[page-1]?.tabOrder||'absent');
  return {status:!valid?'rejected':unresolved.length?'review_required':'structure_verified',order:actual,excluded,unresolved,readerStatus:'required'};
}
