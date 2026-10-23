// Public layout coordinates are physical points (1/72 inch), measured from
// the displayed CropBox's top-left corner after page rotation and UserUnit.
export const COORDINATE_SPACE = "crop-display-points";

export function displayTextItem(item, viewport) {
  if (!Array.isArray(item.transform)) return item;
  const [a,b,c,d,e,f] = item.transform, [x,y,z,w,tx,ty] = viewport.transform;
  // groupTextItemsToBlocks accepts a bottom-origin matrix. Feed it a synthetic
  // display matrix so its existing glyph-corner calculation remains valid.
  return {...item, width:item.width * viewport.userUnit, height:item.height * viewport.userUnit,
    transform:[x*a+z*b,-(y*a+w*b),x*c+z*d,-(y*c+w*d),x*e+z*f+tx,viewport.height-(y*e+w*f+ty)]};
}

export function displayRectangle(rect, viewport) {
  const [x0,y0,x1,y1] = viewport.convertToViewportRectangle(rect);
  return [Math.min(x0,x1),Math.min(y0,y1),Math.abs(x1-x0),Math.abs(y1-y0)];
}
