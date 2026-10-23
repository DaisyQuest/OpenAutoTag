// Independent geometry from saved annotation values, in default user space.
export function inspectLinkGeometry(annotation) {
  const rect=annotation.rectangle,points=annotation.quadPoints;
  const rectangleValid=Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite)&&rect[2]>rect[0]&&rect[3]>rect[1];
  const result={rectangleValid,valid:rectangleValid&&!annotation.linkPathPresent,rect,polygons:[]};
  if(!result.valid||!annotation.quadPointsPresent)return result;
  if(!Array.isArray(points)||!points.length||points.length%8||points.length>8192||!points.every(Number.isFinite)){result.valid=false;return result;}
  for(let start=0;start<points.length;start+=8){
    const polygon=Array.from({length:4},(_,i)=>({x:points[start+2*i],y:points[start+2*i+1]}));
    if(polygon.some(p=>p.x<rect[0]||p.x>rect[2]||p.y<rect[1]||p.y>rect[3]))result.valid=false;
    let area=0;
    const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    for(let i=0;i<4;i++){
      const a=polygon[i],b=polygon[(i+1)%4],c=polygon[(i+2)%4];
      area+=a.x*b.y-a.y*b.x;if(Math.abs(cross(a,b,c))<=1e-8)result.valid=false;
    }
    if(area<=1e-8)result.valid=false;
    for(const [ai,bi,ci,di] of [[0,1,2,3],[1,2,3,0]]){const [a,b,c,d]=[ai,bi,ci,di].map(i=>polygon[i]);if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0)result.valid=false;}
    result.polygons.push(polygon);
  }
  return result;
}

export function containsLinkGlyph(region,matrix,tick=()=>{}) {
  tick();
  if(!region.rectangleValid||!Array.isArray(matrix)||matrix.length!==8||!matrix.every(Number.isFinite))return false;
  const [a,b,c,d,e,f,dx,dy]=matrix,x=e+(a*dx+c*dy)/2,y=f+(b*dx+d*dy)/2,r=region.rect;
  if(x<r[0]-0.25||x>r[2]+0.25||y<r[1]-0.25||y>r[3]+0.25)return false;
  // Unqualified shapes block competing annotations conservatively; they cannot
  // qualify themselves through their rectangular fallback.
  if(!region.valid||!region.polygons.length)return true;
  for(const polygon of region.polygons){
    tick();
    let crossings=0,boundary=false;
    polygon.forEach((p,i)=>{
      const q=polygon[(i+1)%4],edgeX=q.x-p.x,edgeY=q.y-p.y;
      const t=Math.min(1,Math.max(0,((x-p.x)*edgeX+(y-p.y)*edgeY)/(edgeX*edgeX+edgeY*edgeY)));
      if(Math.hypot(x-(p.x+t*edgeX),y-(p.y+t*edgeY))<=0.25)boundary=true;
      if((p.y>y)!==(q.y>y)&&x<p.x+(y-p.y)*edgeX/edgeY)crossings++;
    });
    if(boundary||crossings%2===1)return true;
  }
  return false;
}
