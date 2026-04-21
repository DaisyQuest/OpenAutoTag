import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../../../test/fixtures/create-sample-pdf.js";
import { createSpanishSamplePdf } from "../../../test/fixtures/create-spanish-sample-pdf.js";
import { createImageOnlyPdf } from "../../../test/fixtures/create-image-only-pdf.js";
import { createPdfDocumentLoadOptions, groupTextItemsToBlocks, parsePdf } from "../index.js";
import { renderPageVariantsWithPdfBox, selectBestOcrCandidate } from "../ocr-pipeline.js";

test("parser groups fragmented extractor items into a single line block", () => {
  const blocks = groupTextItemsToBlocks(1, 792, [
    {
      str: "Hello",
      width: 30,
      height: 12,
      transform: [12, 0, 0, 12, 72, 680],
      fontName: "Helvetica"
    },
    {
      str: "world",
      width: 32,
      height: 12,
      transform: [12, 0, 0, 12, 110, 680],
      fontName: "Helvetica"
    },
    {
      str: "Next line",
      width: 50,
      height: 12,
      transform: [12, 0, 0, 12, 72, 650],
      fontName: "Helvetica"
    }
  ]);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "Hello world");
  assert.deepEqual(blocks[0].bbox, [72, 100, 70, 12]);
});

test("parser keeps wide same-baseline gaps as separate blocks", () => {
  const blocks = groupTextItemsToBlocks(1, 792, [
    {
      str: "Left paragraph",
      width: 90,
      height: 12,
      transform: [12, 0, 0, 12, 72, 680],
      fontName: "Helvetica"
    },
    {
      str: "Right note",
      width: 60,
      height: 12,
      transform: [12, 0, 0, 12, 330, 680],
      fontName: "Helvetica"
    }
  ]);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "Left paragraph");
  assert.equal(blocks[1].text, "Right note");
});

test("parser preserves rotated axis labels as vertical blocks", () => {
  const blocks = groupTextItemsToBlocks(1, 792, [
    {
      str: "60",
      width: 7.47,
      height: 6.72,
      transform: [6.72, 0, 0, 6.72, 82.76, 503.33],
      fontName: "Helvetica"
    },
    {
      str: "Inverse usage",
      width: 44.77,
      height: 6.72,
      transform: [0, 6.72, -6.72, 0, 73.16, 503.81],
      fontName: "Helvetica-Bold"
    }
  ]);

  const label = blocks.find((block) => block.text === "Inverse usage");
  const tick = blocks.find((block) => block.text === "60");

  assert.equal(blocks.length, 2);
  assert.ok(label);
  assert.ok(tick);
  assert.equal(label.writingMode, "vertical");
  assert.equal(label.textRotation, 90);
  assert.ok(label.bbox[2] <= 7);
  assert.ok(label.bbox[3] >= 44);
  assert.equal(tick.writingMode, "horizontal");
});

test("parser extracts text blocks with bounding boxes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");

  await createSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath);

  assert.equal(layout.pages.length, 1);
  assert.ok(layout.pages[0].textBlocks.length >= 4);
  assert.equal(layout.pages[0].textBlocks[0].bbox.length, 4);
  assert.ok(layout.pages[0].textBlocks.some((block) => block.text.includes("Accessibility Report")));
});

test("parser suppresses pdfjs warnings in CLI JSON output", () => {
  const options = createPdfDocumentLoadOptions(new Uint8Array([1, 2, 3]));

  assert.equal(options.verbosity, 0);
  assert.equal(options.useSystemFonts, true);
  assert.equal(options.isEvalSupported, false);
});

test("parser detects Spanish language in native text PDFs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-spanish-language-test-"));
  const pdfPath = path.join(tempDir, "spanish.pdf");

  await createSpanishSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath);

  assert.equal(layout.source.language, "es-ES");
  assert.ok(layout.source.languageConfidence >= 0.7);
  assert.equal(layout.pages[0].language, "es-ES");
  assert.equal(layout.source.ocr.languageStrategy, "detected-spanish");
  assert.deepEqual(layout.source.ocr.languages, ["spa", "eng"]);
});

test("OCR candidate selection favors stronger page reconstructions", () => {
  const bestCandidate = selectBestOcrCandidate([
    {
      candidateName: "gray-300/auto",
      score: 0.52,
      characterCount: 28,
      wordCount: 5,
      averageConfidence: 81
    },
    {
      candidateName: "gray-450/sparse",
      score: 0.77,
      characterCount: 62,
      wordCount: 12,
      averageConfidence: 91
    }
  ]);

  assert.equal(bestCandidate.candidateName, "gray-450/sparse");
});

test("parser keeps OCR disabled for pages that already have sufficient native text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-native-text-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");

  await createSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath, {
    ocr: {
      renderPageVariants: async () => {
        throw new Error("OCR rendering should not have been invoked");
      },
      createRecognizer: async () => {
        throw new Error("OCR recognition should not have been invoked");
      }
    }
  });

  assert.equal(layout.source.ocr.status, "skipped");
  assert.equal(layout.source.ocr.appliedPages, 0);
  assert.equal(layout.pages[0].ocr.status, "not-attempted");
});

