const address = r => `${r.pageNumber}:${r.streamOrigin}:${r.operatorIndex}`;
const close = (a,b) => a?.length===4 && b?.length===4 && a.every((v,i)=>Number.isFinite(v)&&Number.isFinite(b[i])&&Math.abs(v-b[i])<=.5);
export function inspectNativeFigures({source,inspection,ownership,intendedNodes,add}) {
  const figures=intendedNodes.filter(({n})=>n.nativeFigure), declared=ownership.nativeFigures||[];
  if(!figures.length&&!declared.length)return true;
  let valid=true;
  const check=(code,id,pass)=>{add(code,id,true,pass);valid&&=pass;};
  check('FIGURE_IMAGE_INSPECTION','document',Array.isArray(source.imageRuns)&&Array.isArray(inspection.imageRuns));
  const sourceRuns=source.imageRuns||[], savedRuns=inspection.imageRuns||[];
  const fingerprint=r=>[r.pageNumber,r.imageSha256,r.appearanceHash,r.width,r.height,r.bitsPerComponent];
  check('FIGURE_SOURCE_SEQUENCE','document',sourceRuns.length===savedRuns.length&&sourceRuns.every((r,i)=>
    JSON.stringify(fingerprint(r))===JSON.stringify(fingerprint(savedRuns[i]))&&close(r.bbox,savedRuns[i].bbox)&&r.matrix?.length===6&&savedRuns[i].matrix?.length===6&&r.matrix.every((v,j)=>Number.isFinite(v)&&Number.isFinite(savedRuns[i].matrix[j])&&Math.abs(v-savedRuns[i].matrix[j])<=.00001)));
  const owners=new Map();for(const n of inspection.structure)for(const ref of n.contentRefs){const list=owners.get(ref)||[];list.push(n.identifier);owners.set(ref,list);}
  const seen=new Set(), ids=new Set();
  for(const evidence of declared) {
    const target=figures.find(({n})=>n.id===evidence.tagNodeId), indices=sourceRuns.flatMap((r,i)=>address(r)===address(evidence)?[i]:[]);
    check('FIGURE_SOURCE_RESOLVES',evidence.tagNodeId,Boolean(target&&indices.length===1&&!seen.has(address(evidence))&&!ids.has(evidence.tagNodeId)));
    seen.add(address(evidence));ids.add(evidence.tagNodeId);
    if(!target||indices.length!==1)continue;
    const original=sourceRuns[indices[0]],saved=savedRuns[indices[0]];
    check('FIGURE_SOURCE_GEOMETRY',target.id,original.pageNumber===target.n.nativeFigure.pageNumber&&close(original.bbox,target.n.nativeFigure.bbox)&&!original.artifact);
    const actual=saved?.owners.flatMap(ref=>owners.get(ref)||[`unresolved:${ref}`])||[];
    check('FIGURE_SOURCE_OWNER',target.id,actual.length===1&&actual[0]===target.id&&!saved?.artifact);
  }
  for(const {n,id} of figures)check('FIGURE_OWNERSHIP_DECLARED',id,ids.has(n.id));
  return valid;
}
