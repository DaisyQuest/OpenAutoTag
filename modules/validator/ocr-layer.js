/** Raw PDF glyph matrices to the explicitly declared display frame. */
function display(g, x, y) {
  const [, , , , l, b, r, t, rotate, u] = g;
  switch (rotate) {
    case 0: return [(x-l)*u,(t-y)*u];
    case 90: return [(y-b)*u,(x-l)*u];
    case 180: return [(r-x)*u,(y-b)*u];
    case 270: return [(t-y)*u,(r-x)*u];
    default: return [NaN,NaN];
  }
}
const near = (a,b) => a?.length === b?.length && a.every((v,i) => Number.isFinite(v) && Math.abs(v-b[i])<=0.02);
export function matchesOcrGeometry(run, quad, geometry) {
  const p=run.positions;
  if (!geometry || !p?.length || p.length!==run.glyphs.length) return false;
  const first=p[0], last=p.at(-1), end=[last[4]+last[0]*last[6]+last[2]*last[7],last[5]+last[1]*last[6]+last[3]*last[7]];
  const actual=[...display(geometry,first[4]+first[2],first[5]+first[3]),
    ...display(geometry,end[0]+first[2],end[1]+first[3]),...display(geometry,...end),...display(geometry,first[4],first[5])];
  if (!near(actual,quad)) return false;
  // Endpoints alone cannot conceal a misplaced intermediate word or altered
  // text scaling. Check every advance in the line, including whitespace.
  const vector=(m,j)=>{const a=display(geometry,m[4],m[5]),b=display(geometry,m[4]+m[j],m[5]+m[j+1]);return b.map((v,i)=>v-a[i]);};
  for (let i=0;i<p.length;i++) {
    if (!near(vector(p[i],0),vector(first,0)) || !near(vector(p[i],2),vector(first,2)) || p[i][7]!==0 || p[i][6]<0) return false;
    if (i && !near(display(geometry,p[i][4],p[i][5]),display(geometry,
      p[i-1][4]+p[i-1][0]*p[i-1][6],p[i-1][5]+p[i-1][1]*p[i-1][6]))) return false;
  }
  return true;
}

/** OCR is a suffix to each page's original glyph sequence, never an excuse to
 * remove, replace, reorder, or reassign any original glyph. */
export function inspectOcrLayer({inspection, source, intendedNodes, add}) {
  const counts=new Map(), expected=new Map(), generated=new Map(), nativeRuns=[], generatedRuns=[];
  for(const run of source.textRuns || [])counts.set(run.pageNumber,Math.max(counts.get(run.pageNumber)||0,run.glyphEnd));
  for(const {n,id} of intendedNodes)for(const entry of n.ocrSegments || []) {
    const entries=expected.get(entry.pageNumber)||[]; entries.push({...entry,owner:id});expected.set(entry.pageNumber,entries);
  }
  for(const run of inspection.textRuns || []) {
    if(run.glyphStart >= (counts.get(run.pageNumber)||0) && run.glyphs.length)generatedRuns.push(run);
    else nativeRuns.push(run);
  }
  for(const run of generatedRuns){const page=generated.get(run.pageNumber)||[];page.push(run);generated.set(run.pageNumber,page);}
  let valid=true;const check=(code,target,a,b)=>{add(code,target,a,b);if(JSON.stringify(a)!==JSON.stringify(b))valid=false;};
  const owners=new Map();
  for(const page of new Set([...expected.keys(),...generated.keys()])) {
    const lines=expected.get(page)||[], runs=generated.get(page)||[];
    check("OCR_LINE_COUNT",`page:${page}`,lines.length,runs.length);
    const geometry=source.pages?.[page-1]?.geometry;
    check("OCR_PAGE_GEOMETRY",`page:${page}`,geometry,inspection.pages?.[page-1]?.geometry);
    let next=counts.get(page)||0;
    for(const run of runs){check("OCR_GLYPH_CONTIGUOUS",`${page}:${run.operatorIndex}`,next,run.glyphStart);next=run.glyphEnd;}
    for(let i=0;i<Math.min(lines.length,runs.length);i++) {
      const line=lines[i],run=runs[i],target=`${page}:${line.sourceBlockId}:${i}`;
      check("OCR_TEXT_EXACT",target,line.text,run.glyphs.map(g=>g[1]).join(""));
      check("OCR_TEXT_INVISIBLE",target,3,run.renderingMode);
      check("OCR_FONT_EMBEDDED",target,true,run.fontEmbedded);
      check("OCR_LINE_GEOMETRY",target,true,matchesOcrGeometry(run,line.quad,geometry));
      check("OCR_REAL_CONTENT",target,false,run.artifact);
      for(let g=run.glyphStart;g<run.glyphEnd;g++)owners.set(`${page}:${g}`,line.owner);
    }
  }
  return {valid,nativeRuns,owners};
}
