// Document-level evidence refinements. Heuristic scores remain uncalibrated.
const heading = n => /^H[1-6]$/.test(n.role);
const style = n => n.fontName && Number.isFinite(n.fontSize) ? `${n.fontName.replace(/^[A-Z]{6}\+/, "")}:${Math.round(n.fontSize * 2)}` : null;
const eligible = n => !n.tableId && !n.formFieldIds?.length && !n.footnoteGroupId && !n.artifactType && !n.semanticRole && !n.labelValuePairId;
const geometry = (a,b) => Math.abs(a.bbox[0]-b.bbox[0]) <= 3 && (a.columnHint??0)===(b.columnHint??0);
const sameType = (a,b) => style(a) && style(a) === style(b) && a.direction === b.direction;
const clean = text => String(text || "").normalize("NFKC").replace(/\s+/g," ").trim();

export function inferDocumentHeadings(nodes) {
  const tasks=[], anchors=new Map();
  for(const n of nodes.filter(heading)) {
    const number=/^\s*(\d+(?:\.\d+){1,5})[.)]?\s+\S/.exec(n.text||"");
    const key=style(n); if(!key || !number || !eligible(n)) continue;
    const group=anchors.get(key)||[]; group.push({node:n,level:number[1].split(".").length}); anchors.set(key,group);
  }
  for(const n of nodes.filter(heading)) {
    const group=anchors.get(style(n))||[];
    if(!eligible(n)||/^\s*\d/.test(n.text||"")||group.length<2||new Set(group.map(a=>a.node.pageNumber)).size<2) continue;
    const levels=new Set(group.map(a=>a.level));
    if(levels.size===1) {n.headingLevel=group[0].level; n.role=`H${n.headingLevel}`; n.headingEvidence="repeated-numbered-style-anchor";}
    else tasks.push({code:"HEADING_ANCHOR_CONFLICT",nodeId:n.id,candidates:group.map(a=>a.node.id)});
  }
  const stack=[], outline=[];
  for(const n of nodes.filter(heading)) {
    const level=Number(n.role.slice(1));
    while(stack.length && stack.at(-1).level>=level) stack.pop();
    const parent=stack.at(-1);
    if(level>(parent?.level||0)+1) tasks.push({code:"HEADING_OUTLINE_GAP",nodeId:n.id,...(parent?{relatedNodeId:parent.id}:{})});
    outline.push({nodeId:n.id,parentNodeId:parent?.id||null,level,evidence:n.headingEvidence||"existing-heading-membership",status:"requires-review"});
    stack.push({id:n.id,level});
  }
  return {outline,tasks};
}

