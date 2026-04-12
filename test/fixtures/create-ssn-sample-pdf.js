import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFile } from "node:fs/promises";

export async function createSsnSamplePdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("Employee Intake Form", { x: 72, y: 720, size: 24, font: boldFont });
  page.drawText("Primary SSN: 123-45-6789", { x: 72, y: 680, size: 12, font });
  page.drawText("Backup SSN 987654321", { x: 72, y: 652, size: 12, font });
  page.drawText("Tax ID 12-3456789 should remain visible.", { x: 72, y: 624, size: 12, font });
  page.drawText("Reference number 123-45-678 should remain visible.", { x: 72, y: 596, size: 12, font });
  page.drawText("No sensitive content on this line.", { x: 72, y: 568, size: 12, font });

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}
