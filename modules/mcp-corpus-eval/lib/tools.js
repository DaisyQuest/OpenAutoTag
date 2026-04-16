import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  readingOrderInversionCount,
  fontEmbedScore,
  veraPdfScore,
  ocrScore,
  paragraphQualityScore,
  computeAggregateScore
} from "./scorers.js";

const DEFAULT_CORPUS_DIR = "C:\\LRBTest";

// ---------------------------------------------------------------------------
// Helper: attempt to get PDF page count via pdfjs-dist
// ---------------------------------------------------------------------------
async function getPageCount(pdfPath) {
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await readFile(pdfPath));
    const doc = await getDocument({ data, useSystemFonts: true }).promise;
    const count = doc.numPages;
    doc.destroy();
    return count;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool: sample_corpus
// ---------------------------------------------------------------------------
export async function sampleCorpus({ directory, n, criteria }) {
  const dir = directory || DEFAULT_CORPUS_DIR;

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { samples: [], skipped: true, reason: `Directory not accessible: ${dir}` };
  }

  let pdfFiles = entries.filter((f) => /\.pdf$/i.test(f));

  if (criteria?.namePattern) {
    const re = new RegExp(criteria.namePattern, "i");
    pdfFiles = pdfFiles.filter((f) => re.test(f));
  }

  // Gather stats
  const withStats = await Promise.all(
    pdfFiles.map(async (f) => {
      const fullPath = path.join(dir, f);
      try {
        const s = await stat(fullPath);
        return { fileName: f, pdfPath: fullPath, sizeBytes: s.size };
      } catch {
        return null;
      }
    })
  );

  let candidates = withStats.filter(Boolean);

  // Get page counts for filtering
  const withPages = await Promise.all(
    candidates.map(async (c) => {
      const pageCount = await getPageCount(c.pdfPath);
      return { ...c, pageCount };
    })
  );

  candidates = withPages;

  if (criteria?.minPages != null) {
    candidates = candidates.filter((c) => c.pageCount != null && c.pageCount >= criteria.minPages);
  }
  if (criteria?.maxPages != null) {
    candidates = candidates.filter((c) => c.pageCount != null && c.pageCount <= criteria.maxPages);
  }

  // Sample n items
  const count = Math.min(n || candidates.length, candidates.length);
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const samples = shuffled.slice(0, count);

  return { samples };
}

