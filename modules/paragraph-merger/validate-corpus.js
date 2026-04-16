/**
 * Corpus-wide validation runner for text-structure paragraph merger.
 *
 * Walks the real job outputs, runs textStructureMerge + all validators,
 * and prints a summary table plus detailed error report.
 *
 * Usage: node modules/paragraph-merger/validate-corpus.js
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { textStructureMerge } from "./lib/text-structure-merge.js";
import { runAllValidators } from "./lib/validators.js";

const UPLOADS_ROOT = "C:/Users/tabur/Videos/BuildEverything/tmp/uploads";
const MAX_NODES = 50000;
const REPORT_PATH = path.resolve("tmp/validation-report.json");

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function findSemanticFiles(root) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === "03-semantic.json") {
        results.push(full);
      }
    }
  }

  await walk(root);
  return results.sort();
}

function extractDocId(filePath) {
  // .../uploads/<uuid>/jobs/<jobId>/03-semantic.json
  const parts = filePath.replace(/\\/g, "/").split("/");
  const jobsIdx = parts.lastIndexOf("jobs");
  if (jobsIdx >= 0 && jobsIdx + 1 < parts.length) {
    return parts[jobsIdx + 1];
  }
  return path.basename(path.dirname(filePath));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const files = await findSemanticFiles(UPLOADS_ROOT);
  console.log(`Found ${files.length} semantic files\n`);

  const results = [];
  let skippedCount = 0;

  for (const filePath of files) {
    const docId = extractDocId(filePath);
    let doc;
    try {
      doc = JSON.parse(await readFile(filePath, "utf8"));
    } catch (err) {
      console.error(`  SKIP ${docId}: failed to parse JSON — ${err.message}`);
      skippedCount++;
      continue;
    }

    const nodeCount = (doc.nodes || []).length;
    if (nodeCount > MAX_NODES) {
      console.log(`  SKIP ${docId}: ${nodeCount} nodes (> ${MAX_NODES} limit)`);
      skippedCount++;
      continue;
    }

    // Run text-structure merge
    let merged, report;
    try {
      const result = textStructureMerge(doc);
      merged = result.document;
      report = result.report;
    } catch (err) {
      console.error(`  ERROR ${docId}: textStructureMerge threw — ${err.message}`);
      results.push({
        docId,
        filePath: filePath.replace(/\\/g, "/"),
        error: err.message,
        linesIn: nodeCount,
        parasOut: null,
        reductionPct: null,
        warnings: [],
        summary: null
      });
      continue;
    }

    // Run validators
    let validation;
    try {
      validation = runAllValidators(merged, doc);
    } catch (err) {
      console.error(`  ERROR ${docId}: runAllValidators threw — ${err.message}`);
      validation = { warnings: [], summary: { errorCount: 0, warningCount: 0, flaggedNodeCount: 0, passedNodeCount: 0 } };
    }

    // Count warnings by type
    const warningsByType = {};
    for (const w of validation.warnings) {
      const key = w.type;
      warningsByType[key] = (warningsByType[key] || 0) + 1;
    }

    const linesIn = report.summary.totalLinesIn;
    const parasOut = report.summary.totalNodesOut;
    const pLinesIn = report.summary.totalParagraphLinesIn;
    const pParasOut = report.summary.totalParagraphsOut;
    const reductionPct = parseFloat(report.summary.overallReductionPercent || "0");

    results.push({
      docId,
      filePath: filePath.replace(/\\/g, "/"),
      linesIn,
      pLinesIn,
      parasOut,
      pParasOut,
      reductionPct,
      warningsByType,
      errorCount: validation.summary.errorCount,
      warningCount: validation.summary.warningCount,
      flaggedNodeCount: validation.summary.flaggedNodeCount,
      totalMergedParas: merged.nodes.filter(n => n.role === "P" && n._mergedFrom && n._mergedFrom.length > 1).length,
      warnings: validation.warnings
    });
  }

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(140));
  console.log("CORPUS VALIDATION SUMMARY");
  console.log("=".repeat(140));
  console.log(
    padR("DocId", 30) +
    padR("Lines", 7) +
    padR("POut", 7) +
    padR("Red%", 7) +
    padR("Errs", 6) +
    padR("Warns", 7) +
    padR("XCol", 6) +
    padR(">2kCh", 7) +
    padR("Hdg", 6) +
    padR("Order", 7) +
    padR("Space", 7) +
    padR("MrgdP", 7)
  );
  console.log("-".repeat(140));

  let totalLinesIn = 0;
  let totalParasOut = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalMergedParas = 0;
  const globalWarningsByType = {};

  for (const r of results) {
    if (r.error) {
      console.log(padR(r.docId, 30) + `  ERROR: ${r.error}`);
      continue;
    }
    totalLinesIn += r.linesIn;
    totalParasOut += r.parasOut;
    totalErrors += r.errorCount;
    totalWarnings += r.warningCount;
    totalMergedParas += r.totalMergedParas;

    for (const [type, count] of Object.entries(r.warningsByType)) {
      globalWarningsByType[type] = (globalWarningsByType[type] || 0) + count;
    }

    console.log(
      padR(r.docId, 30) +
      padR(r.linesIn, 7) +
      padR(r.parasOut, 7) +
      padR(r.reductionPct.toFixed(1), 7) +
      padR(r.errorCount, 6) +
      padR(r.warningCount, 7) +
      padR(r.warningsByType["cross-column merge"] || 0, 6) +
      padR((r.warningsByType["long paragraph"] || 0) + (r.warningsByType["excessive paragraph length"] || 0), 7) +
      padR(r.warningsByType["embedded heading"] || 0, 6) +
      padR(r.warningsByType["reading order inversion"] || 0, 7) +
      padR(r.warningsByType["inconsistent spacing"] || 0, 7) +
      padR(r.totalMergedParas, 7)
    );
  }

  console.log("-".repeat(140));
  console.log(
    padR("TOTALS", 30) +
    padR(totalLinesIn, 7) +
    padR(totalParasOut, 7) +
    padR(totalLinesIn > 0 ? ((1 - totalParasOut / totalLinesIn) * 100).toFixed(1) : "0.0", 7) +
    padR(totalErrors, 6) +
    padR(totalWarnings, 7) +
    padR(globalWarningsByType["cross-column merge"] || 0, 6) +
    padR((globalWarningsByType["long paragraph"] || 0) + (globalWarningsByType["excessive paragraph length"] || 0), 7) +
    padR(globalWarningsByType["embedded heading"] || 0, 6) +
    padR(globalWarningsByType["reading order inversion"] || 0, 7) +
    padR(globalWarningsByType["inconsistent spacing"] || 0, 7) +
    padR(totalMergedParas, 7)
  );

  // ---------------------------------------------------------------------------
  // Key metrics
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(80));
  console.log("KEY METRICS");
  console.log("=".repeat(80));
  console.log(`  Documents processed:     ${results.filter(r => !r.error).length}`);
  console.log(`  Documents skipped:       ${skippedCount}`);
  console.log(`  Total lines in:          ${totalLinesIn}`);
  console.log(`  Total nodes out:         ${totalParasOut}`);
  console.log(`  Overall reduction:       ${totalLinesIn > 0 ? ((1 - totalParasOut / totalLinesIn) * 100).toFixed(1) : "0.0"}%`);
  console.log(`  Total merged paragraphs: ${totalMergedParas}`);
  console.log(`  Total errors:            ${totalErrors}`);
  console.log(`  Total warnings:          ${totalWarnings}`);
  console.log(`  Error rate:              ${totalMergedParas > 0 ? ((totalErrors / totalMergedParas) * 100).toFixed(2) : "0.00"}% of merged paragraphs`);
  console.log(`  Warning rate:            ${totalMergedParas > 0 ? ((totalWarnings / totalMergedParas) * 100).toFixed(2) : "0.00"}% of merged paragraphs`);

  console.log("\n  Warnings by type:");
  for (const [type, count] of Object.entries(globalWarningsByType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${padR(type, 30)} ${count}`);
  }

  // ---------------------------------------------------------------------------
  // Error details for documents with errors
  // ---------------------------------------------------------------------------
  const docsWithErrors = results.filter(r => !r.error && r.errorCount > 0);
  if (docsWithErrors.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log("DOCUMENTS WITH ERRORS — DETAIL");
    console.log("=".repeat(80));
    for (const r of docsWithErrors) {
      console.log(`\n--- ${r.docId} (${r.errorCount} errors) ---`);
      for (const w of r.warnings.filter(w => w.severity === "error")) {
        console.log(`  [${w.severity.toUpperCase()}] ${w.type}`);
        console.log(`    Node:       ${w.nodeId}`);
        console.log(`    Detail:     ${w.detail}`);
        console.log(`    Suggestion: ${w.suggestion}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Warning details for all documents with any issues
  // ---------------------------------------------------------------------------
  const docsWithWarnings = results.filter(r => !r.error && r.warningCount > 0);
  if (docsWithWarnings.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log("DOCUMENTS WITH WARNINGS — DETAIL");
    console.log("=".repeat(80));
    for (const r of docsWithWarnings) {
      console.log(`\n--- ${r.docId} (${r.warningCount} warnings) ---`);
      for (const w of r.warnings.filter(w => w.severity === "warning")) {
        console.log(`  [${w.type}] ${w.nodeId}`);
        console.log(`    ${w.detail}`);
        if (w.suggestion) console.log(`    -> ${w.suggestion}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Write detailed report
  // ---------------------------------------------------------------------------
  const detailedReport = {
    timestamp: new Date().toISOString(),
    corpus: {
      uploadsRoot: UPLOADS_ROOT,
      filesFound: files.length,
      filesSkipped: skippedCount,
      filesProcessed: results.filter(r => !r.error).length
    },
    summary: {
      totalLinesIn,
      totalParasOut,
      overallReductionPct: totalLinesIn > 0 ? parseFloat(((1 - totalParasOut / totalLinesIn) * 100).toFixed(1)) : 0,
      totalMergedParagraphs: totalMergedParas,
      totalErrors,
      totalWarnings,
      errorRate: totalMergedParas > 0 ? parseFloat(((totalErrors / totalMergedParas) * 100).toFixed(2)) : 0,
      warningRate: totalMergedParas > 0 ? parseFloat(((totalWarnings / totalMergedParas) * 100).toFixed(2)) : 0,
      warningsByType: globalWarningsByType
    },
    documents: results
  };

  await writeFile(REPORT_PATH, JSON.stringify(detailedReport, null, 2) + "\n");
  console.log(`\nDetailed report written to: ${REPORT_PATH}`);
}

function padR(val, width) {
  const s = String(val);
  return s.length >= width ? s + " " : s + " ".repeat(width - s.length);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
});
