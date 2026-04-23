import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runPipeline } from "../orchestrator/pipeline-runner.js";

const DEFAULT_MATRIX_INPUT_DIR = path.resolve("output", "ml-fine-tuned-corpus", "v2", "pdfs");
const DEFAULT_MODEL_PATH = path.resolve("output", "ml-pilot", "role-baseline-large-v4-matrix.json");
const DEFAULT_EXPERIMENT_ROOT = path.resolve("output", "ml-experiments");
const DEFAULT_CUSTOM_OUTPUT_DIR = path.join(DEFAULT_EXPERIMENT_ROOT, "ml-vs-vanilla-custom");

export const EXPERIMENT_PRESETS = Object.freeze({
  "matrix-smoke": Object.freeze({
    name: "matrix-smoke",
    description: "Fast A/B experiment over the fine-tuned matrix corpus. Uses a small deterministic slice by default.",
    inputDir: DEFAULT_MATRIX_INPUT_DIR,
    outputDir: path.join(DEFAULT_EXPERIMENT_ROOT, "ml-vs-vanilla-matrix-smoke"),
    modelPath: DEFAULT_MODEL_PATH,
    profileId: "default",
    limit: 6
  }),
  "matrix-full": Object.freeze({
    name: "matrix-full",
    description: "Full A/B experiment over every generated matrix PDF. This can take a long time because each PDF runs twice.",
    inputDir: DEFAULT_MATRIX_INPUT_DIR,
    outputDir: path.join(DEFAULT_EXPERIMENT_ROOT, "ml-vs-vanilla-matrix-full"),
    modelPath: DEFAULT_MODEL_PATH,
    profileId: "default",
    limit: null
  })
});

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-ml-toggle-comparison.js [--experiment matrix-smoke|matrix-full] [--limit <n>]",
    "  node scripts/run-ml-toggle-comparison.js --input-dir <pdf-dir> [--output-dir <output-dir>] [--profile <id>] [--model <model.json>] [--limit <n>]",
    "",
    "Examples:",
    "  npm run ml:experiment",
    "  npm run ml:experiment -- --limit 12",
    "  npm run ml:compare -- --input-dir C:\\PDFs\\real-docs --output-dir output\\ml-experiments\\real-docs --limit 25"
  ].join("\n");
}

function parsePositiveLimit(value) {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  return numeric;
}

