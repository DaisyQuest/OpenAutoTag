/**
 * CLI: Run native vs raster comparison across the LRBTest corpus.
 *
 * Since the native rewriter is not yet built, this produces ESTIMATED
 * proof reports by:
 *   - Using pdfjs-dist to count text operators and links in the source PDF
 *   - Estimating native file size as the original PDF size (no raster inflation)
 *   - Estimating content preservation from text extractability
 *
 * When the real native writer ships, replace the estimation logic with
 * actual file comparison by passing --native-dir.
 *
 * Usage:
 *   node modules/native-verify/verify-corpus.js [--corpus <dir>] [--output-dir <dir>]
 */

import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareWriterModes, generateProofReport } from "./index.js";
import {
  measureFileSize,
  measureTextSelectability,
  measureLinkPreservation
} from "./lib/metrics.js";
import { renderProofReportHtml } from "./lib/proof-report-renderer.js";

const DEFAULT_CORPUS = "C:/LRBTest";

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args.set(argv[i], argv[++i]);
    }
  }
  return {
    corpusDir: args.get("--corpus") || DEFAULT_CORPUS,
    outputDir: args.get("--output-dir") || "tmp/native-verify-reports"
  };
}

async function estimateNativeMetrics(pdfPath) {
  const fileSize = await measureFileSize(pdfPath);

  let textSelectable = false;
  let extractedLength = 0;
  try {
    const textResult = await measureTextSelectability(pdfPath);
    textSelectable = textResult.selectable;
    extractedLength = textResult.extractedLength;
  } catch {
    // PDF might not be readable by pdfjs-dist
  }

  let linkCount = 0;
  try {
    linkCount = await measureLinkPreservation(pdfPath);
  } catch {
    // ignore
  }

  // Estimate operator count from extracted text length
  // Heuristic: ~1 TJ operator per 20 characters on average
  const estimatedOperators = textSelectable ? Math.max(1, Math.ceil(extractedLength / 20)) : 0;

  return {
    fileSize,
    textSelectable,
    operatorCount: estimatedOperators,
    linkCount
  };
}

async function main() {
  const { corpusDir, outputDir } = parseArgs(process.argv.slice(2));

  process.stderr.write(`Corpus directory: ${corpusDir}\n`);
  process.stderr.write(`Output directory: ${outputDir}\n\n`);

  let entries;
  try {
    entries = await readdir(corpusDir);
  } catch (err) {
    process.stderr.write(`Cannot read corpus directory: ${err.message}\n`);
    process.stderr.write(`Place PDF files in ${corpusDir} or use --corpus <dir>\n`);
    process.exitCode = 1;
    return;
  }

  const pdfFiles = entries.filter((f) => f.toLowerCase().endsWith(".pdf")).sort();

  if (pdfFiles.length === 0) {
    process.stderr.write(`No PDF files found in ${corpusDir}\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`Found ${pdfFiles.length} PDFs to verify\n\n`);
  await mkdir(outputDir, { recursive: true });

  const summaries = [];

  for (const pdfFile of pdfFiles) {
    const pdfPath = path.join(corpusDir, pdfFile);
    process.stderr.write(`Processing: ${pdfFile}... `);

    try {
      const estimated = await estimateNativeMetrics(pdfPath);

      const { report, jsonPath, htmlPath } = await generateProofReport({
        pdfPath,
        estimatedNative: estimated,
        outputDir
      });

      summaries.push({
        document: report.document,
        verdict: report.verdict,
        confidence: report.confidence,
        fileSizeRatio: report.comparison.fileSizeRatio,
        contentPreservation: report.comparison.contentPreservationScore,
        structureFidelity: report.comparison.structureFidelity
      });

      process.stderr.write(`${report.verdict} (${(report.confidence * 100).toFixed(0)}%)\n`);
    } catch (err) {
      process.stderr.write(`ERROR: ${err.message}\n`);
      summaries.push({
        document: pdfFile,
        verdict: "error",
        confidence: 0,
        error: err.message
      });
    }
  }

  // Write corpus summary
  const summaryPath = path.join(outputDir, "corpus-summary.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(summaryPath, JSON.stringify({ documents: summaries, totalDocuments: pdfFiles.length }, null, 2));

  process.stderr.write(`\n--- Corpus Summary ---\n`);
  const recommended = summaries.filter((s) => s.verdict === "native-recommended").length;
  const preferred = summaries.filter((s) => s.verdict === "raster-preferred").length;
  const errors = summaries.filter((s) => s.verdict === "error").length;
  process.stderr.write(`Native recommended: ${recommended}\n`);
  process.stderr.write(`Raster preferred:   ${preferred}\n`);
  process.stderr.write(`Errors:             ${errors}\n`);
  process.stderr.write(`Summary written to: ${summaryPath}\n`);

  process.stdout.write(JSON.stringify({ documents: summaries, totalDocuments: pdfFiles.length }, null, 2) + "\n");
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`Fatal: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { estimateNativeMetrics };
