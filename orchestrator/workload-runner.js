import Ajv2020 from "ajv/dist/2020.js";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import pipelineJobSchema from "../contracts/pipeline-job.schema.json" with { type: "json" };
import { getRuntimeSubdir } from "../scripts/runtime-paths.js";

const ajv = new Ajv2020({ allErrors: true });
const validateJob = ajv.compile(pipelineJobSchema);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");
export const DEFAULT_STAGE_ATTEMPTS = 3;
export const DEFAULT_STATUS_HEARTBEAT_INTERVAL_MS = 5000;
const STDERR_TAIL_LIMIT = 64 * 1024;
const noopProgress = async () => {};

function captureStderrTail(buffer, chunk) {
  const next = buffer + chunk.toString("utf8");
  return next.length <= STDERR_TAIL_LIMIT ? next : next.slice(-STDERR_TAIL_LIMIT);
}

function resolveScriptPath(scriptPath) {
  return path.isAbsolute(scriptPath) ? scriptPath : path.join(repoRoot, scriptPath);
}

async function execNodeToFile(scriptPath, args, outputPath) {
  const resolvedScriptPath = resolveScriptPath(scriptPath);
  const resolvedOutputPath = path.resolve(outputPath);
  const tempOutputPath = path.join(
    path.dirname(resolvedOutputPath),
    `.${path.basename(resolvedOutputPath)}.${process.pid}.${Date.now()}.tmp`
  );

  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });

  const child = spawn("node", [resolvedScriptPath, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = captureStderrTail(stderrTail, chunk);
  });

  const stdoutPromise = pipeline(child.stdout, createWriteStream(tempOutputPath, { flags: "wx" })).catch((error) => {
    child.kill();
    throw error;
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const [{ code, signal }] = await Promise.all([exitPromise, stdoutPromise]);

    if (code !== 0) {
      const message = stderrTail.trim();
      throw new Error(message || signal || `Node process exited with code ${code}`);
    }

    await rm(resolvedOutputPath, { force: true });
    await rename(tempOutputPath, resolvedOutputPath);
    return resolvedOutputPath;
  } catch (error) {
    await rm(tempOutputPath, { force: true }).catch(() => {});
    throw new Error(stderrTail.trim() || error.message);
  }
}

export async function runJsonStage(scriptRelativePath, args, outputPath) {
  return execNodeToFile(scriptRelativePath, args, outputPath);
}

