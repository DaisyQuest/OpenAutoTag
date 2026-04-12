import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBrokenRuledTableSamplePdf } from "../fixtures/create-broken-ruled-table-sample-pdf.js";
import { createRuledTableSamplePdf } from "../fixtures/create-ruled-table-sample-pdf.js";
import { parsePdf } from "../../modules/parser/index.js";
import { analyzeLayout } from "../../modules/layout-analyzer/index.js";
import { buildTableStructureMap } from "../../scripts/build-table-structure-map.js";

test("table structure map detects ruled tables and merged header spans", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "table-structure-map-test-"));
  const pdfPath = path.join(tempDir, "ruled-table.pdf");
  const layoutPath = path.join(tempDir, "layout-enriched.json");
  const outputPath = path.join(tempDir, "table-structure-map.json");

  await createRuledTableSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath);
  await writeFile(path.join(tempDir, "layout.json"), JSON.stringify(layout, null, 2));
  const enriched = await analyzeLayout(path.join(tempDir, "layout.json"));
  await writeFile(layoutPath, JSON.stringify(enriched, null, 2));

  const result = await buildTableStructureMap({ pdfPath, layoutPath, outputPath });
  const persisted = JSON.parse(await readFile(outputPath, "utf8"));
  const [table] = result.pages[0].tables;

  assert.equal(result.status, "completed");
  assert.equal(result.summary.detectedTables, 1);
  assert.equal(result.summary.pagesWithTables, 1);
  assert.equal(table.rowCount, 3);
  assert.equal(table.columnCount, 2);
  assert.ok(table.mergeSignals.some((signal) => signal.kind === "colspan" && signal.rowIndex === 0));
  assert.ok(table.cells.some((cell) => cell.rowIndex === 0 && cell.columnIndex === 0 && cell.columnSpan === 2));
  assert.ok(table.assignedBlockIds.length >= 5);
  assert.equal(persisted.summary.totalMergeSignals, result.summary.totalMergeSignals);
});

test("table structure map tolerates small gaps in ruled borders", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "table-structure-broken-test-"));
  const pdfPath = path.join(tempDir, "broken-ruled-table.pdf");
  const layoutPath = path.join(tempDir, "layout-enriched.json");

  await createBrokenRuledTableSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath);
  await writeFile(path.join(tempDir, "layout.json"), JSON.stringify(layout, null, 2));
  const enriched = await analyzeLayout(path.join(tempDir, "layout.json"));
  await writeFile(layoutPath, JSON.stringify(enriched, null, 2));

  const result = await buildTableStructureMap({ pdfPath, layoutPath });
  const [table] = result.pages[0].tables;

  assert.equal(result.summary.detectedTables, 1);
  assert.equal(table.rowCount, 3);
  assert.equal(table.columnCount, 2);
  assert.ok(table.mergeSignals.some((signal) => signal.kind === "colspan" && signal.rowIndex === 0));
});
