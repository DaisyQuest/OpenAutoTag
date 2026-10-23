// Geometric evidence and an illustration title must agree before suppressing
// table inference. This is a review proposal, never a diagram description.
const TITLE = /\b(?:diagram|flowchart|schematic|data\s+flow|(?:software|system|network)\s+architecture)\b/i;
const box = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0;
const inside = (b,r) => {
  const area=Math.max(0,Math.min(b[0]+b[2],r[0]+r[2])-Math.max(b[0],r[0])) *
    Math.max(0,Math.min(b[1]+b[3],r[1]+r[3])-Math.max(b[1],r[1]));
  return area >= b[2]*b[3]*.85;
};

function denseGrid(blocks) {
  const rows=[];
  for(const b of [...blocks].sort((a,b)=>a.bbox[1]-b.bbox[1])) {
    let row=rows.find(r=>Math.abs(r[0].bbox[1]-b.bbox[1])<=Math.max(2,b.fontSize*.2));
    if(!row)rows.push(row=[]);row.push(b);
  }
  const full=rows.filter(r=>r.length>=2);
  if(full.length<2)return false;
  const anchors=[...full[0]].sort((a,b)=>a.bbox[0]-b.bbox[0]).map(b=>b.bbox[0]);
  const regular=full.filter(r=>r.length===anchors.length && [...r].sort((a,b)=>a.bbox[0]-b.bbox[0]).every((b,i)=>Math.abs(b.bbox[0]-anchors[i])<=3));
  return regular.reduce((n,r)=>n+r.length,0)>=blocks.length*.8;
}

export function detectDiagramRegions(page, blocks, tablePage) {
  if(blocks.length>4096 || (page.figures||[]).length>256) return [];
  const titles=blocks.filter(b=>box(b.bbox) && b.blockType==='heading' && b.text.length<=120 && TITLE.test(b.text));
  if(!titles.length)return [];
  const candidates=(page.figures||[]).filter(f=>box(f.bbox)).map(f=>({bbox:f.bbox,evidence:'image-with-diagram-title',figureId:f.id}));
  const graphics=tablePage?.graphicEvidence;
  if(graphics?.status==='available' && graphics.obliqueSegments.length<=4096) {
    // Repeated paint of the same edge does not add independent evidence.
    const unique=new Map();
    for(const s of graphics.obliqueSegments) {
      if(s.length!==4 || !s.every(Number.isFinite) || Math.abs(s[0]-s[2])<3 || Math.abs(s[1]-s[3])<3 || Math.hypot(s[0]-s[2],s[1]-s[3])<24)continue;
      const a=s.slice(0,2),b=s.slice(2),key=JSON.stringify([a,b].sort((p,q)=>p[0]-q[0]||p[1]-q[1]).map(p=>p.map(v=>Math.round(v))));unique.set(key,s);
    }
    if(unique.size>=4){
      const lines=[...unique.values()],xs=lines.flatMap(s=>[s[0],s[2]]),ys=lines.flatMap(s=>[s[1],s[3]]);
      const margin=Math.min(72,page.width*.075),left=Math.max(0,Math.min(...xs)-margin),top=Math.max(0,Math.min(...ys)-margin);
      candidates.push({bbox:[left,top,Math.min(page.width,Math.max(...xs)+margin)-left,Math.min(page.height,Math.max(...ys)+margin)-top],evidence:'connectors-with-diagram-title'});
    }
  }
  const regions=[],claimed=new Set();
  for(const candidate of candidates){
    if(regions.length===256)break;
    const r=candidate.bbox;
    if(r[2]<page.width*.2 || r[3]<page.height*.12)continue;
    const headings=titles.filter(t=>t.bbox[1]+t.bbox[3]<=r[1]+24 && r[1]-t.bbox[1]-t.bbox[3]<=120 && t.bbox[0]<r[0]+r[2] && t.bbox[0]+t.bbox[2]>r[0]);
    if(headings.length!==1)continue;
    const title=headings[0],labels=blocks.filter(b=>b!==title && !b.isArtifact && box(b.bbox) && inside(b.bbox,r));
    if(labels.length<6 || labels.some(b=>claimed.has(b.id)||b.formFieldIds?.length) || labels.filter(b=>b.text.trim().length<=80).length<labels.length*.95 || denseGrid(labels))continue;
    const id=`diagram:${page.pageNumber}:${regions.length+1}`;
    regions.push({id,bbox:[...r],titleBlockId:title.id,blockIds:labels.map(b=>b.id),evidence:candidate.evidence,...(candidate.figureId?{figureId:candidate.figureId}:{}),status:'review_required'});
    labels.forEach(b=>claimed.add(b.id));
  }
  return regions;
}

export function diagramLabel(block, id) {
  const result={...block,blockType:'paragraph',diagramRegionId:id};
  for(const key of Object.keys(result))if(key.startsWith('table') || ['headingLevel','listStyle','listItemNumber','listMarker','listGroupId','rowIndex','columnIndex','cellRole'].includes(key))delete result[key];
  return result;
}