async function stageInputFile(filePath, outputDir) {
  const extension = path.extname(filePath) || ".pdf";
  const stagedFilePath = path.join(outputDir, `00-source${extension}`);

  await rm(stagedFilePath, { force: true }).catch(() => {});

  try {
    await link(filePath, stagedFilePath);
  } catch {
    await copyFile(filePath, stagedFilePath);
  }

  return path.resolve(stagedFilePath);
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

async function emitProgress(onProgress, update) {
  if (typeof onProgress !== "function") {
    return;
  }

  await onProgress(update);
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

function buildCurrentStageDetail({ stage, stageIndex, stageCount, attempt, maxAttempts, startedAt }) {
  return {
    key: stage.key,
    label: stage.label,
    index: stageIndex + 1,
    total: stageCount,
    attempt,
    maxAttempts,
    startedAt
  };
}

function buildStatusStageDetail(stage, overrides = {}) {
  if (!stage) {
    return null;
  }

  return {
    key: stage.key,
    label: stage.label,
    status: stage.status,
    startedAt: stage.startedAt,
    endedAt: stage.endedAt,
    durationMs: stage.durationMs,
    ...overrides
  };
}

function findLastExecutedStage(stages) {
  return [...(stages || [])].reverse().find((stage) => stage.status !== "skipped") || null;
}

function startStageHeartbeat({
  onProgress,
  stage,
  stageIndex,
  stageCount,
  attempt,
  maxAttempts,
  startedAt,
  completedStages,
  heartbeatIntervalMs
}) {
  if (typeof onProgress !== "function" || heartbeatIntervalMs <= 0) {
    return () => {};
  }

  const timer = setInterval(() => {
    void Promise.resolve(
      onProgress({
        state: "running_stage",
        message: `Still running stage ${stageIndex + 1}/${stageCount}: ${stage.label} (attempt ${attempt}/${maxAttempts}).`,
        totalStages: stageCount,
        completedStages,
        heartbeatIntervalMs,
        currentStage: buildCurrentStageDetail({
          stage,
          stageIndex,
          stageCount,
          attempt,
          maxAttempts,
          startedAt
        })
      })
    ).catch(() => {});
  }, heartbeatIntervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
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

function buildJobSnapshot({ jobId, status, workload, input, artifacts, stages, failureStage, error, statusDetail }) {
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

  if (statusDetail) {
    snapshot.statusDetail = statusDetail;
  }

  if (!validateJob(snapshot)) {
    throw new Error(`Pipeline job snapshot failed schema validation: ${ajv.errorsText(validateJob.errors)}`);
  }

  return snapshot;
}

async function executeStageWithRetries(
  stage,
  context,
  stageRunner,
  maxAttempts,
  { stageIndex, stageCount, onProgress, heartbeatIntervalMs }
) {
  const attempts = [];
  const startedAt = new Date().toISOString();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = new Date().toISOString();
    await emitProgress(onProgress, {
      state: "running_stage",
      message: `Running stage ${stageIndex + 1}/${stageCount}: ${stage.label} (attempt ${attempt}/${maxAttempts}).`,
      totalStages: stageCount,
      completedStages: stageIndex,
      heartbeatIntervalMs,
      currentStage: buildCurrentStageDetail({
        stage,
        stageIndex,
        stageCount,
        attempt,
        maxAttempts,
        startedAt: attemptStartedAt
      })
    });
    const stopHeartbeat = startStageHeartbeat({
      onProgress,
      stage,
      stageIndex,
      stageCount,
      attempt,
      maxAttempts,
      startedAt: attemptStartedAt,
      completedStages: stageIndex,
      heartbeatIntervalMs
    });

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
      const completedStage = createStageRecord({
        key: stage.key,
        label: stage.label,
        status: "completed",
        startedAt,
        endedAt: attemptEndedAt,
        attempts,
        artifacts,
        outputPath,
        metadata
      });
      stopHeartbeat();
      await emitProgress(onProgress, {
        state: "stage_completed",
        message: `Completed stage ${stageIndex + 1}/${stageCount}: ${stage.label}.`,
        totalStages: stageCount,
        completedStages: stageIndex + 1,
        heartbeatIntervalMs,
        currentStage: null,
        lastStage: buildStatusStageDetail(completedStage, {
          attempt,
          maxAttempts
        })
      });

      return {
        status: "completed",
        stage: completedStage,
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
      stopHeartbeat();

      if (attempt < maxAttempts && normalizedError.retryable) {
        await emitProgress(onProgress, {
          state: "retrying_stage",
          message: `Retrying stage ${stageIndex + 1}/${stageCount}: ${stage.label} after retryable failure.`,
          totalStages: stageCount,
          completedStages: stageIndex,
          heartbeatIntervalMs,
          currentStage: null,
          lastStage: {
            key: stage.key,
            label: stage.label,
            status: "failed",
            endedAt: attemptEndedAt,
            attempt,
            maxAttempts,
            errorMessage: normalizedError.message
          }
        });
        continue;
      }

      const failedStage = createStageRecord({
        key: stage.key,
        label: stage.label,
        status: "failed",
        startedAt,
        endedAt: attemptEndedAt,
        attempts,
        error: normalizedError,
        outputPath: stage.outputPath
      });
      await emitProgress(onProgress, {
        state: "failed",
        message: `Stage ${stageIndex + 1}/${stageCount} failed: ${stage.label}.`,
        totalStages: stageCount,
        completedStages: stageIndex,
        heartbeatIntervalMs,
        currentStage: null,
        lastStage: buildStatusStageDetail(failedStage, {
          attempt,
          maxAttempts,
          errorMessage: normalizedError.message
        })
      });

      return {
        status: "failed",
        stage: failedStage,
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
  onProgress = noopProgress,
  heartbeatIntervalMs = DEFAULT_STATUS_HEARTBEAT_INTERVAL_MS,
  buildStagePlan
}) {
  const resolvedSourceFilePath = path.resolve(filePath);
  const resolvedOutputDir = path.resolve(outputDir || path.join(getRuntimeSubdir("jobs", { repoRoot }), jobId));
  await emitProgress(onProgress, {
    state: "preparing_workspace",
    message: "Preparing the job workspace.",
    completedStages: 0,
    totalStages: null,
    currentStage: null,
    heartbeatIntervalMs
  });
  await mkdir(resolvedOutputDir, { recursive: true });
  await emitProgress(onProgress, {
    state: "staging_input",
    message: "Staging the source PDF into the job workspace.",
    completedStages: 0,
    totalStages: null,
    currentStage: null,
    heartbeatIntervalMs
  });
  const stagedFilePath = await stageInputFile(resolvedSourceFilePath, resolvedOutputDir);

  const artifacts = {};
  const stages = [];
  await emitProgress(onProgress, {
    state: "building_stage_plan",
    message: "Building the workload stage plan.",
    completedStages: 0,
    totalStages: null,
    currentStage: null,
    heartbeatIntervalMs
  });
  const stagePlan = buildStagePlan({
    filePath: stagedFilePath,
    sourceFilePath: resolvedSourceFilePath,
    resolvedOutputDir,
    artifacts,
    options,
    workload,
    jobId
  });
  const totalStages = stagePlan.length;
  let failureStage = null;
  let failureError = null;

  for (let index = 0; index < stagePlan.length; index += 1) {
    const stage = stagePlan[index];
    const result = await executeStageWithRetries(
      stage,
      {
        filePath: stagedFilePath,
        sourceFilePath: resolvedSourceFilePath,
        outputDir: resolvedOutputDir,
        jobId,
        artifacts,
        options,
        workload
      },
      stageRunner,
      maxStageAttempts,
      {
        stageIndex: index,
        stageCount: totalStages,
        onProgress,
        heartbeatIntervalMs
      }
    );
    stages.push(result.stage);

    if (result.status === "failed") {
      failureStage = result.stage;
      failureError = result.error;
      await emitProgress(onProgress, {
        state: "failed",
        message: `Stage ${failureStage.key} failed. Remaining stages will be skipped.`,
        totalStages,
        completedStages: stages.filter((stageRecord) => stageRecord.status === "completed").length,
        currentStage: null,
        heartbeatIntervalMs,
        lastStage: buildStatusStageDetail(failureStage, {
          errorMessage: failureError?.message || failureStage.error?.message || "unknown error"
        })
      });
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
        filePath: resolvedSourceFilePath,
        stagedFilePath,
        outputDir: resolvedOutputDir,
        workloadId: workload.id,
        options
      },
      artifacts,
      stages,
      failureStage,
      error: `Stage ${failureStage.key} failed after ${failureStage.attempts?.length || 0} attempt(s): ${failureError?.message || failureStage.error?.message || "unknown error"}`,
      statusDetail: {
        state: "failed",
        message: `Stage ${failureStage.key} failed after ${failureStage.attempts?.length || 0} attempt(s).`,
        totalStages,
        completedStages: stages.filter((stageRecord) => stageRecord.status === "completed").length,
        currentStage: null,
        heartbeatIntervalMs,
        lastStage: buildStatusStageDetail(failureStage, {
          errorMessage: failureError?.message || failureStage.error?.message || "unknown error"
        })
      }
    });
  }

  await emitProgress(onProgress, {
    state: "finalizing_job",
    message: totalStages
      ? `Finalizing the job snapshot after ${totalStages} completed stage${totalStages === 1 ? "" : "s"}.`
      : "Finalizing the job snapshot.",
    totalStages,
    completedStages: totalStages,
    currentStage: null,
    heartbeatIntervalMs,
    lastStage: buildStatusStageDetail(findLastExecutedStage(stages))
  });

  return buildJobSnapshot({
    jobId,
    status: "completed",
    workload,
    input: {
      filePath: resolvedSourceFilePath,
      stagedFilePath,
      outputDir: resolvedOutputDir,
      workloadId: workload.id,
      options
    },
    artifacts,
    stages,
    statusDetail: {
      state: "completed",
      message: totalStages
        ? `Completed ${totalStages} stage${totalStages === 1 ? "" : "s"}.`
        : "No stages were scheduled for this workload.",
      totalStages,
      completedStages: totalStages,
      currentStage: null,
      heartbeatIntervalMs,
      lastStage: buildStatusStageDetail(findLastExecutedStage(stages))
    }
  });
}
