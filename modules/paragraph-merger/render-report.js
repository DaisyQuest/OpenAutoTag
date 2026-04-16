#!/usr/bin/env node
/**
 * CLI to render paragraph-merger JSON reports as HTML.
 *
 * Usage:
 *   node modules/paragraph-merger/render-report.js --input <json> --output <html>
 *
 * Detects corpus-summary vs single-document report automatically.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { renderDocumentReport, renderCorpusSummary } from "./lib/report-renderer.js";

function parseArgs(argv) {
  const args = { input: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) args.input = argv[++i];
    else if (argv[i] === "--output" && argv[i + 1]) args.output = argv[++i];
    else if (!args.input) args.input = argv[i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error("Usage: node modules/paragraph-merger/render-report.js --input <json> [--output <html>]");
    console.error("");
    console.error("  --input   Path to a JSON report (corpus-summary or single-document report)");
    console.error("  --output  Path to write HTML (default: replaces .json with .html)");
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(args.input);
  const raw = await readFile(inputPath, "utf8");
  const data = JSON.parse(raw);

  // Detect type: corpus summary has documentsEvaluated; document report has documentId
  const isCorpus = data.documentsEvaluated != null;

  const html = isCorpus ? renderCorpusSummary(data) : renderDocumentReport(data);

  const outputPath = args.output
    ? path.resolve(args.output)
    : inputPath.replace(/\.json$/i, ".html");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");

  console.log(`Wrote ${isCorpus ? "corpus summary" : "document report"}: ${outputPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