test("parser applies OCR fallback to image-only pages using injected OCR dependencies", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-ocr-fallback-test-"));
  const pdfPath = path.join(tempDir, "image-only.pdf");

  await createImageOnlyPdf(pdfPath);
  const layout = await parsePdf(pdfPath, {
    ocr: {
      renderPageVariants: async ({ pages }) => ({
        status: "completed",
        pages: pages.map((page) => ({
          pageNumber: page.pageNumber,
          pdfWidth: page.width,
          pdfHeight: page.height,
          variants: [
            {
              name: "gray-300",
              dpi: 300,
              preprocessing: "grayscale",
              imagePath: path.join(tempDir, `page-${page.pageNumber}.png`),
              imageWidth: 2550,
              imageHeight: 3300
            }
          ]
        }))
      }),
      createRecognizer: async () => ({
        async recognizeVariant() {
          return [
            {
              candidateName: "gray-300/auto",
              variantName: "gray-300",
              profileName: "auto",
              preprocessing: "grayscale",
              dpi: 300,
              averageConfidence: 96,
              pageConfidence: 95,
              blockCount: 2,
              wordCount: 6,
              characterCount: 31,
              alphaNumericRatio: 0.93,
              score: 0.88,
              text: "Scanned heading Scanned paragraph",
              textBlocks: [
                {
                  id: "ocr-1",
                  text: "Scanned heading",
                  bbox: [72, 84, 180, 28],
                  fontSize: 24,
                  fontName: "ocr",
                  textSource: "ocr",
                  ocrConfidence: 97
                },
                {
                  id: "ocr-2",
                  text: "Scanned paragraph",
                  bbox: [72, 138, 220, 18],
                  fontSize: 14,
                  fontName: "ocr",
                  textSource: "ocr",
                  ocrConfidence: 95
                }
              ]
            }
          ];
        },
        async close() {}
      })
    }
  });

  assert.equal(layout.source.ocr.status, "completed");
  assert.equal(layout.source.ocr.appliedPages, 1);
  assert.equal(layout.pages[0].ocr.status, "applied");
  assert.equal(layout.pages[0].textBlocks.length, 2);
  assert.equal(layout.pages[0].textBlocks[0].text, "Scanned heading");
  assert.equal(layout.pages[0].textBlocks[1].text, "Scanned paragraph");
});

test("parser prefers Spanish OCR languages when native text indicates Spanish", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-spanish-ocr-test-"));
  const pdfPath = path.join(tempDir, "spanish.pdf");
  const capturedLanguages = [];

  await createSpanishSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath, {
    ocr: {
      mode: "force",
      renderPageVariants: async ({ pages }) => ({
        status: "completed",
        pages: pages.map((page) => ({
          pageNumber: page.pageNumber,
          pdfWidth: page.width,
          pdfHeight: page.height,
          variants: [
            {
              name: "gray-300",
              dpi: 300,
              preprocessing: "grayscale",
              imagePath: path.join(tempDir, `page-${page.pageNumber}.png`),
              imageWidth: 2550,
              imageHeight: 3300
            }
          ]
        }))
      }),
      createRecognizer: async ({ languages }) => {
        capturedLanguages.push(...languages);
        return {
          async recognizeVariant() {
            return {
              candidates: [
                {
                  candidateName: "gray-300/auto",
                  variantName: "gray-300",
                  profileName: "auto",
                  preprocessing: "grayscale",
                  dpi: 300,
                  averageConfidence: 94,
                  pageConfidence: 94,
                  blockCount: 1,
                  wordCount: 8,
                  characterCount: 47,
                  alphaNumericRatio: 0.93,
                  score: 0.81,
                  text: "Informe de accesibilidad y validacion",
                  textBlocks: [
                    {
                      id: "ocr-1",
                      text: "Informe de accesibilidad y validacion",
                      bbox: [72, 84, 240, 24],
                      fontSize: 24,
                      fontName: "ocr",
                      textSource: "ocr",
                      ocrConfidence: 94
                    }
                  ]
                }
              ],
              errors: []
            };
          },
          async close() {}
        };
      }
    }
  });

  assert.deepEqual(capturedLanguages, ["spa", "eng"]);
  assert.equal(layout.source.language, "es-ES");
  assert.equal(layout.source.ocr.languageStrategy, "detected-spanish");
});

test("parser survives OCR failures when fallback is optional", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-ocr-failure-test-"));
  const pdfPath = path.join(tempDir, "image-only.pdf");

  await createImageOnlyPdf(pdfPath);
  const layout = await parsePdf(pdfPath, {
    ocr: {
      renderPageVariants: async () => {
        throw new Error("renderer unavailable");
      }
    }
  });

  assert.equal(layout.source.ocr.status, "failed");
  assert.equal(layout.pages[0].ocr.status, "failed");
  assert.match(layout.pages[0].ocr.error, /renderer unavailable/);
  assert.equal(layout.pages[0].textBlocks.length, 0);
});

test("parser surfaces OCR failures when OCR is required", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-ocr-required-failure-test-"));
  const pdfPath = path.join(tempDir, "image-only.pdf");

  await createImageOnlyPdf(pdfPath);

  await assert.rejects(
    () =>
      parsePdf(pdfPath, {
        ocr: {
          mode: "required",
          renderPageVariants: async () => {
            throw new Error("required renderer unavailable");
          }
        }
      }),
    /required renderer unavailable/
  );
});

test("PDFBox OCR renderer emits page image variants for image-only PDFs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "parser-ocr-render-test-"));
  const pdfPath = path.join(tempDir, "image-only.pdf");
  const outputDir = path.join(tempDir, "ocr-render-output");

  await createImageOnlyPdf(pdfPath);

  const rendered = await renderPageVariantsWithPdfBox({
    pdfPath,
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792
      }
    ],
    outputDir
  });

  assert.equal(rendered.status, "completed");
  assert.equal(rendered.pages.length, 1);
  assert.equal(rendered.pages[0].variants.length >= 2, true);
  await access(rendered.pages[0].variants[0].imagePath);
});
