const address=r=>`${r.pageNumber}:${r.streamOrigin}:${r.operatorIndex}`;

/** Count source occurrences, including text the native writer could only
 * artifact as a fallback. A newly generated Artifact is not source evidence. */
export function completionCoverage({source,ownership,mode}) {
  const counts={totalGlyphs:0,taggedGlyphs:0,authoredArtifactGlyphs:0,unassignedWhitespace:0,unassignedGlyphs:0,unknownGlyphs:0,totalImages:0,taggedImages:0,authoredArtifactImages:0,unassignedImages:0};
  if(!Array.isArray(source?.textRuns)||!Array.isArray(source?.imageRuns)||!Array.isArray(source?.structure))return {status:'unavailable',...counts};
  const content=new Set(source.structure.flatMap(n=>n.contentRefs)),ranges=new Map(),figures=new Set();
  if(mode==='native'){
    if(!ownership||!Array.isArray(ownership.ranges))return {status:'unavailable',...counts};
    for(const range of ownership.ranges){const k=address(range),items=ranges.get(k)||[];items.push([range.glyphStart,range.glyphEnd]);ranges.set(k,items);}
    for(const figure of ownership.nativeFigures||[])figures.add(address(figure));
  }
  for(const run of source.textRuns){
    const intervals=(ranges.get(address(run))||[]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let cursor=0;
    for(let i=0;i<run.glyphs.length;i++){
      const text=run.glyphs[i][1],unknown=typeof text!=='string'||!text.length||/[\u0000\ufffd]/u.test(text);counts.totalGlyphs++;
      while(cursor<intervals.length&&intervals[cursor][1]<=i)cursor++;
      const owned=mode==='native'?cursor<intervals.length&&intervals[cursor][0]<=i:run.owners?.length===1&&content.has(run.owners[0]);
      if(run.artifact)counts.authoredArtifactGlyphs++;
      else {
        if(unknown)counts.unknownGlyphs++;
        if(owned)counts.taggedGlyphs++;
        else if(!unknown&&/^\p{White_Space}+$/u.test(text))counts.unassignedWhitespace++;
        else counts.unassignedGlyphs++;
      }
    }
  }
  for(const image of source.imageRuns){counts.totalImages++;if(image.artifact)counts.authoredArtifactImages++;else if(mode==='native'?figures.has(address(image)):image.owners?.length===1&&content.has(image.owners[0]))counts.taggedImages++;else counts.unassignedImages++;}
  return {status:counts.unassignedGlyphs||counts.unknownGlyphs||counts.unassignedImages?'incomplete':'complete',...counts};
}
