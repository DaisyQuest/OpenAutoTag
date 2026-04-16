import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProfileContext, injectProfileEnv } from "./profile-runtime.js";
import { DEFAULT_STAGE_ATTEMPTS, repoRoot, runJsonStage, runManagedWorkload } from "./workload-runner.js";

function createPipelineStages({ filePath, resolvedOutputDir, artifacts, profileContext }) {
  const profileEnv = profileContext ? injectProfileEnv(profileContext) : {};
  return [
    {
      key: "repair",
      label: "repairer",
      outputPath: path.join(resolvedOutputDir, "01-repaired.pdf"),
      run: async () => {
        const repairedPdf = path.join(resolvedOutputDir, "01-repaired.pdf");
        const repairReport = path.join(resolvedOutputDir, "01-repair-report.json");
        await runJsonStage(
          "modules/corruption-repairer/index.js",
          ["--pdf", filePath, "--output", repairedPdf],
          repairReport,
          { env: profileEnv }
        );

        return {
          outputPath: repairedPdf,
          artifacts: {
            repairedPdf,
            repairReport
          }
        };
      }
    }
  ];
}

export async function runCorruptionRepairPipeline({
  filePath,
  outputDir,
  jobId = "manual-corruption-repair-run",
  workload = {
    id: "corruption-repair",
    label: "PDF Corruption Repair"
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
    throw new Error("Usage: node orchestrator/corruption-repair-runner.js --pdf <input.pdf> --output-dir <outputDir>");
  }

  const result = await runCorruptionRepairPipeline({ filePath, outputDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
