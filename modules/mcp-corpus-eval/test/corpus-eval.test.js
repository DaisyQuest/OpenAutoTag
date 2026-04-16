import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readingOrderInversionCount,
  fontEmbedScore,
  veraPdfScore,
  ocrScore,
  paragraphQualityScore,
  computeAggregateScore
} from "../lib/scorers.js";
import { sampleCorpus, scoreJob, diffRuns } from "../lib/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

// ---------------------------------------------------------------------------
// sample_corpus
// ---------------------------------------------------------------------------
describe("sample_corpus", () => {
  it("returns array with expected shape for fixtures dir", async () => {
    // The fixtures dir has JSON files, not PDFs, so we create a temp dir with dummy PDFs
    const tmpDir = path.join(__dirname, "fixtures", "_tmp_pdfs");
    await mkdir(tmpDir, { recursive: true });

    // Create minimal dummy PDF-like files (just need .pdf extension for sampling)
    await writeFile(path.join(tmpDir, "test1.pdf"), "fake-pdf-content-1");
    await writeFile(path.join(tmpDir, "test2.pdf"), "fake-pdf-content-2");
    await writeFile(path.join(tmpDir, "test3.pdf"), "fake-pdf-content-3");
    await writeFile(path.join(tmpDir, "readme.txt"), "not a pdf");

    try {
      const result = await sampleCorpus({ directory: tmpDir, n: 2 });

      assert.ok(result.samples, "result should have samples array");
      assert.ok(Array.isArray(result.samples), "samples should be an array");
      assert.equal(result.samples.length, 2, "should return exactly n=2 samples");

      for (const sample of result.samples) {
        assert.ok(sample.fileName, "sample should have fileName");
        assert.ok(sample.pdfPath, "sample should have pdfPath");
        assert.ok(typeof sample.sizeBytes === "number", "sample should have sizeBytes as number");
        assert.ok(sample.fileName.endsWith(".pdf"), "sample should be a PDF file");
        // pageCount may be null for fake PDFs (pdfjs-dist can't parse them)
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("gracefully skips if directory does not exist", async () => {
    const result = await sampleCorpus({ directory: "/nonexistent/path/xyz", n: 5 });
    assert.ok(result.skipped, "should be skipped");
    assert.deepEqual(result.samples, [], "should return empty samples array");
  });
});

// ---------------------------------------------------------------------------
// score_job — missing artifacts
// ---------------------------------------------------------------------------
describe("score_job", () => {
  it("handles missing artifacts gracefully (returns null for unavailable metrics)", async () => {
    const emptyDir = path.join(__dirname, "fixtures", "_tmp_empty_job");
    await mkdir(emptyDir, { recursive: true });

    try {
      const result = await scoreJob({ jobDir: emptyDir });

      assert.equal(result.veraPdfFindingCount, null, "veraPdfFindingCount should be null");
      assert.equal(result.fontEmbedCoverage, null, "fontEmbedCoverage should be null");
      assert.equal(result.readingOrderInversions, null, "readingOrderInversions should be null");
      assert.equal(result.ocrConfidence, null, "ocrConfidence should be null");
      assert.equal(result.aggregateScore, null, "aggregateScore should be null when no metrics");
      assert.equal(result.groundTruth, null, "groundTruth should be null");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("scores available artifacts from a populated job dir", async () => {
    const jobDir = path.join(__dirname, "fixtures", "_tmp_scored_job");
    await mkdir(jobDir, { recursive: true });

    // Copy fixtures into a simulated job dir
    const { readFile: rf } = await import("node:fs/promises");
    const valReport = await rf(path.join(fixturesDir, "sample-validation-report.json"), "utf8");
    const semOrdered = await rf(path.join(fixturesDir, "sample-semantic-ordered.json"), "utf8");
    const layout = await rf(path.join(fixturesDir, "sample-layout.json"), "utf8");

    await writeFile(path.join(jobDir, "07-validation-report.json"), valReport);
    await writeFile(path.join(jobDir, "04-semantic-ordered.json"), semOrdered);
    await writeFile(path.join(jobDir, "01-layout.json"), layout);

    try {
      const result = await scoreJob({ jobDir });

      assert.equal(result.veraPdfFindingCount, 2, "should count 2 error findings");
      assert.equal(result.readingOrderInversions, 2, "should detect 2 inversions");
      assert.equal(result.ocrConfidence, 90, "average OCR confidence should be 90");
      assert.equal(result.fontEmbedCoverage, null, "no writer report, so null");
      assert.ok(typeof result.aggregateScore === "number", "aggregate score should be computed");
      assert.equal(result.groundTruth, null);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readingOrderInversionCount
// ---------------------------------------------------------------------------
describe("readingOrderInversionCount", () => {
  it("detects known inversions in crafted semantic JSON", async () => {
    const filePath = path.join(fixturesDir, "sample-semantic-ordered.json");
    const count = await readingOrderInversionCount(filePath);

    // n1 (x=200,y=100) -> n2 (x=50,y=100): inversion (same line, n2 is left of n1)
    // n2 (x=50,y=100) -> n3 (x=50,y=200): different line, no inversion
    // n4 (x=300,y=50) -> n5 (x=50,y=50): inversion (same line on page 2)
    assert.equal(count, 2, "should detect exactly 2 inversions");
  });

  it("returns null for nonexistent file", async () => {
    const count = await readingOrderInversionCount("/does/not/exist.json");
    assert.equal(count, null);
  });

  it("returns null for empty nodes", async () => {
    const tmpFile = path.join(fixturesDir, "_tmp_empty_nodes.json");
    await writeFile(tmpFile, JSON.stringify({ nodes: [] }));
    try {
      const count = await readingOrderInversionCount(tmpFile);
      assert.equal(count, null);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// veraPdfScore
// ---------------------------------------------------------------------------
describe("veraPdfScore", () => {
  it("counts error-severity findings", async () => {
    const count = await veraPdfScore(path.join(fixturesDir, "sample-validation-report.json"));
    assert.equal(count, 2, "should count 2 error findings (not warnings)");
  });

  it("returns null for nonexistent file", async () => {
    const count = await veraPdfScore("/does/not/exist.json");
    assert.equal(count, null);
  });
});

// ---------------------------------------------------------------------------
// ocrScore
// ---------------------------------------------------------------------------
describe("ocrScore", () => {
  it("averages OCR confidence from layout with mixed blocks", async () => {
    const score = await ocrScore(path.join(fixturesDir, "sample-layout.json"));
    // (92 + 88) / 2 = 90
    assert.equal(score, 90);
  });

  it("returns null when no OCR blocks exist", async () => {
    const tmpFile = path.join(fixturesDir, "_tmp_no_ocr_layout.json");
    await writeFile(tmpFile, JSON.stringify({
      pages: [{ textBlocks: [{ id: "b1", text: "Normal text", bbox: [0,0,100,10] }] }]
    }));
    try {
      const score = await ocrScore(tmpFile);
      assert.equal(score, null);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fontEmbedScore
// ---------------------------------------------------------------------------
describe("fontEmbedScore", () => {
  it("computes correct coverage fraction", async () => {
    const tmpFile = path.join(fixturesDir, "_tmp_writer_report.json");
    await writeFile(tmpFile, JSON.stringify({
      fonts: [
        { name: "Arial", embedded: true, toUnicodeCoverage: 1.0 },
        { name: "Times", embedded: true, toUnicodeCoverage: 0.5 },
        { name: "Courier", embedded: false, toUnicodeCoverage: 1.0 }
      ]
    }));
    try {
      const score = await fontEmbedScore(tmpFile);
      // Only Arial qualifies (embedded=true, coverage>=0.99): 1/3
      assert.ok(Math.abs(score - 1/3) < 0.001);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it("returns null when no fonts array", async () => {
    const tmpFile = path.join(fixturesDir, "_tmp_no_fonts.json");
    await writeFile(tmpFile, JSON.stringify({ status: "completed" }));
    try {
      const score = await fontEmbedScore(tmpFile);
      assert.equal(score, null);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// paragraphQualityScore
// ---------------------------------------------------------------------------
describe("paragraphQualityScore", () => {
  it("scores >0.8 for 5 paragraphs of ~200 chars each", async () => {
    const tmpFile = path.join(fixturesDir, "_tmp_good_paras.json");
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      pageNumber: 1,
      bbox: [50, 50 + i * 60, 300, 14],
      type: "P",
      text: "A".repeat(200)
    }));
    await writeFile(tmpFile, JSON.stringify({ schemaVersion: "1.0.0", nodes }));
    try {
      const score = await paragraphQualityScore(tmpFile);
      assert.ok(score !== null, "score should not be null");
      assert.ok(score > 0.8, `expected >0.8, got ${score}`);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it("scores <0.5 for 50 one-line paragraphs", async () => {
    const tmpFile = path.join(fixturesDir, "_tmp_bad_paras.json");
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`,
      pageNumber: 1,
      bbox: [50, 50 + i * 12, 300, 10],
      type: "P",
      text: "Short."
    }));
    await writeFile(tmpFile, JSON.stringify({ schemaVersion: "1.0.0", nodes }));
    try {
      const score = await paragraphQualityScore(tmpFile);
      assert.ok(score !== null, "score should not be null");
      assert.ok(score < 0.5, `expected <0.5, got ${score}`);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it("returns null for nonexistent file", async () => {
    const score = await paragraphQualityScore("/does/not/exist.json");
    assert.equal(score, null);
  });

  it("returns null for empty nodes", async () => {
    const tmpFile = path.join(fixturesDir, "_tmp_empty_para_nodes.json");
    await writeFile(tmpFile, JSON.stringify({ nodes: [] }));
    try {
      const score = await paragraphQualityScore(tmpFile);
      assert.equal(score, null);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// computeAggregateScore
// ---------------------------------------------------------------------------
describe("computeAggregateScore", () => {
  it("computes weighted score from all metrics", () => {
    const score = computeAggregateScore({
      veraPdfFindings: 0,
      fontEmbedCoverage: 1.0,
      readingOrderInversions: 0,
      ocrConfidence: 100
    });

    // All perfect: each normalized to 1.0, weighted sum / total weight = 1.0
    assert.ok(Math.abs(score - 1.0) < 0.001, `expected ~1.0, got ${score}`);
  });

  it("returns null when no metrics available", () => {
    const score = computeAggregateScore({
      veraPdfFindings: null,
      fontEmbedCoverage: null,
      readingOrderInversions: null,
      ocrConfidence: null
    });
    assert.equal(score, null);
  });

  it("re-normalizes weights for partial metrics", () => {
    const score = computeAggregateScore({
      veraPdfFindings: 0,
      fontEmbedCoverage: null,
      readingOrderInversions: null,
      ocrConfidence: null
    });

    // Only veraPdf: 1/(1+0)=1.0 * 0.4 / 0.4 = 1.0
    assert.ok(Math.abs(score - 1.0) < 0.001);
  });
});

// ---------------------------------------------------------------------------
// diff_runs
// ---------------------------------------------------------------------------
describe("diff_runs", () => {
  let runADir;
  let runBDir;

  before(async () => {
    runADir = path.join(__dirname, "fixtures", "_tmp_runA");
    runBDir = path.join(__dirname, "fixtures", "_tmp_runB");

    // Create two run directories with overlapping job subdirs
    await mkdir(path.join(runADir, "doc1"), { recursive: true });
    await mkdir(path.join(runADir, "doc2"), { recursive: true });
    await mkdir(path.join(runBDir, "doc1"), { recursive: true });
    await mkdir(path.join(runBDir, "doc2"), { recursive: true });

    // Run A: doc1 has 5 errors, doc2 has 0 errors
    await writeFile(
      path.join(runADir, "doc1", "07-validation-report.json"),
      JSON.stringify({
        findings: [
          { severity: "error", code: "E1" },
          { severity: "error", code: "E2" },
          { severity: "error", code: "E3" },
          { severity: "error", code: "E4" },
          { severity: "error", code: "E5" }
        ]
      })
    );
    await writeFile(
      path.join(runADir, "doc2", "07-validation-report.json"),
      JSON.stringify({ findings: [] })
    );

    // Run B: doc1 has 1 error (improved), doc2 has 3 errors (regressed)
    await writeFile(
      path.join(runBDir, "doc1", "07-validation-report.json"),
      JSON.stringify({ findings: [{ severity: "error", code: "E1" }] })
    );
    await writeFile(
      path.join(runBDir, "doc2", "07-validation-report.json"),
      JSON.stringify({
        findings: [
          { severity: "error", code: "E1" },
          { severity: "error", code: "E2" },
          { severity: "error", code: "E3" }
        ]
      })
    );
  });

  it("computes correct deltas between two runs", async () => {
    const result = await diffRuns({ runADir, runBDir });

    assert.ok(result.comparisons, "should have comparisons");
    assert.equal(result.comparisons.length, 2, "should compare 2 docs");

    const doc1 = result.comparisons.find((c) => c.fileName === "doc1");
    const doc2 = result.comparisons.find((c) => c.fileName === "doc2");

    assert.ok(doc1, "doc1 should be in comparisons");
    assert.ok(doc2, "doc2 should be in comparisons");

    // doc1: improved (fewer errors -> higher score)
    assert.ok(doc1.delta > 0, "doc1 should have positive delta (improved)");
    assert.equal(doc1.improved, true);

    // doc2: regressed (more errors -> lower score)
    assert.ok(doc2.delta < 0, "doc2 should have negative delta (regressed)");
    assert.equal(doc2.improved, false);

    assert.equal(result.aggregate.improvedCount, 1);
    assert.equal(result.aggregate.regressedCount, 1);
    assert.equal(result.aggregate.unchangedCount, 0);
    assert.ok(typeof result.aggregate.meanDelta === "number");

    // Cleanup
    await rm(runADir, { recursive: true, force: true });
    await rm(runBDir, { recursive: true, force: true });
  });
});
