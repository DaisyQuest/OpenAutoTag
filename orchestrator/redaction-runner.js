import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProfileContext, injectProfileEnv } from "./profile-runtime.js";
import { DEFAULT_STAGE_ATTEMPTS, repoRoot, runJsonStage, runManagedWorkload } from "./workload-runner.js";

function createPipelineStages({ filePath, resolvedOutputDir, artifacts, profileContext }) {
  const profileEnv = profileContext ? injectProfileEnv(profileContext) : {};
  return [
    {
      key: "layout",
      label: "parser",
      outputPath: path.join(resolvedOutputDir, "01-layout.json"),
      run: async () => ({
        outputPath: await runJsonStage("modules/parser/index.js", [filePath], path.join(resolvedOutputDir, "01-layout.json"), { env: profileEnv }),
        artifacts: { layout: path.join(resolvedOutputDir, "01-layout.json") }
      })
    },
    {
      key: "redactor",
      label: "redactor",
      outputPath: path.join(resolvedOutputDir, "02-redacted.pdf"),
      run: async () => {
        const redactedPdf = path.join(resolvedOutputDir, "02-redacted.pdf");
        const redactionReport = path.join(resolvedOutputDir, "02-redaction-report.json");
        await runJsonStage(
          "modules/redactor/index.js",
          ["--pdf", filePath, "--layout", artifacts.layout, "--output", redactedPdf],
          redactionReport
        );

        return {
          outputPath: redactedPdf,
          artifacts: {
            redactedPdf,
            redactionReport
          }
        };
      }
    }
  ];
}

export async function runRedactionPipeline({
  filePath,
  outputDir,
  jobId = "manual-redaction-run",
  workload = {
    id: "ssn-redaction",
    label: "SSN Redaction"
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
    throw new Error("Usage: node orchestrator/redaction-runner.js --pdf <input.pdf> --output-dir <outputDir>");
  }

  const result = await runRedactionPipeline({ filePath, outputDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
