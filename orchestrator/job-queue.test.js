import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobQueue } from "./job-queue.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject
  };
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for queue state.");
}

test("createJobQueue surfaces worker check-ins while a job is running", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "job-queue-progress-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, "source.pdf");
  await writeFile(sourcePath, "queue progress payload");

  const runningCheckpoint = createDeferred();
  const releaseCompletion = createDeferred();
  const workload = {
    id: "test-workload",
    label: "Test Workload"
  };
  const queue = createJobQueue({
    outputRoot: tempDir,
    processor: async ({ jobId, filePath, outputDir, options, onProgress }) => {
      await onProgress({
        state: "preparing_workspace",
        message: "Preparing the job workspace.",
        completedStages: 0,
        totalStages: 2,
        currentStage: null
      });
      await onProgress({
        state: "running_stage",
        message: "Running stage 1/2: parser (attempt 1/3).",
        completedStages: 0,
        totalStages: 2,
        heartbeatIntervalMs: 50,
        currentStage: {
          key: "layout",
          label: "parser",
          index: 1,
          total: 2,
          attempt: 1,
          maxAttempts: 3,
          startedAt: new Date().toISOString()
        }
      });
      runningCheckpoint.resolve();
      await releaseCompletion.promise;

      return {
        jobId,
        status: "completed",
        workload,
        input: {
          filePath,
          outputDir,
          workloadId: workload.id,
          options
        },
        artifacts: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        statusDetail: {
          state: "completed",
          message: "Completed 2 stages.",
          completedStages: 2,
          totalStages: 2,
          currentStage: null,
          lastStage: {
            key: "validator",
            label: "validator",
            status: "completed"
          }
        }
      };
    }
  });

  const job = queue.enqueue({
    filePath: sourcePath,
    workload,
    options: {}
  });

  await runningCheckpoint.promise;

  const runningJob = await waitFor(() => {
    const snapshot = queue.get(job.jobId);
    return snapshot?.statusDetail?.state === "running_stage" ? snapshot : null;
  });

  assert.equal(runningJob.status, "running");
  assert.equal(runningJob.statusDetail.currentStage?.label, "parser");
  assert.equal(runningJob.statusDetail.totalStages, 2);
  assert.ok(runningJob.statusDetail.checkInCount >= 4);

  releaseCompletion.resolve();

  const completedJob = await waitFor(() => {
    const snapshot = queue.get(job.jobId);
    return snapshot?.status === "completed" ? snapshot : null;
  });

  assert.equal(completedJob.statusDetail.state, "completed");
  assert.equal(completedJob.statusDetail.completedStages, 2);
  assert.equal(completedJob.statusDetail.lastStage?.label, "validator");
  assert.ok(completedJob.statusDetail.checkInCount > runningJob.statusDetail.checkInCount);
});

test("createJobQueue holds work for remote capacity and falls back locally after lease expiry", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "job-queue-remote-lease-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, "source.pdf");
  await writeFile(sourcePath, "remote lease payload");

  const processorInvocations = [];
  const workload = {
    id: "test-workload",
    label: "Test Workload"
  };
  const queue = createJobQueue({
    outputRoot: tempDir,
    remoteLeaseGraceMs: 30,
    processor: async ({ jobId, filePath, outputDir, options }) => {
      processorInvocations.push(jobId);
      return {
        jobId,
        status: "completed",
        workload,
        input: {
          filePath,
          outputDir,
          workloadId: workload.id,
          options
        },
        artifacts: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        statusDetail: {
          state: "completed",
          message: "Completed locally after lease expiry.",
          completedStages: 1,
          totalStages: 1,
          currentStage: null
        }
      };
    }
  });

  queue.setRemoteCapacityProvider(() => 1);
  const queuedJob = queue.enqueue({
    filePath: sourcePath,
    workload,
    options: {}
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(processorInvocations.length, 0);
  assert.equal(queue.get(queuedJob.jobId)?.status, "queued");

  const claimedJob = queue.claimNextRemoteJob({
    agent: {
      agentId: "agent-alpha",
      label: "Agent Alpha"
    },
    heartbeatIntervalMs: 10
  });

  assert.equal(claimedJob?.status, "running");
  assert.equal(claimedJob?.worker?.kind, "agent");

  await new Promise((resolve) => setTimeout(resolve, 40));
  const expiredAssignments = queue.recoverExpiredRemoteClaims();
  assert.equal(expiredAssignments.length, 1);
  assert.equal(queue.get(queuedJob.jobId)?.status, "queued");

  queue.setRemoteCapacityProvider(() => 0);
  queue.requestDrain();

  const completedJob = await waitFor(() => {
    const snapshot = queue.get(queuedJob.jobId);
    return snapshot?.status === "completed" ? snapshot : null;
  });

  assert.equal(processorInvocations.length, 1);
  assert.equal(completedJob.worker?.kind, "local");
  assert.equal(completedJob.statusDetail.state, "completed");
});
