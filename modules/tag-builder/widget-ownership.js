// Native object identity is distinct from field name: repeated text controls and
// radio groups have one field but several individually owned widget annotations.
export function attachWidgetOwnership(root, semantic) {
  const bySource=new Map(),ids=new Set(),reviews=[],widgets=[],parents=new Map();
  const visit=(node,parent,depth=0)=>{
    if(depth>128||ids.size>=100000||ids.has(node.id))throw new Error('Invalid widget intent tree');
    ids.add(node.id);parents.set(node,parent);
    for(const id of node.sourceNodeIds||[]){const entries=bySource.get(id)||[];entries.push(node);bySource.set(id,entries);}
    for(const child of node.children)visit(child,node,depth+1);
  };visit(root,null);
  const seen=new Set();
  for(const field of semantic.formRelationships||[])for(const widget of field.widgets) {
    if(widgets.length>=10000)throw new Error('Native widget intent limit exceeded');
    if(seen.has(widget.id))throw new Error(`Duplicate semantic widget identity: ${widget.id}`);seen.add(widget.id);
    // This is PDF.js Ref.toString(), also used by parser authored-widget-captions.
    const match=/^([1-9]\d*)R(\d+)?$/.exec(widget.id);
    if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[2]||0)>65535){reviews.push({widgetId:widget.id,code:'WIDGET_SOURCE_ID_UNRESOLVED'});continue;}
    const sourceRef=`${match[1]} ${Number(match[2]||0)} R`,id=`tag:widget:${widget.id}`;
    if(ids.has(id))throw new Error(`Duplicate widget tag identity: ${id}`);ids.add(id);
    const labelIds=widget.labelStatus==='associated'?widget.labelNodeIds||[]:widget.labelStatus==='associated-context'?widget.contextNodeIds||[]:[];
    const anchors=labelIds.flatMap(label=>bySource.get(label)||[]);
    let container=null;
    // Merged label fragments may share one leaf. Each fragment must still
    // resolve uniquely; a duplicated source occurrence remains ambiguous.
    if(labelIds.length&&labelIds.every(label=>bySource.get(label)?.length===1)) {
      const containers=anchors.map(leaf=>{
        let node=leaf;while(node!==root&&!['P','LBody','TD','TH','H1','H2','H3','H4','H5','H6'].includes(node.type))node=parents.get(node);
        return node;
      });
      if(new Set(containers).size===1&&containers[0]!==root)container=containers[0];
    }
    const form={id,type:'Form',children:[],nativeWidget:{widgetId:widget.id,sourceRef,pageNumber:widget.pageNumber,
      fieldName:widget.fieldName||'',placement:container?'label-context':'unresolved',anchorNodeIds:container?labelIds:[]}};
    if(container&&/^H[1-6]$/.test(container.type)) {
      const parent=parents.get(container);let index=parent.children.indexOf(container)+1;
      while(parent.children[index]?.nativeWidget?.anchorNodeIds.some(a=>labelIds.includes(a)))index++;
      parent.children.splice(index,0,form);
    } else (container||root).children.push(form);
    if(!container)reviews.push({widgetId:widget.id,code:'WIDGET_PLACEMENT_REVIEW'});
    widgets.push({widgetId:widget.id,tagId:id,sourceRef,pageNumber:widget.pageNumber});
  }
  return {widgets,reviews};
}
