// Running content requires cross-page evidence; edge position alone is insufficient.
const clean=s=>String(s||"").normalize("NFKC").replace(/\s+/g," ").trim();
const font=n=>String(n.fontName||"").replace(/^[A-Z]{6}\+/,"").toLowerCase();
const size=n=>n.fontSize||n.bbox[3]||1;
const bottom=n=>n.bbox[1]+n.bbox[3];
const eligible=n=>["P","H1","H2","H3","H4","H5","H6"].includes(n.role)&&!n.artifactType&&!n.tableId&&
 !n.formFieldIds?.length&&!n.semanticRole&&!n.footnoteGroupId&&!n.labelValuePairId&&!n.paragraphGroupId&&
 n.textProvenance!=="ocr"&&(n.writingMode||"horizontal")==="horizontal"&&Math.abs((n.textRotation||0)%360)<1;
function band(n,page) {
 const edge=Math.min(54,page.height*.06);
 if(n.bbox[1]>=0&&bottom(n)<=edge)return "header";
 if(n.bbox[1]>=page.height-edge&&bottom(n)<=page.height)return "footer";
 return null;
}
function roman(token) {
 if(!/^(?=[ivxlcdm]+$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(token))return null;
 const values={i:1,v:5,x:10,l:50,c:100,d:500,m:1000},digits=[...token.toLowerCase()].map(c=>values[c]);
 return digits.reduce((v,d,i)=>v+(d<(digits[i+1]||0)?-d:d),0);
}
function counter(text) {
 const match=/^(page\s+)?(\d{1,6}|[ivxlcdm]{1,15})(?:\s*(of|\/)\s*(\d{1,6}|[ivxlcdm]{1,15}))?$/i.exec(text);
 if(!match)return null;
 const scheme=/^\d+$/.test(match[2])?"decimal":match[2]===match[2].toUpperCase()?"roman-upper":"roman-lower";
 const number=/^\d+$/.test(match[2])?Number(match[2]):roman(match[2]);
 const total=match[4]?(/^\d+$/.test(match[4])?Number(match[4]):roman(match[4])):null;
 if(!number||(match[4]&&(!total||number>total)))return null;
 return {number,key:`${scheme}:${Boolean(match[1])}:${match[3]||""}:${total??""}`};
}
function detached(n,placement,others,page,numeric) {
 const gap=Math.max(3,size(n)*(numeric?.35:1.5));
 // A number immediately beside prose may be a footnote marker or list label.
 if(numeric&&others.some(o=>o!==n&&Math.abs(bottom(o)-bottom(n))<size(n)*.5&&
  Math.max(o.bbox[0]-n.bbox[0]-n.bbox[2],n.bbox[0]-o.bbox[0]-o.bbox[2],0)<size(n)*2))return false;
 if(!numeric&&others.some(o=>o!==n&&counter(clean(o.text))&&Math.abs(bottom(o)-bottom(n))<size(n)*.5&&
  Math.max(o.bbox[0]-n.bbox[0]-n.bbox[2],n.bbox[0]-o.bbox[0]-o.bbox[2],0)<size(n)*2))return false;
 const body=others.filter(o=>o!==n&&o.role!=="Artifact"&&!(band(o,page)&&(numeric||counter(clean(o.text)))));
 if(!body.length)return numeric;
 return placement==="header"?body.every(o=>o.bbox[1]>=bottom(n)+gap):body.every(o=>bottom(o)<=n.bbox[1]-gap);
}

export function inferRunningContent(nodes,pages) {
 const tasks=[],groups=new Map(),byPage=new Map();
 for(const n of nodes){const list=byPage.get(n.pageNumber)||[];list.push(n);byPage.set(n.pageNumber,list);}
 for(const page of pages) {
  const pageNodes=byPage.get(page.pageNumber)||[];
  if(pageNodes.length>10000){tasks.push({code:"RUNNING_CONTENT_INFERENCE_LIMIT",pageNumber:page.pageNumber});continue;}
  const bodySizes=pageNodes.filter(n=>!band(n,page)&&n.role==="P"&&!n.tableId).map(size).sort((a,b)=>a-b);
  const bodySize=bodySizes[Math.floor(bodySizes.length/2)]||0;
  for(const n of pageNodes) {
   const text=clean(n.text),placement=band(n,page);
   if(!placement||!eligible(n)||!text||text.length>100||!font(n)||n.bbox[3]>size(n)*1.5)continue;
   // Widget proximity also protects prompts whose label association is unresolved.
   if((page.formFields||[]).some(w=>Array.isArray(w.bbox)&&
    Math.max(w.bbox[0]-n.bbox[0]-n.bbox[2],n.bbox[0]-w.bbox[0]-w.bbox[2],0)<=size(n)*2&&
    Math.max(w.bbox[1]-bottom(n),n.bbox[1]-w.bbox[1]-w.bbox[3],0)<=size(n)*1.5))continue;
   const pagination=counter(text);
   if(!pagination&&(/^(?:page\s|[\divxlcdm]+$)/i.test(text)))continue;
   if(pagination&&n.role!=="P"&&bodySize>0&&size(n)>bodySize*1.25)continue;
   if(!pagination&&(n.role!=="P"||size(n)>bodySize*1.05||(/bold|heavy|black/i.test(font(n))&&size(n)>=bodySize*.95)||
    /(?:https?:|www\.|@|\b(?:contact|click|visit|email)\b)/i.test(text)))continue;
   if(!detached(n,placement,pageNodes,page,Boolean(pagination)))continue;
   const style=`${font(n)}:${Math.round(size(n)*2)}`;
   const key=pagination?`counter:${pagination.key}:${pagination.number-n.pageNumber}:${style}`:`text:${placement}:${text}:${style}`;
   const group=groups.get(key)||[];group.push({node:n,placement,pagination,hasBody:bodySizes.length>0});groups.set(key,group);
  }
 }
 let marked=0;
 for(const group of groups.values()) {
  const pageIds=new Set(group.map(g=>g.node.pageNumber));
  if(pageIds.size<3||pageIds.size!==group.length)continue;
  // A numbered blank separator page can inherit an established sequence, but
  // a document consisting only of numbered cards must not become all artifacts.
  if(group[0].pagination&&group.filter(g=>g.hasBody).length<2)continue;
  for(const {node,placement,pagination} of group) {
   node.role="Artifact";node.artifactType=placement;delete node.headingLevel;
   node.artifactEvidence=pagination?"consistent-pagination-sequence":"repeated-detached-margin-text";
   tasks.push({code:"RUNNING_CONTENT_INFERRED",pageNumber:node.pageNumber,nodeId:node.id});marked++;
  }
 }
 return {tasks,marked};
}