// ---------------------------------------------------------------------------
// Tool: run_profile
// ---------------------------------------------------------------------------
export async function runProfile({ profileId, profileOverrides, pdfPaths, outputDir }) {
  const runId = `eval-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const baseOutputDir = outputDir || path.join("tmp", "eval-runs", runId);
  await mkdir(baseOutputDir, { recursive: true });

  // Import pipeline-runner dynamically so this module works without a running server
  const { runPipeline } = await import("../../../orchestrator/pipeline-runner.js");

  const results = [];

  for (const pdfPath of pdfPaths) {
    const fileName = path.basename(pdfPath, ".pdf");
    const jobOutputDir = path.join(baseOutputDir, fileName);
    const jobId = `${runId}--${fileName}`;

    const stageTimes = {};
    const startTime = Date.now();

    try {
      const job = await runPipeline({
        filePath: pdfPath,
        outputDir: jobOutputDir,
        jobId,
        onProgress: async (update) => {
          if (update.lastStage) {
            stageTimes[update.lastStage.key] = update.lastStage.durationMs;
          }
        }
      });

      results.push({
        fileName: path.basename(pdfPath),
        pdfPath,
        jobDir: jobOutputDir,
        status: job.status,
        durationMs: Date.now() - startTime,
        stageTimes,
        outputPaths: job.artifacts || {}
      });
    } catch (error) {
      results.push({
        fileName: path.basename(pdfPath),
        pdfPath,
        jobDir: jobOutputDir,
        status: "error",
        durationMs: Date.now() - startTime,
        stageTimes,
        error: error.message
      });
    }
  }

  return { runId, outputDir: baseOutputDir, jobs: results };
}

// ---------------------------------------------------------------------------
// Tool: score_job
// ---------------------------------------------------------------------------
export async function scoreJob({ jobDir }) {
  // Discover artifact files with common naming conventions
  const files = await readdir(jobDir).catch(() => []);

  const find = (pattern) => {
    const match = files.find((f) => pattern.test(f));
    return match ? path.join(jobDir, match) : null;
  };

  const writerReportPath = find(/writer-report\.json$/i);
  const validationReportPath = find(/validation-report\.json$/i);
  const semanticOrderedPath = find(/semantic-ordered\.json$/i);
  const layoutPath = find(/^01-layout\.json$/i);

  const [veraPdfFindingCount, fontEmbedCoverage, readingOrderInversions, ocrConfidenceVal, paragraphQualityVal] =
    await Promise.all([
      validationReportPath ? veraPdfScore(validationReportPath) : null,
      writerReportPath ? fontEmbedScore(writerReportPath) : null,
      semanticOrderedPath ? readingOrderInversionCount(semanticOrderedPath) : null,
      layoutPath ? ocrScore(layoutPath) : null,
      semanticOrderedPath ? paragraphQualityScore(semanticOrderedPath) : null
    ]);

  // Attempt to read profile scoring weights from the job
  let scoringWeights = null;
  const jobSnapshotPath = find(/pipeline-job\.json$/i);
  if (jobSnapshotPath) {
    try {
      const snapshot = JSON.parse(await readFile(jobSnapshotPath, "utf8"));
      scoringWeights = snapshot?.profile?.evaluation?.scoringWeights;
    } catch {
      // ignore
    }
  }

  const metrics = {
    veraPdfFindingCount: veraPdfFindingCount ?? null,
    fontEmbedCoverage: fontEmbedCoverage ?? null,
    readingOrderInversions: readingOrderInversions ?? null,
    ocrConfidence: ocrConfidenceVal ?? null,
    paragraphQuality: paragraphQualityVal ?? null
  };

  const aggregateScore = computeAggregateScore(
    {
      veraPdfFindings: metrics.veraPdfFindingCount,
      fontEmbedCoverage: metrics.fontEmbedCoverage,
      readingOrderInversions: metrics.readingOrderInversions,
      ocrConfidence: metrics.ocrConfidence,
      paragraphQuality: metrics.paragraphQuality
    },
    scoringWeights || undefined
  );

  return {
    jobDir,
    ...metrics,
    aggregateScore,
    groundTruth: null
  };
}

// ---------------------------------------------------------------------------
// Tool: diff_runs
// ---------------------------------------------------------------------------
export async function diffRuns({ runADir, runBDir }) {
  const listJobDirs = async (runDir) => {
    const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => ({
      name: e.name,
      path: path.join(runDir, e.name)
    }));
  };

  const [jobsA, jobsB] = await Promise.all([listJobDirs(runADir), listJobDirs(runBDir)]);

  const scoresA = new Map();
  for (const job of jobsA) {
    const score = await scoreJob({ jobDir: job.path });
    scoresA.set(job.name, score);
  }

  const scoresB = new Map();
  for (const job of jobsB) {
    const score = await scoreJob({ jobDir: job.path });
    scoresB.set(job.name, score);
  }

  const allNames = new Set([...scoresA.keys(), ...scoresB.keys()]);
  const comparisons = [];
  let improvedCount = 0;
  let regressedCount = 0;
  let unchangedCount = 0;
  const deltas = [];

  for (const name of allNames) {
    const a = scoresA.get(name);
    const b = scoresB.get(name);

    const scoreA = a?.aggregateScore ?? null;
    const scoreB = b?.aggregateScore ?? null;

    let delta = null;
    let improved = null;

    if (scoreA !== null && scoreB !== null) {
      delta = scoreB - scoreA;
      deltas.push(delta);

      if (delta > 0.001) {
        improved = true;
        improvedCount++;
      } else if (delta < -0.001) {
        improved = false;
        regressedCount++;
      } else {
        improved = null;
        unchangedCount++;
      }
    }

    comparisons.push({ fileName: name, scoreA, scoreB, delta, improved });
  }

  const meanDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;

  return {
    comparisons,
    aggregate: { meanDelta, improvedCount, regressedCount, unchangedCount }
  };
}
