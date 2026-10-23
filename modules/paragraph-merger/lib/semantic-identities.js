const unique=values=>[...new Set(values)];
export function protectedBoundary(a,b) {
  if(a.diagramRegionId || b.diagramRegionId)return "diagram label boundary";
  if((a.textProvenance === "ocr") !== (b.textProvenance === "ocr"))return "native/OCR boundary";
  if(a.pageNumber!==b.pageNumber || (a.columnHint??0)!==(b.columnHint??0))return "page or column boundary";
  if(a.tableId||b.tableId)return "table boundary";
  if(a.regionId&&b.regionId&&a.regionId!==b.regionId)return "region boundary";
  if(a.semanticRole!==b.semanticRole||a.footnoteGroupId!==b.footnoteGroupId||a.blockQuoteGroupId!==b.blockQuoteGroupId)return "semantic group boundary";
  if((a.labelValuePairId||b.labelValuePairId)&&(a.labelValuePairId!==b.labelValuePairId||a.labelValuePart!==b.labelValuePart))return "label/value boundary";
  if(a.paragraphGroupId&&b.paragraphGroupId&&a.paragraphGroupId!==b.paragraphGroupId)return "explicit paragraph boundary";
  const fields=n=>[...(n.formFieldIds||[])].sort().join("|");
  if(fields(a)!==fields(b))return "form field boundary";
  const marginal=n=>/^(?:page\s+)?\d+\s+(?:of|\/)\s+\d+$/i.test(n.text.trim())||/^(?:https?:\/\/|www\.)?\S+\.(?:gov|org|com|edu)(?:\/\S*)?$/i.test(n.text.trim());
  if(marginal(a)||marginal(b))return "standalone page counter or URL";
  return null;
}

// Rebind every semantic reference after a merge; identities never follow similar text.
export function preserveSemanticIdentities(source, output) {
  const original=new Map(source.nodes.map(n=>[n.id,n])),mapping=new Map();
  for(const n of output.nodes) {
    const members=unique([n.id,...(n._mergedFrom||[])]).filter(id=>original.has(id));
    for(const id of members){if(mapping.has(id))throw new Error(`Merged source has duplicate ownership: ${id}`);mapping.set(id,n.id);}
    if(members.length>1) {
      const parts=members.map(id=>original.get(id));
      n.sourceBlockIds=unique(parts.flatMap(p=>p.sourceBlockIds||[p.sourceBlockId]).filter(Boolean));
      if(!n.sourceBlockIds.length)delete n.sourceBlockIds;
      if(parts.some(p=>typeof p.rawText==="string"))n.rawText=parts.map(p=>p.rawText??p.text).join("\n");
      if(parts.some(p=>typeof p.comparisonText==="string"))n.comparisonText=n.text.normalize("NFKC").replace(/\s+/g," ").trim();
      if(parts.some(p=>p.referenceMarkers))n.referenceMarkers=unique(parts.flatMap(p=>p.referenceMarkers||[]));
      if(parts.some(p=>p.ocrSegments))n.ocrSegments=parts.flatMap(p=>p.ocrSegments||[]);
    }
  }
  const resolve=id=>mapping.get(id)||id,resolveAll=ids=>unique(ids.map(resolve));
  if(source.relations)output.relations=source.relations.map(r=>({...r,from:resolve(r.from),to:resolve(r.to)})).filter(r=>r.from!==r.to||!["precedes","continues"].includes(r.type));
  if(source.orderedNodeIds)output.orderedNodeIds=resolveAll(source.orderedNodeIds);
  for(const n of output.nodes)for(const key of ["continuesFrom","listContinuationOf","captionForId","footnoteReferenceId","asideAnchorId"])
    if(n[key]){n[key]=resolve(n[key]);if(n[key]===n.id)delete n[key];}
  for(const key of ["regions","tableFragments"])if(source[key])output[key]=source[key].map(r=>({...r,nodeIds:resolveAll(r.nodeIds)}));
  if(source.figures)output.figures=source.figures.map(f=>({...f,captionNodeIds:resolveAll(f.captionNodeIds)}));
  if(source.formRelationships)output.formRelationships=source.formRelationships.map(f=>({...f,labels:resolveAll(f.labels),widgets:f.widgets.map(w=>{
    const widget={...w};for(const key of ["labelNodeIds","instructionNodeIds","contextNodeIds"])if(w[key])widget[key]=resolveAll(w[key]);return widget;
  })}));
  if(source.semanticReviewTasks)output.semanticReviewTasks=source.semanticReviewTasks.map(t=>({...t,...(t.nodeId?{nodeId:resolve(t.nodeId)}:{}),...(t.relatedNodeId?{relatedNodeId:resolve(t.relatedNodeId)}:{}),...(t.candidates?{candidates:resolveAll(t.candidates)}:{})}));
  return output;
}
