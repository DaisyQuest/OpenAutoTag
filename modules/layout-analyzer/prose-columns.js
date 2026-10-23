// A repeated empty gutter between long, vertically aligned prose lines is
// stronger evidence than a gap between all block centers (titles bridge that
// gap). Known table cells are removed by the caller; forms stay conservative.
export function detectProseColumns(page, blocks) {
  if (page.formFields?.length) return null;
  const lines = blocks.filter(b => b.blockType === "paragraph" && !b.isArtifact &&
    String(b.text || "").trim().length >= 40 && b.bbox[2] >= page.width * .22 &&
    b.bbox[2] <= page.width * .52 && b.bbox[3] > 0 && b.bbox[3] <= 30)
    .sort((a,b) => a.bbox[1]-b.bbox[1] || a.bbox[0]-b.bbox[0]);
  const groups = new Map(), minimumGutter = Math.max(12, page.width * .02);
  for (let i=0; i<lines.length; i++) for (let j=i+1; j<lines.length; j++) {
    if (lines[j].bbox[1]-lines[i].bbox[1] > 15) break;
    const [left,right] = [lines[i],lines[j]].sort((a,b)=>a.bbox[0]-b.bbox[0]);
    if (Math.abs(left.bbox[1]-right.bbox[1]) > Math.min(left.bbox[3],right.bbox[3])*.6) continue;
    const gap=right.bbox[0]-left.bbox[0]-left.bbox[2];
    if (gap < minimumGutter || gap > page.width*.2) continue;
    const key=`${Math.round(left.bbox[0]/12)}:${Math.round(right.bbox[0]/12)}`;
    const group=groups.get(key)||[]; group.push({left,right}); groups.set(key,group);
  }
  const candidates=[];
  for (const pairs of groups.values()) {
    const tops=[...new Set(pairs.map(p=>p.left.bbox[1]))].sort((a,b)=>a-b);
    if (tops.length<3 || tops.at(-1)-tops[0] < 2*Math.max(...pairs.map(p=>p.left.bbox[3]))) continue;
    const gutterLeft=Math.max(...pairs.map(p=>p.left.bbox[0]+p.left.bbox[2]));
    const gutterRight=Math.min(...pairs.map(p=>p.right.bbox[0]));
    if (gutterRight-gutterLeft<minimumGutter) continue;
    const splitX=(gutterLeft+gutterRight)/2;
    // A paragraph through the proposed gutter within the body band invalidates
    // this split. Headings outside/above the band may span both columns.
    if (blocks.some(b=>!b.isArtifact && b.bbox[1]>=tops[0] && b.bbox[1]<=tops.at(-1) &&
      b.bbox[0]<splitX && b.bbox[0]+b.bbox[2]>splitX)) continue;
    candidates.push({count:2,splitX,gutter:gutterRight-gutterLeft,confidence:Math.min(.95,tops.length/10),support:tops.length});
  }
  candidates.sort((a,b)=>b.support-a.support || a.splitX-b.splitX);
  return candidates[0] || null;
}
