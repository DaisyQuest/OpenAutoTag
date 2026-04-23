import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trainRoleClassifierFromArtifacts } from "../../machine-learning/train-role-classifier.js";
import {
  ROLE_CLASSIFIER_MODEL_TYPE,
  buildFeatureContext,
  buildMlPredictionDocument,
  createPredictionEntries,
  evaluateRoleClassifier,
  finalizeRoleClassifierModel,
  predictRole,
  trainRoleClassifier
} from "../../machine-learning/role-classifier.js";

function createFixtureDocument(documentId, { titleText = "Annual Report", bodyText = "The report body explains the finding." } = {}) {
  const layoutDocument = {
    schemaVersion: "1.0.0",
    documentId: `layout-${documentId}`,
    source: {
      filePath: `${documentId}.pdf`,
      pageCount: 1
    },
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        textBlocks: [
          {
            id: `${documentId}-b1`,
            text: titleText,
            bbox: [72, 64, 430, 30],
            fontSize: 18,
            fontName: "NotoSans-Bold",
            blockType: "heading",
            headingLevel: 1
          },
          {
            id: `${documentId}-b2`,
            text: bodyText,
            bbox: [72, 140, 430, 42],
            fontSize: 10,
            fontName: "NotoSans-Regular",
            blockType: "paragraph"
          },
          {
            id: `${documentId}-b3`,
            text: "- First bullet",
            bbox: [90, 205, 260, 20],
            fontSize: 10,
            fontName: "NotoSans-Regular",
            blockType: "list-item"
          }
        ]
      }
    ]
  };
  const semanticDocument = {
    schemaVersion: "1.0.0",
    documentId: `semantic-${documentId}`,
    source: {
      layoutDocumentId: layoutDocument.documentId,
      filePath: `${documentId}.pdf`
    },
    nodes: [
      {
        id: `${documentId}-n1`,
        pageNumber: 1,
        sourceBlockId: `${documentId}-b1`,
        role: "H1",
        text: titleText,
        bbox: [72, 64, 430, 30],
        headingLevel: 1,
        confidence: 0.95,
        readingOrder: 0
      },
      {
        id: `${documentId}-n2`,
        pageNumber: 1,
        sourceBlockId: `${documentId}-b2`,
        role: "P",
        text: bodyText,
        bbox: [72, 140, 430, 42],
        confidence: 0.88,
        readingOrder: 1
      },
      {
        id: `${documentId}-n3`,
        pageNumber: 1,
        sourceBlockId: `${documentId}-b3`,
        role: "LI",
        text: "- First bullet",
        bbox: [90, 205, 260, 20],
        confidence: 0.91,
        readingOrder: 2
      }
    ],
    orderedNodeIds: [`${documentId}-n1`, `${documentId}-n2`, `${documentId}-n3`]
  };

  return {
    semanticDocument,
    layoutDocument,
    sourcePath: `${documentId}.pdf`
  };
}

async function writeArtifactDocument(artifactsDir, document, dirName = document.semanticDocument.documentId) {
  const jobDir = path.join(artifactsDir, dirName);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "04-semantic-ordered.json"), `${JSON.stringify(document.semanticDocument, null, 2)}\n`);
  await writeFile(path.join(jobDir, "02-layout-enriched.json"), `${JSON.stringify(document.layoutDocument, null, 2)}\n`);
}

