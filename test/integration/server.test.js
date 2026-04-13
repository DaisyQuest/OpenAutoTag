import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";
import { createSsnSamplePdf } from "../fixtures/create-ssn-sample-pdf.js";
import { createAuthController } from "../../orchestrator/auth-controller.js";
import { createJobQueue } from "../../orchestrator/job-queue.js";
import { createAppServer } from "../../orchestrator/server.js";
import { runWorkload } from "../../orchestrator/workloads/index.js";

async function waitForCompletion(baseUrl, jobId, headers = {}) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/jobs/${jobId}`, { headers });
    const job = await response.json();

    if (job.status === "completed" || job.status === "failed") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("Timed out waiting for job completion");
}

async function waitForBatchCompletion(baseUrl, batchId, headers = {}) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/batches/${batchId}`, { headers });
    const batch = await response.json();

    if (batch.status !== "processing") {
      return batch;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out waiting for batch completion");
}

function createPrivateServer(tempDir, { apiKey = "api-secret", adminKey = "admin-secret" } = {}) {
  const queue = createJobQueue({ processor: runWorkload });

  return createAppServer({
    queue,
    uploadRoot: path.join(tempDir, "uploads"),
    auth: createAuthController({
      publicMode: false,
      bootstrapApiKeys: apiKey ? [apiKey] : [],
      adminKeys: [adminKey],
      registryPath: path.join(tempDir, "security", "api-keys.json")
    })
  });
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

test("private mode keeps static pages available but blocks protected routes without keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-private-auth-test-"));
  const server = createPrivateServer(tempDir);

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const homeResponse = await fetch(baseUrl);
    const homeHtml = await homeResponse.text();
    assert.equal(homeResponse.status, 200);
    assert.match(homeHtml, /Unlock the workspace/);

    const configResponse = await fetch(`${baseUrl}/auth/config`);
    const configPayload = await configResponse.json();
    assert.equal(configResponse.status, 200);
    assert.equal(configPayload.publicMode, false);

    const workloadsResponse = await fetch(`${baseUrl}/workloads`);
    const workloadsPayload = await workloadsResponse.json();
    assert.equal(workloadsResponse.status, 401);
    assert.match(workloadsPayload.error, /X-API-KEY|X-ADMIN-KEY/i);

    const adminResponse = await fetch(`${baseUrl}/admin/system`);
    const adminPayload = await adminResponse.json();
    assert.equal(adminResponse.status, 401);
    assert.match(adminPayload.error, /X-ADMIN-KEY/i);

    const artifactsPageResponse = await fetch(`${baseUrl}/admin/artifacts.html`);
    const artifactsPageHtml = await artifactsPageResponse.text();
    assert.equal(artifactsPageResponse.status, 200);
    assert.match(artifactsPageHtml, /Artifact Browser/);

    const artifactInventoryResponse = await fetch(`${baseUrl}/admin/artifacts`);
    const artifactInventoryPayload = await artifactInventoryResponse.json();
    assert.equal(artifactInventoryResponse.status, 401);
    assert.match(artifactInventoryPayload.error, /X-ADMIN-KEY/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("private mode accepts bootstrap keys and keeps admin endpoints admin-only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-private-bootstrap-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");

  await createSamplePdf(pdfPath);

  const server = createPrivateServer(tempDir, {
    apiKey: "bootstrap-api-key",
    adminKey: "bootstrap-admin-key"
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const workloadsResponse = await fetch(`${baseUrl}/workloads`, {
      headers: {
        "X-API-KEY": "bootstrap-api-key"
      }
    });
    const workloadsPayload = await workloadsResponse.json();
    assert.equal(workloadsResponse.status, 200);
    assert.equal(workloadsPayload.workloads.length >= 1, true);

    const forbiddenAdminResponse = await fetch(`${baseUrl}/admin/system`, {
      headers: {
        "X-API-KEY": "bootstrap-api-key"
      }
    });
    const forbiddenAdminPayload = await forbiddenAdminResponse.json();
    assert.equal(forbiddenAdminResponse.status, 403);
    assert.match(forbiddenAdminPayload.error, /X-ADMIN-KEY/i);

    const adminResponse = await fetch(`${baseUrl}/workloads`, {
      headers: {
        "X-ADMIN-KEY": "bootstrap-admin-key"
      }
    });
    assert.equal(adminResponse.status, 200);

    const jobResponse = await fetch(`${baseUrl}/process-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": "bootstrap-api-key"
      },
      body: JSON.stringify({ filePath: pdfPath, outputDir: path.join(tempDir, "output") })
    });
    const job = await jobResponse.json();

    assert.equal(jobResponse.status, 202);
    const completedJob = await waitForCompletion(baseUrl, job.jobId, {
      "X-API-KEY": "bootstrap-api-key"
    });
    assert.equal(completedJob.status, "completed");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("private mode can mint managed API keys from the admin console endpoint", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-managed-key-test-"));
  const server = createPrivateServer(tempDir, {
    apiKey: "",
    adminKey: "bootstrap-admin-key"
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createResponse = await fetch(`${baseUrl}/admin/api-keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ADMIN-KEY": "bootstrap-admin-key"
      },
      body: JSON.stringify({
        label: "Queue uploader",
        description: "Created in integration coverage"
      })
    });
    const created = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.match(created.key, /^bea_/);
    assert.equal(created.record.label, "Queue uploader");

    const workloadsResponse = await fetch(`${baseUrl}/workloads`, {
      headers: {
        "X-API-KEY": created.key
      }
    });
    const workloadsPayload = await workloadsResponse.json();
    assert.equal(workloadsResponse.status, 200);
    assert.equal(workloadsPayload.workloads.some((workload) => workload.id === "accessibility-tagging"), true);

    const listResponse = await fetch(`${baseUrl}/admin/api-keys`, {
      headers: {
        "X-ADMIN-KEY": "bootstrap-admin-key"
      }
    });
    const listPayload = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.summary.activeManagedKeys, 1);
    assert.equal(listPayload.managedKeys[0].lastUsedAt !== null, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("admin artifact inventory lists emitted JSON reports and binary outputs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-artifact-browser-test-"));
  const pdfPath = path.join(tempDir, "sample.pdf");

  await createSamplePdf(pdfPath);

  const server = createPrivateServer(tempDir, {
    apiKey: "bootstrap-api-key",
    adminKey: "bootstrap-admin-key"
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/process-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": "bootstrap-api-key"
      },
      body: JSON.stringify({ filePath: pdfPath, outputDir: path.join(tempDir, "output") })
    });

    assert.equal(response.status, 202);
    const job = await response.json();
    const completedJob = await waitForCompletion(baseUrl, job.jobId, {
      "X-API-KEY": "bootstrap-api-key"
    });

    assert.equal(completedJob.status, "completed");

    const inventoryResponse = await fetch(`${baseUrl}/admin/artifacts`, {
      headers: {
        "X-ADMIN-KEY": "bootstrap-admin-key"
      }
    });
    const inventory = await inventoryResponse.json();

    assert.equal(inventoryResponse.status, 200);
    assert.ok(inventory.summary.totalArtifacts >= 5);
    assert.ok(inventory.summary.previewableArtifacts >= 1);
    assert.ok(inventory.summary.totalBytes > 0);

    const layoutArtifact = inventory.artifacts.find((artifact) => artifact.jobId === job.jobId && artifact.name === "layout");
    const validationArtifact = inventory.artifacts.find((artifact) => artifact.jobId === job.jobId && artifact.name === "validationReport");
    const taggedPdfArtifact = inventory.artifacts.find((artifact) => artifact.jobId === job.jobId && artifact.name === "taggedPdf");

    assert.ok(layoutArtifact);
    assert.equal(layoutArtifact.browserPreviewable, true);
    assert.equal(layoutArtifact.previewMode, "report");

    assert.ok(validationArtifact);
    assert.equal(validationArtifact.label, "Validation report");
    assert.match(validationArtifact.reportUrl, /artifact=validationReport/);

    assert.ok(taggedPdfArtifact);
    assert.equal(taggedPdfArtifact.kind, "pdf");
    assert.equal(taggedPdfArtifact.browserPreviewable, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server blocks private-network remote PDF URLs by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-url-private-host-test-"));
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
        fileUrl: "http://127.0.0.1:8123/private.pdf"
      })
    });

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.match(payload.error, /blocked by download safety policy/i);
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
  const server = createAppServer({
    queue,
    uploadRoot: path.join(tempDir, "uploads"),
    remoteDownloadPolicy: {
      allowPrivateHosts: true
    }
  });

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
  const server = createAppServer({
    queue,
    uploadRoot: path.join(tempDir, "uploads"),
    remoteDownloadPolicy: {
      allowPrivateHosts: true
    }
  });

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
    assert.match(payload.error, /did not (look like|resolve to) a PDF/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => remoteTextServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server rejects remote files that fail PDF signature validation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-url-signature-test-"));
  const remoteTextServer = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/pdf" });
    response.end("<html>definitely not a pdf</html>");
  });

  await new Promise((resolve) => remoteTextServer.listen(0, resolve));
  const remoteAddress = remoteTextServer.address();
  const fileUrl = `http://127.0.0.1:${remoteAddress.port}/fixtures/bad-signature.pdf`;

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({
    queue,
    uploadRoot: path.join(tempDir, "uploads"),
    remoteDownloadPolicy: {
      allowPrivateHosts: true
    }
  });

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
    assert.match(payload.error, /signature validation/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => remoteTextServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("server rejects remote PDFs that exceed the configured size limit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "server-url-size-test-"));
  const remotePdfServer = http.createServer((_request, response) => {
    const body = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(512, 0x20)]);
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": String(body.length)
    });
    response.end(body);
  });

  await new Promise((resolve) => remotePdfServer.listen(0, resolve));
  const remoteAddress = remotePdfServer.address();
  const fileUrl = `http://127.0.0.1:${remoteAddress.port}/fixtures/too-large.pdf`;

  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({
    queue,
    uploadRoot: path.join(tempDir, "uploads"),
    remoteDownloadPolicy: {
      allowPrivateHosts: true,
      maxBytes: 64
    }
  });

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

    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.error, /safety limit/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => remotePdfServer.close((error) => (error ? reject(error) : resolve())));
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
