// PDF Association, Tagged PDF Best Practice Guide 1.0.1, §§3.2 and 4.4:
// Table captions are boundary children; Figure captions are adjacent siblings.
// Never move a caption across prose, even when an explicit target was supplied.
export function associateCaptions(root, semantic, {enableCaptionDetection = false} = {}) {
  const source = new Map(semantic.nodes.map(n => [n.id, n])), entries = [], tables = [], reviews = [];
  const walk = (node, parent) => {
    const entry = {node, parent}; entries.push(entry);
    for (const child of node.children || []) walk(child, node);
  };
  walk(root, null);
  const descendants = node => [...new Set([...(node.sourceNodeIds || []).map(id => source.get(id)).filter(Boolean), ...node.children.flatMap(descendants)])];
  const bounds = nodes => {
    if (!nodes.length || new Set(nodes.map(n => n.pageNumber)).size !== 1) return null;
    const x = Math.min(...nodes.map(n => n.bbox[0])), y = Math.min(...nodes.map(n => n.bbox[1]));
    return {pageNumber:nodes[0].pageNumber, bbox:[x,y,Math.max(...nodes.map(n => n.bbox[0]+n.bbox[2]))-x,Math.max(...nodes.map(n => n.bbox[1]+n.bbox[3]))-y]};
  };
  const near = (caption, target) => {
    if (!caption || !target || caption.pageNumber !== target.pageNumber) return null;
    const [cx,cy,cw,ch] = caption.bbox, [tx,ty,tw,th] = target.bbox;
    if (Math.min(cx+cw,tx+tw)-Math.max(cx,tx) < Math.min(cw,tw)*.25 || Math.min(cw,tw,ch,th)<=0) return null;
    if (cy >= ty+th-1 && cy-ty-th <= 36) return 'after';
    if (ty >= cy+ch-1 && ty-cy-ch <= 36) return 'before';
    return null;
  };
  for (const entry of entries.filter(e => e.node.type === 'Table')) {
    const nodes = descendants(entry.node);
    tables.push({...entry, nodes, aliases:new Set([entry.node.id,...nodes.flatMap(n => [n.id,n.sourceBlockId,...(n.sourceBlockIds||[]),n.tableId,n.tableGroupId]).filter(Boolean)])});
  }
  const figures = (semantic.figures || []).map(f => ({figure:f, aliases:new Set([f.id,`figure:${f.id}`,`tag:figure:${f.id}`])}));
  const requests = new Map();
  const request = (id, target) => {if (!requests.has(id)) requests.set(id,new Set());requests.get(id).add(target);};
  for (const n of semantic.nodes) if (n.captionForId) request(n.id,n.captionForId);
  for (const r of semantic.relations || []) if (r.type === 'captionFor') request(r.from,r.to);
  for (const f of semantic.figures || []) for (const id of f.captionNodeIds) request(id,`figure:${f.id}`);
  const captions = entries.filter(({node}) => node.type !== 'Span' && (node.type === 'Caption' || node.type === 'P' && descendants(node).some(n => requests.has(n.id))));
  let associated=0;
  const claimed=new Set();
  for (const {node, parent} of captions) {
    node.type='Caption';
    const reject = code => reviews.push({code,captionId:node.id});
    const parts=descendants(node), geometry=bounds(parts);
    const explicit=[...new Set(parts.flatMap(n=>[...(requests.get(n.id)||[])]))];
    const kind=/^\s*(Table|Tab\.)\s+\d/i.test(node.label||'')?'Table':/^\s*(Figure|Fig\.)\s+\d/i.test(node.label||'')?'Figure':null;
    let targets;
    if (explicit.length) {
      const resolved=explicit.map(id=>[...tables,...figures].filter(t=>t.aliases.has(id)));
      if(resolved.some(r=>r.length!==1)){reject('CAPTION_TARGET_UNRESOLVED');continue;}
      targets=[...new Set(resolved.flat())];
      if(targets.length!==1){reject('CAPTION_TARGET_CONFLICT');continue;}
    } else {
      if(!enableCaptionDetection){reject('CAPTION_TARGET_REQUIRED');continue;}
      const index=parent.children.indexOf(node);
      targets=tables.filter(t=>t.parent===parent&&Math.abs(parent.children.indexOf(t.node)-index)===1);
    }
    const targetGeometry=t=>{
      if(t.figure)return t.figure;
      // A continued table has different boxes on different pages. A caption
      // can describe only its first/last logical boundary, never an inner page.
      const before=t.parent===parent&&parent.children.indexOf(node)<parent.children.indexOf(t.node);
      const page=before?t.nodes[0]?.pageNumber:t.nodes.at(-1)?.pageNumber;
      return bounds(t.nodes.filter(n=>n.pageNumber===page));
    };
    const eligible=targets.filter(t=>{
      if(kind && kind!==(t.figure?'Figure':'Table'))return false;
      const g=targetGeometry(t);
      return near(geometry,g);
    });
    if(eligible.length!==1){reject(eligible.length?'CAPTION_TARGET_AMBIGUOUS':'CAPTION_GEOMETRY_OR_KIND');continue;}
    const target=eligible[0], position=near(geometry,targetGeometry(target));
    if(claimed.has(target)){reject('CAPTION_TARGET_ALREADY_CLAIMED');continue;}
    let targetId;
    if(target.figure) {
      const f=target.figure;
      if(semantic.source?.coordinateSpace!=="crop-display-points"){reject("CAPTION_FIGURE_COORDINATES_UNQUALIFIED");continue;}
      // A raster image cannot own separately painted labels or intervening prose.
      const low=Math.min(geometry.bbox[1],f.bbox[1]),high=Math.max(geometry.bbox[1]+geometry.bbox[3],f.bbox[1]+f.bbox[3]);
      const obstructed=semantic.nodes.some(n=>!parts.includes(n)&&n.role!=='Artifact'&&n.pageNumber===f.pageNumber&&
        n.bbox[1]<high&&n.bbox[1]+n.bbox[3]>low&&n.bbox[0]<f.bbox[0]+f.bbox[2]&&n.bbox[0]+n.bbox[2]>f.bbox[0]);
      if(obstructed){reject('CAPTION_FIGURE_CONTENT_INTERVENES');continue;}
      targetId=`tag:figure:${f.id}`;
      if(entries.some(e=>e.node.id===targetId)){reject('CAPTION_FIGURE_ID_CONFLICT');continue;}
      const figure={id:targetId,type:'Figure',children:[],nativeFigure:{pageNumber:f.pageNumber,bbox:[...f.bbox],sourceId:f.id}};
      parent.children.splice(parent.children.indexOf(node)+(position==='before'?1:0),0,figure);
    } else {
      const index=parent.children.indexOf(node), targetIndex=parent.children.indexOf(target.node);
      if(target.parent!==parent||targetIndex!==index+(position==='before'?1:-1)){reject('CAPTION_CONTENT_INTERVENES');continue;}
      targetId=target.node.id;
      parent.children.splice(index,1);
      if(position==='before')target.node.children.unshift(node);else target.node.children.push(node);
    }
    node.captionAssociation={targetId,targetType:target.figure?'Figure':'Table',position,evidence:explicit.length?'explicit-target-and-geometry':'adjacent-table-and-geometry'};
    claimed.add(target);associated++;
  }
  return {detected:captions.length,associated,reviews};
}