test("role classifier trains, predicts, and emits draft ML prediction evidence", () => {
  const documents = [
    createFixtureDocument("a"),
    createFixtureDocument("b", { titleText: "Quarterly Filing", bodyText: "This filing contains multiple sections." })
  ];
  const model = finalizeRoleClassifierModel(
    trainRoleClassifier(documents, {
      classifierId: "unit-role-model",
      trainingDatasetVersion: "unit"
    })
  );

  assert.equal(model.modelType, ROLE_CLASSIFIER_MODEL_TYPE);
  assert.match(model.modelHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(model.classes, ["H1", "LI", "P"]);

  const evaluation = evaluateRoleClassifier(model, documents);
  assert.equal(evaluation.exampleCount, 6);
  assert.ok(evaluation.accuracy >= evaluation.majorityBaseline.accuracy);

  const context = buildFeatureContext(documents[0]);
  const prediction = predictRole(model, documents[0].semanticDocument.nodes[0], context);
  assert.equal(prediction.label, "H1");
  assert.ok(prediction.confidence > 0.5);

  const entries = createPredictionEntries({
    semanticDocument: documents[0].semanticDocument,
    layoutDocument: documents[0].layoutDocument,
    model
  });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].taskHead, "role-classification");
  assert.equal(entries[0].contractProjection.status, "semantic-compatible");

  const predictionDocument = buildMlPredictionDocument({
    semanticDocument: documents[0].semanticDocument,
    layoutDocument: documents[0].layoutDocument,
    model,
    predictions: entries,
    semanticPath: "semantic.json",
    outputPath: "semantic.ml.json"
  });
  assert.equal(predictionDocument.source.layoutDocumentId, "layout-a");
  assert.equal(predictionDocument.model.trainingDatasetVersion, "unit");
  assert.equal(predictionDocument.shadowMode.enabled, true);
});

test("role classifier training CLI helper writes model, report, and model card from artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-classifier-training-test-"));
  const artifactsDir = path.join(tempDir, "jobs");
  const modelPath = path.join(tempDir, "model.json");
  const reportPath = path.join(tempDir, "report.json");
  const modelCardPath = path.join(tempDir, "model-card.md");

  for (const document of [
    createFixtureDocument("train-a"),
    createFixtureDocument("train-b", {
      titleText: "Quarterly Filing",
      bodyText: "This filing contains multiple sections."
    })
  ]) {
    await writeArtifactDocument(artifactsDir, document);
  }

  const result = await trainRoleClassifierFromArtifacts({
    artifactsDir,
    modelPath,
    reportPath,
    modelCardPath,
    classifierId: "artifact-role-model",
    datasetVersion: "artifact-unit",
    trainRatio: 0.5
  });

  assert.equal(result.model.classifierId, "artifact-role-model");
  assert.match(result.model.modelHash, /^[a-f0-9]{64}$/);

  const writtenModel = JSON.parse(await readFile(modelPath, "utf8"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const modelCard = await readFile(modelCardPath, "utf8");

  assert.equal(writtenModel.trainingDatasetVersion, "artifact-unit");
  assert.equal(report.input.documentCount, 2);
  assert.equal(report.releaseGateStatus.assistiveOutputAllowed, false);
  assert.match(modelCard, /Research-only and shadow-mode/);
});

test("role classifier training helper loads multiple roots and deduplicates repeated semantic artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "role-classifier-multiroot-test-"));
  const artifactsDirA = path.join(tempDir, "jobs-a");
  const artifactsDirB = path.join(tempDir, "jobs-b");
  const modelPath = path.join(tempDir, "model.json");
  const reportPath = path.join(tempDir, "report.json");

  const duplicateDocument = createFixtureDocument("duplicate-a");
  await writeArtifactDocument(artifactsDirA, duplicateDocument, "first-copy");
  await writeArtifactDocument(artifactsDirB, duplicateDocument, "second-copy");
  await writeArtifactDocument(
    artifactsDirB,
    createFixtureDocument("unique-b", {
      titleText: "Compliance Summary",
      bodyText: "This summary contains a distinct paragraph."
    })
  );

  const result = await trainRoleClassifierFromArtifacts({
    artifactsDir: [artifactsDirA, artifactsDirB],
    modelPath,
    reportPath,
    classifierId: "artifact-role-model-multiroot",
    datasetVersion: "artifact-unit-multiroot",
    trainRatio: 0.5
  });

  const report = JSON.parse(await readFile(reportPath, "utf8"));

  assert.equal(result.report.input.documentCount, 2);
  assert.equal(report.input.artifactRoots.length, 2);
  assert.equal(report.input.discoveredArtifactCount, 3);
  assert.equal(report.input.duplicateArtifactCount, 1);
  assert.equal(report.input.semanticArtifacts.length, 2);
  assert.ok(report.input.semanticArtifacts.every((artifact) => artifact.corpusSignature));
});
