import Ajv2020 from "ajv/dist/2020.js";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pipelineJobSchema from "../contracts/pipeline-job.schema.json" with { type: "json" };
import { getRuntimeSubdir } from "../scripts/runtime-paths.js";

const ajv = new Ajv2020({ allErrors: true });
const validateJob = ajv.compile(pipelineJobSchema);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");
export const DEFAULT_STAGE_ATTEMPTS = 3;

function execNode(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile("node", [scriptPath, ...args], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

export async function runJsonStage(scriptRelativePath, args, outputPath) {
  const stdout = await execNode(path.join(repoRoot, scriptRelativePath), args);
  await writeFile(outputPath, stdout);
  return path.resolve(outputPath);
}

function isRetryableStageError(error) {
  if (!error) {
    return false;
  }

  if (error.retryable === true || error.transient === true) {
    return true;
  }

  const message = String(error.message || error.stderr || error.stdout || error).toLowerCase();
  return /emfile|enfile|eagain|ebusy|etimedout|timeout|econnreset|epipe|temporarily unavailable|resource busy/.test(
    message
  );
}

function normalizeStageError(error) {
  const message = String(error?.message || error?.stderr || error?.stdout || error || "Stage execution failed");

  return {
    name: error?.name || "Error",
    message,
    code: error?.code || null,
    retryable: isRetryableStageError(error),
    stack: error?.stack || null
  };
}

function durationMs(startedAt, endedAt) {
  return Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
}

function createAttemptRecord({ attempt, startedAt, endedAt, status, error }) {
  const record = {
    attempt,
    status,
    startedAt,
    endedAt,
    durationMs: durationMs(startedAt, endedAt)
  };

  if (error) {
    record.error = error;
  }

  return record;
}

function createStageRecord({
  key,
  label,
  status,
  startedAt,
  endedAt,
  attempts,
  artifacts,
  error,
  outputPath,
  skippedReason,
  metadata
}) {
  const record = {
    key,
    label,
    status,
    startedAt,
    endedAt,
    durationMs: durationMs(startedAt, endedAt),
    attempts
  };

  if (artifacts && Object.keys(artifacts).length > 0) {
    record.artifacts = artifacts;
  }

  if (outputPath) {
    record.outputPath = path.resolve(outputPath);
  }

  if (error) {
    record.error = error;
  }

  if (skippedReason) {
    record.skippedReason = skippedReason;
  }

  if (metadata) {
    Object.assign(record, metadata);
  }

  return record;
}

function summarizeStages(stages) {
  return stages.reduce(
    (summary, stage) => {
      summary.total += 1;
      summary[`${stage.status}Stages`] = (summary[`${stage.status}Stages`] || 0) + 1;
      summary.totalAttempts += stage.attempts?.length || 0;
      summary.retryableFailures += stage.attempts?.filter((attempt) => attempt.status === "failed" && attempt.error?.retryable)
        .length || 0;
      return summary;
    },
    {
      total: 0,
      completedStages: 0,
      failedStages: 0,
      skippedStages: 0,
      totalAttempts: 0,
      retryableFailures: 0
    }
  );
}

function buildJobSnapshot({ jobId, status, workload, input, artifacts, stages, failureStage, error }) {
  const timestamp = new Date().toISOString();
  const snapshot = {
    jobId,
    status,
    workload,
    input,
    artifacts,
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
    stages,
    stageSummary: summarizeStages(stages || [])
  };

  if (failureStage) {
    snapshot.failureStage = failureStage;
  }

  if (error) {
    snapshot.error = error;
  }

  if (!validateJob(snapshot)) {
    throw new Error(`Pipeline job snapshot failed schema validation: ${ajv.errorsText(validateJob.errors)}`);
  }

  return snapshot;
}

async function executeStageWithRetries(stage, context, stageRunner, maxAttempts) {
  const attempts = [];
  const startedAt = new Date().toISOString();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = new Date().toISOString();

    try {
      const result = await stageRunner({
        stage,
        attempt,
        context,
        run: () => stage.run(context)
      });

      const attemptEndedAt = new Date().toISOString();
      attempts.push(createAttemptRecord({ attempt, startedAt: attemptStartedAt, endedAt: attemptEndedAt, status: "completed" }));

      const { artifacts = {}, outputPath = stage.outputPath, ...metadata } = result || {};

      return {
        status: "completed",
        stage: createStageRecord({
          key: stage.key,
          label: stage.label,
          status: "completed",
          startedAt,
          endedAt: attemptEndedAt,
          attempts,
          artifacts,
          outputPath,
          metadata
        }),
        artifacts
      };
    } catch (error) {
      const normalizedError = normalizeStageError(error);
      const attemptEndedAt = new Date().toISOString();
      attempts.push(
        createAttemptRecord({
          attempt,
          startedAt: attemptStartedAt,
          endedAt: attemptEndedAt,
          status: "failed",
          error: normalizedError
        })
      );
      lastError = normalizedError;

      if (attempt < maxAttempts && normalizedError.retryable) {
        continue;
      }

      return {
        status: "failed",
        stage: createStageRecord({
          key: stage.key,
          label: stage.label,
          status: "failed",
          startedAt,
          endedAt: attemptEndedAt,
          attempts,
          error: normalizedError,
          outputPath: stage.outputPath
        }),
        error: normalizedError
      };
    }
  }

  return {
    status: "failed",
    stage: createStageRecord({
      key: stage.key,
      label: stage.label,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      attempts,
      error: lastError,
      outputPath: stage.outputPath
    }),
    error: lastError
  };
}

function createSkippedStage(stage, reason) {
  const timestamp = new Date().toISOString();

  return createStageRecord({
    key: stage.key,
    label: stage.label,
    status: "skipped",
    startedAt: timestamp,
    endedAt: timestamp,
    attempts: [],
    skippedReason: reason,
    outputPath: stage.outputPath
  });
}

export async function runManagedWorkload({
  filePath,
  outputDir,
  jobId,
  workload,
  options = {},
  stageRunner = async ({ run }) => run(),
  maxStageAttempts = DEFAULT_STAGE_ATTEMPTS,
  buildStagePlan
}) {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedOutputDir = path.resolve(outputDir || path.join(getRuntimeSubdir("jobs", { repoRoot }), jobId));
  await mkdir(resolvedOutputDir, { recursive: true });

  const artifacts = {};
  const stages = [];
  const stagePlan = buildStagePlan({
    filePath: resolvedFilePath,
    resolvedOutputDir,
    artifacts,
    options,
    workload,
    jobId
  });
  let failureStage = null;
  let failureError = null;

  for (let index = 0; index < stagePlan.length; index += 1) {
    const stage = stagePlan[index];
    const result = await executeStageWithRetries(
      stage,
      { filePath: resolvedFilePath, outputDir: resolvedOutputDir, jobId, artifacts, options, workload },
      stageRunner,
      maxStageAttempts
    );
    stages.push(result.stage);

    if (result.status === "failed") {
      failureStage = result.stage;
      failureError = result.error;
      for (const skippedStage of stagePlan.slice(index + 1)) {
        stages.push(createSkippedStage(skippedStage, `Skipped after ${stage.key} failed.`));
      }
      break;
    }

    Object.assign(artifacts, result.artifacts);
  }

  if (failureStage) {
    return buildJobSnapshot({
      jobId,
      status: "failed",
      workload,
      input: {
        filePath: resolvedFilePath,
        outputDir: resolvedOutputDir,
        workloadId: workload.id,
        options
      },
      artifacts,
      stages,
      failureStage,
      error: `Stage ${failureStage.key} failed after ${failureStage.attempts?.length || 0} attempt(s): ${failureError?.message || failureStage.error?.message || "unknown error"}`
    });
  }

  return buildJobSnapshot({
    jobId,
    status: "completed",
    workload,
    input: {
      filePath: resolvedFilePath,
      outputDir: resolvedOutputDir,
      workloadId: workload.id,
      options
    },
    artifacts,
    stages
  });
}
