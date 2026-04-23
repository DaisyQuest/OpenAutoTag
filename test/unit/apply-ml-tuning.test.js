import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMlTuning } from "../../scripts/apply-ml-tuning.js";
import { finalizeRoleClassifierModel, trainRoleClassifier } from "../../machine-learning/role-classifier.js";

function createSemanticAndLayout() {
  const layoutDocument = {
    schemaVersion: "1.0.0",
    documentId: "layout-apply-test",
    source: {
      filePath: "apply-test.pdf",
      pageCount: 1
    },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "Application Heading",
            bbox: [72, 64, 430, 30],
            fontSize: 18,
            fontName: "NotoSans-Bold",
            blockType: "heading",
            headingLevel: 1
          },
          {
            id: "b2",
            text: "Application paragraph.",
            bbox: [72, 130, 430, 24],
            fontSize: 10,
            fontName: "NotoSans-Regular",
            blockType: "paragraph"
          }
        ]
      }
    ]
  };
  const semanticDocument = {
    schemaVersion: "1.0.0",
    documentId: "semantic-apply-test",
    source: {
      layoutDocumentId: layoutDocument.documentId,
      filePath: "apply-test.pdf"
    },
    nodes: [
      {
        id: "n1",
        pageNumber: 1,
        sourceBlockId: "b1",
        role: "H1",
        text: "Application Heading",
        bbox: [72, 64, 430, 30],
        headingLevel: 1,
        confidence: 0.95,
        readingOrder: 0
      },
      {
        id: "n2",
        pageNumber: 1,
        sourceBlockId: "b2",
        role: "P",
        text: "Application paragraph.",
        bbox: [72, 130, 430, 24],
        confidence: 0.86,
        readingOrder: 1
      }
    ],
    orderedNodeIds: ["n1", "n2"]
  };

  return { semanticDocument, layoutDocument };
}

test("apply ML tuning loads a trained role model and emits shadow predictions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "apply-ml-tuning-test-"));
  const semanticPath = path.join(tempDir, "semantic.json");
  const layoutPath = path.join(tempDir, "layout.json");
  const modelPath = path.join(tempDir, "role-model.json");
  const tunedPath = path.join(tempDir, "semantic.ml.json");
  const reportPath = path.join(tempDir, "ml-predictions.json");
  const { semanticDocument, layoutDocument } = createSemanticAndLayout();
  const model = finalizeRoleClassifierModel(
    trainRoleClassifier(
      [
        {
          semanticDocument,
          layoutDocument
        }
      ],
      {
        classifierId: "apply-test-role-model",
        trainingDatasetVersion: "apply-test"
      }
    )
  );

  await writeFile(semanticPath, `${JSON.stringify(semanticDocument, null, 2)}\n`);
  await writeFile(layoutPath, `${JSON.stringify(layoutDocument, null, 2)}\n`);
  await writeFile(modelPath, `${JSON.stringify(model, null, 2)}\n`);

  await applyMlTuning({
    semanticPath,
    layoutPath,
    outputPath: tunedPath,
    reportPath,
    classifierId: "apply-test-role-model",
    modelPath,
    mode: "shadow"
  });

  const tuned = JSON.parse(await readFile(tunedPath, "utf8"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));

  assert.equal(tuned.mlTuning.status, "shadow-predictions-emitted");
  assert.equal(tuned.mlTuning.predictionCount, 2);
  assert.equal(report.status, "completed");
  assert.equal(report.model.id, "apply-test-role-model");
  assert.equal(report.source.layoutDocumentId, "layout-apply-test");
  assert.equal(report.predictions.length, 2);
  assert.equal(report.shadowMode.enabled, true);
});
