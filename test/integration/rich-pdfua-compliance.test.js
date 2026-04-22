import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildTagTree } from "../../modules/tag-builder/index.js";
import { writeTaggedArtifacts } from "../../modules/pdf-writer/index.js";
import { validateTaggedArtifacts } from "../../modules/validator/index.js";
import { inspectPdfLowLevel } from "../../scripts/inspect-pdf-low-level.js";

async function createRichSourcePdf(pdfPath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("Quarterly Accessibility Report", { x: 72, y: 720, size: 18, font: boldFont });
  page.drawText("This document verifies rich PDF UA structure.", { x: 72, y: 682, size: 12, font });
  page.drawText("- Keyboard flow verified", { x: 90, y: 644, size: 12, font });
  page.drawText("- Table headers announced", { x: 90, y: 622, size: 12, font });

  page.drawText("Metric", { x: 90, y: 560, size: 12, font: boldFont });
  page.drawText("Value", { x: 270, y: 560, size: 12, font: boldFont });
  page.drawText("Tagged pages", { x: 90, y: 534, size: 12, font });
  page.drawText("1", { x: 270, y: 534, size: 12, font });
  page.drawText("PDF UA status", { x: 90, y: 508, size: 12, font });
  page.drawText("Pass", { x: 270, y: 508, size: 12, font });

  await writeFile(pdfPath, await pdfDoc.save());
}

function createNode({ id, role, text, bbox, readingOrder, table = {} }) {
  return {
    id,
    pageNumber: 1,
    sourceBlockId: `block-${id}`,
    role,
    text,
    bbox,
    confidence: 0.98,
    readingOrder,
    ...table
  };
}

function findTagNode(root, predicate) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.shift();
    if (predicate(node)) return node;
    stack.unshift(...(node.children || []));
  }
  return null;
}

