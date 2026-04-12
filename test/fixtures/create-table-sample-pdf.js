import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFile } from "node:fs/promises";

export async function createTableSamplePdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("Performance Tables", { x: 72, y: 728, size: 22, font: boldFont });

  page.drawText("Section", { x: 72, y: 680, size: 12, font: boldFont });
  page.drawText("Players", { x: 220, y: 680, size: 12, font: boldFont });
  page.drawText("Strings", { x: 72, y: 656, size: 12, font: regularFont });
  page.drawText("34", { x: 220, y: 656, size: 12, font: regularFont });
  page.drawText("Brass", { x: 72, y: 632, size: 12, font: regularFont });
  page.drawText("12", { x: 220, y: 632, size: 12, font: regularFont });

  page.drawText("The personnel table should stay separate from the venue table below.", {
    x: 72,
    y: 590,
    size: 12,
    font: regularFont
  });

  page.drawText("Venue", { x: 72, y: 520, size: 12, font: boldFont });
  page.drawText("City", { x: 220, y: 520, size: 12, font: boldFont });
  page.drawText("Palace Theatre", { x: 72, y: 496, size: 12, font: regularFont });
  page.drawText("Albany", { x: 220, y: 496, size: 12, font: regularFont });
  page.drawText("Troy Savings", { x: 72, y: 472, size: 12, font: regularFont });
  page.drawText("Troy", { x: 220, y: 472, size: 12, font: regularFont });

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}
