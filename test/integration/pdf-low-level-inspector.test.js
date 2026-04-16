import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";
import { writeTaggedArtifacts } from "../../modules/pdf-writer/index.js";
import { inspectPdfLowLevel } from "../../scripts/inspect-pdf-low-level.js";

test("low-level inspector distinguishes source text pages from reconstructed tagged pages", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "low-level-inspector-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "tagged.pdf");

  await createSamplePdf(pdfPath);

  await writeFile(
    tagsPath,
    JSON.stringify({
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
              },
              {
                id: "tag:n-1-2",
                type: "P",
                label: "This paragraph explains the report output.",
                sourceNodeIds: ["n-1-2"],
                children: []
              }
            ]
          }
        ]
      }
    }, null, 2)
  );

  await writeFile(
    semanticPath,
    JSON.stringify({
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
        },
        {
          id: "n-1-2",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "P",
          text: "This paragraph explains the report output.",
          bbox: [72, 100, 220, 12],
          confidence: 0.9,
          readingOrder: 1
        }
      ],
      orderedNodeIds: ["n-1-1", "n-1-2"]
    }, null, 2)
  );

  await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });

  const sourceInspection = await inspectPdfLowLevel({ pdfPath });
  const taggedInspection = await inspectPdfLowLevel({ pdfPath: outputPath });

  assert.equal(sourceInspection.catalog.hasStructTreeRoot, false);
  assert.equal(sourceInspection.pages[0].resources.imageXObjectCount, 0);
  assert.equal(sourceInspection.pages[0].operators.hasTextOperators, true);
  assert.equal(sourceInspection.pages[0].operators.imageDrawCount, 0);

  assert.equal(taggedInspection.catalog.hasStructTreeRoot, true);
  assert.equal(taggedInspection.catalog.hasMarkInfo, true);
  assert.equal(taggedInspection.structureTree.exists, true);
  assert.ok(taggedInspection.structureTree.totalTypedNodes >= 3);
  assert.equal(taggedInspection.pages[0].resources.imageXObjectCount, 1);
  assert.equal(taggedInspection.pages[0].operators.hasMarkedContentOperators, true);
  assert.ok(taggedInspection.pages[0].operators.artifactMarkedContentCount >= 1);
  assert.ok(taggedInspection.pages[0].operators.imageDrawCount >= 1);
  // With Type0/CID overlay fonts (Noto Sans via PDType0Font.load), text in
  // the content stream is CID-encoded. The raw text samples may not contain
  // human-readable ASCII. Instead verify overlay text operators exist.
  assert.ok(
    taggedInspection.pages[0].operators.textSamples.length > 0,
    "tagged page should have text operator samples from the invisible overlay"
  );
});

test("low-level inspector exposes native table attribute samples", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "low-level-table-attrs-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "tagged.pdf");

  await createSamplePdf(pdfPath);

  await writeFile(
    tagsPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "tagging:table-attrs",
      source: { semanticDocumentId: "semantic:table-attrs" },
      root: {
        id: "tag:document",
        type: "Document",
        children: [
          {
            id: "tag:table:1",
            type: "Table",
            children: [
              {
                id: "tag:table:1:head",
                type: "THead",
                children: [
                  {
                    id: "tag:table:1:head:row:0",
                    type: "TR",
                    children: [
                      {
                        id: "tag:n-1-1",
                        type: "TH",
                        label: "Revenue Summary",
                        sourceNodeIds: ["n-1-1"],
                        columnSpan: 2,
                        tableSection: "head",
                        tableSource: "vector-grid",
                        children: []
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    }, null, 2)
  );

  await writeFile(
    semanticPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:table-attrs",
      source: { layoutDocumentId: "layout:table-attrs", filePath: pdfPath },
      nodes: [
        {
          id: "n-1-1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "TH",
          text: "Revenue Summary",
          bbox: [72, 48, 220, 24],
          confidence: 0.96,
          readingOrder: 0,
          tableId: "vector-table:1:1",
          tableRole: "header",
          tableSection: "head",
          tableRowIndex: 0,
          tableColumnIndex: 0,
          tableColumnSpan: 2,
          tableSource: "vector-grid"
        }
      ],
      orderedNodeIds: ["n-1-1"]
    }, null, 2)
  );

  await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });

  const taggedInspection = await inspectPdfLowLevel({ pdfPath: outputPath });
  const tableAttributeSample = taggedInspection.structureTree.attributeSamples.find(
    (sample) => sample.structureType === "TH"
  );

  assert.ok(taggedInspection.structureTree.tableAttributeNodeCount >= 1);
  assert.equal(taggedInspection.structureTree.typeCounts.THead, 1);
  assert.equal(tableAttributeSample.colSpan, 2);
  assert.equal(tableAttributeSample.rowSpan, 1);
  assert.equal(tableAttributeSample.scope, "Column");
});
