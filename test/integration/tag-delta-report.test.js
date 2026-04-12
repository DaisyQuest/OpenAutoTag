import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";
import { writeTaggedArtifacts } from "../../modules/pdf-writer/index.js";
import { buildTagDeltaReport } from "../../scripts/build-tag-delta-report.js";

test("tag delta report compares source and tagged PDF structure signals", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tag-delta-report-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "tagged.pdf");

  await createSamplePdf(pdfPath);

  await writeFile(
    tagsPath,
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        documentId: "tagging:sample",
        source: { semanticDocumentId: "semantic:sample" },
        root: {
          id: "tag:document",
          type: "Document",
          children: [
            {
              id: "tag:section:n-1-1",
              type: "Sect",
              children: [
                {
                  id: "tag:n-1-1",
                  type: "H1",
                  label: "Accessibility Report",
                  sourceNodeIds: ["n-1-1"],
                  children: []
                }
              ]
            }
          ]
        }
      },
      null,
      2
    )
  );

  await writeFile(
    semanticPath,
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        documentId: "semantic:sample",
        source: { layoutDocumentId: "layout:sample", filePath: pdfPath },
        nodes: [
          {
            id: "n-1-1",
            pageNumber: 1,
            sourceBlockId: "b1",
            role: "H1",
            text: "Accessibility Report",
            bbox: [72, 48, 220, 24],
            confidence: 0.9,
            readingOrder: 0
          }
        ],
        orderedNodeIds: ["n-1-1"]
      },
      null,
      2
    )
  );

  await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });
  const report = await buildTagDeltaReport({ sourcePdf: pdfPath, taggedPdf: outputPath });

  assert.equal(report.status, "completed");
  assert.equal(report.delta.structTreeAdded, true);
  assert.ok(report.delta.totalTypedNodesDelta > 0);
  assert.ok(report.delta.markedContentOperatorCountDelta > 0);
  assert.equal(report.perPage.length, 1);
});
