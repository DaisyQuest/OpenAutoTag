import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { compareDocuments } from "../../orchestrator/diff-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tmpDir = path.join(repoRoot, "tmp", "difftool-test-" + Date.now());

/**
 * Dynamically import createAppServer from server.js and start a test server.
 * If any import fails (e.g. missing deps), the entire test file self-skips.
 */
let createAppServer;
let createJobQueue;
try {
  ({ createAppServer } = await import("../../orchestrator/server.js"));
  ({ createJobQueue } = await import("../../orchestrator/job-queue.js"));
} catch {
  test("difftool-server tests skipped — server module could not be loaded", { skip: true }, () => {});
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function request(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: urlPath,
      method,
      headers
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buf,
          text: buf.toString("utf8"),
          json() {
            return JSON.parse(buf.toString("utf8"));
          }
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Create a minimal valid PDF buffer. */
function minimalPdf() {
  return Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n" +
    "trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF"
  );
}

function validationReport({ compliant = false, failedRules = 4, failedChecks = 7 } = {}) {
  return {
    isCompliant: compliant,
    engine: { name: "veraPDF", version: "test" },
    summary: { failedRules, failedChecks },
    metadataDiagnostics: {
      metadataPresent: true,
      dcTitleDetected: true,
      pdfUaIdentificationDetected: compliant,
      infoMatchesXmp: true
    },
    findings: compliant ? [] : [{ code: "TAG-001", description: "Missing tag" }]
  };
}

function sampleComparisonReport(mode) {
  const report = compareDocuments([
    {
      id: "source",
      label: "source.pdf",
      role: "source",
      file: { fileName: "source.pdf", sizeBytes: 1000, pageCount: 1, downloadUrl: "/api/difftool/files/run/source" },
      validationReport: validationReport()
    },
    {
      id: "competitor",
      label: "competitor.pdf",
      role: "competitor",
      file: { fileName: "competitor.pdf", sizeBytes: 1000, pageCount: 1, downloadUrl: "/api/difftool/files/run/competitor" },
      validationReport: validationReport({ failedRules: 2, failedChecks: 3 })
    },
    {
      id: `ours-${mode}`,
      label: `AutoTag (${mode})`,
      role: "ours",
      file: { fileName: `autotag-${mode}.pdf`, sizeBytes: 1200, pageCount: 1, downloadUrl: `/api/difftool/files/run/ours-${mode}` },
      validationReport: validationReport({ compliant: true, failedRules: 0, failedChecks: 0 }),
      writerReport: { writerMode: mode, requestedMode: mode, pagesNative: 1, pagesRaster: 0, matchRate: 0.94 }
    }
  ]);
  report.mode = mode;
  return report;
}

function buildMultipartBody(boundary, fields) {
  const parts = [];
  for (const field of fields) {
    let header = `--${boundary}\r\n`;
    if (field.filename) {
      header += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`;
      header += `Content-Type: ${field.contentType || "application/pdf"}\r\n`;
    } else {
      header += `Content-Disposition: form-data; name="${field.name}"\r\n`;
    }
    header += "\r\n";
    parts.push(Buffer.from(header));
    parts.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(field.value));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

if (createAppServer) {
  let server;

  test.before(async () => {
    await mkdir(tmpDir, { recursive: true });
    const queue = createJobQueue({
      processor: async () => ({ status: "completed", artifacts: {} }),
      outputRoot: tmpDir
    });
    server = createAppServer({ queue, uploadRoot: tmpDir });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  test.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("GET /difftool serves the difftool HTML page", async () => {
    const res = await request(server, "GET", "/difftool");
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["content-type"].includes("text/html"));
    assert.ok(res.text.includes("PDF Diff Tool"));
    assert.ok(res.text.includes("difftool.js"));
    assert.ok(res.text.includes("export-btn"));
  });

  test("GET /difftool.html serves the same page via static asset", async () => {
    const res = await request(server, "GET", "/difftool.html");
    assert.equal(res.statusCode, 200);
    assert.ok(res.text.includes("PDF Diff Tool"));
  });

  test("GET /difftool.css serves the diff-tool stylesheet", async () => {
    const res = await request(server, "GET", "/difftool.css");
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["content-type"].includes("text/css"));
  });

  test("GET /difftool.js serves the diff-tool client script", async () => {
    const res = await request(server, "GET", "/difftool.js");
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["content-type"].includes("javascript"));
  });

  test("POST /api/difftool/compare returns 400 without files", async () => {
    const boundary = "----TestBoundary" + Date.now();
    const body = buildMultipartBody(boundary, [
      { name: "writerMode", value: "auto" }
    ]);

    const res = await request(server, "POST", "/api/difftool/compare", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    });

    assert.equal(res.statusCode, 400);
    const json = res.json();
    assert.ok(json.error);
  });

  test("POST /api/difftool/analyze returns 400 without a file", async () => {
    const boundary = "----TestBoundary" + Date.now();
    const body = buildMultipartBody(boundary, []);

    const res = await request(server, "POST", "/api/difftool/analyze", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    });

    assert.equal(res.statusCode, 400);
    const json = res.json();
    assert.ok(json.error);
  });

  test("POST /api/difftool/compare with PDFs returns a comparison report", async () => {
    const pdf = minimalPdf();
    const boundary = "----TestBoundary" + Date.now();
    const body = buildMultipartBody(boundary, [
      { name: "sourcePdf", value: pdf, filename: "source.pdf" },
      { name: "competitorPdf", value: pdf, filename: "competitor.pdf" },
      { name: "writerMode", value: "auto" }
    ]);

    const res = await request(server, "POST", "/api/difftool/compare", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    });

    // The pipeline may fail (missing deps), but the endpoint should return 200
    // with whatever documents it could analyze (including nulls for failed ones)
    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.ok(Array.isArray(json.documents), "response should have documents array");
    assert.ok(Array.isArray(json.categories), "response should have categories array");
    assert.ok("overallWinner" in json, "response should have overallWinner");
    assert.ok("generatedAt" in json, "response should have generatedAt");
    assert.equal(json.mode, "auto");
    assert.ok(json.runId, "response should include a diff run id");

    const source = json.documents.find((document) => document.id === "source");
    assert.ok(source.details, "source should include PDF details");
    assert.ok(source.details.downloadUrl, "source should include a download URL");

    const download = await request(server, "GET", source.details.downloadUrl);
    assert.equal(download.statusCode, 200);
    assert.ok(download.headers["content-type"].includes("application/pdf"));
    assert.ok(download.body.subarray(0, 5).equals(Buffer.from("%PDF-")));
  });

  test("POST /api/difftool/export returns a PDF page per mode", async () => {
    const payload = JSON.stringify({
      reports: ["auto", "native", "raster"].map(sampleComparisonReport)
    });

    const res = await request(server, "POST", "/api/difftool/export", Buffer.from(payload), {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["content-type"].includes("application/pdf"));
    assert.ok(res.body.subarray(0, 5).equals(Buffer.from("%PDF-")));

    const pdf = await PDFDocument.load(res.body);
    assert.equal(pdf.getPageCount(), 3);
  });

  test("POST /api/difftool/analyze with a PDF returns analysis", async () => {
    const pdf = minimalPdf();
    const boundary = "----TestBoundary" + Date.now();
    const body = buildMultipartBody(boundary, [
      { name: "pdf", value: pdf, filename: "test.pdf" }
    ]);

    const res = await request(server, "POST", "/api/difftool/analyze", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    });

    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.ok("validationReport" in json, "response should have validationReport key");
  });

  test("dashboard index.html includes difftool link", async () => {
    const res = await request(server, "GET", "/");
    assert.equal(res.statusCode, 200);
    assert.ok(res.text.includes("/difftool"), "index.html should link to /difftool");
  });
}
