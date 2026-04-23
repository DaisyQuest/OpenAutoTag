import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runPipeline } from "../orchestrator/pipeline-runner.js";
import { parseArgs } from "../machine-learning/ml-artifacts.js";
import { trainRoleClassifierFromArtifacts } from "../machine-learning/train-role-classifier.js";

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
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
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

export async function runMlPilot({
  inputDir,
  outputDir,
  limit = null,
  profileId = "default",
  classifierId = "openautotag-role-baseline",
  datasetVersion = "pilot",
  trainRatio = 0.8,
  runPipelineImpl = runPipeline
}) {
  if (!inputDir || !outputDir) {
    throw new Error("inputDir and outputDir are required.");
  }

  const resolvedInputDir = path.resolve(inputDir);
  const resolvedOutputDir = path.resolve(outputDir);
  const jobsDir = path.join(resolvedOutputDir, "jobs");
  const modelsDir = path.join(resolvedOutputDir, "models");
  await mkdir(jobsDir, { recursive: true });
  await mkdir(modelsDir, { recursive: true });

  const allPdfs = await listPdfFiles(resolvedInputDir);
  const selectedPdfs = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? allPdfs.slice(0, Number(limit))
    : allPdfs;

  const jobs = [];
  for (let index = 0; index < selectedPdfs.length; index += 1) {
    const pdf = selectedPdfs[index];
    const caseDir = path.join(jobsDir, `${String(index + 1).padStart(4, "0")}-${sanitizePathSegment(pdf.relativePath)}`);
    const job = await runPipelineImpl({
      filePath: pdf.absolutePath,
      outputDir: caseDir,
      jobId: `ml-pilot-${index + 1}`,
      options: {
        profileId,
        mlClassifier: {
          enabled: false
        }
      }
    });
    jobs.push({
      relativePath: pdf.relativePath,
      outputDir: caseDir,
      status: job.status,
      artifacts: job.artifacts || {}
    });
  }

  const modelPath = path.join(modelsDir, `${classifierId}.json`);
  const trainingReportPath = path.join(resolvedOutputDir, "role-classifier-training-report.json");
  const modelCardPath = path.join(resolvedOutputDir, "role-classifier-model-card.md");
  const training = await trainRoleClassifierFromArtifacts({
    artifactsDir: jobsDir,
    modelPath,
    reportPath: trainingReportPath,
    modelCardPath,
    classifierId,
    datasetVersion,
    trainRatio
  });

  const pilotReport = {
    schemaVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    inputDir: resolvedInputDir,
    outputDir: resolvedOutputDir,
    profileId,
    selectedPdfCount: selectedPdfs.length,
    jobs,
    model: {
      classifierId,
      modelPath: training.modelPath,
      modelHash: training.model.modelHash,
      trainingReportPath,
      modelCardPath
    },
    evaluation: training.report.evaluation.metrics,
    releaseGateStatus: training.report.releaseGateStatus
  };
  const pilotReportPath = path.join(resolvedOutputDir, "ml-pilot-report.json");
  await writeFile(pilotReportPath, `${JSON.stringify(pilotReport, null, 2)}\n`);

  return {
    ...pilotReport,
    pilotReportPath,
    trainingReportPath,
    modelCardPath,
    modelPath: training.modelPath
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = args.get("--input-dir");
  const outputDir = args.get("--output-dir");

  if (!inputDir || !outputDir) {
    throw new Error("Usage: node scripts/run-ml-pilot.js --input-dir <pdf-dir> --output-dir <output-dir> [--limit <n>] [--profile <id>]");
  }

  const result = await runMlPilot({
    inputDir,
    outputDir,
    limit: args.get("--limit") ? Number(args.get("--limit")) : null,
    profileId: args.get("--profile") || "default",
    classifierId: args.get("--classifier-id") || "openautotag-role-baseline",
    datasetVersion: args.get("--dataset-version") || "pilot",
    trainRatio: args.get("--train-ratio") ? Number(args.get("--train-ratio")) : 0.8
  });

  process.stdout.write(`${JSON.stringify({
    pilotReportPath: result.pilotReportPath,
    trainingReportPath: result.trainingReportPath,
    modelCardPath: result.modelCardPath,
    modelPath: result.modelPath,
    evaluation: result.evaluation
  }, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
