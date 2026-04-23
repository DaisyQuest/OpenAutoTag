import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAccessibilityPreparationStages, createTaggingOutputStages } from "./accessibility-stage-plan.js";
import { normalizeMlClassifierOptions } from "./ml-tuning.js";
import { createProfileContext } from "./profile-runtime.js";
import { DEFAULT_STAGE_ATTEMPTS, runManagedWorkload } from "./workload-runner.js";

function createPipelineStages({ filePath, resolvedOutputDir, artifacts, profileContext, options }) {
  const mlClassifier = normalizeMlClassifierOptions(options);
  return [
    ...createAccessibilityPreparationStages({ filePath, resolvedOutputDir, artifacts, profileContext, options }),
    ...createTaggingOutputStages({
      filePath,
      resolvedOutputDir,
      artifacts,
      profileContext,
      semanticArtifactKey: mlClassifier.enabled ? "semanticMlTuned" : "semanticOrdered"
    })
  ];
}

export async function runPipeline({
  filePath,
  outputDir,
  jobId = "manual-run",
  workload = {
    id: "accessibility-tagging",
    label: "Accessibility Tagging"
  },
  options = {},
  stageRunner = async ({ run }) => run(),
  maxStageAttempts = DEFAULT_STAGE_ATTEMPTS,
  onProgress,
  heartbeatIntervalMs
}) {
  const profileContext = await createProfileContext(
    options.profileId || "default",
    options.profileOverrides || {}
  );

  return runManagedWorkload({
    filePath,
    outputDir,
    jobId,
    workload,
    options,
    profileContext,
    stageRunner,
    maxStageAttempts,
    onProgress,
    heartbeatIntervalMs,
    buildStagePlan: createPipelineStages
  });
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }

  const filePath = args.get("--pdf");
  const outputDir = args.get("--output-dir");
  const profileId = args.get("--profile");
  const forceWriterMode = args.get("--writer-mode");
  const forceAlreadyTaggedPolicy = args.get("--already-tagged-policy");
  const mlClassifierEnabled = args.has("--ml-classifier") || args.get("--ml-classifier-enabled") === "true";
  const mlModelPath = args.get("--ml-model") || args.get("--model");

  if (!filePath) {
    throw new Error("Usage: node orchestrator/pipeline-runner.js --pdf <input.pdf> --output-dir <outputDir> [--profile <id|auto>]");
  }

  let resolvedProfileId = profileId;
  let autoDetection = null;
  if (profileId === "auto") {
    // Auto-mode: parse the PDF once via NativeContentStreamParser
    // and run the profile detector on the resulting operators.json.
    // This is a cheap up-front invocation (~1-2s per doc) that
    // the full pipeline would do anyway — we just front-load it so
    // we can pick the right profile before expensive stages run.
    const { autoDetectProfile } = await import("./auto-profile.js");
    autoDetection = await autoDetectProfile({ pdfPath: filePath, outputDir });
    resolvedProfileId = autoDetection.profileId;
    process.stderr.write(
      `[auto-profile] ${path.basename(filePath)} → ${resolvedProfileId} (confidence ${autoDetection.confidence}). ${autoDetection.reasoning}\n`
    );
  }

  const options = resolvedProfileId ? { profileId: resolvedProfileId } : {};
  if (mlClassifierEnabled) {
    options.mlClassifier = {
      enabled: true,
      mode: "shadow",
      ...(mlModelPath ? { modelPath: mlModelPath } : {})
    };
  }
  if (forceWriterMode || forceAlreadyTaggedPolicy) {
    options.profileOverrides = options.profileOverrides || {};
    options.profileOverrides.pdfWriter = options.profileOverrides.pdfWriter || {};
    if (forceWriterMode) options.profileOverrides.pdfWriter.mode = forceWriterMode;
    if (forceAlreadyTaggedPolicy) options.profileOverrides.pdfWriter.alreadyTaggedPolicy = forceAlreadyTaggedPolicy;
  }
  const result = await runPipeline({ filePath, outputDir, options });
  if (autoDetection) result.autoProfile = autoDetection;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
