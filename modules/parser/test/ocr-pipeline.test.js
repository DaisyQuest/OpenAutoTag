import test from "node:test";
import assert from "node:assert/strict";
import { runOcrPipeline, selectBestOcrCandidate } from "../ocr-pipeline.js";

test("OCR candidate selection prefers the stronger final score", () => {
  const best = selectBestOcrCandidate([
    {
      candidateName: "noisy",
      score: 0.86,
      finalScore: 0.62,
      characterCount: 60,
      wordCount: 10,
      averageConfidence: 98
    },
    {
      candidateName: "stable",
      score: 0.79,
      finalScore: 0.84,
      characterCount: 58,
      wordCount: 10,
      averageConfidence: 93
    }
  ]);

  assert.equal(best.candidateName, "stable");
});

test("OCR pipeline favors consensus-backed candidates across variants", async () => {
  const result = await runOcrPipeline({
    pdfPath: "ignored.pdf",
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792
      }
    ],
    languages: ["eng"],
    renderPageVariants: async () => ({
      status: "completed",
      pages: [
        {
          pageNumber: 1,
          pdfWidth: 612,
          pdfHeight: 792,
          variants: [
            { name: "noisy", dpi: 300, imagePath: "noisy.png", imageWidth: 1000, imageHeight: 1000 },
            { name: "stable-a", dpi: 300, imagePath: "stable-a.png", imageWidth: 1000, imageHeight: 1000 },
            { name: "stable-b", dpi: 300, imagePath: "stable-b.png", imageWidth: 1000, imageHeight: 1000 }
          ]
        }
      ]
    }),
    createRecognizer: async () => ({
      async recognizeVariant(variant) {
        if (variant.name === "noisy") {
          return {
            candidates: [
              {
                candidateName: "noisy/auto",
                variantName: "noisy",
                profileName: "auto",
                preprocessing: "grayscale",
                dpi: 300,
                averageConfidence: 98,
                pageConfidence: 98,
                blockCount: 2,
                wordCount: 4,
                characterCount: 18,
                alphaNumericRatio: 0.35,
                suspiciousCharacterRatio: 0.45,
                repeatedCharacterRatio: 0.15,
                score: 0.78,
                text: "A$$e55 rep0rt ###",
                textBlocks: [
                  {
                    id: "ocr-1",
                    text: "A$$e55 rep0rt ###",
                    bbox: [72, 80, 200, 24],
                    fontSize: 20
                  }
                ]
              }
            ],
            errors: []
          };
        }

        return {
          candidates: [
            {
              candidateName: `${variant.name}/auto`,
              variantName: variant.name,
              profileName: "auto",
              preprocessing: "grayscale",
              dpi: 300,
              averageConfidence: 94,
              pageConfidence: 94,
              blockCount: 2,
              wordCount: 6,
              characterCount: 30,
              alphaNumericRatio: 0.96,
              suspiciousCharacterRatio: 0,
              repeatedCharacterRatio: 0,
              score: 0.74,
              text: "Accessibility Report",
              textBlocks: [
                {
                  id: `${variant.name}-1`,
                  text: "Accessibility Report",
                  bbox: [72, 80, 220, 24],
                  fontSize: 20
                }
              ]
            }
          ],
          errors: []
        };
      },
      async close() {}
    })
  });

  assert.equal(result.status, "completed");
  assert.equal(result.pages[0].selectedCandidate.candidateName, "stable-a/auto");
  const noisyCandidate = result.pages[0].candidates.find((candidate) => candidate.candidateName === "noisy/auto");
  assert.equal(result.pages[0].selectedCandidate.finalScore > noisyCandidate.finalScore, true);
});

test("OCR pipeline preserves partial recognition errors while keeping successful candidates", async () => {
  const result = await runOcrPipeline({
    pdfPath: "ignored.pdf",
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792
      }
    ],
    languages: ["eng"],
    renderPageVariants: async () => ({
      status: "completed",
      pages: [
        {
          pageNumber: 1,
          pdfWidth: 612,
          pdfHeight: 792,
          variants: [
            { name: "working", dpi: 300, imagePath: "working.png", imageWidth: 1000, imageHeight: 1000 },
            { name: "broken", dpi: 300, imagePath: "broken.png", imageWidth: 1000, imageHeight: 1000 }
          ]
        }
      ]
    }),
    createRecognizer: async () => ({
      async recognizeVariant(variant) {
        if (variant.name === "broken") {
          return {
            candidates: [],
            errors: [
              {
                variantName: "broken",
                profileName: "auto",
                message: "simulated OCR failure",
                attempts: 2
              }
            ]
          };
        }

        return {
          candidates: [
            {
              candidateName: "working/auto",
              variantName: "working",
              profileName: "auto",
              preprocessing: "grayscale",
              dpi: 300,
              averageConfidence: 95,
              pageConfidence: 95,
              blockCount: 1,
              wordCount: 2,
              characterCount: 20,
              alphaNumericRatio: 0.95,
              suspiciousCharacterRatio: 0,
              repeatedCharacterRatio: 0,
              score: 0.73,
              text: "Scanned heading",
              textBlocks: [
                {
                  id: "ocr-1",
                  text: "Scanned heading",
                  bbox: [72, 84, 180, 28],
                  fontSize: 24
                }
              ]
            }
          ],
          errors: []
        };
      },
      async close() {}
    })
  });

  assert.equal(result.status, "completed");
  assert.equal(result.pages[0].textBlocks.length, 1);
  assert.equal(result.pages[0].errors.length, 1);
  assert.match(result.pages[0].errors[0].message, /simulated OCR failure/);
});
