import Ajv2020 from "ajv/dist/2020.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import redactionReportSchema from "../contracts/redaction-report.schema.json" with { type: "json" };
import { finalizeRedactionReport } from "../modules/redactor/shared.js";
import { createAccessibilityPreparationStages, createTaggingOutputStages } from "./accessibility-stage-plan.js";
import { DEFAULT_STAGE_ATTEMPTS, repoRoot, runJsonStage, runManagedWorkload } from "./workload-runner.js";

const ajv = new Ajv2020({ allErrors: true });
const validateRedactionReport = ajv.compile(redactionReportSchema);

async function materializeRedactionReport({ artifacts, outputPath, workloadId }) {
  const redactionPlan = JSON.parse(await readFile(artifacts.redactionPlan, "utf8"));
  const report = finalizeRedactionReport({
    workloadId,
    sourcePdf: redactionPlan.sourcePdf,
    outputPdf: path.resolve(artifacts.taggedPdf),
    plan: redactionPlan,
    outputMode: redactionPlan.matches?.length ? "tagged-raster-redaction" : "tagged-raster-copy",
    accessibilityTreeRedacted: Boolean(redactionPlan.matches?.length)
  });

  if (!validateRedactionReport(report)) {
    throw new Error(`Tagged redaction report failed schema validation: ${ajv.errorsText(validateRedactionReport.errors)}`);
  }

  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return path.resolve(outputPath);
}

function createTagAndRedactStages({ filePath, resolvedOutputDir, artifacts, workload }) {
  return [
    ...createAccessibilityPreparationStages({ filePath, resolvedOutputDir, artifacts }),
    {
      key: "semanticRedaction",
      label: "semantic-redactor",
      outputPath: path.join(resolvedOutputDir, "04b-semantic-redacted.json"),
      run: async () => {
        const semanticOutputPath = path.join(resolvedOutputDir, "04b-semantic-redacted.json");
        const planOutputPath = path.join(resolvedOutputDir, "04c-redaction-plan.json");
        await runJsonStage(
          "modules/redactor/semantic-redactor.js",
          [
            "--semantic",
            artifacts.semanticOrdered,
            "--layout",
            artifacts.layout,
            "--semantic-output",
            semanticOutputPath,
            "--plan-output",
            planOutputPath
          ],
          path.join(resolvedOutputDir, "04d-semantic-redaction-stage.json")
        );

        return {
          outputPath: semanticOutputPath,
          artifacts: {
            semanticRedacted: semanticOutputPath,
            redactionPlan: planOutputPath
          }
        };
      }
    },
    ...createTaggingOutputStages({
      filePath,
      resolvedOutputDir,
      artifacts,
      semanticArtifactKey: "semanticRedacted",
      taggedPdfFileName: "06-tagged-redacted.pdf",
      includeValidator: false,
      writerArgs: () => (artifacts.redactionPlan ? ["--redactions", artifacts.redactionPlan] : [])
    }),
    {
      key: "redactionFinalize",
      label: "redaction-report",
      outputPath: path.join(resolvedOutputDir, "06b-redaction-report.json"),
      run: async () => {
        const reportPath = await materializeRedactionReport({
          artifacts,
          outputPath: path.join(resolvedOutputDir, "06b-redaction-report.json"),
          workloadId: workload.id
        });

        return {
          outputPath: reportPath,
          artifacts: { redactionReport: reportPath }
        };
      }
    },
    {
      key: "validator",
      label: "validator",
      outputPath: path.join(resolvedOutputDir, "07-validation-report.json"),
      run: async () => ({
        outputPath: await runJsonStage(
          "modules/validator/index.js",
          ["--pdf", artifacts.taggedPdf, "--manifest", artifacts.tagManifest],
          path.join(resolvedOutputDir, "07-validation-report.json")
        ),
        artifacts: { validationReport: path.join(resolvedOutputDir, "07-validation-report.json") }
      })
    }
  ];
}

export async function runTagAndRedactPipeline({
  filePath,
  outputDir,
  jobId = "manual-tag-redaction-run",
  workload = {
    id: "tag-and-ssn-redact",
    label: "Tag + SSN Redaction"
  },
  options = {},
  stageRunner = async ({ run }) => run(),
  maxStageAttempts = DEFAULT_STAGE_ATTEMPTS,
  onProgress,
  heartbeatIntervalMs
}) {
  const resolvedOutputDir = path.resolve(outputDir || path.join(repoRoot, "tmp", jobId));
  await mkdir(resolvedOutputDir, { recursive: true });

  return runManagedWorkload({
    filePath,
    outputDir: resolvedOutputDir,
    jobId,
    workload,
    options,
    stageRunner,
    maxStageAttempts,
    onProgress,
    heartbeatIntervalMs,
    buildStagePlan: (context) => createTagAndRedactStages({ ...context, workload })
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
    throw new Error("Usage: node orchestrator/tag-redaction-runner.js --pdf <input.pdf> --output-dir <outputDir>");
  }

  const result = await runTagAndRedactPipeline({ filePath, outputDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