test("native writer emits rich PDF UA compliant list and table tagging", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rich-pdfua-test-"));
  const pdfPath = path.join(tempDir, "rich-source.pdf");
  const semanticPath = path.join(tempDir, "semantic.json");
  const tagsPath = path.join(tempDir, "tagging.json");
  const outputPath = path.join(tempDir, "tagged.pdf");

  await createRichSourcePdf(pdfPath);

  const nodes = [
    createNode({
      id: "heading",
      role: "H1",
      text: "Quarterly Accessibility Report",
      bbox: [72, 48, 360, 26],
      readingOrder: 0
    }),
    createNode({
      id: "intro",
      role: "P",
      text: "This document verifies rich PDF UA structure.",
      bbox: [72, 96, 360, 20],
      readingOrder: 1
    }),
    createNode({
      id: "li-1",
      role: "LI",
      text: "- Keyboard flow verified",
      bbox: [90, 132, 260, 18],
      readingOrder: 2
    }),
    createNode({
      id: "li-2",
      role: "LI",
      text: "- Table headers announced",
      bbox: [90, 154, 280, 18],
      readingOrder: 3
    }),
    createNode({
      id: "th-metric",
      role: "TH",
      text: "Metric",
      bbox: [90, 226, 150, 18],
      readingOrder: 4,
      table: {
        tableGroupId: "rich-table",
        tableSection: "head",
        tableRowIndex: 0,
        tableColumnIndex: 0,
        tableSource: "synthetic-rich-fixture"
      }
    }),
    createNode({
      id: "th-value",
      role: "TH",
      text: "Value",
      bbox: [270, 226, 120, 18],
      readingOrder: 5,
      table: {
        tableGroupId: "rich-table",
        tableSection: "head",
        tableRowIndex: 0,
        tableColumnIndex: 1,
        tableSource: "synthetic-rich-fixture"
      }
    }),
    createNode({
      id: "td-pages-label",
      role: "TD",
      text: "Tagged pages",
      bbox: [90, 252, 150, 18],
      readingOrder: 6,
      table: {
        tableGroupId: "rich-table",
        tableSection: "body",
        tableRowIndex: 1,
        tableColumnIndex: 0,
        tableSource: "synthetic-rich-fixture"
      }
    }),
    createNode({
      id: "td-pages-value",
      role: "TD",
      text: "1",
      bbox: [270, 252, 120, 18],
      readingOrder: 7,
      table: {
        tableGroupId: "rich-table",
        tableSection: "body",
        tableRowIndex: 1,
        tableColumnIndex: 1,
        tableSource: "synthetic-rich-fixture"
      }
    }),
    createNode({
      id: "td-status-label",
      role: "TD",
      text: "PDF UA status",
      bbox: [90, 278, 150, 18],
      readingOrder: 8,
      table: {
        tableGroupId: "rich-table",
        tableSection: "body",
        tableRowIndex: 2,
        tableColumnIndex: 0,
        tableSource: "synthetic-rich-fixture"
      }
    }),
    createNode({
      id: "td-status-value",
      role: "TD",
      text: "Pass",
      bbox: [270, 278, 120, 18],
      readingOrder: 9,
      table: {
        tableGroupId: "rich-table",
        tableSection: "body",
        tableRowIndex: 2,
        tableColumnIndex: 1,
        tableSource: "synthetic-rich-fixture"
      }
    })
  ];

  await writeFile(
    semanticPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      documentId: "semantic:rich-pdfua",
      source: { layoutDocumentId: "layout:rich-pdfua", filePath: pdfPath },
      nodes,
      orderedNodeIds: nodes.map((node) => node.id)
    }, null, 2)
  );

  const tagging = await buildTagTree(semanticPath, {
    enableTableHeaders: true,
    enableLayoutAttrs: true
  });
  await writeFile(tagsPath, JSON.stringify(tagging, null, 2));

  const firstListItem = findTagNode(tagging.root, (node) => node?.type === "LI");
  assert.ok(firstListItem, "tag-builder should emit list item structure");
  assert.deepEqual(firstListItem.children.map((node) => node.type), ["Lbl", "LBody"]);
  assert.deepEqual(firstListItem.children[0].sourceNodeIds, []);
  assert.deepEqual(firstListItem.children[1].sourceNodeIds, ["li-1"]);

  const firstBodyCell = findTagNode(tagging.root, (node) => node?.id?.includes("td-pages-label"));
  assert.deepEqual(firstBodyCell.tableAttrs.Headers, ["H_r0c0"]);

  const writerReport = await writeTaggedArtifacts({
    pdfPath,
    tagsPath,
    semanticPath,
    outputPath,
    mode: "native"
  });
  const validationReport = await validateTaggedArtifacts({
    pdfPath: outputPath,
    manifestPath: writerReport.manifestPath
  });
  const inspection = await inspectPdfLowLevel({ pdfPath: outputPath });

  assert.equal(writerReport.writerMode, "native");
  assert.equal(writerReport.nativeTaggingApplied, true);
  assert.equal(writerReport.matchRate, 1);

  assert.equal(validationReport.status, "completed");
  assert.equal(validationReport.isCompliant, true);
  assert.equal(validationReport.overall.status, "pass");
  assert.equal(validationReport.findings.length, 0);
  assert.equal(validationReport.summary.failedRules, 0);
  assert.equal(validationReport.summary.failedChecks, 0);
  assert.equal(validationReport.fontAudit?.errorCount ?? 0, 0);

  const typeCounts = inspection.structureTree.typeCounts;
  assert.equal(typeCounts.Document, 1);
  assert.equal(typeCounts.H1, 1);
  assert.equal(typeCounts.P, 1);
  assert.equal(typeCounts.L, 1);
  assert.equal(typeCounts.LI, 2);
  assert.equal(typeCounts.Lbl, 2);
  assert.equal(typeCounts.LBody, 2);
  assert.equal(typeCounts.Table, 1);
  assert.equal(typeCounts.THead, 1);
  assert.equal(typeCounts.TBody, 1);
  assert.equal(typeCounts.TH, 2);
  assert.equal(typeCounts.TD, 4);
  assert.ok(typeCounts.Span >= 2);

  const thAttributeSamples = inspection.structureTree.attributeSamples.filter(
    (sample) => sample.structureType === "TH"
  );
  assert.ok(thAttributeSamples.length >= 2);
  assert.ok(thAttributeSamples.every((sample) => sample.scope === "Column"));
  assert.equal(inspection.structureTree.idCountsByType.TH, 2);
  assert.ok(inspection.structureTree.tableAttributeNodeCount >= 6);
});
