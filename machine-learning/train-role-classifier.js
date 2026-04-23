import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadArtifactDocumentCorpus, parseArgs, parsePathList, splitDocuments } from "./ml-artifacts.js";
import {
  evaluateRoleClassifier,
  finalizeRoleClassifierModel,
  trainRoleClassifier
} from "./role-classifier.js";

function usage() {
  return [
    "Usage: node machine-learning/train-role-classifier.js --artifacts-dir <pipeline-artifacts-dir>[;<pipeline-artifacts-dir>...] --model <model.json> [--report <report.json>] [--model-card <model-card.md>]",
    "",
    "Required:",
    "  --artifacts-dir  Directory, or semicolon/comma-separated directories, containing pipeline job artifacts with 04-semantic-ordered.json files.",
    "  --model          Output model JSON path.",
    "",
    "Optional:",
    "  --report         Output training/evaluation report JSON path.",
    "  --model-card     Output model card markdown path.",
    "  --classifier-id  Model identifier. Default: openautotag-role-baseline.",
    "  --dataset-version Dataset version label. Default: pilot.",
    "  --train-ratio    Deterministic document-level train split ratio. Default: 0.8.",
    "  --limit          Maximum number of artifact directories to load.",
    "  --no-dedupe      Disable deterministic corpus-signature dedupe.",
    "  --alpha          Naive Bayes smoothing alpha when --no-sweep is used.",
    "  --class-prior-exponent Class prior exponent when --no-sweep is used.",
    "  --min-feature-count Minimum corpus feature count when --no-sweep is used.",
    "  --no-sweep       Disable deterministic hyperparameter sweep."
  ].join("\n");
}

function defaultHyperparameterGrid() {
  const alphas = [0.25, 0.5, 1];
  const classPriorExponents = [0, 0.35, 0.7];
  const minFeatureCounts = [1, 2];
  const grid = [];

  for (const alpha of alphas) {
    for (const classPriorExponent of classPriorExponents) {
      for (const minFeatureCount of minFeatureCounts) {
        grid.push({ alpha, classPriorExponent, minFeatureCount });
      }
    }
  }

  return grid;
}

function candidateScore(metrics) {
  return [
    Number(metrics.supportedMacroF1 || 0),
    Number(metrics.balancedAccuracy || 0),
    Number(metrics.accuracy || 0),
    -Number(metrics.expectedCalibrationError || 0)
  ];
}

function compareCandidates(left, right) {
  const leftScore = candidateScore(left.metrics);
  const rightScore = candidateScore(right.metrics);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return rightScore[index] - leftScore[index];
    }
  }
  return left.config.alpha - right.config.alpha ||
    left.config.classPriorExponent - right.config.classPriorExponent ||
    left.config.minFeatureCount - right.config.minFeatureCount;
}

function trainCandidate(split, { classifierId, datasetVersion, config }) {
  const model = finalizeRoleClassifierModel(
    trainRoleClassifier(split.train, {
      classifierId,
      trainingDatasetVersion: datasetVersion,
      ...config
    })
  );
  const trainingMetrics = evaluateRoleClassifier(model, split.train);
  const metrics = evaluateRoleClassifier(model, split.evaluation);
  return {
    config,
    model,
    trainingMetrics,
    metrics
  };
}

