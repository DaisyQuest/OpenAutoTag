import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";
import { parsePdf } from "../../modules/parser/index.js";
import { buildSourceTextMap } from "../../scripts/build-source-text-map.js";

test("source text map aligns parser blocks with source text runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "source-text-map-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const layoutPath = path.join(tempDir, "layout.json");
  const outputPath = path.join(tempDir, "source-text-map.json");

  await createSamplePdf(pdfPath);
  const layout = await parsePdf(pdfPath);
  await writeFile(layoutPath, JSON.stringify(layout, null, 2));

  const result = await buildSourceTextMap({ pdfPath, layoutPath, outputPath });
  const persisted = JSON.parse(await readFile(outputPath, "utf8"));

  assert.equal(result.status, "completed");
  assert.equal(result.summary.totalBlocks, 5);
  assert.equal(result.summary.matchedBlocks, 5);
  assert.equal(result.summary.unmatchedBlocks, 0);
  assert.equal(result.summary.totalRuns, 5);
  assert.equal(result.summary.unmatchedRuns, 0);
  assert.equal(result.summary.exactTextMatches, 5);
  assert.equal(
    result.blockMappings.every((mapping) => mapping.status === "matched" && mapping.confidence >= 0.9),
    true
  );
  assert.equal(persisted.summary.matchedBlocks, 5);
});
