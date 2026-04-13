import crypto from "node:crypto";
import path from "node:path";
import { getRuntimeSubdir } from "../scripts/runtime-paths.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createInitialStatusDetail(timestamp) {
  return {
    state: "queued_waiting_for_worker",
    message: "Waiting for an available worker.",
    stateSinceAt: timestamp,
    lastCheckInAt: timestamp,
    checkInCount: 1,
    completedStages: 0,
    totalStages: null,
    currentStage: null,
    lastStage: null
  };
}

function mergeStatusDetail(previous, update = {}, timestamp = new Date().toISOString()) {
  const source = previous && typeof previous === "object" ? previous : {};
  const patch = update && typeof update === "object" ? update : {};
  const nextState = hasOwn(patch, "state") ? patch.state : source.state || null;

  const next = {
    state: nextState,
    message: hasOwn(patch, "message") ? patch.message : source.message || null,
    stateSinceAt: hasOwn(patch, "stateSinceAt")
      ? patch.stateSinceAt
      : nextState && nextState !== source.state
        ? timestamp
        : source.stateSinceAt || timestamp,
    lastCheckInAt: hasOwn(patch, "lastCheckInAt") ? patch.lastCheckInAt : timestamp,
    checkInCount: Math.max(1, Number(source.checkInCount || 0) + 1),
    completedStages: hasOwn(patch, "completedStages") ? patch.completedStages : source.completedStages ?? 0,
    totalStages: hasOwn(patch, "totalStages") ? patch.totalStages : source.totalStages ?? null,
    currentStage: hasOwn(patch, "currentStage") ? cloneJsonValue(patch.currentStage) ?? null : cloneJsonValue(source.currentStage) ?? null,
    lastStage: hasOwn(patch, "lastStage") ? cloneJsonValue(patch.lastStage) ?? null : cloneJsonValue(source.lastStage) ?? null
  };

  if (hasOwn(patch, "heartbeatIntervalMs")) {
    next.heartbeatIntervalMs = patch.heartbeatIntervalMs;
  } else if (source.heartbeatIntervalMs != null) {
    next.heartbeatIntervalMs = source.heartbeatIntervalMs;
  }

  return next;
}

export function createJobQueue({ processor, outputRoot = getRuntimeSubdir("jobs", { repoRoot: process.cwd() }) }) {
  const jobs = new Map();
  const queue = [];
  let running = false;

  function updateJob(jobId, patch = {}) {
    const currentJob = jobs.get(jobId);

    if (!currentJob) {
      return null;
    }

    const timestamp = patch.updatedAt || new Date().toISOString();
    const nextJob = {
      ...currentJob,
      ...patch,
      updatedAt: timestamp
    };

    if (hasOwn(patch, "statusDetail")) {
      nextJob.statusDetail = mergeStatusDetail(currentJob.statusDetail, patch.statusDetail, timestamp);
    } else if (!currentJob.statusDetail) {
      nextJob.statusDetail = createInitialStatusDetail(timestamp);
    }

    if (hasOwn(patch, "error") && patch.error == null) {
      delete nextJob.error;
    }

    jobs.set(jobId, nextJob);
    return nextJob;
  }

  function finalizeJob(jobId, baseJob, result) {
    const currentJob = jobs.get(jobId) || baseJob;
    const timestamp = result.updatedAt || new Date().toISOString();

    jobs.set(jobId, {
      ...result,
      workload: result.workload || baseJob.workload,
      input: {
        ...(baseJob.input || {}),
        ...(result.input || {}),
        workloadId: baseJob.workload.id,
        options: baseJob.input.options || {}
      },
      createdAt: baseJob.createdAt,
      updatedAt: timestamp,
      statusDetail: mergeStatusDetail(
        currentJob?.statusDetail,
        result.statusDetail || {
          state: result.status || currentJob?.status || "completed",
          message:
            result.status === "failed"
              ? result.error || "Job failed."
              : result.status === "completed"
                ? "Job completed."
                : `Job is ${result.status || "running"}.`
        },
        timestamp
      )
    });
  }

  async function drain() {
    if (running || queue.length === 0) {
      return;
    }

    running = true;
    const jobId = queue.shift();
    const job = jobs.get(jobId);

    if (!job) {
      running = false;
      queueMicrotask(drain);
      return;
    }

    updateJob(jobId, {
      status: "running",
      statusDetail: {
        state: "worker_claimed",
        message: "Worker claimed the job and is preparing execution.",
        currentStage: null
      }
    });

    try {
      const result = await processor({
        filePath: job.input.filePath,
        outputDir: job.input.outputDir,
        workloadId: job.workload.id,
        workload: job.workload,
        options: job.input.options || {},
        jobId,
        onProgress: async (statusDetail) => {
          updateJob(jobId, {
            status: "running",
            statusDetail
          });
        }
      });

      finalizeJob(jobId, job, result);
    } catch (error) {
      const snapshot = error?.snapshot || error?.jobSnapshot;

      if (snapshot && snapshot.jobId === jobId) {
        finalizeJob(jobId, job, {
          ...snapshot,
          updatedAt: snapshot.updatedAt || new Date().toISOString()
        });
        return;
      }

      updateJob(jobId, {
        status: "failed",
        error: error.message,
        statusDetail: {
          state: "failed",
          message: error.message || "Job failed before completion.",
          currentStage: null
        }
      });
    } finally {
      running = false;
      queueMicrotask(drain);
    }
  }

  return {
    enqueue({ filePath, outputDir, workload, options = {}, inputMetadata = {} }) {
      const jobId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const resolvedFilePath = path.resolve(filePath);
      const resolvedOutputDir = path.resolve(outputDir || path.join(outputRoot, jobId));
      const job = {
        jobId,
        status: "queued",
        workload,
        input: {
          ...(inputMetadata || {}),
          filePath: resolvedFilePath,
          outputDir: resolvedOutputDir,
          workloadId: workload?.id,
          options
        },
        artifacts: {},
        createdAt: timestamp,
        updatedAt: timestamp,
        statusDetail: createInitialStatusDetail(timestamp)
      };

      jobs.set(jobId, job);
      queue.push(jobId);
      void drain();
      return clone(job);
    },
    get(jobId) {
      const job = jobs.get(jobId);
      return job ? clone(job) : null;
    },
    list() {
      return [...jobs.values()].map(clone);
    },
    stats() {
      const summary = {
        total: jobs.size,
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        pendingQueueDepth: queue.length
      };

      for (const job of jobs.values()) {
        if (summary[job.status] !== undefined) {
          summary[job.status] += 1;
        }
      }

      return clone(summary);
    }
  };
}
