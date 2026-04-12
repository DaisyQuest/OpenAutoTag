import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../../../test/fixtures/create-sample-pdf.js";
import { writeTaggedArtifacts } from "../../pdf-writer/index.js";
import { buildTagTree } from "../../tag-builder/index.js";
import { validateTaggedArtifacts } from "../index.js";

function execNode(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

test("validator uses veraPDF to report PDF/UA non-compliance", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "validator-test-"));
  const pdfPath = path.join(tempDir, "tagged.pdf");
  const manifestPath = `${pdfPath}.tags.json`;

  await createSamplePdf(pdfPath);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      writerMode: "sidecar-manifest",
      nativeTaggingApplied: false,
      tagging: {
        schemaVersion: "1.0.0",
        documentId: "tagging:sample",
        source: { semanticDocumentId: "semantic:sample" },
        root: { id: "tag:document", type: "Document", children: [] }
      }
    }, null, 2)
  );

  const report = await validateTaggedArtifacts({ pdfPath, manifestPath });

  assert.equal(report.status, "completed");
  assert.equal(report.isCompliant, false);
  assert.equal(report.engine.name, "veraPDF");
  assert.equal(report.profileName, "PDF/UA-1 validation profile");
  assert.ok(report.findings.length > 0);
});

test("validator suppresses known veraPDF PDFBox metadata false positives", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "validator-metadata-fix-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");
  const writerCliPath = path.resolve("modules", "pdf-writer", "index.js");

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

  await execNode([
    writerCliPath,
    "--pdf",
    pdfPath,
    "--tags",
    tagsPath,
    "--semantic",
    semanticPath,
    "--output",
    outputPath
  ]);

  const report = await validateTaggedArtifacts({
    pdfPath: outputPath,
    manifestPath: `${outputPath}.tags.json`
  });

  assert.equal(report.status, "completed");
  assert.equal(report.isCompliant, true);
  assert.equal(report.findings.length, 0);
  assert.equal(report.summary.failedRules, 0);
  assert.equal(report.summary.failedChecks, 0);
  assert.equal(report.rawSummary.failedRules, 2);
  assert.deepEqual(report.metadataDiagnostics?.suppressedFindingCodes, ["VERAPDF_5_1", "VERAPDF_7_1_9"]);
  assert.equal(report.metadataDiagnostics?.correctedByValidator, true);
});

test("validator accepts automatically normalized heading sequences", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "validator-heading-fix-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const tagsPath = path.join(tempDir, "tagging.json");
  const semanticPath = path.join(tempDir, "semantic.json");
  const outputPath = path.join(tempDir, "output", "tagged.pdf");

  await createSamplePdf(pdfPath);
  await writeFile(
    semanticPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:heading-fix",
      source: { layoutDocumentId: "layout:heading-fix", filePath: pdfPath },
      nodes: [
        {
          id: "n-1-1",
          pageNumber: 1,
          sourceBlockId: "b1",
          role: "H2",
          text: "Accessibility Report",
          bbox: [72, 48, 220, 24],
          confidence: 0.9,
          headingLevel: 2,
          readingOrder: 0
        },
        {
          id: "n-1-2",
          pageNumber: 1,
          sourceBlockId: "b2",
          role: "P",
          text: "Intro paragraph",
          bbox: [72, 84, 260, 18],
          confidence: 0.88,
          readingOrder: 1
        },
        {
          id: "n-1-3",
          pageNumber: 1,
          sourceBlockId: "b3",
          role: "H3",
          text: "Section Details",
          bbox: [72, 120, 180, 20],
          confidence: 0.89,
          headingLevel: 3,
          readingOrder: 2
        },
        {
          id: "n-1-4",
          pageNumber: 1,
          sourceBlockId: "b4",
          role: "P",
          text: "More details",
          bbox: [72, 150, 240, 18],
          confidence: 0.88,
          readingOrder: 3
        }
      ],
      orderedNodeIds: ["n-1-1", "n-1-2", "n-1-3", "n-1-4"]
    }, null, 2)
  );

  const tagging = await buildTagTree(semanticPath);
  await writeFile(tagsPath, JSON.stringify(tagging, null, 2));
  await writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, outputPath });

  const report = await validateTaggedArtifacts({
    pdfPath: outputPath,
    manifestPath: `${outputPath}.tags.json`
  });

  assert.equal(tagging.root.children[0].children[0].type, "H1");
  assert.equal(tagging.root.children[0].children[2].children[0].type, "H2");
  assert.equal(report.status, "completed");
  assert.equal(report.isCompliant, true);
  assert.equal(report.findings.some((finding) => finding.code === "VERAPDF_7_4_2_1"), false);
});