function buildModelCard({ model, report }) {
  const evalMetrics = report.evaluation.metrics;
  return `# ${model.classifierId}

## Model Summary

- Model type: ${model.modelType}
- Version: ${model.modelVersion}
- Task head: ${model.taskHead}
- Dataset version: ${model.trainingDatasetVersion}
- Model hash: ${model.modelHash}
- Selected hyperparameters: ${JSON.stringify(model.selection?.selectedHyperparameters || {})}

## Intended Use

Research-only and shadow-mode role-classification evidence for OpenAutoTag semantic nodes. Deterministic engine output remains final.

## Training Data

- Artifact roots scanned: ${report.input.artifactRoots.length}
- Semantic artifacts discovered: ${report.input.discoveredArtifactCount}
- Semantic artifacts retained: ${report.input.documentCount}
- Duplicate semantic artifacts removed: ${report.input.duplicateArtifactCount}
- Training documents: ${report.split.trainDocuments}
- Evaluation documents: ${report.split.evaluationDocuments}
- Training examples: ${model.trainingSummary.exampleCount}
- Feature count: ${model.trainingSummary.featureCount}

## Evaluation

- Evaluation examples: ${evalMetrics.exampleCount}
- Accuracy: ${evalMetrics.accuracy}
- Macro F1: ${evalMetrics.macroF1}
- Supported macro F1: ${evalMetrics.supportedMacroF1}
- Balanced accuracy: ${evalMetrics.balancedAccuracy}
- Brier score: ${evalMetrics.brierScore}
- Expected calibration error: ${evalMetrics.expectedCalibrationError}
- Majority baseline accuracy: ${evalMetrics.majorityBaseline.accuracy}
- Zero-support evaluation roles: ${(evalMetrics.zeroSupportRoles || []).join(", ") || "none"}

## Release Status

This baseline does not satisfy release gates for assistive output. It is suitable for deterministic, reproducible pilot execution and shadow-mode evidence only.
`;
}

