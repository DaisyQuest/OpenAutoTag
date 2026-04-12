import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";

export async function createBrokenRuledTableSamplePdf(filePath) {
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

  drawLine({ x: xLeft, y: yTop }, { x: 214, y: yTop });
  drawLine({ x: 226, y: yTop }, { x: xRight, y: yTop });
  drawLine({ x: xLeft, y: yHeaderBottom }, { x: 214, y: yHeaderBottom });
  drawLine({ x: 226, y: yHeaderBottom }, { x: xRight, y: yHeaderBottom });
  drawLine({ x: xLeft, y: yRowOneBottom }, { x: 214, y: yRowOneBottom });
  drawLine({ x: 226, y: yRowOneBottom }, { x: xRight, y: yRowOneBottom });
  drawLine({ x: xLeft, y: yBottom }, { x: 214, y: yBottom });
  drawLine({ x: 226, y: yBottom }, { x: xRight, y: yBottom });

  drawLine({ x: xLeft, y: yTop }, { x: xLeft, y: 684 });
  drawLine({ x: xLeft, y: 678 }, { x: xLeft, y: yBottom });
  drawLine({ x: xRight, y: yTop }, { x: xRight, y: 684 });
  drawLine({ x: xRight, y: 678 }, { x: xRight, y: yBottom });
  drawLine({ x: xMiddle, y: yHeaderBottom }, { x: xMiddle, y: 666 });
  drawLine({ x: xMiddle, y: 660 }, { x: xMiddle, y: yBottom });

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

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}
