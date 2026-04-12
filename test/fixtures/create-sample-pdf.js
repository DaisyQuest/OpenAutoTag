import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFile } from "node:fs/promises";

export async function createSamplePdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("Accessibility Report", { x: 72, y: 720, size: 24, font: boldFont });
  page.drawText("This paragraph explains the report output.", {
    x: 72,
    y: 680,
    size: 12,
    font
  });
  page.drawText("- First checklist item", { x: 72, y: 650, size: 12, font });
  page.drawText("- Second checklist item", { x: 72, y: 630, size: 12, font });
  page.drawText("Right column note", { x: 330, y: 680, size: 12, font });

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}