export async function trainRoleClassifierFromArtifacts({
  artifactsDir,
  modelPath,
  reportPath = null,
  modelCardPath = null,
  classifierId = "openautotag-role-baseline",
  datasetVersion = "pilot",
  trainRatio = 0.8,
  limit = null,
  sweep = true,
  alpha = 1,
  classPriorExponent = 0.35,
  minFeatureCount = 1,
  dedupe = true
}) {
  if (!artifactsDir || !modelPath) {
    throw new Error("artifactsDir and modelPath are required.");
  }

  const artifactDirs = parsePathList(artifactsDir);
  const corpus = await loadArtifactDocumentCorpus(artifactDirs, { limit, dedupe });
  const documents = corpus.documents;
  if (documents.length < 2) {
    throw new Error(`At least two artifact documents are required for a train/evaluation split; found ${documents.length}.`);
  }

  const split = splitDocuments(documents, { trainRatio });
  const sweepCandidates = sweep
    ? defaultHyperparameterGrid().map((config) => trainCandidate(split, { classifierId, datasetVersion, config }))
    : [trainCandidate(split, {
        classifierId,
        datasetVersion,
        config: {
          alpha,
          classPriorExponent,
          minFeatureCount
        }
      })];
  sweepCandidates.sort(compareCandidates);
  const selectedCandidate = sweepCandidates[0];
  const model = selectedCandidate.model;
  const trainingMetrics = selectedCandidate.trainingMetrics;
  const evaluationMetrics = selectedCandidate.metrics;
  const modelWithEvaluation = {
    ...model,
    selection: {
      method: sweep ? "deterministic-grid-search" : "fixed-hyperparameters",
      scoreOrder: ["supportedMacroF1", "balancedAccuracy", "accuracy", "negativeExpectedCalibrationError"],
      selectedHyperparameters: selectedCandidate.config
    },
    evaluation: {
      generatedAt: new Date().toISOString(),
      metrics: evaluationMetrics,
      trainingMetrics
    }
  };

  await mkdir(path.dirname(path.resolve(modelPath)), { recursive: true });
  await writeFile(modelPath, `${JSON.stringify(modelWithEvaluation, null, 2)}\n`);

  const report = {
    schemaVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    input: {
      artifactsDir: artifactDirs.length === 1 ? path.resolve(artifactDirs[0]) : null,
      artifactDirs: artifactDirs.map((dir) => path.resolve(dir)),
      artifactRoots: corpus.inventory.artifactRoots,
      dedupeEnabled: corpus.inventory.dedupeEnabled,
      discoveredArtifactCount: corpus.inventory.discoveredArtifactCount,
      selectedArtifactCount: corpus.inventory.selectedArtifactCount,
      duplicateArtifactCount: corpus.inventory.duplicateArtifactCount,
      duplicateArtifactSamples: corpus.inventory.duplicates,
      documentCount: documents.length,
      semanticArtifacts: documents.map((document) => ({
        artifactRootLabel: document.artifactRootLabel,
        relativeArtifactDir: document.relativeArtifactDir,
        corpusSignature: document.corpusSignature,
        semanticPath: document.semanticPath,
        layoutPath: document.layoutPath
      }))
    },
    split: {
      trainRatio: Number(trainRatio),
      trainDocuments: split.train.length,
      evaluationDocuments: split.evaluation.length,
      trainDocumentIds: split.train.map((document) => document.relativeArtifactDir || document.semanticDocument.documentId),
      evaluationDocumentIds: split.evaluation.map((document) => document.relativeArtifactDir || document.semanticDocument.documentId),
      diagnostics: split.diagnostics
    },
    model: {
      classifierId: modelWithEvaluation.classifierId,
      modelType: modelWithEvaluation.modelType,
      modelVersion: modelWithEvaluation.modelVersion,
      modelHash: modelWithEvaluation.modelHash,
      modelPath: path.resolve(modelPath)
    },
    trainingSummary: modelWithEvaluation.trainingSummary,
    hyperparameterSweep: {
      enabled: Boolean(sweep),
      selectedHyperparameters: selectedCandidate.config,
      candidates: sweepCandidates.map((candidate) => ({
        config: candidate.config,
        metrics: {
          exampleCount: candidate.metrics.exampleCount,
          accuracy: candidate.metrics.accuracy,
          supportedMacroF1: candidate.metrics.supportedMacroF1,
          balancedAccuracy: candidate.metrics.balancedAccuracy,
          expectedCalibrationError: candidate.metrics.expectedCalibrationError,
          zeroSupportRoles: candidate.metrics.zeroSupportRoles
        }
      }))
    },
    evaluation: {
      trainingMetrics,
      metrics: evaluationMetrics
    },
    releaseGateStatus: {
      mode: "research-only",
      deterministicOutputFinal: true,
      assistiveOutputAllowed: false,
      zeroSupportRoles: evaluationMetrics.zeroSupportRoles,
      reason: evaluationMetrics.zeroSupportRoles.length > 0
        ? "Pilot baseline is trained from engine-projected labels and still has evaluation roles with zero support."
        : "Pilot baseline is trained from engine-projected labels and has not passed release gates."
    }
  };

  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (modelCardPath) {
    await mkdir(path.dirname(path.resolve(modelCardPath)), { recursive: true });
    await writeFile(modelCardPath, buildModelCard({ model: modelWithEvaluation, report }));
  }

  return {
    model: modelWithEvaluation,
    report,
    modelPath: path.resolve(modelPath),
    reportPath: reportPath ? path.resolve(reportPath) : null,
    modelCardPath: modelCardPath ? path.resolve(modelCardPath) : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactsDir = args.get("--artifacts-dir");
  const modelPath = args.get("--model");

  if (!artifactsDir || !modelPath) {
    throw new Error(usage());
  }

  const result = await trainRoleClassifierFromArtifacts({
    artifactsDir,
    modelPath,
    reportPath: args.get("--report") || null,
    modelCardPath: args.get("--model-card") || null,
    classifierId: args.get("--classifier-id") || "openautotag-role-baseline",
    datasetVersion: args.get("--dataset-version") || "pilot",
    trainRatio: args.get("--train-ratio") ? Number(args.get("--train-ratio")) : 0.8,
    limit: args.get("--limit") ? Number(args.get("--limit")) : null,
    sweep: !args.has("--no-sweep"),
    alpha: args.get("--alpha") ? Number(args.get("--alpha")) : 1,
    classPriorExponent: args.get("--class-prior-exponent") ? Number(args.get("--class-prior-exponent")) : 0.35,
    minFeatureCount: args.get("--min-feature-count") ? Number(args.get("--min-feature-count")) : 1,
    dedupe: !args.has("--no-dedupe")
  });

  process.stdout.write(`${JSON.stringify({
    modelPath: result.modelPath,
    reportPath: result.reportPath,
    modelCardPath: result.modelCardPath,
    modelHash: result.model.modelHash,
    evaluation: result.report.evaluation.metrics
  }, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
