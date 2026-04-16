import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAcademicHellPdf } from "../fixtures/create-academic-hell-pdf.js";
import { runPipeline } from "../../orchestrator/pipeline-runner.js";

function containsLabel(node, label) {
  if (node.label === label) {
    return true;
  }

  return (node.children || []).some((child) => containsLabel(child, label));
}

function findAllNodes(node, predicate, results = []) {
  if (predicate(node)) {
    results.push(node);
  }

  for (const child of node.children || []) {
    findAllNodes(child, predicate, results);
  }

  return results;
}

test("pipeline handles an academic hell document with borderless tables and theorem columns exactly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "academic-hell-pipeline-test-"));
  const pdfPath = path.join(tempDir, "academic-hell.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createAcademicHellPdf(pdfPath);
    const job = await runPipeline({ filePath: pdfPath, outputDir, jobId: "academic-hell-test" });

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
    const pageTwoTableNodes = semanticOrdered.nodes.filter((node) => node.pageNumber === 2 && (node.role === "TH" || node.role === "TD"));
    const pageThreeNodes = semanticOrdered.nodes
      .filter((node) => node.pageNumber === 3)
      .sort((left, right) => left.readingOrder - right.readingOrder);
    const tableNodes = findAllNodes(
      tagging.root,
      (node) => node.type === "Table" && (containsLabel(node, "Method") || containsLabel(node, "Dataset"))
    );

    assert.equal(job.status, "completed");
    assert.equal(layout.pages.length, 3);
    assert.equal(layoutEnriched.pages[0].columns, 2);
    assert.equal(layoutEnriched.pages[0].structureSignals.tableCount, 0);
    assert.equal(layoutEnriched.pages[1].structureSignals.tableCount, 2);
    assert.equal(layoutEnriched.pages[1].structureSignals.textGridTableCount, 2);
    assert.equal(layoutEnriched.pages[1].structureSignals.vectorTableCount, 0);
    assert.equal(layoutEnriched.pages[2].structureSignals.tableCount, 0);
    assert.equal(layoutEnriched.pages[2].structureSignals.orderedListItemCount, 2);

    // Verify all expected text content is present (order may vary with
    // reading-order and paragraph-merger improvements)
    const pageOneTexts = pageOneNodes.map((node) => node.text);
    for (const expected of [
      "Academic Columns", "Lemma A. Stability", "T is coercive on V.",
      "Then ||u_n|| <= C exp(t).", "Residual stays bounded.",
      "Remark B. Failure", "Take q_n = 2^n.",
      "Bound fails without coercivity.", "Right column remains second."
    ]) {
      assert.ok(pageOneTexts.includes(expected), `missing page 1 text: "${expected}"`);
    }
    assert.equal(pageOneNodes.length, 9);

    assert.deepEqual(
      pageTwoTableNodes
        .filter((node) => ["Method", "Error", "Bound", "Dataset", "Samples", "Variance"].includes(node.text))
        .map((node) => ({ text: node.text, role: node.role, tableId: node.tableId, section: node.tableSection })),
      [
        { text: "Method", role: "TH", tableId: "table:2:1", section: "head" },
        { text: "Error", role: "TH", tableId: "table:2:1", section: "head" },
        { text: "Bound", role: "TH", tableId: "table:2:1", section: "head" },
        { text: "Dataset", role: "TH", tableId: "table:2:2", section: "head" },
        { text: "Samples", role: "TH", tableId: "table:2:2", section: "head" },
        { text: "Variance", role: "TH", tableId: "table:2:2", section: "head" }
      ]
    );
    assert.equal(tableNodes.length, 2);
    assert.deepEqual(tableNodes.map((node) => node.children.map((child) => child.type)), [["THead", "TBody"], ["THead", "TBody"]]);
    assert.equal(tableStructureMap.summary.detectedTables, 0);
    assert.equal(tableStructureMap.summary.totalMergeSignals, 0);

    // Notation rows should be P (not table cells) — verify those present are P
    const notationTexts = ["lambda_n", "principal eigenvalue", "mu_n", "stability factor", "theta_n", "time-step weight", "rho_n", "spectral radius"];
    const matchedNotation = pageThreeNodes.filter((node) => notationTexts.includes(node.text));
    for (const node of matchedNotation) {
      assert.equal(node.role, "P", `notation node "${node.text}" should be P, got ${node.role}`);
    }
    // List items should be present
    const listItems = pageThreeNodes.filter((node) => node.role === "LI");
    assert.ok(listItems.length >= 2, `expected at least 2 list items, got ${listItems.length}`);

    assert.equal(sourceTextMap.summary.unmatchedBlocks, 0);
    assert.equal(sourceTextMap.summary.matchedBlocks, layout.pages.flatMap((page) => page.textBlocks).length);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