export function resolveExperimentOptions(args) {
  const hasCustomPath = args.has("--input-dir") || args.has("--output-dir");
  const experimentName = args.get("--experiment") || (hasCustomPath ? "custom" : "matrix-smoke");
  const preset = experimentName === "custom" ? null : EXPERIMENT_PRESETS[experimentName];
  if (experimentName !== "custom" && !preset) {
    throw new Error(`Unknown experiment '${experimentName}'.\n${usage()}`);
  }

  const explicitLimit = args.has("--limit") ? parsePositiveLimit(args.get("--limit")) : undefined;
  const inputDir = args.get("--input-dir") || preset?.inputDir || DEFAULT_MATRIX_INPUT_DIR;
  const outputDir = args.get("--output-dir") || preset?.outputDir || DEFAULT_CUSTOM_OUTPUT_DIR;
  const modelPath = args.get("--model") || args.get("--ml-model") || preset?.modelPath || DEFAULT_MODEL_PATH;

  return {
    experimentName,
    experimentDescription: preset?.description || "Custom A/B experiment over a caller-supplied PDF directory.",
    inputDir,
    outputDir,
    profileId: args.get("--profile") || preset?.profileId || "default",
    modelPath,
    limit: explicitLimit !== undefined ? explicitLimit : preset?.limit ?? null
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

function sanitizePathSegment(value, fallback = "document") {
  const cleaned = String(value || "")
    .replace(/[/\\]+/g, "__")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

async function listPdfFiles(inputDir) {
  const root = path.resolve(inputDir);
  const files = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        files.push({
          absolutePath: fullPath,
          relativePath: path.relative(root, fullPath).replace(/\\/g, "/")
        });
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readJsonIfPresent(filePath) {
  if (!filePath) {
    return null;
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function numericDelta(left, right) {
  const leftNumber = Number(left ?? 0);
  const rightNumber = Number(right ?? 0);
  return leftNumber - rightNumber;
}

async function summarizeRun(job) {
  const [validationReport, tagDeltaReport, writerReport, mlPredictions] = await Promise.all([
    readJsonIfPresent(job?.artifacts?.validationReport),
    readJsonIfPresent(job?.artifacts?.tagDeltaReport),
    readJsonIfPresent(job?.artifacts?.writerReport),
    readJsonIfPresent(job?.artifacts?.mlPredictions)
  ]);

  return {
    status: job?.status || "unknown",
    outputDir: job?.input?.outputDir || null,
    artifacts: job?.artifacts || {},
    validation: validationReport
      ? {
          isCompliant: Boolean(validationReport.isCompliant),
          failedRules: validationReport.summary?.failedRules ?? 0,
          failedChecks: validationReport.summary?.failedChecks ?? 0,
          findingCodes: (validationReport.findings || []).map((finding) => finding.code).slice(0, 12)
        }
      : null,
    tagDelta: tagDeltaReport?.delta || null,
    writer: writerReport
      ? {
          writerMode: writerReport.writerMode || null,
          nativeTaggingApplied: Boolean(writerReport.nativeTaggingApplied),
          pagesNative: writerReport.pagesNative ?? writerReport.pagesRewritten ?? 0,
          pagesRaster: writerReport.pagesRaster ?? 0,
          operatorMatchRate: writerReport.matchRate ?? writerReport.operatorMatchRate ?? null
        }
      : null,
    ml: mlPredictions
      ? {
          status: mlPredictions.status || "reported",
          mode: mlPredictions.runtimePolicy?.mode || null,
          tuningApplied: Boolean(mlPredictions.tuning?.applied),
          predictionCount: Array.isArray(mlPredictions.predictions) ? mlPredictions.predictions.length : 0,
          oodDecision: mlPredictions.documentProfile?.oodDecision || null
        }
      : null
  };
}

function compareRuns(withMl, withoutMl) {
  return {
    statusChanged: withMl.status !== withoutMl.status,
    complianceChanged: Boolean(withMl.validation?.isCompliant) !== Boolean(withoutMl.validation?.isCompliant),
    failedRulesDelta: numericDelta(withMl.validation?.failedRules, withoutMl.validation?.failedRules),
    failedChecksDelta: numericDelta(withMl.validation?.failedChecks, withoutMl.validation?.failedChecks),
    typedNodeDeltaDifference: numericDelta(withMl.tagDelta?.totalTypedNodesDelta, withoutMl.tagDelta?.totalTypedNodesDelta),
    markedContentDeltaDifference: numericDelta(withMl.tagDelta?.markedContentOperatorCountDelta, withoutMl.tagDelta?.markedContentOperatorCountDelta),
    tableAttributeDeltaDifference: numericDelta(withMl.tagDelta?.tableAttributeNodeCountDelta, withoutMl.tagDelta?.tableAttributeNodeCountDelta),
    writerModeChanged: (withMl.writer?.writerMode || null) !== (withoutMl.writer?.writerMode || null),
    mlPredictionStatus: withMl.ml?.status || "missing"
  };
}

function buildTotals(documents) {
  return documents.reduce(
    (totals, doc) => {
      totals.total += 1;
      if (doc.withMl.status === "completed") totals.withMlCompleted += 1;
      if (doc.withoutMl.status === "completed") totals.withoutMlCompleted += 1;
      if (doc.comparison.complianceChanged) totals.complianceChanged += 1;
      if (doc.comparison.statusChanged) totals.statusChanged += 1;
      if (doc.comparison.failedRulesDelta < 0) totals.mlReducedFailedRules += 1;
      if (doc.comparison.failedRulesDelta > 0) totals.mlIncreasedFailedRules += 1;
      return totals;
    },
    {
      total: 0,
      withMlCompleted: 0,
      withoutMlCompleted: 0,
      complianceChanged: 0,
      statusChanged: 0,
      mlReducedFailedRules: 0,
      mlIncreasedFailedRules: 0
    }
  );
}

function renderHtmlReport(report) {
  const experiment = report.experiment || {};
  const rows = report.documents
    .map(
      (doc) => `
        <tr>
          <td>${escapeHtml(doc.relativePath)}</td>
          <td>${escapeHtml(doc.withMl.status)}</td>
          <td>${escapeHtml(doc.withoutMl.status)}</td>
          <td>${escapeHtml(String(doc.comparison.failedRulesDelta))}</td>
          <td>${escapeHtml(String(doc.comparison.failedChecksDelta))}</td>
          <td>${escapeHtml(doc.comparison.mlPredictionStatus)}</td>
        </tr>
      `
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ML Enhanced vs Vanilla NoML Experiment</title>
    <style>
      body { font-family: "Segoe UI", Arial, sans-serif; margin: 2rem; color: #172326; background: #f7f4ed; }
      h1 { margin-bottom: 0.25rem; }
      .meta { display: grid; gap: 0.35rem; margin: 1rem 0 1.5rem; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; margin: 1.5rem 0; }
      .card { border: 1px solid #d8d1c3; background: #fffdf8; padding: 1rem; border-radius: 8px; }
      .card span { display: block; color: #526066; font-size: 0.84rem; }
      .card strong { display: block; margin-top: 0.3rem; font-size: 1.35rem; }
      .note { max-width: 72rem; line-height: 1.55; color: #526066; }
      table { width: 100%; border-collapse: collapse; background: #fffdf8; }
      th, td { text-align: left; padding: 0.7rem; border-bottom: 1px solid #ded8cc; vertical-align: top; }
      th { background: #ebe5d9; }
      code { background: #eee7dc; padding: 0.12rem 0.25rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>ML Enhanced vs Vanilla NoML Experiment</h1>
    <div class="meta">
      <span>Experiment: <code>${escapeHtml(experiment.name || "custom")}</code></span>
      <span>Input: <code>${escapeHtml(report.inputDir)}</code></span>
      <span>Output: <code>${escapeHtml(report.outputDir)}</code></span>
      <span>Model: <code>${escapeHtml(report.modelPath || "not supplied")}</code></span>
      <span>Profile: <code>${escapeHtml(report.profileId)}</code></span>
    </div>
    <p class="note">${escapeHtml(experiment.description || "Runs the same PDF set through two engine configurations.")}</p>
    <p class="note">Run order is ML-enhanced first, then vanilla-noML. The ML arm uses shadow mode so this report can compare evidence without changing the dashboard default, which remains ML off.</p>
    <section class="cards">
      <article class="card"><span>Total PDFs</span><strong>${report.totals.total}</strong></article>
      <article class="card"><span>ML-enhanced completed</span><strong>${report.totals.withMlCompleted}</strong></article>
      <article class="card"><span>vanilla-noML completed</span><strong>${report.totals.withoutMlCompleted}</strong></article>
      <article class="card"><span>Compliance changed</span><strong>${report.totals.complianceChanged}</strong></article>
      <article class="card"><span>ML reduced failed rules</span><strong>${report.totals.mlReducedFailedRules}</strong></article>
      <article class="card"><span>ML increased failed rules</span><strong>${report.totals.mlIncreasedFailedRules}</strong></article>
    </section>
    <table>
      <thead>
        <tr>
          <th>PDF</th>
          <th>ML-enhanced</th>
          <th>vanilla-noML</th>
          <th>Failed rules delta</th>
          <th>Failed checks delta</th>
          <th>ML artifact</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </body>
</html>
`;
}

export async function runMlToggleComparison({
  inputDir,
  outputDir,
  profileId = "default",
  modelPath = null,
  limit = null,
  experimentName = "custom",
  experimentDescription = "Custom A/B experiment over a caller-supplied PDF directory.",
  runPipelineImpl = runPipeline
}) {
  if (!inputDir || !outputDir) {
    throw new Error("inputDir and outputDir are required.");
  }

  const resolvedInputDir = path.resolve(inputDir);
  const resolvedOutputDir = path.resolve(outputDir);
  const inputStats = await stat(resolvedInputDir);
  if (!inputStats.isDirectory()) {
    throw new Error(`inputDir is not a directory: ${resolvedInputDir}`);
  }

  await mkdir(resolvedOutputDir, { recursive: true });
  const allPdfs = await listPdfFiles(resolvedInputDir);
  const selectedPdfs = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? allPdfs.slice(0, Number(limit))
    : allPdfs;

  const documents = [];
  for (let index = 0; index < selectedPdfs.length; index += 1) {
    const pdf = selectedPdfs[index];
    const caseDir = path.join(resolvedOutputDir, `${String(index + 1).padStart(4, "0")}-${sanitizePathSegment(pdf.relativePath)}`);
    const withMlOutputDir = path.join(caseDir, "with-ml");
    const withoutMlOutputDir = path.join(caseDir, "without-ml");

    const withMlJob = await runPipelineImpl({
      filePath: pdf.absolutePath,
      outputDir: withMlOutputDir,
      jobId: `ml-compare-${index + 1}-with-ml`,
      options: {
        profileId,
        mlClassifier: {
          enabled: true,
          mode: "shadow",
          ...(modelPath ? { modelPath } : {})
        }
      }
    });

    const withoutMlJob = await runPipelineImpl({
      filePath: pdf.absolutePath,
      outputDir: withoutMlOutputDir,
      jobId: `ml-compare-${index + 1}-without-ml`,
      options: {
        profileId,
        mlClassifier: {
          enabled: false
        }
      }
    });

    const withMl = await summarizeRun(withMlJob);
    const withoutMl = await summarizeRun(withoutMlJob);

    documents.push({
      relativePath: pdf.relativePath,
      sourcePath: pdf.absolutePath,
      caseDir,
      withMl,
      withoutMl,
      comparison: compareRuns(withMl, withoutMl)
    });
  }

  const report = {
    schemaVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    experiment: {
      name: experimentName,
      description: experimentDescription,
      variants: [
        {
          id: "with-ml",
          label: "ML-enhanced",
          outputSubdir: "with-ml",
          mlClassifier: {
            enabled: true,
            mode: "shadow",
            modelPath: modelPath ? path.resolve(modelPath) : null
          }
        },
        {
          id: "without-ml",
          label: "vanilla-noML",
          outputSubdir: "without-ml",
          mlClassifier: {
            enabled: false
          }
        }
      ],
      availablePdfCount: allPdfs.length,
      selectedPdfCount: selectedPdfs.length,
      limit: Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : null,
      evidencePolicy: "ML-enhanced runs in shadow mode; vanilla-noML is the deterministic baseline."
    },
    inputDir: resolvedInputDir,
    outputDir: resolvedOutputDir,
    profileId,
    modelPath: modelPath ? path.resolve(modelPath) : null,
    runOrder: ["with-ml", "without-ml"],
    displayRunOrder: ["ML-enhanced", "vanilla-noML"],
    totals: buildTotals(documents),
    documents
  };

  const summaryPath = path.join(resolvedOutputDir, "ml-toggle-comparison-summary.json");
  const reportPath = path.join(resolvedOutputDir, "ml-toggle-comparison-report.html");
  await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, renderHtmlReport(report));

  return {
    ...report,
    summaryPath,
    reportPath
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = resolveExperimentOptions(args);
  const report = await runMlToggleComparison(options);
  process.stdout.write(`${JSON.stringify({
    experiment: report.experiment,
    summaryPath: report.summaryPath,
    reportPath: report.reportPath,
    totals: report.totals
  }, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
