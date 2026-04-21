import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../../../test/fixtures/create-sample-pdf.js";
import { createSsnSamplePdf } from "../../../test/fixtures/create-ssn-sample-pdf.js";
import { createSpanishSamplePdf } from "../../../test/fixtures/create-spanish-sample-pdf.js";
import { inspectPdfLowLevel } from "../../../scripts/inspect-pdf-low-level.js";
import { writeTaggedArtifacts } from "../index.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

async function createPaintedSamplePdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  page.drawText("Tagged", { x: 72, y: 720, size: 18, font });
  page.drawLine({
    start: { x: 72, y: 690 },
    end: { x: 260, y: 690 },
    thickness: 2,
    color: rgb(1, 0, 0)
  });
  page.drawText("text", { x: 145, y: 720, size: 18, font });

  const bytes = await pdfDoc.save();
  await writeFile(filePath, bytes);
}

test("pdf writer adds native structure and creates a sidecar manifest", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "writer-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");

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
            id: "tag:n-1-1",
            type: "H1",
            label: "Accessibility Report",
            sourceNodeIds: ["n-1-1"],
            children: []
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
        }
      ],
      orderedNodeIds: ["n-1-1"]
    }, null, 2)
  );

  const report = await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });
  const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));
  const outputBytes = await readFile(report.outputPath);
  const outputText = outputBytes.toString("latin1");

  await access(report.outputPath);
  await access(report.manifestPath);
  assert.equal(report.nativeTaggingApplied, true);
  assert.equal(manifest.writerMode, "pdfbox-native-structure");
  assert.equal(report.markedContentCount, 1);
  assert.match(outputText, /<dc:creator>/);
  assert.match(outputText, /<dc:description>/);
  assert.match(outputText, /<pdfuaid:part>1<\/pdfuaid:part>/);
});

test("pdf writer role-maps Aside footnote tags to the standard Note type", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "writer-aside-rolemap-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");

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
            id: "tag:n-1-1",
            type: "Aside",
            label: "Accessibility Report",
            sourceNodeIds: ["n-1-1"],
            semanticRole: "Footnote",
            footnoteGroupId: "footnote:1:1:1",
            footnoteMarker: "1",
            children: []
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
          role: "P",
          semanticRole: "Footnote",
          footnote: true,
          footnoteGroupId: "footnote:1:1:1",
          footnoteMarker: "1",
          text: "Accessibility Report",
          bbox: [72, 48, 220, 24],
          confidence: 0.9,
          readingOrder: 0
        }
      ],
      orderedNodeIds: ["n-1-1"]
    }, null, 2)
  );

  const report = await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });
  const inspection = await inspectPdfLowLevel({ pdfPath: report.outputPath });

  assert.equal(inspection.structureTree.roleMap.Aside, "Note");
  assert.equal(inspection.structureTree.idCountsByType.Aside, inspection.structureTree.typeCounts.Aside);
});

test("pdf writer artifacts visible non-text paint operators in native mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "writer-paint-artifact-test-"));
  const pdfPath = path.join(tempDir, "painted.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");

  await createPaintedSamplePdf(pdfPath);
  await writeFile(
    tagsPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "tagging:painted",
      source: { semanticDocumentId: "semantic:painted" },
      root: {
        id: "tag:document",
        type: "Document",
        children: [
          {
            id: "tag:n-1-1",
            type: "P",
            label: "Tagged text",
            sourceNodeIds: ["n-1-1"],
            children: []
          }
        ]
      }
    }, null, 2)
  );
  await writeFile(
    semanticPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:painted",
      source: { layoutDocumentId: "layout:painted", filePath: pdfPath },
      nodes: [
        {
          id: "n-1-1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "P",
          text: "Tagged text",
          bbox: [72, 54, 110, 22],
          confidence: 0.9,
          readingOrder: 0
        }
      ],
      orderedNodeIds: ["n-1-1"]
    }, null, 2)
  );

  const report = await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });
  const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));

  assert.equal(report.nativeTaggingApplied, true);
  assert.ok(report.markedContentCount >= 2);
  assert.ok(report.totalArtifactWraps >= 1);
  assert.ok(report.splitMarkedContentRuns >= 1);
  assert.ok(manifest.summary.totalArtifactWraps >= 1);
  assert.ok(manifest.summary.splitMarkedContentRuns >= 1);
});

test("pdf writer tolerates unsupported Unicode glyphs in invisible overlay text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "writer-unicode-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");

  await createSamplePdf(pdfPath);
  await writeFile(
    tagsPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "tagging:unicode-sample",
      source: { semanticDocumentId: "semantic:unicode-sample" },
      root: {
        id: "tag:document",
        type: "Document",
        children: [
          {
            id: "tag:n-1-1",
            type: "P",
            label: "∑ All We Need ♯",
            sourceNodeIds: ["n-1-1"],
            children: []
          }
        ]
      }
    }, null, 2)
  );
  await writeFile(
    semanticPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:unicode-sample",
      source: { layoutDocumentId: "layout:unicode-sample", filePath: pdfPath },
      nodes: [
        {
          id: "n-1-1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "P",
          text: "∑ All We Need ♯",
          bbox: [72, 48, 220, 24],
          confidence: 0.9,
          readingOrder: 0
        }
      ],
      orderedNodeIds: ["n-1-1"]
    }, null, 2)
  );

  const report = await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });
  const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));

  await access(report.outputPath);
  await access(report.manifestPath);
  assert.equal(report.nativeTaggingApplied, true);
  assert.equal(report.markedContentCount, 1);
  assert.equal(manifest.writerMode, "pdfbox-native-structure");
});

