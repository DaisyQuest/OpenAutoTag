import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHellishPdf } from "../fixtures/create-hellish-pdf.js";
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

function containsLabel(node, label) {
  if (node.label === label) {
    return true;
  }

  return (node.children || []).some((child) => containsLabel(child, label));
}

function findFirstNode(node, predicate) {
  if (predicate(node)) {
    return node;
  }

  for (const child of node.children || []) {
    const match = findFirstNode(child, predicate);
    if (match) {
      return match;
    }
  }

  return null;
}

test("pipeline handles a mathematically generated hell document with exact structural expectations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hellish-pipeline-test-"));
  const pdfPath = path.join(tempDir, "hellish.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createHellishPdf(pdfPath);
    const job = await runPipeline({ filePath: pdfPath, outputDir, jobId: "hellish-test" });

    const [layout, layoutEnriched, semanticOrdered, tagging, sourceTextMap, tableStructureMap] = await Promise.all([
      readFile(job.artifacts.layout, "utf8").then(JSON.parse),
      readFile(job.artifacts.layoutEnriched, "utf8").then(JSON.parse),
      readFile(job.artifacts.semanticOrdered, "utf8").then(JSON.parse),
      readFile(job.artifacts.tagging, "utf8").then(JSON.parse),
      readFile(job.artifacts.sourceTextMap, "utf8").then(JSON.parse),
      readFile(job.artifacts.tableStructureMap, "utf8").then(JSON.parse)
    ]);

    const pageOneNodes = semanticOrdered.nodes
      .filter((node) => node.pageNumber === 1)
      .sort((left, right) => left.readingOrder - right.readingOrder);
    const pageThreeNodes = semanticOrdered.nodes
      .filter((node) => node.pageNumber === 3)
      .sort((left, right) => left.readingOrder - right.readingOrder);
    const mergedHeaderNode = semanticOrdered.nodes.find((node) => node.text === "Weighted Revenue Matrix");
    const mergedHeaderBlock = layoutEnriched.pages[1].textBlocks.find((block) => block.text === "Weighted Revenue Matrix");
    const mergedHeaderTag = findTagByLabel(tagging.root, "Weighted Revenue Matrix");
    const pageTwoTable = findFirstNode(
      tagging.root,
      (node) => node.type === "Table" && containsLabel(node, "Weighted Revenue Matrix")
    );

    assert.equal(job.status, "completed");
    assert.equal(layout.pages.length, 3);
    assert.equal(layoutEnriched.pages[0].columns, 2);
    assert.equal(layoutEnriched.pages[1].structureSignals.vectorTableCount, 1);
    assert.equal(layoutEnriched.pages[1].structureSignals.tableHeaderRowCount, 2);
    assert.equal(layoutEnriched.pages[2].structureSignals.tableCount, 0);
    assert.equal(layoutEnriched.pages[2].structureSignals.orderedListItemCount, 2);

    const pageOneTexts = pageOneNodes.map((node) => node.text);
    for (const expected of [
      "Hell Matrix Report",
      "- L alpha: f(x)=x^2+1.", "- L beta: g(t)=sin(t)+3.",
      "- L gamma: h(n)=2*n+5.", "- L delta: limit(k)=42.",
      "- R alpha: area=pi*r^2.", "- R beta: slope=dy/dx.",
      "- R gamma: integral[0,1]=0.5.", "- R delta: matrix rank=2."
    ]) {
      assert.ok(pageOneTexts.includes(expected), `missing page 1 text: "${expected}"`);
    }
    assert.equal(pageOneNodes.length, 9);

    assert.equal(mergedHeaderBlock.tableId, "vector-table:2:1");
    assert.equal(mergedHeaderBlock.tableRole, "header");
    assert.equal(mergedHeaderBlock.tableSection, "head");
    assert.equal(mergedHeaderBlock.tableColumnSpan, 3);
    assert.equal(mergedHeaderNode.role, "TH");
    assert.equal(mergedHeaderNode.tableColumnSpan, 3);
    assert.equal(mergedHeaderNode.tableSection, "head");
    assert.equal(mergedHeaderTag.type, "TH");
    assert.equal(mergedHeaderTag.columnSpan, 3);
    assert.deepEqual(pageTwoTable.children.map((child) => child.type), ["THead", "TBody"]);
    assert.equal(pageTwoTable.children[0].children.length, 2);
    assert.equal(pageTwoTable.children[1].children.length, 3);

    assert.equal(tableStructureMap.summary.detectedTables, 1);
    assert.equal(tableStructureMap.summary.totalMergeSignals, 2);
    assert.equal(tableStructureMap.pages[1].tables[0].cells[0].columnSpan, 3);

    const falseTableTexts = ["Composer", "Ada Lovelace", "Venue", "Albany Hall", "Duration", "47 minutes"];
    const matchedFalseTable = pageThreeNodes.filter((node) => falseTableTexts.includes(node.text));
    for (const node of matchedFalseTable) {
      assert.equal(node.role, "P", `false-table node "${node.text}" should be P, got ${node.role}`);
    }
    const listItems = pageThreeNodes.filter((node) => node.role === "LI");
    assert.ok(listItems.length >= 2, `expected at least 2 list items, got ${listItems.length}`);

    assert.equal(sourceTextMap.summary.unmatchedBlocks, 0);
    assert.equal(sourceTextMap.summary.matchedBlocks, layout.pages.flatMap((page) => page.textBlocks).length);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
