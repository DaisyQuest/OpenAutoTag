import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuledTableSamplePdf } from "../fixtures/create-ruled-table-sample-pdf.js";
import { runPipeline } from "../../orchestrator/pipeline-runner.js";

function findTagByLabel(node, label) {
  if (node.label === label) {
    return node;
  }

  for (const child of node.children || []) {
    const match = findTagByLabel(child, label);
    if (match) {
      return match;
    }
  }

  return null;
}

test("pipeline promotes ruled-table diagnostics into enriched layout, semantic roles, and tag spans", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ruled-table-pipeline-test-"));
  const pdfPath = path.join(tempDir, "ruled-table.pdf");
  const outputDir = path.join(tempDir, "output");

  await createRuledTableSamplePdf(pdfPath);
  const job = await runPipeline({ filePath: pdfPath, outputDir, jobId: "ruled-table-test" });

  const layoutEnriched = JSON.parse(await readFile(job.artifacts.layoutEnriched, "utf8"));
  const semanticOrdered = JSON.parse(await readFile(job.artifacts.semanticOrdered, "utf8"));
  const tagging = JSON.parse(await readFile(job.artifacts.tagging, "utf8"));
  const tableStructureMap = JSON.parse(await readFile(job.artifacts.tableStructureMap, "utf8"));

  const mergedHeaderBlock = layoutEnriched.pages[0].textBlocks.find((block) => block.text === "Revenue Summary");
  const mergedHeaderNode = semanticOrdered.nodes.find((node) => node.text === "Revenue Summary");
  const mergedHeaderTag = findTagByLabel(tagging.root, "Revenue Summary");

  assert.equal(job.status, "completed");
  assert.equal(tableStructureMap.summary.detectedTables, 1);
  assert.equal(mergedHeaderBlock.tableId, "vector-table:1:1");
  assert.equal(mergedHeaderBlock.tableRole, "header");
  assert.equal(mergedHeaderBlock.tableColumnSpan, 2);
  assert.equal(mergedHeaderBlock.tableSource, "vector-grid");
  assert.equal(mergedHeaderNode.role, "TH");
  assert.equal(mergedHeaderNode.tableColumnSpan, 2);
  assert.equal(mergedHeaderNode.tableSource, "vector-grid");
  assert.equal(mergedHeaderTag.type, "TH");
  assert.equal(mergedHeaderTag.columnSpan, 2);
});