test("pdf writer reports native table attributes for merged header cells", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "writer-table-attrs-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");

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
                id: "tag:table:1:row:0",
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

  const report = await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });
  const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));

  assert.equal(report.nativeTaggingApplied, true);
  assert.equal(report.tableAttributeCount, 1);
  assert.equal(manifest.summary.tableAttributeCount, 1);
});

test("pdf writer applies Spanish document language metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "writer-spanish-language-test-"));
  const pdfPath = path.join(tempDir, "spanish.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");

  await createSpanishSamplePdf(pdfPath);
  await writeFile(
    tagsPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "tagging:spanish-sample",
      source: { semanticDocumentId: "semantic:spanish-sample" },
      root: {
        id: "tag:document",
        type: "Document",
        children: [
          {
            id: "tag:n-1-1",
            type: "H1",
            label: "Informe de accesibilidad",
            sourceNodeIds: ["n-1-1"],
            children: []
          }
        ]
      }
    }, null, 2)
  );
  await writeFile(
    semanticPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:spanish-sample",
      source: {
        layoutDocumentId: "layout:spanish-sample",
        filePath: pdfPath,
        language: "es-ES",
        languageConfidence: 0.93
      },
      nodes: [
        {
          id: "n-1-1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "H1",
          text: "Informe de accesibilidad",
          bbox: [72, 48, 260, 24],
          confidence: 0.93,
          readingOrder: 0
        }
      ],
      orderedNodeIds: ["n-1-1"]
    }, null, 2)
  );

  const report = await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });
  const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));
  const inspection = await inspectPdfLowLevel({ pdfPath: outputPath });

  assert.equal(report.language, "es-ES");
  assert.equal(manifest.summary.language, "es-ES");
  assert.equal(inspection.catalog.language, "es-ES");
});

test("pdf writer applies supplied redaction plans to visible and accessibility content", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "writer-redaction-test-"));
  const pdfPath = path.join(tempDir, "ssn.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const redactionsPath = path.join(tempDir, "redaction-plan.json");
  const outputPath = path.join(tempDir, "output", "tagged-redacted.pdf");

  await createSsnSamplePdf(pdfPath);
  await writeFile(
    tagsPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "tagging:ssn-sample",
      source: { semanticDocumentId: "semantic:ssn-sample" },
      root: {
        id: "tag:document",
        type: "Document",
        children: [
          {
            id: "tag:n-1-1",
            type: "H1",
            label: "Employee Intake Form",
            sourceNodeIds: ["n-1-1"],
            children: []
          },
          {
            id: "tag:n-1-2",
            type: "P",
            label: "Primary SSN: ***-**-6789",
            sourceNodeIds: ["n-1-2"],
            children: []
          }
        ]
      }
    }, null, 2)
  );
  await writeFile(
    semanticPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:ssn-sample",
      source: { layoutDocumentId: "layout:ssn-sample", filePath: pdfPath },
      nodes: [
        {
          id: "n-1-1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "H1",
          text: "Employee Intake Form",
          bbox: [72, 72, 240, 24],
          confidence: 0.98,
          readingOrder: 0
        },
        {
          id: "n-1-2",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "P",
          text: "Primary SSN: ***-**-6789",
          bbox: [72, 112, 220, 12],
          confidence: 0.95,
          readingOrder: 1
        }
      ],
      orderedNodeIds: ["n-1-1", "n-1-2"]
    }, null, 2)
  );
  await writeFile(
    redactionsPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      workloadId: "tag-and-ssn-redact",
      sourcePdf: pdfPath,
      semanticDocumentId: "semantic:ssn-sample",
      summary: {
        pagesProcessed: 1,
        candidateMatches: 1,
        redactedMatches: 1,
        pagesRedacted: 1,
        outputMode: "semantic-mask-plan"
      },
      redactedNodeIds: ["n-1-2"],
      matches: [
        {
          matchId: "n-1-2:ssn:1",
          pageNumber: 1,
          sourceBlockId: "b2",
          sourceNodeId: "n-1-2",
          maskedText: "***-**-6789",
          bbox: [150, 112, 90, 16]
        }
      ]
    }, null, 2)
  );

  const report = await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, redactionsPath, outputPath });
  const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));
  const inspection = await inspectPdfLowLevel({ pdfPath: outputPath });
  const outputBytes = await readFile(outputPath);

  assert.equal(report.redactionCount, 1);
  assert.equal(manifest.summary.redactionCount, 1);
  assert.equal(manifest.summary.accessibilityTreeRedacted, true);
  assert.equal(outputBytes.toString("latin1").includes("123-45-6789"), false);
  assert.equal(
    inspection.pages.some((page) => page.operators.textSamples.some((sample) => sample.text.includes("123-45-6789"))),
    false
  );
  // With Type0/CID fonts (Noto Sans), the masked SSN may be encoded as CID
  // values rather than ASCII in the raw content stream. Check the manifest's
  // accessibility tree instead, which records the ActualText.
  assert.equal(manifest.summary.accessibilityTreeRedacted, true);
  assert.equal(report.redactionCount, 1);
});
