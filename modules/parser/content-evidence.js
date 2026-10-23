// Comparison normalization never replaces the text that is emitted or displayed.
export const comparisonText = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
export function textEvidence(block, source) {
  return { ...block, rawText: block.rawText ?? block.text, comparisonText: comparisonText(block.text), textProvenance: source };
}
function overlap(a, b) {
  const area = Math.max(0, Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])) *
    Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
  return area / Math.max(1, Math.min(a[2]*a[3],b[2]*b[3]));
}
export function alignOcrText(nativeBlocks, ocrBlocks) {
  if (nativeBlocks.length * ocrBlocks.length > 2000000) return { blocks: nativeBlocks, suppressed: 0, conflicts: [{ code: "OCR_ALIGNMENT_LIMIT" }] };
  const blocks = nativeBlocks.map(b=>textEvidence(b,"native")), conflicts=[];
  let suppressed=0;
  for(const ocr of ocrBlocks) {
    const peers=nativeBlocks.filter(n=>overlap(n.bbox,ocr.bbox)>.1);
    if(peers.length) {
      suppressed++;
      const nativeText=peers.map(n=>n.text).join(" ");
      if(comparisonText(nativeText)!==comparisonText(ocr.text)) conflicts.push({code:"OCR_NATIVE_CONFLICT",nativeBlockIds:peers.map(n=>n.id),nativeText,ocrText:ocr.text,bbox:ocr.bbox});
    } else blocks.push(textEvidence(ocr,"ocr"));
  }
  blocks.sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]);
  return {blocks,suppressed,conflicts};
}

// PDF.js expands form XObjects in the operator list. Track graphics transforms only;
// clipping and vector-composite classification remain explicit review limitations.
export function imageEvidence(operatorList, OPS, viewport, pageNumber) {
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  let matrix=[1,0,0,1,0,0]; const stack=[],figures=[];
  for(let i=0;i<operatorList.fnArray.length;i++) {
    const op=operatorList.fnArray[i],args=operatorList.argsArray[i];
    if(op===OPS.save || op===OPS.paintFormXObjectBegin) {
      if(stack.length>=128) throw new Error("Image evidence graphics stack limit exceeded");
      stack.push([...matrix]);
      if(op===OPS.paintFormXObjectBegin&&args[0])matrix=multiply(matrix,args[0]);
    } else if(op===OPS.restore || op===OPS.paintFormXObjectEnd) {if(!stack.length)throw new Error("Unbalanced image evidence graphics stack");matrix=stack.pop();}
    else if(op===OPS.transform)matrix=multiply(matrix,args);
    else if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op)) {
      const t=multiply(viewport.transform,matrix),points=[[0,0],[0,1],[1,0],[1,1]].map(([x,y])=>[t[0]*x+t[2]*y+t[4],t[1]*x+t[3]*y+t[5]]);
      const left=Math.max(0,Math.min(...points.map(p=>p[0]))),top=Math.max(0,Math.min(...points.map(p=>p[1])));
      const right=Math.min(viewport.width,Math.max(...points.map(p=>p[0]))),bottom=Math.min(viewport.height,Math.max(...points.map(p=>p[1])));
      if(right>left&&bottom>top)figures.push({id:`image:${pageNumber}:${i}`,bbox:[left,top,right-left,bottom-top],source:"image-operator",operatorIndex:i});
    }
  }
  return figures;
}
