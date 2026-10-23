import { COORDINATE_SPACE } from "./page-geometry.js";

const rounded = value => Math.round(value * 1000000) / 1000000;
const finite = values => values.every(Number.isFinite);

/** The renderer already applies CropBox and page rotation. Its exact scale,
 * rather than the rounded bitmap dimensions, maps pixels to display points. */
export function recognitionTransform(variant, rotation = 0) {
  const { imageWidth: width, imageHeight: height, pdfWidth, pdfHeight, pixelToDisplay: matrix } = variant;
  if (variant.coordinateSpace !== COORDINATE_SPACE || !Number.isInteger(width) || width <= 0 ||
      !Number.isInteger(height) || height <= 0 || !finite([pdfWidth, pdfHeight]) || pdfWidth <= 0 || pdfHeight <= 0 ||
      !Array.isArray(matrix) || matrix.length !== 6 || !finite(matrix) || matrix[0] <= 0 || matrix[3] !== matrix[0] ||
      matrix[1] !== 0 || matrix[2] !== 0 || matrix[4] !== 0 || matrix[5] !== 0)
    throw new Error("OCR requires an explicit display-pixel coordinate transform");
  const scale = matrix[0];
  if (Math.abs(pdfWidth - width * scale) > scale + 0.002 || Math.abs(pdfHeight - height * scale) > scale + 0.002)
    throw new Error("OCR render dimensions disagree with its coordinate transform");
  if (!Number.isFinite(rotation) || Math.abs(rotation) > Math.PI) throw new Error("Invalid OCR recognition rotation");
  // Tesseract.js 7 uses Leptonica pixRotate without canvas expansion. Rotation
  // is clockwise about the integer image center; angles < .001 are a no-op.
  const angle = Math.abs(rotation) < 0.001 ? 0 : Math.fround(rotation);
  const c = Math.cos(angle), s = Math.sin(angle), cx = Math.floor(width / 2), cy = Math.floor(height / 2);
  return { angle, scale, matrix: [scale*c, -scale*s, scale*s, scale*c,
    scale*(cx-c*cx-s*cy), scale*(cy+s*cx-c*cy)] };
}

export function mapRecognitionBox(box, variant, transform) {
  const { x0, y0, x1, y1 } = box || {};
  if (!finite([x0,y0,x1,y1]) || x1 <= x0 || y1 <= y0 || x0 < 0 || y0 < 0 || x1 > variant.imageWidth || y1 > variant.imageHeight)
    throw new Error("OCR returned an invalid pixel bounding box");
  const [a,b,c,d,e,f] = transform.matrix;
  const corners = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(([x,y]) => [a*x+c*y+e,b*x+d*y+f]);
  const left = Math.min(...corners.map(p=>p[0])), top = Math.min(...corners.map(p=>p[1]));
  const right = Math.max(...corners.map(p=>p[0])), bottom = Math.max(...corners.map(p=>p[1]));
  // PDFRenderer uses float scale/products. Ignore subpixel numeric drift at
  // an exact canvas edge, while still clipping the emitted enclosing box.
  const epsilon = transform.scale * 0.001;
  const clipped = left < -epsilon || top < -epsilon || right > variant.pdfWidth + epsilon || bottom > variant.pdfHeight + epsilon;
  const x = Math.max(0,left), y = Math.max(0,top), r = Math.min(variant.pdfWidth,right), bot = Math.min(variant.pdfHeight,bottom);
  if (r <= x || bot <= y) throw new Error("OCR bounding box falls outside the displayed page");
  return {
    bbox: [x,y,r-x,bot-y].map(rounded),
    evidence: { coordinateSpace: COORDINATE_SPACE, imageSize: [variant.imageWidth,variant.imageHeight],
      recognitionRotationRadians: transform.angle, pixelBox: [x0,y0,x1,y1],
      pixelToDisplay: transform.matrix, quad: corners.flat().map(rounded), clipped }
  };
}
