import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPipeline } from "../../orchestrator/pipeline-runner.js";

function countBy(items, keyFn) {
  return items.reduce((counts, item) => {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

test("bad1.pdf is tagged without chart/table false positives or sparse table misses", async (t) => {
  const pdfPath = path.resolve("test/fixtures/badcases/bad1.pdf");

  try {
    await access(pdfPath);
  } catch {
    t.skip("bad1.pdf fixture is not available in this checkout");
    return;
  }

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "bad1-pipeline-test-"));
  const job = await runPipeline({ filePath: pdfPath, outputDir, jobId: "bad1-pipeline-test", profileId: "scientific" });

  const layout = JSON.parse(await readFile(job.artifacts.layoutEnriched, "utf8"));
  const semanticOrdered = JSON.parse(await readFile(job.artifacts.semanticOrdered, "utf8"));
  const tableStructureMap = JSON.parse(await readFile(job.artifacts.tableStructureMap, "utf8"));
  const writerReport = JSON.parse(await readFile(job.artifacts.writerReport, "utf8"));
  const nativeTagPlan = JSON.parse(await readFile(`${job.artifacts.taggedPdf}.auto-probe-tag-plan.json`, "utf8"));
  const validationReport = JSON.parse(await readFile(job.artifacts.validationReport, "utf8"));

  assert.equal(job.status, "completed");
  assert.equal(validationReport.status, "completed");
  assert.equal(validationReport.isCompliant, true);
  assert.equal(validationReport.summary.failedRules, 0);
  assert.equal(validationReport.summary.failedChecks, 0);
  assert.ok(writerReport.totalArtifactWraps > 0);
  assert.ok(writerReport.splitMarkedContentRuns > 0);

  assert.equal(tableStructureMap.summary.detectedTables, 0);
  assert.equal(layout.pages[0].structureSignals.tableCount, 0);
  for (const page of layout.pages.slice(1, 4)) {
    assert.equal(page.structureSignals.tableCount, 0);
    assert.ok(page.textBlocks.some((block) => block.text === "APPROVED" && block.isArtifact));
    assert.ok((countBy(page.textBlocks, (block) => block.blockType).paragraph || 0) > (countBy(page.textBlocks, (block) => block.blockType).heading || 0));
  }

  const page5 = layout.pages[4];
  assert.equal(page5.structureSignals.tableCount, 1);
  assert.equal(page5.structureSignals.vectorTableCount, 0);
  assert.equal(page5.structureSignals.sparseNumericTableCount, 1);
  assert.equal(page5.structureSignals.textGridTableCount, 0);
  assert.equal(page5.structureSignals.borderlessTableCount, 0);
  assert.equal(page5.structureSignals.tableRowCount, 16);
  assert.equal(page5.structureSignals.tableColumnCount, 6);
  assert.equal(page5.structureSignals.tableHeaderRowCount, 1);

  const tableCells = page5.textBlocks.filter((block) => block.tableId);
  assert.deepEqual([...new Set(tableCells.map((block) => block.tableId))], ["table:5:sparse-numeric:1"]);
  assert.equal(tableCells.filter((block) => block.tableRole === "header").length, 6);
  assert.equal(tableCells.filter((block) => block.tableRole === "cell").length, 77);
  assert.ok(tableCells.every((block) => block.tableSource === "sparse-numeric-grid"));
  assert.ok(tableCells.filter((block) => block.tableRole === "cell").every((block) => block.tableColumnSpan === 1));
  assert.deepEqual(
    tableCells
      .filter((block) => block.tableRole === "header")
      .sort((left, right) => left.tableColumnIndex - right.tableColumnIndex)
      .map((block) => [block.tableRowIndex, block.tableColumnIndex, block.tableColumnSpan, block.text]),
    [
      [0, 0, 1, "CF"],
      [0, 1, 1, "Min"],
      [0, 2, 1, "fsw"],
      [0, 3, 1, "Air"],
      [0, 4, 1, "EANx 32%"],
      [0, 5, 1, "EANx 36%"]
    ]
  );
  assert.ok(tableCells.filter((block) => block.tableRole === "header").every((block) => block.synthetic));

  for (const chartLabel of ["Programmers", "Artists", "Days after download", "Inverse usage", "Inverse log usage"]) {
    assert.ok(page5.textBlocks.some((block) => block.text.includes(chartLabel) && !block.tableId));
  }
  const verticalAxisLabels = page5.textBlocks.filter((block) => block.text === "Inverse usage" || block.text === "Inverse log usage");
  assert.equal(verticalAxisLabels.length, 2);
  assert.ok(verticalAxisLabels.every((block) => block.writingMode === "vertical" && block.textRotation === 90));
  assert.ok(page5.textBlocks.some((block) => block.text === "APPROVED" && block.isArtifact && !block.tableId));

  const page5Plan = nativeTagPlan.pages.find((page) => page.pageNumber === 5);
  const tableHeaderNodes = semanticOrdered.nodes
    .filter((node) => node.pageNumber === 5 && node.role === "TH")
    .sort((left, right) => left.tableColumnIndex - right.tableColumnIndex);
  assert.deepEqual(tableHeaderNodes.map((node) => node.text), ["CF", "Min", "fsw", "Air", "EANx 32%", "EANx 36%"]);
  for (const node of tableHeaderNodes) {
    const assignment = page5Plan.assignments.find((item) => item.tagNodeId === `tag:${node.id}`);
    assert.ok(assignment, `missing native assignment for table header ${node.text}`);
    assert.equal(assignment.operators.map((operator) => operator.text).join(""), node.text.replace(/\s+/g, ""));
  }

  const verticalAxisNodes = semanticOrdered.nodes.filter((node) => node.text === "Inverse usage" || node.text === "Inverse log usage");
  assert.equal(verticalAxisNodes.length, 2);
  for (const node of verticalAxisNodes) {
    const assignment = page5Plan.assignments.find((item) => item.tagNodeId === `tag:${node.id}:span`);
    assert.ok(assignment, `missing native assignment for ${node.text}`);
    assert.equal(assignment.operators.map((operator) => operator.text).join(""), node.text.replace(/\s+/g, ""));
  }

  const roleCounts = countBy(semanticOrdered.nodes, (node) => node.role);
  assert.equal(roleCounts.Artifact, 4);
  assert.equal(roleCounts.TH, 6);
  assert.equal(roleCounts.TD, 77);
});