export function inferRegionsAndAnchors(nodes,pages) {
  const regions=[], relations=[], tasks=[];
  for(const page of pages) {
    const content=nodes.filter(n=>n.pageNumber===page.pageNumber && n.role!=="Artifact");
    const columns=[...new Set(content.filter(n=>!heading(n)&&!n.tableId&&!n.footnoteGroupId).map(n=>n.columnHint??0))].sort((a,b)=>a-b);
    const root=`region:${page.pageNumber}`;
    regions.push({id:root,pageNumber:page.pageNumber,parentId:null,kind:"page",nodeIds:content.map(n=>n.id)});
    const splitX=page.columns===2 && Number.isFinite(page.columnSplitX) ? page.columnSplitX : null;
    const spans=content.filter(n=>!n.tableId&&!n.footnoteGroupId&&columns.length>1 &&
      ((n.bbox[2]>=page.width*.62 && (heading(n)||n.captionForId)) ||
       (splitX!==null && n.bbox[0]<splitX && n.bbox[0]+n.bbox[2]>splitX)))
      .sort((a,b)=>a.bbox[1]-b.bbox[1] || a.id.localeCompare(b.id));
    // Keep a detached footer band after both prose columns without hiding its
    // text as Artifact. Require a URL/page-number anchor and a clear vertical
    // gap; ordinary bottom-of-column prose must keep its column position.
    const footer=columns.length>1 && !page.formFields?.length ? content.filter(n=>
      !n.tableId && !n.footnoteGroupId && n.bbox[1]>=page.height*.9 && n.bbox[3]<=12 && n.text.length<=80) : [];
    if(footer.length>0 && footer.length<=4 &&
      Math.max(...footer.map(n=>n.bbox[1]))-Math.min(...footer.map(n=>n.bbox[1]))<=Math.max(...footer.map(n=>n.bbox[3])) &&
      footer.some(n=>/^(?:(?:https?:\/\/|www\.)\S+|\d+(?:\s*\/\s*\d+)?)$/i.test(n.text.trim()))) {
      const before=content.filter(n=>!footer.includes(n));
      const bottom=before.reduce((y,n)=>Math.max(y,n.bbox[1]+n.bbox[3]),0);
      if(Math.min(...footer.map(n=>n.bbox[1]))-bottom>=Math.max(18,...footer.map(n=>n.bbox[3]*2))) {
        for(const f of footer) {
          if(!spans.includes(f)) spans.push(f);
          for(const n of before) relations.push({type:"precedes",from:n.id,to:f.id,evidence:"detached-footer-after-columns"});
        }
        spans.sort((a,b)=>a.bbox[1]-b.bbox[1] || a.id.localeCompare(b.id));
      }
    }
    for(const n of content) n.regionId=spans.includes(n) ? `${root}:span:${n.id}` : n.footnoteGroupId ? `${root}:notes` : `${root}:band:${spans.filter(h=>h!==n&&h.bbox[1]+h.bbox[3]<=n.bbox[1]).length}:column:${n.columnHint??0}`;
    const groups=new Map();
    for(const n of content) {
      const group=groups.get(n.regionId)||[];group.push(n);groups.set(n.regionId,group);
    }
    for(const [id,group] of groups) regions.push({id,pageNumber:page.pageNumber,parentId:root,kind:spans.includes(group[0])?"spanning":group[0].footnoteGroupId?"footnotes":"column",nodeIds:group.map(n=>n.id)});
    // Column flow within a band, without breaking list/table members into unrelated units.
    if(spans.length) for(let band=0;band<=spans.length;band++) {
      const previous=spans[band-1],next=spans[band];
      const bandNodes=content.filter(n=>!spans.includes(n)&&!n.footnoteGroupId&&(!previous||n.bbox[1]>=previous.bbox[1]+previous.bbox[3])&&(!next||n.bbox[1]+n.bbox[3]<=next.bbox[1]));
      for(const n of bandNodes) {
        if(previous) relations.push({type:"precedes",from:previous.id,to:n.id,evidence:"region-band-start"});
        if(next) relations.push({type:"precedes",from:n.id,to:next.id,evidence:"region-band-end"});
      }
    }
    for(const note of content.filter(n=>n.footnoteGroupId && n.footnoteMarker && !n.footnoteReferenceId)) {
      const marker=String(note.footnoteMarker);
      const candidates=content.filter(n=>!n.footnoteGroupId&&!n.tableId && n.bbox[1]<note.bbox[1] &&
        Array.isArray(n.referenceMarkers) && n.referenceMarkers.includes(marker));
      if(candidates.length===1) {note.footnoteReferenceId=candidates[0].id;relations.push({type:"precedes",from:candidates[0].id,to:note.id,evidence:"unique-authored-note-marker"});}
      else if(candidates.length>1) tasks.push({code:"FOOTNOTE_ANCHOR_AMBIGUOUS",nodeId:note.id,candidates:candidates.map(n=>n.id)});
    }
  }
  return {regions,relations,tasks};
}

export function refineTableTopology(nodes,pages) {
  const tasks=[],groups=new Map(),heights=new Map(pages.map(p=>[p.pageNumber,p.height])),byId=new Map(nodes.map(n=>[n.id,n]));
  for(const n of nodes.filter(n=>n.tableId)) {const key=`${n.pageNumber}:${n.tableId}`,g=groups.get(key)||[];g.push(n);groups.set(key,g);}
  const fragments=[];
  for(const [id,cells] of groups) {
    const occupied=new Map(),issues=new Set();
    for(const n of cells) {
      const row=n.tableRowIndex,col=n.tableColumnIndex,rs=n.tableRowSpan||1,cs=n.tableColumnSpan||1;
      if(!Number.isInteger(row)||!Number.isInteger(col)||!Number.isInteger(rs)||!Number.isInteger(cs)||row<0||col<0||rs>1000||cs>1000||rs*cs>10000||rs<1||cs<1||occupied.size+rs*cs>100000) {issues.add("TABLE_GRID_UNRESOLVED");continue;}
      for(let r=row;r<row+rs;r++) for(let c=col;c<col+cs;c++) {
        const key=`${r}:${c}`;if(occupied.has(key))issues.add("TABLE_GRID_OVERLAP");occupied.set(key,n.id);
      }
    }
    const headers=cells.filter(n=>n.role==="TH"), page=cells[0].pageNumber;
    if(occupied.size&&!issues.size) {
      const slots=[...occupied.keys()].map(key=>key.split(":").map(Number));
      const rows=slots.map(s=>s[0]),cols=slots.map(s=>s[1]);
      const expected=(Math.max(...rows)-Math.min(...rows)+1)*(Math.max(...cols)-Math.min(...cols)+1);
      if(expected!==occupied.size)issues.add("TABLE_GRID_GAP");
    }
    const anchors=[...new Set(cells.map(n=>n.tableColumnIndex))].filter(Number.isInteger).sort((a,b)=>a-b).map(col=>Math.min(...cells.filter(n=>n.tableColumnIndex===col).map(n=>n.bbox[0])));
    const firstRow=Math.min(...headers.map(n=>n.tableRowIndex));
    const signature=headers.filter(n=>n.tableRowIndex===firstRow).sort((a,b)=>a.tableColumnIndex-b.tableColumnIndex).map(n=>clean(n.text));
    const fragment={id,pageNumber:page,tableId:cells[0].tableId,nodeIds:cells.map(n=>n.id),anchors,headerSignature:signature,status:issues.size?"requires-review":"grid-checked",continuesFrom:null};
    for(const code of issues)tasks.push({code,nodeId:cells[0].id,candidates:cells.map(n=>n.id)});
    fragments.push(fragment);
  }
  // Require all columns, repeated complete header text and page-boundary evidence.
  for(const f of fragments) {
    if(f.status!=="grid-checked"||f.anchors.length<2||!f.headerSignature.length)continue;
    const cells=f.nodeIds.map(id=>byId.get(id));
    const candidates=fragments.filter(p=>p.pageNumber===f.pageNumber-1&&p.status==="grid-checked"&&p.anchors.length===f.anchors.length&&
      p.anchors.every((x,i)=>Math.abs(x-f.anchors[i])<=3)&&JSON.stringify(p.headerSignature)===JSON.stringify(f.headerSignature)&&
      Math.max(...p.nodeIds.map(id=>byId.get(id).bbox[1]))>=heights.get(p.pageNumber)*.7 &&
      Math.min(...cells.map(n=>n.bbox[1]))<=heights.get(f.pageNumber)*.25);
    if(candidates.length===1) {f.continuesFrom=candidates[0].id;f.status="continuation-proposed";}
    else if(candidates.length>1)tasks.push({code:"TABLE_CONTINUATION_AMBIGUOUS",nodeId:cells[0].id,candidates:candidates.flatMap(c=>c.nodeIds)});
  }
  return {fragments,tasks};
}

