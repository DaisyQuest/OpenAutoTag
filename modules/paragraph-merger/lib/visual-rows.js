const left=n=>n.bbox[0],top=n=>n.bbox[1],bottom=n=>top(n)+n.bbox[3];
const size=n=>Math.max(1,n.fontSize||n.bbox[3]||1);

// An anchored baseline avoids both bucket-edge splits and cumulative row drift.
export function visualRows(nodes) {
  const rows=[];
  for(const node of [...nodes].sort((a,b)=>bottom(a)-bottom(b)||left(a)-left(b)||a.id.localeCompare(b.id))){
    const row=rows.at(-1),tolerance=Math.max(1,Math.min(6,size(node)*.3,row?size(row[0])*.3:6));
    if(row&&Math.abs(bottom(node)-bottom(row[0]))<=tolerance)row.push(node);
    else rows.push([node]);
  }
  for(const row of rows)row.sort((a,b)=>left(a)-left(b)||top(a)-top(b)||a.id.localeCompare(b.id));
  return rows;
}

// Only inferred native label/value fragments have sufficiently precise boxes.
export function joinPairedFragments(nodes) {
  let text=String(nodes[0]?.text||"").trim();
  for(let i=1;i<nodes.length;i++){
    const a=nodes[i-1],b=nodes[i],gap=left(b)-left(a)-a.bbox[2],em=Math.min(size(a),size(b));
    const touching=Math.abs(bottom(a)-bottom(b))<=em*.15&&gap>=-em*.1&&gap<=em*.12&&!/\s$/.test(a.text)&&!/^\s/.test(b.text);
    text+=(touching?"":" ")+String(b.text||"").trim();
  }
  return text;
}
