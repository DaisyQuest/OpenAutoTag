import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROLE_CLASSIFIER_VERSION,
  buildMlPredictionDocument,
  createPredictionEntries
} from "../machine-learning/role-classifier.js";

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

function buildPredictionReport({ semantic, layout = null, semanticPath, outputPath, classifierId, mode, modelPath, modelAvailable }) {
  const timestamp = new Date().toISOString();
  const status = modelAvailable ? "completed" : "not-configured";
  return {
    schemaVersion: "0.1.0-draft",
    status,
    generatedAt: timestamp,
    documentId: semantic.documentId,
    source: {
      layoutDocumentId: semantic.source?.layoutDocumentId || layout?.documentId || "unknown-layout",
      semanticDocumentId: semantic.documentId,
      filePath: semantic.source?.filePath || null,
      semanticPath: path.resolve(semanticPath),
      tunedSemanticPath: path.resolve(outputPath)
    },
    model: {
      id: classifierId,
      version: ROLE_CLASSIFIER_VERSION,
      taskHeads: [
        "role-classification",
        "ood-detection"
      ],
      trainingDatasetVersion: "not-trained",
      modelPath: modelPath || null,
      available: modelAvailable
    },
    runtimePolicy: {
      mode,
      fallbackBehavior: "deterministic-on-any-policy-fail",
      abstentionEnabled: true
    },
    documentProfile: {
      oodScore: 1,
      oodDecision: modelAvailable ? "near-boundary" : "unknown",
      matchedProfiles: []
    },
    predictions: [],
    calibration: {
      datasetVersion: "not-trained",
      globalExpectedCalibrationError: 0,
      globalBrierScore: 0,
      sliceStatus: [
        {
          slice: "all",
          status: modelAvailable ? "not-measured" : "fail",
          expectedCalibrationError: 0
        }
      ]
    },
    shadowMode: {
      enabled: mode === "shadow",
      wouldChangeOutput: false,
      decisionLogs: []
    },
    tuning: {
      applied: false,
      semanticNodesInput: Array.isArray(semantic.nodes) ? semantic.nodes.length : 0,
      semanticNodesOutput: Array.isArray(semantic.nodes) ? semantic.nodes.length : 0,
      reason: modelAvailable
        ? "No model adapter is implemented yet, so semantic output was preserved."
        : "No trained classifier model was configured; semantic output was preserved."
    }
  };
}

async function pathExists(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function applyMlTuning({
  semanticPath,
  layoutPath = null,
  outputPath,
  reportPath,
  classifierId = "openautotag-ml-classifier",
  mode = "shadow",
  modelPath = null
}) {
  if (!semanticPath || !outputPath) {
    throw new Error("semanticPath and outputPath are required.");
  }

  const semantic = JSON.parse(await readFile(semanticPath, "utf8"));
  const layout = layoutPath ? JSON.parse(await readFile(layoutPath, "utf8")) : null;
  const modelAvailable = await pathExists(modelPath);
  const model = modelAvailable ? JSON.parse(await readFile(modelPath, "utf8")) : null;
  const predictions = model
    ? createPredictionEntries({
        semanticDocument: semantic,
        layoutDocument: layout,
        model,
        mode
      })
    : [];
  const tunedSemantic = {
    ...semantic,
    mlTuning: {
      enabled: true,
      mode,
      classifierId: model?.classifierId || classifierId,
      modelPath: modelPath || null,
      modelHash: model?.modelHash || null,
      predictionCount: predictions.length,
      applied: false,
      status: modelAvailable ? "shadow-predictions-emitted" : "model-not-configured"
    }
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(tunedSemantic, null, 2)}\n`);

  const report = model
    ? buildMlPredictionDocument({
        semanticDocument: semantic,
        layoutDocument: layout,
        model,
        predictions,
        semanticPath: path.resolve(semanticPath),
        outputPath: path.resolve(outputPath),
        mode,
        status: "completed"
      })
    : buildPredictionReport({
        semantic,
        layout,
        semanticPath,
        outputPath,
        classifierId,
        mode,
        modelPath,
        modelAvailable
      });

  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return tunedSemantic;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const semanticPath = args.get("--semantic");
  const layoutPath = args.get("--layout") || null;
  const outputPath = args.get("--output");
  const reportPath = args.get("--report");
  const classifierId = args.get("--classifier-id") || "openautotag-ml-classifier";
  const mode = args.get("--mode") || "shadow";
  const modelPath = args.get("--model") || null;

  if (!semanticPath || !outputPath) {
    throw new Error("Usage: node scripts/apply-ml-tuning.js --semantic <semantic.json> --output <semantic.ml.json> [--layout <layout.json>] [--report <ml-predictions.json>] [--classifier-id <id>] [--mode shadow|assistive] [--model <model.json>]");
  }

  const tuned = await applyMlTuning({
    semanticPath,
    layoutPath,
    outputPath,
    reportPath,
    classifierId,
    mode,
    modelPath
  });
  process.stdout.write(`${JSON.stringify(tuned, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
