import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { createSamplePdf } from "./create-sample-pdf.js";
import { renderPageVariantsWithPdfBox } from "../../modules/parser/ocr-pipeline.js";

export async function createScannedSamplePdf(filePath) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "scanned-sample-fixture-"));
  const sourcePdfPath = path.join(tempDir, "source.pdf");
  const renderOutputDir = path.join(tempDir, "render");

  try {
    await createSamplePdf(sourcePdfPath);
    const rendered = await renderPageVariantsWithPdfBox({
      pdfPath: sourcePdfPath,
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792
        }
      ],
      outputDir: renderOutputDir,
      renderVariants: [
        {
          name: "gray-300",
          dpi: 300,
          imageType: "GRAY",
          preprocessing: "grayscale"
        }
      ]
    });

    const imagePath = rendered.pages[0].variants[0].imagePath;
    const imageBytes = await readFile(imagePath);
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([rendered.pages[0].pdfWidth, rendered.pages[0].pdfHeight]);
    const image = await pdfDoc.embedPng(imageBytes);

    page.drawImage(image, {
      x: 0,
      y: 0,
      width: rendered.pages[0].pdfWidth,
      height: rendered.pages[0].pdfHeight
    });

    const bytes = await pdfDoc.save();
    await writeFile(filePath, bytes);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
