import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFile } from "node:fs/promises";

export async function createSpanishSamplePdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("Informe de accesibilidad", { x: 72, y: 720, size: 24, font: boldFont });
  page.drawText("Este parrafo explica la salida del informe con detalle.", {
    x: 72,
    y: 680,
    size: 12,
    font
  });
  page.drawText("Donde estan los datos y como se validan?", {
    x: 72,
    y: 652,
    size: 12,
    font
  });
  page.drawText("- Primer elemento de verificacion", { x: 72, y: 624, size: 12, font });
  page.drawText("- Segundo elemento de verificacion", { x: 72, y: 604, size: 12, font });
  page.drawText("Nota lateral en espanol", { x: 330, y: 680, size: 12, font });

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}
