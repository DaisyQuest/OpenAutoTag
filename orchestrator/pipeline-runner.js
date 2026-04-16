import { pathToFileURL } from "node:url";
import { createAccessibilityPreparationStages, createTaggingOutputStages } from "./accessibility-stage-plan.js";
import { createProfileContext } from "./profile-runtime.js";
import { DEFAULT_STAGE_ATTEMPTS, runManagedWorkload } from "./workload-runner.js";

function createPipelineStages({ filePath, resolvedOutputDir, artifacts, profileContext }) {
  return [
    ...createAccessibilityPreparationStages({ filePath, resolvedOutputDir, artifacts, profileContext }),
    ...createTaggingOutputStages({ filePath, resolvedOutputDir, artifacts, profileContext })
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
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }

  const filePath = args.get("--pdf");
  const outputDir = args.get("--output-dir");

  if (!filePath) {
    throw new Error("Usage: node orchestrator/pipeline-runner.js --pdf <input.pdf> --output-dir <outputDir>");
  }

  const result = await runPipeline({ filePath, outputDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
