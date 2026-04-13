import crypto from "node:crypto";
import path from "node:path";
import { getRuntimeSubdir } from "../scripts/runtime-paths.js";

export const DEFAULT_REMOTE_LEASE_GRACE_MS = 30_000;
export const DEFAULT_LOCAL_WORKER_ID = "local-main";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function toPositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function computeLeaseDurationMs(heartbeatIntervalMs, remoteLeaseGraceMs) {
  const heartbeatWindowMs = toPositiveInteger(heartbeatIntervalMs, 0) * 3;
  return Math.max(toPositiveInteger(remoteLeaseGraceMs, DEFAULT_REMOTE_LEASE_GRACE_MS), heartbeatWindowMs);
}

function buildLeaseExpiry(timestamp, heartbeatIntervalMs, remoteLeaseGraceMs) {
  return new Date(new Date(timestamp).getTime() + computeLeaseDurationMs(heartbeatIntervalMs, remoteLeaseGraceMs)).toISOString();
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

function mergeWorker(previous, patch, timestamp) {
  if (patch == null) {
    return null;
  }

  const source = previous && typeof previous === "object" ? cloneJsonValue(previous) : {};
  const next = {
    ...source,
    ...cloneJsonValue(patch),
    updatedAt: timestamp
  };

  if (!next.assignedAt) {
    next.assignedAt = timestamp;
  }

  if (!next.kind) {
    next.kind = "local";
  }

  if (!next.id) {
    next.id = DEFAULT_LOCAL_WORKER_ID;
  }

  return next;
}

function buildLocalWorker(timestamp) {
  return {
    kind: "local",
    id: DEFAULT_LOCAL_WORKER_ID,
    label: "Primary server",
    assignedAt: timestamp,
    lastHeartbeatAt: timestamp
  };
}

function buildRemoteWorker(agent, timestamp, heartbeatIntervalMs) {
  const agentId = String(agent?.agentId || "").trim();
  return {
    kind: "agent",
    id: agentId,
    label: String(agent?.label || agent?.hostname || agentId || "Remote agent"),
    hostname: String(agent?.hostname || "").trim() || null,
    version: String(agent?.version || "").trim() || null,
    assignedAt: timestamp,
    lastHeartbeatAt: timestamp,
    heartbeatIntervalMs: toPositiveInteger(heartbeatIntervalMs, 0) || undefined
  };
}

export function createJobQueue({
  processor,
  outputRoot = getRuntimeSubdir("jobs", { repoRoot: process.cwd() }),
  remoteLeaseGraceMs = DEFAULT_REMOTE_LEASE_GRACE_MS
}) {
  const jobs = new Map();
  const queue = [];
  const remoteAssignments = new Map();
  let localRunning = false;
  let remoteCapacityProvider = () => 0;

  function getRemoteCapacity() {
    try {
      return Math.max(0, toPositiveInteger(remoteCapacityProvider(), 0));
    } catch {
      return 0;
    }
  }

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

    if (hasOwn(patch, "worker")) {
      nextJob.worker = mergeWorker(currentJob.worker, patch.worker, timestamp);
    } else if (currentJob.worker) {
      nextJob.worker = cloneJsonValue(currentJob.worker);
    }

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

  function removeFromQueue(jobId) {
    const index = queue.indexOf(jobId);
    if (index >= 0) {
      queue.splice(index, 1);
    }
  }

  function enqueueFront(jobId) {
    removeFromQueue(jobId);
    queue.unshift(jobId);
  }

  function recoverExpiredRemoteClaims(now = new Date()) {
    const timestamp = now.toISOString();
    const expired = [];

    for (const [jobId, assignment] of remoteAssignments.entries()) {
      if (new Date(assignment.expiresAt).getTime() > now.getTime()) {
        continue;
      }

      remoteAssignments.delete(jobId);
      const currentJob = jobs.get(jobId);

      if (!currentJob || currentJob.status !== "running" || currentJob.worker?.kind !== "agent") {
        continue;
      }

      updateJob(jobId, {
        status: "queued",
        worker: null,
        statusDetail: {
          state: "queued_waiting_for_worker",
          message: `Agent ${assignment.agentLabel || assignment.agentId || "remote"} stopped heartbeating. Job returned to the queue.`,
          completedStages: currentJob.statusDetail?.completedStages ?? 0,
          totalStages: currentJob.statusDetail?.totalStages ?? null,
          currentStage: null,
          lastStage: currentJob.statusDetail?.lastStage ?? null,
          stateSinceAt: timestamp,
          heartbeatIntervalMs: null
        }
      });
      enqueueFront(jobId);
      expired.push({
        jobId,
        ...cloneJsonValue(assignment),
        expiredAt: timestamp
      });
    }

    if (expired.length > 0) {
      queueMicrotask(drain);
    }

    return expired;
  }

  function finalizeJob(jobId, baseJob, result) {
    const currentJob = jobs.get(jobId) || baseJob;
    const timestamp = result.updatedAt || new Date().toISOString();
    const worker = cloneJsonValue(result.worker || currentJob?.worker || null);

    if (worker) {
      worker.completedAt = worker.completedAt || timestamp;
      worker.lastHeartbeatAt = worker.lastHeartbeatAt || timestamp;
    }

    remoteAssignments.delete(jobId);

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
      worker,
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
    recoverExpiredRemoteClaims();

    if (localRunning || queue.length === 0) {
      return;
    }

    if (queue.length <= getRemoteCapacity()) {
      return;
    }

    localRunning = true;
    const jobId = queue.shift();
    const job = jobs.get(jobId);

    if (!job) {
      localRunning = false;
      queueMicrotask(drain);
      return;
    }

    const claimedAt = new Date().toISOString();
    updateJob(jobId, {
      status: "running",
      worker: buildLocalWorker(claimedAt),
      statusDetail: {
        state: "local_worker_claimed",
        message: "Primary server claimed the job and is preparing execution.",
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
            worker: {
              lastHeartbeatAt: new Date().toISOString(),
              heartbeatIntervalMs: statusDetail?.heartbeatIntervalMs
            },
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
        worker: {
          completedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString()
        },
        statusDetail: {
          state: "failed",
          message: error.message || "Job failed before completion.",
          currentStage: null
        }
      });
    } finally {
      localRunning = false;
      queueMicrotask(drain);
    }
  }

  return {
    setRemoteCapacityProvider(provider) {
      remoteCapacityProvider = typeof provider === "function" ? provider : () => 0;
      queueMicrotask(drain);
    },
    requestDrain() {
      queueMicrotask(drain);
    },
    enqueue({ filePath, outputDir, workload, options = {}, inputMetadata = {} }) {
      recoverExpiredRemoteClaims();
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
    claimNextRemoteJob({ agent, heartbeatIntervalMs } = {}) {
      recoverExpiredRemoteClaims();

      if (queue.length === 0) {
        return null;
      }

      const jobId = queue.shift();
      const job = jobs.get(jobId);

      if (!job) {
        queueMicrotask(drain);
        return null;
      }

      const timestamp = new Date().toISOString();
      const worker = buildRemoteWorker(agent, timestamp, heartbeatIntervalMs);
      remoteAssignments.set(jobId, {
        jobId,
        agentId: worker.id,
        agentLabel: worker.label,
        claimedAt: timestamp,
        lastHeartbeatAt: timestamp,
        heartbeatIntervalMs: toPositiveInteger(heartbeatIntervalMs, 0),
        expiresAt: buildLeaseExpiry(timestamp, heartbeatIntervalMs, remoteLeaseGraceMs)
      });

      const updatedJob = updateJob(jobId, {
        status: "running",
        worker,
        statusDetail: {
          state: "agent_claimed",
          message: `${worker.label} claimed the job and is downloading the workspace.`,
          currentStage: null,
          heartbeatIntervalMs: toPositiveInteger(heartbeatIntervalMs, 0) || undefined
        }
      });

      queueMicrotask(drain);
      return updatedJob ? clone(updatedJob) : null;
    },
    heartbeatRemoteJob({ jobId, agentId, statusDetail = {} } = {}) {
      recoverExpiredRemoteClaims();
      const assignment = remoteAssignments.get(jobId);

      if (!assignment || assignment.agentId !== String(agentId || "").trim()) {
        return null;
      }

      const timestamp = new Date().toISOString();
      const nextHeartbeatIntervalMs =
        toPositiveInteger(statusDetail?.heartbeatIntervalMs, 0) || assignment.heartbeatIntervalMs || 0;

      assignment.lastHeartbeatAt = timestamp;
      assignment.heartbeatIntervalMs = nextHeartbeatIntervalMs;
      assignment.expiresAt = buildLeaseExpiry(timestamp, nextHeartbeatIntervalMs, remoteLeaseGraceMs);

      const updatedJob = updateJob(jobId, {
        status: "running",
        worker: {
          lastHeartbeatAt: timestamp,
          heartbeatIntervalMs: nextHeartbeatIntervalMs || undefined
        },
        statusDetail
      });

      return updatedJob ? clone(updatedJob) : null;
    },
    completeRemoteJob({ jobId, agentId, result } = {}) {
      recoverExpiredRemoteClaims();
      const assignment = remoteAssignments.get(jobId);

      if (!assignment || assignment.agentId !== String(agentId || "").trim()) {
        return null;
      }

      const currentJob = jobs.get(jobId);
      if (!currentJob) {
        remoteAssignments.delete(jobId);
        return null;
      }

      finalizeJob(jobId, currentJob, {
        ...result,
        worker: {
          ...(result?.worker || {}),
          kind: "agent",
          id: assignment.agentId,
          label: assignment.agentLabel,
          assignedAt: assignment.claimedAt,
          lastHeartbeatAt: assignment.lastHeartbeatAt,
          heartbeatIntervalMs: assignment.heartbeatIntervalMs || undefined
        }
      });

      queueMicrotask(drain);
      return clone(jobs.get(jobId));
    },
    failRemoteJob({ jobId, agentId, error, snapshot } = {}) {
      recoverExpiredRemoteClaims();
      const assignment = remoteAssignments.get(jobId);

      if (!assignment || assignment.agentId !== String(agentId || "").trim()) {
        return null;
      }

      if (snapshot && snapshot.jobId === jobId) {
        return this.completeRemoteJob({
          jobId,
          agentId,
          result: {
            ...snapshot,
            updatedAt: snapshot.updatedAt || new Date().toISOString()
          }
        });
      }

      remoteAssignments.delete(jobId);
      const timestamp = new Date().toISOString();
      const updatedJob = updateJob(jobId, {
        status: "failed",
        error: String(error?.message || error || "Remote agent execution failed."),
        worker: {
          kind: "agent",
          id: assignment.agentId,
          label: assignment.agentLabel,
          assignedAt: assignment.claimedAt,
          completedAt: timestamp,
          lastHeartbeatAt: assignment.lastHeartbeatAt,
          heartbeatIntervalMs: assignment.heartbeatIntervalMs || undefined
        },
        statusDetail: {
          state: "failed",
          message: String(error?.message || error || "Remote agent execution failed."),
          currentStage: null
        }
      });

      queueMicrotask(drain);
      return updatedJob ? clone(updatedJob) : null;
    },
    isJobAssignedToAgent(jobId, agentId) {
      recoverExpiredRemoteClaims();
      const assignment = remoteAssignments.get(jobId);
      return Boolean(assignment && assignment.agentId === String(agentId || "").trim());
    },
    getRemoteAssignment(jobId) {
      recoverExpiredRemoteClaims();
      const assignment = remoteAssignments.get(jobId);
      return assignment ? clone(assignment) : null;
    },
    recoverExpiredRemoteClaims() {
      return cloneJsonValue(recoverExpiredRemoteClaims());
    },
    get(jobId) {
      recoverExpiredRemoteClaims();
      const job = jobs.get(jobId);
      return job ? clone(job) : null;
    },
    list() {
      recoverExpiredRemoteClaims();
      return [...jobs.values()].map(clone);
    },
    stats() {
      recoverExpiredRemoteClaims();
      const summary = {
        total: jobs.size,
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        pendingQueueDepth: queue.length,
        remoteCapacity: getRemoteCapacity(),
        localWorkerBusy: localRunning,
        remoteWorkersBusy: remoteAssignments.size
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
