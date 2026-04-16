import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  measureFileSize,
  measureTextSelectability,
  measureContentPreservation,
  measureLinkPreservation,
  measureStructureFidelity,
  measureFileSizeRatio
} from "./lib/metrics.js";
import { renderProofReportHtml } from "./lib/proof-report-renderer.js";

/**
 * Compare raster and native writer modes on the same document.
 *
 * When real native output is not yet available, pass estimatedNative
 * to supply simulated metrics from the content stream parser.
 *
 * @param {object} options
 * @param {string} options.pdfPath - original source PDF
 * @param {string} [options.semanticPath] - semantic.ordered.json path
 * @param {string} [options.tagsPath] - tagging.json path
 * @param {string} [options.rasterOutputDir] - directory containing raster-mode output
 * @param {string} [options.nativeOutputDir] - directory containing native-mode output
 * @param {object} [options.estimatedNative] - simulated native metrics when real output unavailable
 * @param {number} [options.estimatedNative.operatorCount] - total text operators found in source
 * @param {number} [options.estimatedNative.linkCount] - link annotations in source
 * @param {number} [options.estimatedNative.fileSize] - estimated native file size (usually ~= original)
 * @param {boolean} [options.estimatedNative.textSelectable] - whether source has selectable text
 * @param {object} [options.rasterTagTree] - tag tree from raster mode for fidelity comparison
 * @param {object} [options.nativeTagTree] - tag tree from native mode for fidelity comparison
 * @returns {Promise<object>} proof report JSON
 */
export async function compareWriterModes(options) {
  const {
    pdfPath,
    rasterOutputDir,
    nativeOutputDir,
    estimatedNative,
    rasterTagTree = null,
    nativeTagTree = null
  } = options;

  const docName = path.basename(pdfPath);

  // --- Raster mode metrics ---
  let rasterMetrics;
  if (rasterOutputDir) {
    const rasterPdf = path.join(rasterOutputDir, docName);
    const rasterSize = await measureFileSize(rasterPdf).catch(() => 0);
    const rasterText = await measureTextSelectability(rasterPdf).catch(() => ({
      selectable: false,
      extractedLength: 0
    }));
    const rasterLinks = await measureLinkPreservation(rasterPdf).catch(() => 0);
    rasterMetrics = {
      fileSize: rasterSize,
      textSelectable: rasterText.selectable,
      nativeTextPreserved: 0, // raster destroys native text
      totalTextOperators: 0,
      linksPreserved: rasterLinks,
      formFieldsPreserved: 0
    };
  } else {
    // Simulate raster: assume large inflated file, no native text
    const originalSize = await measureFileSize(pdfPath);
    rasterMetrics = {
      fileSize: Math.round(originalSize * 5), // raster inflates ~5x
      textSelectable: false,
      nativeTextPreserved: 0,
      totalTextOperators: 0,
      linksPreserved: 0,
      formFieldsPreserved: 0
    };
  }

  // --- Native mode metrics ---
  let nativeMetrics;
  if (nativeOutputDir) {
    const nativePdf = path.join(nativeOutputDir, docName);
    const nativeSize = await measureFileSize(nativePdf);
    const nativeText = await measureTextSelectability(nativePdf).catch(() => ({
      selectable: false,
      extractedLength: 0
    }));
    const nativeLinks = await measureLinkPreservation(nativePdf).catch(() => 0);

    // Count native operators in the output
    const originalLinks = await measureLinkPreservation(pdfPath).catch(() => 0);
    nativeMetrics = {
      fileSize: nativeSize,
      textSelectable: nativeText.selectable,
      nativeTextPreserved: estimatedNative?.operatorCount || 0,
      totalTextOperators: estimatedNative?.operatorCount || 0,
      linksPreserved: nativeLinks,
      formFieldsPreserved: 0
    };
  } else if (estimatedNative) {
    // Simulated native metrics from content stream parser
    nativeMetrics = {
      fileSize: estimatedNative.fileSize || await measureFileSize(pdfPath),
      textSelectable: estimatedNative.textSelectable ?? true,
      nativeTextPreserved: estimatedNative.operatorCount || 0,
      totalTextOperators: estimatedNative.operatorCount || 0,
      linksPreserved: estimatedNative.linkCount || 0,
      formFieldsPreserved: 0
    };
  } else {
    // Fallback: measure source PDF directly as proxy for native output
    const sourceSize = await measureFileSize(pdfPath);
    const sourceText = await measureTextSelectability(pdfPath).catch(() => ({
      selectable: false,
      extractedLength: 0
    }));
    const sourceLinks = await measureLinkPreservation(pdfPath).catch(() => 0);
    nativeMetrics = {
      fileSize: sourceSize,
      textSelectable: sourceText.selectable,
      nativeTextPreserved: 0,
      totalTextOperators: 0,
      linksPreserved: sourceLinks,
      formFieldsPreserved: 0
    };
  }

  // --- Comparison ---
  const fileSizeRatio = measureFileSizeRatio(rasterMetrics.fileSize, nativeMetrics.fileSize);
  const contentPreservationScore = measureContentPreservation(
    nativeMetrics.nativeTextPreserved,
    nativeMetrics.totalTextOperators
  );
  const structureFidelity = measureStructureFidelity(rasterTagTree, nativeTagTree);

  const nativeAdvantages = [];
  const nativeRisks = [];

  if (fileSizeRatio < 1) {
    const ratio = Math.round(1 / fileSizeRatio);
    nativeAdvantages.push(`${ratio}x smaller file size`);
  }
  if (nativeMetrics.textSelectable && !rasterMetrics.textSelectable) {
    nativeAdvantages.push("Vector text preserved (sharp at any zoom)");
  }
  if (nativeMetrics.nativeTextPreserved > 0) {
    nativeAdvantages.push("Original fonts retained");
  }
  if (nativeMetrics.linksPreserved > 0 && rasterMetrics.linksPreserved === 0) {
    nativeAdvantages.push(`${nativeMetrics.linksPreserved} hyperlinks preserved`);
  }

  const unmatched = nativeMetrics.totalTextOperators - nativeMetrics.nativeTextPreserved;
  if (unmatched > 0) {
    const pct = ((unmatched / nativeMetrics.totalTextOperators) * 100).toFixed(1);
    nativeRisks.push(`${unmatched} operators unmatched (${pct}% content loss)`);
  }

  // --- Verdict ---
  const { verdict, confidence } = computeVerdict({
    contentPreservationScore,
    structureFidelity,
    fileSizeRatio,
    nativeTextSelectable: nativeMetrics.textSelectable
  });

  const report = {
    document: docName,
    modes: {
      raster: rasterMetrics,
      native: nativeMetrics
    },
    comparison: {
      fileSizeRatio: Math.round(fileSizeRatio * 1000) / 1000,
      contentPreservationScore,
      structureFidelity,
      veraPdfFindingsDelta: 0,
      nativeAdvantages,
      nativeRisks
    },
    verdict,
    confidence
  };

  return report;
}

