import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHumanReviewProject, findPredictionReportFiles } from "../../machine-learning/human-review-store.js";
import { createHumanReviewServer } from "../../machine-learning/human-review-server.js";
import { buildHumanReviewSampleSvg } from "../../machine-learning/human-review-visuals.js";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";

function createSemanticDocument(semanticPath, { pdfPath = "review-fixture.pdf" } = {}) {
  return {
    schemaVersion: "1.0.0",
    documentId: "semantic-review-fixture",
    source: {
      layoutDocumentId: "layout-review-fixture",
      filePath: pdfPath
    },
    nodes: [
      {
        id: "n1",
        pageNumber: 1,
        sourceBlockId: "b1",
        role: "P",
        text: "This paragraph should be reviewed by a human.",
        bbox: [72, 120, 300, 42],
        confidence: 0.9,
        readingOrder: 0
      }
    ],
    orderedNodeIds: ["n1"],
    semanticPath
  };
}

function createPredictionReport(semanticPath, { pdfPath = "review-fixture.pdf" } = {}) {
  return {
    schemaVersion: "0.1.0-draft",
    status: "completed",
    documentId: "semantic-review-fixture",
    source: {
      filePath: pdfPath,
      semanticPath
    },
    model: {
      id: "unit-review-model",
      modelHash: "a".repeat(64),
      trainingDatasetVersion: "unit"
    },
    predictions: [
      {
        id: "role-n1",
        taskHead: "role-classification",
        target: {
          sourceNodeId: "n1",
          sourceBlockId: "b1",
          pageNumber: 1,
          bbox: [72, 120, 300, 42]
        },
        prediction: {
          label: "P",
          alternatives: [
            { label: "P", confidence: 0.92 },
            { label: "H1", confidence: 0.08 }
          ]
        },
        confidence: 0.92,
        calibratedConfidence: 0.9,
        deterministicDecision: "P",
        finalDecision: "P",
        fallbackReason: "shadow-mode"
      }
    ]
  };
}

test("human review project loads ML predictions, joins semantic text, and records button decisions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "human-review-store-test-"));
  const semanticPath = path.join(tempDir, "04-semantic-ordered.json");
  const reportPath = path.join(tempDir, "04b-ml-predictions.json");
  const labelPath = path.join(tempDir, "reviews.jsonl");

  await writeFile(semanticPath, `${JSON.stringify(createSemanticDocument(semanticPath), null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(createPredictionReport(semanticPath), null, 2)}\n`);

  const reportFiles = await findPredictionReportFiles(tempDir);
  assert.deepEqual(reportFiles, [reportPath]);

  const project = await createHumanReviewProject({
    reports: tempDir,
    labelPath
  });

  const queue = project.listItems({ status: "unreviewed" });
  assert.equal(queue.total, 1);
  assert.match(queue.items[0].text, /reviewed by a human/);

  const record = await project.recordReview({
    itemKey: queue.items[0].itemKey,
    decision: "yes",
    notes: "Clear paragraph evidence."
  });

  assert.equal(record.decision, "yes");
  assert.equal(record.acceptedLabel, "P");
  assert.match(record.notesForAgents, /paragraph evidence/);
  assert.equal(project.summary().reviewedItems, 1);
  assert.equal(project.summary().notesForAgents, 1);
  assert.equal(project.listItems({ status: "unreviewed" }).total, 0);
  assert.match(await readFile(labelPath, "utf8"), /Clear paragraph evidence/);
});

test("human review project rejects invalid decisions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "human-review-invalid-test-"));
  const semanticPath = path.join(tempDir, "04-semantic-ordered.json");
  const reportPath = path.join(tempDir, "04b-ml-predictions.json");

  await mkdir(tempDir, { recursive: true });
  await writeFile(semanticPath, `${JSON.stringify(createSemanticDocument(semanticPath), null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(createPredictionReport(semanticPath), null, 2)}\n`);

  const project = await createHumanReviewProject({
    reports: tempDir,
    labelPath: path.join(tempDir, "reviews.jsonl")
  });
  const item = project.listItems({ status: "unreviewed" }).items[0];

  await assert.rejects(
    () => project.recordReview({ itemKey: item.itemKey, decision: "maybe" }),
    /decision must be one of/
  );
});

test("human review visual sample endpoint draws the target bbox for reviewers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "human-review-visual-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const semanticPath = path.join(tempDir, "04-semantic-ordered.json");
  const reportPath = path.join(tempDir, "04b-ml-predictions.json");

  await createSamplePdf(pdfPath);
  await writeFile(semanticPath, `${JSON.stringify(createSemanticDocument(semanticPath, { pdfPath }), null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(createPredictionReport(semanticPath, { pdfPath }), null, 2)}\n`);

  const project = await createHumanReviewProject({
    reports: reportPath,
    labelPath: path.join(tempDir, "reviews.jsonl")
  });
  const item = project.listItems({ status: "unreviewed" }).items[0];
  const svg = await buildHumanReviewSampleSvg(item);

  assert.match(svg, /<svg /);
  assert.match(svg, /class="target"/);
  assert.match(svg, /This paragraph should be/);
  assert.match(svg, /reviewed by a human/);

  const server = await createHumanReviewServer({
    reports: reportPath,
    labelPath: path.join(tempDir, "reviews.jsonl"),
    rasterCacheDir: path.join(tempDir, "raster-cache")
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/items/${encodeURIComponent(item.itemKey)}/sample.svg`);
    const body = await response.text();
    const pngResponse = await fetch(`${baseUrl}/api/items/${encodeURIComponent(item.itemKey)}/page.png`);
    const pngBytes = new Uint8Array(await pngResponse.arrayBuffer());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(body, /Selected sample/);
    assert.match(body, /class="target"/);
    assert.match(body, /data:image\/png;base64/);
    assert.equal(pngResponse.status, 200);
    assert.match(pngResponse.headers.get("content-type"), /image\/png/);
    assert.deepEqual([...pngBytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
