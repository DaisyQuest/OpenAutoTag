import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyMlTuning } from "../scripts/apply-ml-tuning.js";
import { loadArtifactDocumentCorpus, parseArgs, parsePathList } from "./ml-artifacts.js";

const DEFAULT_OUTPUT_DIR = path.resolve("output", "ml-human-review", "predictions-large-v1");
const DEFAULT_MODEL_PATH = path.resolve("output", "ml-pilot", "role-baseline-large-v1.json");

function usage() {
  return [
    "Usage: node machine-learning/generate-human-review-predictions.js --artifacts-dir <dir>[;<dir>...] [--model <model.json>] [--output-dir <dir>] [--limit <n>] [--no-dedupe] [--force]",
    "",
    "Creates review-ready ML prediction reports from existing 04-semantic-ordered.json and 02-layout-enriched.json artifacts.",
    "This does not rerun parsing, writing, validation, or PDF rasterization."
  ].join("\n");
}

function sanitizePathSegment(value) {
  return String(value || "artifact")
    .replace(/^[A-Za-z]:/, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "artifact";
}

function buildCaseName(document, index) {
  const signature = String(document.corpusSignature || "").slice(0, 12) || String(index + 1).padStart(4, "0");
  const sourceName = sanitizePathSegment(path.basename(document.sourcePath || document.relativeArtifactDir || "artifact", ".pdf"));
  return `${String(index + 1).padStart(4, "0")}-${signature}-${sourceName}`;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function generateHumanReviewPredictions({
  artifactsDir,
  modelPath = DEFAULT_MODEL_PATH,
  outputDir = DEFAULT_OUTPUT_DIR,
  limit = null,
  dedupe = true,
  force = false
} = {}) {
  const artifactDirs = parsePathList(artifactsDir);
  if (artifactDirs.length === 0) {
    throw new Error("artifactsDir is required.");
  }

  const corpus = await loadArtifactDocumentCorpus(artifactDirs, { limit, dedupe });
  const resolvedOutputDir = path.resolve(outputDir);
  const jobsDir = path.join(resolvedOutputDir, "jobs");
  const jobs = [];

  await mkdir(jobsDir, { recursive: true });

  for (let index = 0; index < corpus.documents.length; index += 1) {
    const document = corpus.documents[index];
    const caseDir = path.join(jobsDir, buildCaseName(document, index));
    const tunedSemanticPath = path.join(caseDir, "04b-semantic-ml.json");
    const reportPath = path.join(caseDir, "04b-ml-predictions.json");
    await mkdir(caseDir, { recursive: true });

    const alreadyGenerated = await pathExists(reportPath);
    if (force || !alreadyGenerated) {
      await applyMlTuning({
        semanticPath: document.semanticPath,
        layoutPath: document.layoutPath,
        outputPath: tunedSemanticPath,
        reportPath,
        modelPath,
        mode: "shadow"
      });
    }

    jobs.push({
      relativeArtifactDir: document.relativeArtifactDir,
      corpusSignature: document.corpusSignature,
      semanticPath: document.semanticPath,
      layoutPath: document.layoutPath,
      tunedSemanticPath,
      reportPath,
      skippedExisting: alreadyGenerated && !force
    });
  }

  const summary = {
    schemaVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    input: {
      artifactDirs: artifactDirs.map((dir) => path.resolve(dir)),
      modelPath: path.resolve(modelPath),
      outputDir: resolvedOutputDir,
      limit,
      dedupe,
      force
    },
    corpusInventory: corpus.inventory,
    totals: {
      documents: corpus.documents.length,
      predictionReports: jobs.length
    },
    jobs
  };

  const summaryPath = path.join(resolvedOutputDir, "human-review-predictions-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return {
    ...summary,
    summaryPath,
    reportsDir: jobsDir
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactsDir = args.get("--artifacts-dir");

  if (!artifactsDir) {
    throw new Error(usage());
  }

  const result = await generateHumanReviewPredictions({
    artifactsDir,
    modelPath: args.get("--model") || DEFAULT_MODEL_PATH,
    outputDir: args.get("--output-dir") || DEFAULT_OUTPUT_DIR,
    limit: args.get("--limit") ? Number(args.get("--limit")) : null,
    dedupe: !args.has("--no-dedupe"),
    force: args.has("--force")
  });

  process.stdout.write(`${JSON.stringify({
    summaryPath: result.summaryPath,
    reportsDir: result.reportsDir,
    totals: result.totals,
    corpus: {
      discovered: result.corpusInventory.discoveredArtifactCount,
      retained: result.corpusInventory.loadedDocumentCount,
      duplicates: result.corpusInventory.duplicateArtifactCount
    }
  }, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
