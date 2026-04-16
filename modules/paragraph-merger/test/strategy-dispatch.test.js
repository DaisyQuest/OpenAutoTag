import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { mergeWithStrategy, mergeParagraphs } from "../index.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helper: build a multi-line semantic document with many P lines
// ---------------------------------------------------------------------------
function makeMultiLineDoc(lineCount = 30) {
  const nodes = [];
  for (let i = 0; i < lineCount; i++) {
    nodes.push({
      id: `n${i}`,
      role: "P",
      pageNumber: 1,
      sourceBlockId: `sb${i}`,
      confidence: 0.95,
      bbox: [72, 80 + i * 14, 468, 12],
      text: `This is line number ${i} of the test document that continues flowing`
    });
  }
  // Add a couple of non-P nodes
  nodes.push({
    id: "h1",
    role: "H1",
    pageNumber: 1,
    sourceBlockId: "sbh1",
    confidence: 0.99,
    bbox: [72, 40, 468, 20],
    text: "Document Title"
  });
  return {
    schemaVersion: "1.0.0",
    documentId: "test-doc-001",
    source: { layoutDocumentId: "layout-001" },
    pages: [{ pageNumber: 1, width: 612, height: 792 }],
    nodes
  };
}

// ---------------------------------------------------------------------------
// mergeWithStrategy — strategy dispatch
// ---------------------------------------------------------------------------
describe("mergeWithStrategy — strategy dispatch", () => {
  it("strategy='text-structure' produces >70% P-line reduction on a multi-line doc", () => {
    const doc = makeMultiLineDoc(30);
    const pLinesBefore = doc.nodes.filter((n) => n.role === "P").length;

    const { document, report } = mergeWithStrategy(doc, { strategy: "text-structure" });

    const pLinesAfter = document.nodes.filter((n) => n.role === "P").length;
    const reduction = ((pLinesBefore - pLinesAfter) / pLinesBefore) * 100;

    assert.ok(reduction > 70, `Expected >70% P-line reduction, got ${reduction.toFixed(1)}%`);
    assert.ok(report, "Should return a report");
    assert.ok(report.summary, "Report should have a summary");
  });

  it("strategy='pairwise' produces the same output as mergeParagraphs", () => {
    const doc = makeMultiLineDoc(10);

    const pairwiseResult = mergeWithStrategy(doc, { strategy: "pairwise" });
    const directResult = mergeParagraphs(doc);

    // Same number of output nodes
    assert.equal(
      pairwiseResult.document.nodes.length,
      directResult.document.nodes.length,
      "Node count should match between pairwise strategy and direct mergeParagraphs"
    );

    // Same text content
    const pairwiseTexts = pairwiseResult.document.nodes.map((n) => n.text).sort();
    const directTexts = directResult.document.nodes.map((n) => n.text).sort();
    assert.deepEqual(pairwiseTexts, directTexts);
  });

  it("strategy='disabled' passes through unchanged", () => {
    const doc = makeMultiLineDoc(10);
    const originalNodeCount = doc.nodes.length;

    const { document, report } = mergeWithStrategy(doc, { strategy: "disabled" });

    assert.equal(document.nodes.length, originalNodeCount, "Node count should be unchanged");
    assert.equal(report.summary.totalNodesOut, originalNodeCount);
    assert.equal(report.summary.reductionPercent, "0.0");
  });

  it("enabled=false always passes through regardless of strategy", () => {
    const doc = makeMultiLineDoc(10);
    const originalNodeCount = doc.nodes.length;

    const { document } = mergeWithStrategy(doc, { enabled: false, strategy: "text-structure" });

    assert.equal(document.nodes.length, originalNodeCount, "Should passthrough when enabled=false");
  });

  it("default strategy (no strategy specified) uses text-structure", () => {
    const doc = makeMultiLineDoc(30);
    const pLinesBefore = doc.nodes.filter((n) => n.role === "P").length;

    const { document, report } = mergeWithStrategy(doc, {});

    const pLinesAfter = document.nodes.filter((n) => n.role === "P").length;
    const reduction = ((pLinesBefore - pLinesAfter) / pLinesBefore) * 100;

    // text-structure should produce >70% reduction; pairwise would typically produce less
    assert.ok(reduction > 70, `Default strategy should behave like text-structure, got ${reduction.toFixed(1)}% reduction`);
    assert.equal(report.strategy, "text-structure-merge", "Report should indicate text-structure strategy");
  });

  it("throws on unknown strategy", () => {
    const doc = makeMultiLineDoc(5);

    assert.throws(
      () => mergeWithStrategy(doc, { strategy: "unknown-strategy" }),
      /Unknown paragraph-merger strategy/
    );
  });
});

