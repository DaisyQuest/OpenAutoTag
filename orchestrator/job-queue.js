import crypto from "node:crypto";
import path from "node:path";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createJobQueue({ processor, outputRoot = path.resolve("tmp", "jobs") }) {
  const jobs = new Map();
  const queue = [];
  let running = false;

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

    job.status = "running";
    job.updatedAt = new Date().toISOString();

    try {
      const result = await processor({
        filePath: job.input.filePath,
        outputDir: job.input.outputDir,
        workloadId: job.workload.id,
        workload: job.workload,
        options: job.input.options || {},
        jobId
      });

      jobs.set(jobId, {
        ...result,
        workload: result.workload || job.workload,
        input: {
          ...(job.input || {}),
          ...(result.input || {}),
          workloadId: job.workload.id,
          options: job.input.options || {}
        },
        createdAt: job.createdAt
      });
    } catch (error) {
      const snapshot = error?.snapshot || error?.jobSnapshot;

      if (snapshot && snapshot.jobId === jobId) {
        jobs.set(jobId, {
          ...snapshot,
          workload: snapshot.workload || job.workload,
          input: {
            ...(job.input || {}),
            ...(snapshot.input || {}),
            workloadId: job.workload.id,
            options: job.input.options || {}
          },
          createdAt: job.createdAt,
          updatedAt: snapshot.updatedAt || new Date().toISOString()
        });
        return;
      }

      jobs.set(jobId, {
        ...job,
        status: "failed",
        error: error.message,
        updatedAt: new Date().toISOString()
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
        updatedAt: timestamp
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
    }
  };
}
