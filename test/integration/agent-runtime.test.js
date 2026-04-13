import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentService } from "../../orchestrator/agent-service.js";
import { createJobQueue } from "../../orchestrator/job-queue.js";
import { createAppServer } from "../../orchestrator/server.js";

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for expected condition.");
}

function buildSyntheticValidationReport() {
  return {
    status: "completed",
    isCompliant: true,
    profileName: "Synthetic remote validation",
    statement: "Remote worker emitted a synthetic validation report for integration coverage.",
    summary: {
      failedRules: 0,
      failedChecks: 0
    },
    findings: [],
    metadataDiagnostics: {
      metadataPresent: true,
      infoMatchesXmp: true,
      dcTitleDetected: true,
      dcTitleValue: "Synthetic remote document",
      pdfUaIdentificationDetected: true,
      pdfUaIdentificationPart: "1",
      suspectedVeraPdfMetadataMismatch: false
    }
  };
}

test("remote agent polls the master, executes a claimed job, uploads artifacts, and shows up in admin telemetry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const outputDir = path.join(tempDir, "master-output");

  await writeFile(pdfPath, Buffer.from("%PDF-1.7\nsynthetic remote test\n"));
  await mkdir(outputDir, { recursive: true });

  const queue = createJobQueue({
    outputRoot: outputDir,
    processor: async () => {
      throw new Error("local fallback should not run while an idle agent is available");
    }
  });
  const server = createAppServer({
    queue,
    uploadRoot: path.join(tempDir, "uploads")
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const masterAddress = server.address();
  const masterBaseUrl = `http://127.0.0.1:${masterAddress.port}`;

  const agentService = await createAgentService({
    masterEndpoint: masterBaseUrl,
    pollIntervalMs: 50,
    checkInIntervalMs: 50,
    heartbeatIntervalMs: 25,
    runtimeRoot: path.join(tempDir, "agent-runtime"),
    workRoot: path.join(tempDir, "agent-runtime", "jobs"),
    runJob: async ({ filePath, outputDir: agentOutputDir, jobId, workload, options, onProgress }) => {
      const startedAt = new Date().toISOString();
      const validationReportPath = path.join(agentOutputDir, "06-validation-report.json");
      await mkdir(agentOutputDir, { recursive: true });
      await onProgress({
        state: "running_stage",
        message: "Synthetic remote stage is running.",
        completedStages: 0,
        totalStages: 1,
        heartbeatIntervalMs: 25,
        currentStage: {
          key: "synthetic",
          label: "synthetic-stage",
          index: 1,
          total: 1,
          attempt: 1,
          maxAttempts: 1,
          startedAt
        }
      });
      await writeFile(validationReportPath, `${JSON.stringify(buildSyntheticValidationReport(), null, 2)}\n`, "utf8");
      const endedAt = new Date().toISOString();

      return {
        jobId,
        status: "completed",
        workload,
        input: {
          filePath,
          outputDir: agentOutputDir,
          workloadId: workload.id,
          options
        },
        artifacts: {
          validationReport: validationReportPath
        },
        createdAt: startedAt,
        updatedAt: endedAt,
        stages: [
          {
            key: "synthetic",
            label: "synthetic-stage",
            status: "completed",
            startedAt,
            endedAt,
            durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
            attempts: [
              {
                attempt: 1,
                status: "completed",
                startedAt,
                endedAt,
                durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
              }
            ],
            artifacts: {
              validationReport: validationReportPath
            },
            outputPath: validationReportPath
          }
        ],
        stageSummary: {
          total: 1,
          completedStages: 1,
          failedStages: 0,
          skippedStages: 0,
          totalAttempts: 1,
          retryableFailures: 0
        },
        statusDetail: {
          state: "completed",
          message: "Synthetic remote stage completed.",
          completedStages: 1,
          totalStages: 1,
          currentStage: null,
          lastStage: {
            key: "synthetic",
            label: "synthetic-stage",
            status: "completed"
          }
        }
      };
    }
  });
  await agentService.start({ port: 0 });

  try {
    const initialAgentSnapshot = await waitFor(async () => {
      const response = await fetch(`${masterBaseUrl}/admin/agents`);
      const payload = await response.json();
      return payload.summary?.total === 1 ? payload : null;
    });

    assert.equal(initialAgentSnapshot.summary.idle, 1);

    const enqueueResponse = await fetch(`${masterBaseUrl}/process-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filePath: pdfPath,
        outputDir
      })
    });
    const queuedJob = await enqueueResponse.json();

    assert.equal(enqueueResponse.status, 202);

    const completedJob = await waitFor(async () => {
      const response = await fetch(`${masterBaseUrl}/jobs/${queuedJob.jobId}`);
      const payload = await response.json();
      return payload.status === "completed" ? payload : null;
    });

    assert.equal(completedJob.worker.kind, "agent");
    assert.equal(completedJob.statusDetail.state, "completed");
    assert.ok(completedJob.artifactLinks.validationReport);

    const validationReportResponse = await fetch(`${masterBaseUrl}${completedJob.artifactLinks.validationReport}`);
    const validationReport = await validationReportResponse.json();
    assert.equal(validationReportResponse.status, 200);
    assert.equal(validationReport.isCompliant, true);

    const agentSnapshot = await waitFor(async () => {
      const response = await fetch(`${masterBaseUrl}/admin/agents`);
      const payload = await response.json();
      return payload.summary?.jobsCompleted === 1 ? payload : null;
    });

    assert.equal(agentSnapshot.summary.total, 1);
    assert.equal(agentSnapshot.summary.jobsCompleted, 1);
    assert.equal(agentSnapshot.summary.busy, 0);
    assert.equal(agentSnapshot.agents[0].jobsCompleted, 1);
    assert.equal(agentSnapshot.agents[0].currentJobId, null);
  } finally {
    await agentService.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
});
