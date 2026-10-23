// Protect aligned label/value sequences without reclassifying their PDF roles.
const left=n=>n.bbox[0], top=n=>n.bbox[1], right=n=>left(n)+n.bbox[2], bottom=n=>top(n)+n.bbox[3];
const size=n=>Math.max(1,n.fontSize||n.bbox[3]||1);
const eligible=n=>n.role==="P"&&!n.tableId&&!n.formFieldIds?.length&&!n.semanticRole&&!n.footnoteGroupId&&
  !n.blockQuoteGroupId&&!n.paragraphGroupId&&!n.artifactType&&n.textProvenance!=="ocr"&&n.direction!=="rtl"&&
  (n.writingMode||"horizontal")==="horizontal"&&Math.abs((n.textRotation||0)%360)<1;
const sameRegion=(a,b)=>(a.columnHint??0)===(b.columnHint??0)&&(!a.regionId||!b.regionId||a.regionId===b.regionId);

/** Anchor each row to its first baseline; do not chain drift across rows. */
export function visualRows(nodes) {
  const rows=[];
  for(const node of [...nodes].sort((a,b)=>bottom(a)-bottom(b)||left(a)-left(b)||a.id.localeCompare(b.id))){
    const row=rows.at(-1), tolerance=Math.max(1,Math.min(6,size(node)*.3,row?size(row[0])*.3:6));
    if(row&&Math.abs(bottom(node)-bottom(row[0]))<=tolerance)row.push(node);
    else rows.push([node]);
  }
  for(const row of rows)row.sort((a,b)=>left(a)-left(b)||top(a)-top(b)||a.id.localeCompare(b.id));
  return rows;
}

function chunks(row) {
  const groups=[];
  for(const n of row){
    const group=groups.at(-1),prev=group?.at(-1);
    if(prev&&left(n)-right(prev)<=Math.max(2,Math.min(size(prev),size(n))*.8)&&sameRegion(prev,n))group.push(n);
    else groups.push([n]);
  }
  return groups;
}

// Only qualified row fragments use touching glyph boxes to reconstruct words.
// Coarse OCR boxes elsewhere retain the merger's historical whitespace policy.
export function joinPairedFragments(nodes) {
  let text=String(nodes[0]?.text||"").trim();
  for(let i=1;i<nodes.length;i++){
    const a=nodes[i-1],b=nodes[i],gap=left(b)-right(a),em=Math.min(size(a),size(b));
    const touching=Math.abs(bottom(a)-bottom(b))<=em*.15&&gap>=-em*.1&&gap<=em*.12&&!/\s$/.test(a.text)&&!/^\s/.test(b.text);
    text+=(touching?"":" ")+String(b.text||"").trim();
  }
  return text;
}

export function inferLabelValuePairs(pageNodes) {
  // Bound candidate comparisons; the caller records a review task on overflow.
  if(pageNodes.length>10000)return {relations:[],pairs:0,limited:true};
  const rows=visualRows(pageNodes), candidates=[];
  for(let rowIndex=0;rowIndex<rows.length;rowIndex++){
    const row=rows[rowIndex];if(!row.every(eligible))continue;
    const parts=chunks(row);if(parts.length!==2)continue;
    const [label,value]=parts,a=label[0],b=value[0],text=joinPairedFragments(label),em=Math.max(size(a),size(b));
    if(!sameRegion(a,b)||left(b)-right(label.at(-1))<em*.8||label.length+value.length>64||
      text.length>80||text.split(/\s+/).length>8)continue;
    const colon=/[:：]$/.test(text),term=/^[\p{L}][\p{L}\p{N}&/+().-]{0,19}$/u.test(text);
    if(size(a)/size(b)<.8||size(a)/size(b)>1.2)continue;
    if(!colon&&!term)continue;
    candidates.push({rowIndex,label,value,colon,em,strong:/^[A-Z][A-Z0-9&/+().-]{1,19}$/.test(text)});
  }
  const aligned=(a,b)=>sameRegion(a.label[0],b.label[0])&&
    Math.abs(left(a.label[0])-left(b.label[0]))<=Math.max(3,Math.min(a.em,b.em)*.3)&&
    Math.abs(left(a.value[0])-left(b.value[0]))<=Math.max(3,Math.min(a.em,b.em)*.3);
  const anchors=candidates.filter(a=>a.colon||(a.strong&&candidates.some(b=>a!==b&&(b.strong||b.colon)&&aligned(a,b))));
  const accepted=candidates.filter(a=>anchors.includes(a)||anchors.filter(b=>aligned(a,b)&&Math.abs(top(a.label[0])-top(b.label[0]))<=a.em*8).length>=2);
  const pairRows=new Set(accepted.map(p=>p.rowIndex)), groups=new Map(),relations=[];
  for(const pair of accepted){
    let lastRow=pair.value;
    for(let i=pair.rowIndex+1;i<rows.length&&!pairRows.has(i);i++){
      const row=rows[i],parts=chunks(row),first=row[0];
      if(!row.every(eligible)||parts.length!==1||!sameRegion(pair.value[0],first)||
        Math.abs(left(first)-left(pair.value[0]))>Math.max(3,pair.em*.3)||
        top(first)-Math.max(...lastRow.map(bottom))>pair.em||size(first)/pair.em<.8||size(first)/pair.em>1.2)break;
      pair.value.push(...row);lastRow=row;
    }
    for(const [kind,members] of [["label",pair.label],["value",pair.value]]){
      const id=`paired:${pair.label[0].id}:${kind}`;
      for(const n of members)groups.set(n.id,{paragraphGroupId:id,labelValuePairId:pair.label[0].id,labelValuePart:kind});
    }
    const sequence=[...pair.label,...pair.value];
    for(let i=1;i<sequence.length;i++)relations.push({type:"precedes",from:sequence[i-1].id,to:sequence[i].id,evidence:"aligned-label-value-row"});
  }
  for(let i=1;i<accepted.length;i++){
    const a=accepted[i-1],b=accepted[i];
    if(aligned(a,b))relations.push({type:"precedes",from:a.value.at(-1).id,to:b.label[0].id,evidence:"successive-label-value-rows"});
  }
  for(const n of pageNodes)if(groups.has(n.id))Object.assign(n,groups.get(n.id));
  return {relations,pairs:accepted.length,limited:false};
}