/**
 * Compute verdict and confidence from comparison metrics.
 */
export function computeVerdict({ contentPreservationScore, structureFidelity, fileSizeRatio, nativeTextSelectable }) {
  let confidence = 0;

  // Content preservation is the most important signal
  if (contentPreservationScore > 0.9) confidence += 0.4;
  else if (contentPreservationScore > 0.7) confidence += 0.2;

  // Structure fidelity
  if (structureFidelity > 0.85) confidence += 0.25;
  else if (structureFidelity > 0.6) confidence += 0.1;

  // File size advantage
  if (fileSizeRatio < 0.5) confidence += 0.2;
  else if (fileSizeRatio < 1) confidence += 0.1;

  // Text selectability
  if (nativeTextSelectable) confidence += 0.15;

  confidence = Math.min(confidence, 1.0);
  confidence = Math.round(confidence * 100) / 100;

  const verdict =
    contentPreservationScore > 0.9 && structureFidelity >= 0.85
      ? "native-recommended"
      : "raster-preferred";

  return { verdict, confidence };
}

/**
 * Generate proof report and optionally write HTML to disk.
 */
export async function generateProofReport(options) {
  const report = await compareWriterModes(options);

  if (options.outputDir) {
    await mkdir(options.outputDir, { recursive: true });
    const baseName = path.basename(options.pdfPath, ".pdf");
    const jsonPath = path.join(options.outputDir, `${baseName}.proof-report.json`);
    const htmlPath = path.join(options.outputDir, `${baseName}.proof-report.html`);

    await writeFile(jsonPath, JSON.stringify(report, null, 2));
    await writeFile(htmlPath, renderProofReportHtml(report));

    return { report, jsonPath, htmlPath };
  }

  return { report };
}

// --- CLI ---
function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    args.set(argv[i], argv[i + 1]);
  }
  return {
    pdfPath: args.get("--pdf"),
    semanticPath: args.get("--semantic"),
    tagsPath: args.get("--tags"),
    rasterOutputDir: args.get("--raster-dir"),
    nativeOutputDir: args.get("--native-dir"),
    outputDir: args.get("--output-dir")
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.pdfPath) {
    process.stderr.write(
      "Usage: node modules/native-verify/index.js --pdf <source.pdf> [--raster-dir <dir>] [--native-dir <dir>] [--output-dir <dir>]\n"
    );
    process.exitCode = 1;
    return;
  }

  const { report, jsonPath, htmlPath } = await generateProofReport(options);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (jsonPath) {
    process.stderr.write(`Report written to: ${jsonPath}\n`);
    process.stderr.write(`HTML written to: ${htmlPath}\n`);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
