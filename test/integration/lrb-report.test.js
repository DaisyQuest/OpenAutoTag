import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { generateLrbReport, resolveLrbTestsDirectory } from "../../scripts/generate-lrb-report.js";

test("generate an LRB corpus report from the local LRBTests directory", async (context) => {
  let inputDir;

  try {
    inputDir = await resolveLrbTestsDirectory();
  } catch (error) {
    context.skip(error.message);
    return;
  }

  const result = await generateLrbReport({ inputDir });

  await access(result.summaryPath);
  await access(result.reportPath);

  const summary = JSON.parse(await readFile(result.summaryPath, "utf8"));
  const html = await readFile(result.reportPath, "utf8");

  assert.ok(summary.kpis.totalFiles > 0);
  assert.equal(summary.files.length, summary.kpis.totalFiles);
  assert.ok(Object.hasOwn(summary.kpis, "totalTypedNodeDelta"));
  assert.ok(summary.files.every((file) => Object.hasOwn(file, "typedNodeDelta")));
  assert.match(html, /LRB PDF Processing Report/);
  assert.match(html, /File-by-File Matrix/i);
  assert.match(html, /Typed node delta/i);

  console.log(`LRB report written to ${result.reportPath}`);
});
