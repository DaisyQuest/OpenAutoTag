import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";
import { createSsnSamplePdf } from "../fixtures/create-ssn-sample-pdf.js";
import { createJobQueue } from "../../orchestrator/job-queue.js";
import { createAppServer } from "../../orchestrator/server.js";
import { runWorkload } from "../../orchestrator/workloads/index.js";

async function waitForCompletion(baseUrl, jobId) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/jobs/${jobId}`);
    const job = await response.json();

    if (job.status === "completed" || job.status === "failed") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("Timed out waiting for job completion");
}

async function waitForBatchCompletion(baseUrl, batchId) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/batches/${batchId}`);
    const batch = await response.json();

    if (batch.status !== "processing") {
      return batch;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out waiting for batch completion");
}

test("server accepts process-pdf jobs and exposes job status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");

  await createSamplePdf(pdfPath);

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const workloadsResponse = await fetch(`${baseUrl}/workloads`);
    const workloadsPayload = await workloadsResponse.json();

    assert.equal(workloadsResponse.status, 200);
    assert.equal(workloadsPayload.workloads.some((workload) => workload.id === "ssn-redaction"), true);

    const response = await fetch(`${baseUrl}/process-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ filePath: pdfPath, outputDir: path.join(tempDir, "output") })
    });

    assert.equal(response.status, 202);
    const job = await response.json();
    const completedJob = await waitForCompletion(baseUrl, job.jobId);

    assert.equal(completedJob.status, "completed");
    assert.ok(completedJob.artifacts.validationReport);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server accepts remote PDF URLs and exposes job status plus artifact links", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-url-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");

  await createSamplePdf(pdfPath);

  const remotePdfServer = http.createServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/pdf" });
    response.end(await readFile(pdfPath));
  });

  await new Promise((resolve) => remotePdfServer.listen(0, resolve));
  const remoteAddress = remotePdfServer.address();
  const fileUrl = `http://127.0.0.1:${remoteAddress.port}/fixtures/sample.pdf`;

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue, uploadRoot: path.join(tempDir, "uploads") });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/process-pdf-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileUrl,
        outputDir: path.join(tempDir, "url-output")
      })
    });

    assert.equal(response.status, 202);
    const job = await response.json();
    assert.equal(job.input.sourceUrl, fileUrl);
    assert.equal(job.sourceUrl, fileUrl);
    assert.equal(job.fileName, "sample.pdf");

    const completedJob = await waitForCompletion(baseUrl, job.jobId);
    assert.equal(completedJob.status, "completed");
    assert.equal(completedJob.sourceUrl, fileUrl);
    assert.ok(completedJob.artifactLinks.validationReport);

    const artifactResponse = await fetch(`${baseUrl}${completedJob.artifactLinks.validationReport}`);
    const validationReport = await artifactResponse.json();
    assert.equal(artifactResponse.status, 200);
    assert.equal(validationReport.status, "completed");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => remotePdfServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server rejects remote URLs that do not resolve to a PDF", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-url-reject-test-"));
  const remoteTextServer = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not a pdf");
  });

  await new Promise((resolve) => remoteTextServer.listen(0, resolve));
  const remoteAddress = remoteTextServer.address();
  const fileUrl = `http://127.0.0.1:${remoteAddress.port}/fixtures/not-a-pdf.txt`;

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue, uploadRoot: path.join(tempDir, "uploads") });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/process-pdf-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fileUrl })
    });

    assert.equal(response.status, 415);
    const payload = await response.json();
    assert.match(payload.error, /did not resolve to a PDF/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => remoteTextServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server accepts uploaded PDF batches and serves browser UI artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-upload-test-"));
  const pdfPathA = path.join(tempDir, "alpha.pdf");
  const pdfPathB = path.join(tempDir, "nested", "beta.pdf");

  await mkdir(path.dirname(pdfPathB), { recursive: true });
  await createSamplePdf(pdfPathA);
  await createSamplePdf(pdfPathB);

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue, uploadRoot: path.join(tempDir, "uploads") });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const homeResponse = await fetch(baseUrl);
    const homeHtml = await homeResponse.text();
    assert.equal(homeResponse.status, 200);
    assert.match(homeHtml, /Run Selected Workload/);

    const formData = new FormData();
    formData.append("files", new File([await readFile(pdfPathA)], "alpha.pdf", { type: "application/pdf" }));
    formData.append("relativePaths", "alpha.pdf");
    formData.append("files", new File([await readFile(pdfPathB)], "beta.pdf", { type: "application/pdf" }));
    formData.append("relativePaths", "nested/beta.pdf");

    const uploadResponse = await fetch(`${baseUrl}/process-pdf-upload`, {
      method: "POST",
      body: formData
    });

    assert.equal(uploadResponse.status, 202);
    const batch = await uploadResponse.json();
    assert.equal(batch.totals.total, 2);

    const completedBatch = await waitForBatchCompletion(baseUrl, batch.batchId);
    assert.equal(completedBatch.totals.completed, 2);
    assert.equal(completedBatch.items.length, 2);
    assert.equal(completedBatch.items.every((item) => item.validation?.metadataDiagnostics?.infoMatchesXmp === true), true);

    const artifactResponse = await fetch(`${baseUrl}${completedBatch.items[0].artifacts.validationReport}`);
    const validationReport = await artifactResponse.json();

    assert.equal(artifactResponse.status, 200);
    assert.equal(validationReport.status, "completed");

    const reportResponse = await fetch(
      `${baseUrl}/report.html?jobId=${completedBatch.items[0].jobId}&artifact=validationReport`
    );
    const reportHtml = await reportResponse.text();

    assert.equal(reportResponse.status, 200);
    assert.match(reportHtml, /On-Demand Browser Reports/);

    const matrixResponse = await fetch(`${baseUrl}/testing-matrix.html`);
    const matrixHtml = await matrixResponse.text();
    assert.equal(matrixResponse.status, 200);
    assert.match(matrixHtml, /Coverage Map/);

    const matrixDataResponse = await fetch(`${baseUrl}/testing-matrix.data.json`);
    const matrixData = await matrixDataResponse.json();
    assert.equal(matrixDataResponse.status, 200);
    assert.ok(matrixData.summary.rowCount >= 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server reports mixed batch outcomes when one uploaded PDF fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-mixed-batch-test-"));
  const pdfPathA = path.join(tempDir, "alpha.pdf");
  const pdfPathB = path.join(tempDir, "beta.pdf");

  await createSamplePdf(pdfPathA);
  await createSamplePdf(pdfPathB);

  const queue = createJobQueue({
    processor: async ({ filePath, outputDir, jobId, workloadId, workload, options }) => {
      if (filePath.endsWith("beta.pdf")) {
        throw new Error("simulated batch failure");
      }

      return runWorkload({ filePath, outputDir, jobId, workloadId, workload, options });
    }
  });
  const server = createAppServer({ queue, uploadRoot: path.join(tempDir, "uploads") });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const formData = new FormData();
    formData.append("files", new File([await readFile(pdfPathA)], "alpha.pdf", { type: "application/pdf" }));
    formData.append("relativePaths", "alpha.pdf");
    formData.append("files", new File([await readFile(pdfPathB)], "beta.pdf", { type: "application/pdf" }));
    formData.append("relativePaths", "beta.pdf");

    const uploadResponse = await fetch(`${baseUrl}/process-pdf-upload`, {
      method: "POST",
      body: formData
    });

    assert.equal(uploadResponse.status, 202);
    const batch = await uploadResponse.json();

    const completedBatch = await waitForBatchCompletion(baseUrl, batch.batchId);
    assert.equal(completedBatch.status, "completed_with_failures");
    assert.equal(completedBatch.totals.completed, 1);
    assert.equal(completedBatch.totals.failed, 1);
    assert.equal(completedBatch.items.some((item) => item.error === "simulated batch failure"), true);
    assert.equal(completedBatch.items.some((item) => item.validation?.failedRules >= 0), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server runs the SSN redaction workload and exposes redaction artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-redaction-test-"));
  const pdfPath = path.join(tempDir, "ssn-sample.pdf");

  await createSsnSamplePdf(pdfPath);

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue, uploadRoot: path.join(tempDir, "uploads") });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const formData = new FormData();
    formData.append("workloadId", "ssn-redaction");
    formData.append("files", new File([await readFile(pdfPath)], "ssn-sample.pdf", { type: "application/pdf" }));
    formData.append("relativePaths", "ssn-sample.pdf");

    const uploadResponse = await fetch(`${baseUrl}/process-pdf-upload`, {
      method: "POST",
      body: formData
    });

    assert.equal(uploadResponse.status, 202);
    const batch = await uploadResponse.json();
    assert.equal(batch.workload.id, "ssn-redaction");

    const completedBatch = await waitForBatchCompletion(baseUrl, batch.batchId);
    assert.equal(completedBatch.status, "completed");
    assert.equal(completedBatch.items[0].workload.id, "ssn-redaction");
    assert.equal(completedBatch.items[0].summary.label, "2 SSNs redacted");

    const reportResponse = await fetch(`${baseUrl}${completedBatch.items[0].artifacts.redactionReport}`);
    const report = await reportResponse.json();
    assert.equal(reportResponse.status, 200);
    assert.equal(report.summary.redactedMatches, 2);
    assert.equal(report.matches.length, 2);

    const reportPageResponse = await fetch(
      `${baseUrl}/report.html?jobId=${completedBatch.items[0].jobId}&artifact=redactionReport`
    );
    const reportPageHtml = await reportPageResponse.text();

    assert.equal(reportPageResponse.status, 200);
    assert.match(reportPageHtml, /On-Demand Browser Reports/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server runs the combined tag-and-redact workload and exposes validation plus redaction artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-tag-redaction-test-"));
  const pdfPath = path.join(tempDir, "ssn-sample.pdf");

  await createSsnSamplePdf(pdfPath);

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue, uploadRoot: path.join(tempDir, "uploads") });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const formData = new FormData();
    formData.append("workloadId", "tag-and-ssn-redact");
    formData.append("files", new File([await readFile(pdfPath)], "ssn-sample.pdf", { type: "application/pdf" }));
    formData.append("relativePaths", "ssn-sample.pdf");

    const uploadResponse = await fetch(`${baseUrl}/process-pdf-upload`, {
      method: "POST",
      body: formData
    });

    assert.equal(uploadResponse.status, 202);
    const batch = await uploadResponse.json();

    const completedBatch = await waitForBatchCompletion(baseUrl, batch.batchId);
    const item = completedBatch.items[0];

    assert.equal(completedBatch.status, "completed");
    assert.equal(item.workload.id, "tag-and-ssn-redact");
    assert.equal(item.summary.label, "2 SSNs redacted");
    assert.ok(item.artifacts.validationReport);
    assert.ok(item.artifacts.tagDeltaReport);
    assert.ok(item.artifacts.redactionReport);
    assert.ok(item.artifacts.taggedPdf);
    assert.equal(item.validation?.tagDelta?.structTreeAdded, true);
    assert.ok((item.validation?.tagDelta?.totalTypedNodesDelta ?? 0) > 0);

    const redactionResponse = await fetch(`${baseUrl}${item.artifacts.redactionReport}`);
    const redactionReport = await redactionResponse.json();
    assert.equal(redactionResponse.status, 200);
    assert.equal(redactionReport.accessibilityTreeRedacted, true);

    const validationResponse = await fetch(`${baseUrl}${item.artifacts.validationReport}`);
    const validationReport = await validationResponse.json();
    assert.equal(validationResponse.status, 200);
    assert.equal(validationReport.status, "completed");

    const tagDeltaResponse = await fetch(`${baseUrl}${item.artifacts.tagDeltaReport}`);
    const tagDeltaReport = await tagDeltaResponse.json();
    assert.equal(tagDeltaResponse.status, 200);
    assert.equal(tagDeltaReport.status, "completed");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
