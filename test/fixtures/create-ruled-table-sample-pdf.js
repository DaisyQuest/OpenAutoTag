import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";

export async function createRuledTableSamplePdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const xLeft = 72;
  const xMiddle = 220;
  const xRight = 360;
  const yTop = 720;
  const yHeaderBottom = 696;
  const yRowOneBottom = 672;
  const yBottom = 648;

  const drawLine = (start, end) =>
    page.drawLine({
      start,
      end,
      thickness: 1,
      color: rgb(0, 0, 0)
    });

  drawLine({ x: xLeft, y: yTop }, { x: xRight, y: yTop });
  drawLine({ x: xLeft, y: yHeaderBottom }, { x: xRight, y: yHeaderBottom });
  drawLine({ x: xLeft, y: yRowOneBottom }, { x: xRight, y: yRowOneBottom });
  drawLine({ x: xLeft, y: yBottom }, { x: xRight, y: yBottom });

  drawLine({ x: xLeft, y: yTop }, { x: xLeft, y: yBottom });
  drawLine({ x: xRight, y: yTop }, { x: xRight, y: yBottom });
  drawLine({ x: xMiddle, y: yHeaderBottom }, { x: xMiddle, y: yBottom });

  page.drawText("Revenue Summary", {
    x: 145,
    y: 703,
    size: 12,
    font: boldFont
  });
  page.drawText("Region", {
    x: 88,
    y: 679,
    size: 12,
    font: boldFont
  });
  page.drawText("Amount", {
    x: 240,
    y: 679,
    size: 12,
    font: boldFont
  });
  page.drawText("North", {
    x: 88,
    y: 655,
    size: 12,
    font: regularFont
  });
  page.drawText("$120", {
    x: 240,
    y: 655,
    size: 12,
    font: regularFont
  });

  page.drawText("This paragraph sits below the ruled table and should not be grouped into it.", {
    x: 72,
    y: 600,
    size: 12,
    font: regularFont
  });

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}