// ---------------------------------------------------------------------------
// CLI --strategy flag
// ---------------------------------------------------------------------------
describe("CLI --strategy flag", () => {
  const cliPath = path.resolve("modules/paragraph-merger/index.js");

  it("--strategy text-structure flag works", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-"));
    const inputPath = path.join(tmpDir, "input.json");
    const outputPath = path.join(tmpDir, "output.json");

    const doc = makeMultiLineDoc(20);
    await writeFile(inputPath, JSON.stringify(doc));

    try {
      await execFileAsync("node", [cliPath, inputPath, outputPath, "--strategy", "text-structure"]);
      const output = JSON.parse(await readFile(outputPath, "utf8"));
      const pLinesAfter = output.nodes.filter((n) => n.role === "P").length;
      const pLinesBefore = doc.nodes.filter((n) => n.role === "P").length;
      const reduction = ((pLinesBefore - pLinesAfter) / pLinesBefore) * 100;
      assert.ok(reduction > 70, `CLI text-structure should get >70% reduction, got ${reduction.toFixed(1)}%`);
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  });

  it("--strategy disabled passes through", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-"));
    const inputPath = path.join(tmpDir, "input.json");
    const outputPath = path.join(tmpDir, "output.json");

    const doc = makeMultiLineDoc(10);
    await writeFile(inputPath, JSON.stringify(doc));

    try {
      await execFileAsync("node", [cliPath, inputPath, outputPath, "--strategy", "disabled"]);
      const output = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(output.nodes.length, doc.nodes.length, "disabled strategy should passthrough");
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  });

  it("default (no --strategy flag) uses text-structure", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-"));
    const inputPath = path.join(tmpDir, "input.json");
    const outputPath = path.join(tmpDir, "output.json");

    const doc = makeMultiLineDoc(20);
    await writeFile(inputPath, JSON.stringify(doc));

    try {
      await execFileAsync("node", [cliPath, inputPath, outputPath]);
      const output = JSON.parse(await readFile(outputPath, "utf8"));
      const pLinesAfter = output.nodes.filter((n) => n.role === "P").length;
      const pLinesBefore = doc.nodes.filter((n) => n.role === "P").length;
      const reduction = ((pLinesBefore - pLinesAfter) / pLinesBefore) * 100;
      assert.ok(reduction > 70, `Default should use text-structure (>70% reduction), got ${reduction.toFixed(1)}%`);
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  });

  it("--strategy flag overrides config file strategy", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-"));
    const inputPath = path.join(tmpDir, "input.json");
    const outputPath = path.join(tmpDir, "output.json");
    const configPath = path.join(tmpDir, "config.json");

    const doc = makeMultiLineDoc(10);
    await writeFile(inputPath, JSON.stringify(doc));
    // Config says pairwise, but CLI flag says disabled
    await writeFile(configPath, JSON.stringify({ strategy: "pairwise" }));

    try {
      await execFileAsync("node", [cliPath, inputPath, outputPath, "--config", configPath, "--strategy", "disabled"]);
      const output = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(output.nodes.length, doc.nodes.length, "--strategy flag should override config file");
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
      await unlink(configPath).catch(() => {});
    }
  });
});
