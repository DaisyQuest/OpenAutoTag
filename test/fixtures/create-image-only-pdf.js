import { PDFDocument } from "pdf-lib";
import { writeFile } from "node:fs/promises";

const ONE_BY_ONE_WHITE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax2R5sAAAAASUVORK5CYII=";

export async function createImageOnlyPdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const imageBytes = Buffer.from(ONE_BY_ONE_WHITE_PNG_BASE64, "base64");
  const image = await pdfDoc.embedPng(imageBytes);

  page.drawImage(image, {
    x: 0,
    y: 0,
    width: 612,
    height: 792
  });

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}