export function refineFigures(nodes,pages) {
  const figures=[],tasks=[],relations=[];
  for(const page of pages) {
    const matches=(page.figures||[]).map(image=>({image,candidates:nodes.filter(n=>n.pageNumber===page.pageNumber&&n.role==="P"&&!n.tableId&&!n.formFieldIds?.length&&/^\s*(?:Figure|Fig\.)\s+\d+[.:]?\s+\S/i.test(n.text)&&
      n.bbox[1]>=image.bbox[1]+image.bbox[3]&&n.bbox[1]-image.bbox[1]-image.bbox[3]<=36&&
      n.bbox[0]<image.bbox[0]+image.bbox[2]&&n.bbox[0]+n.bbox[2]>image.bbox[0])}));
    for(const {image,candidates} of matches) {
    const record={id:image.id,pageNumber:page.pageNumber,bbox:image.bbox,captionNodeIds:[],status:"requires-description-review"};
    const unique=candidates.length===1&&matches.filter(m=>m.candidates.includes(candidates[0])).length===1;
    if(unique) {
      record.captionNodeIds=[candidates[0].id]; candidates[0].semanticRole="Caption";
      relations.push({type:"captionFor",from:candidates[0].id,to:`figure:${image.id}`,evidence:"unique-caption-below-figure"});
    }
    tasks.push({code:candidates.length&&!unique?"FIGURE_CAPTION_AMBIGUOUS":"FIGURE_DESCRIPTION_REQUIRED",pageNumber:page.pageNumber,candidates:candidates.map(n=>n.id)});
    figures.push(record);
    }
  }
  return {figures,tasks,relations};
}

export function refineSequenceBoundaries(nodes) {
  const tasks=[],relations=[];const last=new Map(),segments=new Map();
  for(const n of nodes) {
    if(n.role==="Artifact"||n.footnoteGroupId)continue;
    const key=`${n.pageNumber}:${n.columnHint??0}`,p=last.get(key);
    const groupKey=n.listGroupId?`${key}:${n.listGroupId}:${n.listLevel||1}`:null;
    if(groupKey&&segments.has(groupKey))n.listGroupId=segments.get(groupKey);
    if(p&&eligible(p)&&eligible(n)&&sameType(p,n)&&geometry(p,n)&&n.bbox[1]>=p.bbox[1]+p.bbox[3]) {
      const gap=n.bbox[1]-p.bbox[1]-p.bbox[3];
      // Join split lines only with an unfinished sentence and a tight baseline gap.
      if(p.role==="P"&&n.role==="P"&&!p.blockQuoteGroupId&&!n.blockQuoteGroupId&&gap<=p.fontSize*.55&&/[\p{L},;]$/u.test(clean(p.text))&&/^\p{Ll}/u.test(clean(n.text))) {
        n.paragraphGroupId=p.paragraphGroupId ||= `paragraph:${p.id}`;n.continuesFrom=p.id;
        relations.push({type:"continues",from:p.id,to:n.id,evidence:"same-page-unfinished-sentence-tight-lines"});
      }
      if(groupKey&&p.role==="LI"&&n.role==="LI"&&p.listGroupId===n.listGroupId&&(p.listLevel||1)===(n.listLevel||1)&&/^\s*1[.)]\s/.test(n.text)&&/^\s*\d+[.)]\s/.test(p.text)) {
        n.listGroupId=`list:restart:${n.id}`;segments.set(groupKey,n.listGroupId);tasks.push({code:"LIST_RESTART_REVIEW",nodeId:n.id,relatedNodeId:p.id});
      }
    }
    last.set(key,n);
  }
  return {tasks,relations};
}
