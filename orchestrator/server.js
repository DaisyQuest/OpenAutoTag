import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createJobQueue } from "./job-queue.js";
import { getPublicWorkload, listWorkloads, runWorkload, summarizeWorkloadJob } from "./workloads/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"]
]);

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function readFormData(request) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const requestLike = new Request(new URL(request.url, "http://localhost"), {
    method: request.method,
    headers,
    body: request,
    duplex: "half"
  });

  return requestLike.formData();
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function writeText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(text);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getContentType(filePath) {
  return contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function parseHttpUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function decodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractFilenameFromContentDisposition(headerValue) {
  const source = String(headerValue || "");
  const encodedMatch = source.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    return decodeUriComponent(encodedMatch[1].trim().replace(/^"(.*)"$/, "$1"));
  }

  const plainMatch = source.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1].trim() : "";
}

function isPdfResponse(url, response) {
  const decodedPath = decodeUriComponent(url.pathname || "").toLowerCase();
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  return decodedPath.endsWith(".pdf") || contentType.includes("application/pdf");
}

function buildRemoteFileName(sourceUrl, response) {
  const contentDispositionName = extractFilenameFromContentDisposition(response.headers.get("content-disposition"));
  const finalUrl = parseHttpUrl(response.url) || sourceUrl;
  const urlFileName = decodeUriComponent(path.basename(finalUrl.pathname || ""));
  const baseName = sanitizeSegment(contentDispositionName || urlFileName, "remote-document.pdf");
  return baseName.toLowerCase().endsWith(".pdf") ? baseName : `${baseName}.pdf`;
}

async function downloadRemotePdf({ fileUrl, downloadRoot }) {
  const sourceUrl = parseHttpUrl(fileUrl);
  if (!sourceUrl) {
    throw createHttpError(400, "fileUrl must be an absolute http or https URL.");
  }

  let response;
  try {
    response = await fetch(sourceUrl, { redirect: "follow" });
  } catch (error) {
    throw createHttpError(502, `Unable to fetch remote PDF: ${error.message}`);
  }

  if (!response.ok) {
    throw createHttpError(502, `Remote server returned ${response.status} ${response.statusText}.`);
  }

  const finalUrl = parseHttpUrl(response.url) || sourceUrl;
  if (!isPdfResponse(finalUrl, response)) {
    throw createHttpError(415, "Remote URL did not resolve to a PDF.");
  }

  if (!response.body) {
    throw createHttpError(502, "Remote server returned an empty response body.");
  }

  await mkdir(downloadRoot, { recursive: true });
  const downloadDir = path.join(downloadRoot, crypto.randomUUID());
  await mkdir(downloadDir, { recursive: true });

  const fileName = buildRemoteFileName(sourceUrl, response);
  const targetPath = path.join(downloadDir, fileName);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(targetPath));

  return {
    absolutePath: targetPath,
    fileName,
    sourceUrl: sourceUrl.toString(),
    finalUrl: finalUrl.toString()
  };
}

function resolvePublicAsset(urlPath) {
  const relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const assetPath = path.resolve(publicDir, relativePath);

  if (!assetPath.startsWith(path.resolve(publicDir))) {
    return null;
  }

  return assetPath;
}

async function serveStaticAsset(response, assetPath) {
  try {
    const body = await readFile(assetPath);
    response.writeHead(200, { "Content-Type": getContentType(assetPath) });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSegment(value, fallback = "document") {
  const cleaned = String(value || "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || fallback;
}

function sanitizeRelativePath(relativePath, fallbackName) {
  const source = String(relativePath || fallbackName || "document.pdf").replace(/\\/g, "/");
  const segments = source
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..")
    .map((segment, index, parts) => sanitizeSegment(segment, index === parts.length - 1 ? fallbackName : "folder"));

  if (segments.length === 0) {
    return sanitizeSegment(fallbackName || "document.pdf");
  }

  return path.join(...segments);
}

function makeOutputDirectoryName(relativePath, index) {
  const fileName = path.basename(relativePath, path.extname(relativePath));
  const slug = fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${String(index + 1).padStart(2, "0")}-${slug || "document"}`;
}

async function persistUpload({ file, relativePath, uploadDir }) {
  const safeRelativePath = sanitizeRelativePath(relativePath, file.name);
  const absolutePath = path.resolve(uploadDir, safeRelativePath);

  if (!absolutePath.startsWith(path.resolve(uploadDir))) {
    throw new Error(`Upload path escaped the batch directory: ${relativePath}`);
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, Buffer.from(await file.arrayBuffer()));

  return {
    absolutePath,
    fileName: path.basename(safeRelativePath),
    relativePath: safeRelativePath
  };
}

function buildArtifactLinks(jobId, job) {
  const artifactLinks = {};

  for (const [artifactName, artifactPath] of Object.entries(job?.artifacts || {})) {
    if (artifactPath) {
      artifactLinks[artifactName] = `/jobs/${jobId}/artifacts/${artifactName}`;
    }
  }

  return artifactLinks;
}

function getJobDisplayName(job) {
  return sanitizeSegment(job?.input?.sourceFileName || path.basename(job?.input?.filePath || "document.pdf"), "document.pdf");
}

function getJobDisplayPath(job) {
  return job?.input?.sourceUrl || job?.input?.filePath || getJobDisplayName(job);
}

async function buildJobResponse(jobId, job) {
  const workloadSummary = job
    ? await summarizeWorkloadJob(job)
    : { workload: null, summary: null, validation: null };

  return {
    ...job,
    workload: workloadSummary.workload || job?.workload,
    fileName: getJobDisplayName(job),
    relativePath: getJobDisplayPath(job),
    sourceUrl: job?.input?.sourceUrl || null,
    summary: workloadSummary.summary,
    validation: workloadSummary.validation,
    artifactLinks: buildArtifactLinks(jobId, job)
  };
}

function createBatchRegistry({ queue, uploadRoot = path.join(repoRoot, "tmp", "uploads") }) {
  const batches = new Map();

  async function buildBatchSnapshot(batch) {
    const items = await Promise.all(
      batch.items.map(async (item) => {
        const job = queue.get(item.jobId);
        const workloadSummary = job ? await summarizeWorkloadJob(job) : { workload: item.workload, summary: null, validation: null };

        return {
          jobId: item.jobId,
          fileName: item.fileName,
          relativePath: item.relativePath,
          workload: workloadSummary.workload || item.workload,
          status: job?.status || "missing",
          error: job?.error || null,
          createdAt: job?.createdAt || batch.createdAt,
          updatedAt: job?.updatedAt || batch.createdAt,
          summary: workloadSummary.summary,
          validation: workloadSummary.validation,
          artifacts: buildArtifactLinks(item.jobId, job)
        };
      })
    );

    const totals = items.reduce(
      (summary, item) => {
        summary.total += 1;
        summary[item.status] = (summary[item.status] || 0) + 1;
        return summary;
      },
      {
        total: 0,
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        missing: 0
      }
    );

    let status = "processing";
    if (totals.total === 0) {
      status = "empty";
    } else if (totals.queued > 0 || totals.running > 0) {
      status = "processing";
    } else if (totals.failed > 0 && totals.completed > 0) {
      status = "completed_with_failures";
    } else if (totals.failed > 0) {
      status = "failed";
    } else if (totals.missing > 0) {
      status = "incomplete";
    } else {
      status = "completed";
    }

    const updatedAt = items.reduce(
      (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
      batch.createdAt
    );

    return {
      batchId: batch.batchId,
      workload: batch.workload,
      status,
      totals,
      createdAt: batch.createdAt,
      updatedAt,
      items
    };
  }

  return {
    async enqueueUploads(files, workloadId) {
      const batchId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const batchRoot = path.join(uploadRoot, batchId);
      const uploadDir = path.join(batchRoot, "uploads");
      const outputDir = path.join(batchRoot, "jobs");
      const items = [];
      const workload = getPublicWorkload(workloadId);

      for (let index = 0; index < files.length; index += 1) {
        const uploaded = files[index];
        const persisted = await persistUpload({
          file: uploaded.file,
          relativePath: uploaded.relativePath,
          uploadDir
        });

        const job = queue.enqueue({
          filePath: persisted.absolutePath,
          outputDir: path.join(outputDir, makeOutputDirectoryName(persisted.relativePath, index)),
          workload,
          options: {}
        });

        items.push({
          jobId: job.jobId,
          fileName: persisted.fileName,
          relativePath: persisted.relativePath,
          workload
        });
      }

      const batch = {
        batchId,
        createdAt,
        workload,
        items
      };

      batches.set(batchId, batch);
      return buildBatchSnapshot(batch);
    },
    async get(batchId) {
      const batch = batches.get(batchId);
      return batch ? buildBatchSnapshot(batch) : null;
    }
  };
}

export function createAppServer({ queue, uploadRoot = path.join(repoRoot, "tmp", "uploads") }) {
  const batches = createBatchRegistry({ queue, uploadRoot });
  const remoteDownloadRoot = path.join(uploadRoot, "remote");

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/workloads") {
        writeJson(response, 200, { workloads: listWorkloads() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/process-pdf") {
        const body = await readJsonBody(request);
        if (!body.filePath) {
          writeJson(response, 400, { error: "filePath is required" });
          return;
        }

        const workload = getPublicWorkload(body.workloadId);
        const job = queue.enqueue({
          filePath: body.filePath,
          outputDir: body.outputDir,
          workload,
          options: body.options || {},
          inputMetadata: {
            inputMode: "path"
          }
        });

        writeJson(response, 202, await buildJobResponse(job.jobId, job));
        return;
      }

      if (request.method === "POST" && url.pathname === "/process-pdf-url") {
        const body = await readJsonBody(request);
        if (!body.fileUrl) {
          writeJson(response, 400, { error: "fileUrl is required" });
          return;
        }

        const workload = getPublicWorkload(body.workloadId);
        const remotePdf = await downloadRemotePdf({
          fileUrl: body.fileUrl,
          downloadRoot: remoteDownloadRoot
        });
        const job = queue.enqueue({
          filePath: remotePdf.absolutePath,
          outputDir: body.outputDir,
          workload,
          options: body.options || {},
          inputMetadata: {
            inputMode: "url",
            sourceUrl: remotePdf.sourceUrl,
            sourceFileName: remotePdf.fileName,
            ...(remotePdf.finalUrl !== remotePdf.sourceUrl ? { resolvedUrl: remotePdf.finalUrl } : {})
          }
        });

        writeJson(response, 202, await buildJobResponse(job.jobId, job));
        return;
      }

      if (request.method === "POST" && url.pathname === "/process-pdf-upload") {
        const formData = await readFormData(request);
        const files = formData
          .getAll("files")
          .filter((value) => typeof value === "object" && typeof value.arrayBuffer === "function");
        const relativePaths = formData.getAll("relativePaths").map((value) => String(value || ""));
        const workloadId = String(formData.get("workloadId") || "accessibility-tagging");
        const pdfFiles = files
          .map((file, index) => ({
            file,
            relativePath: relativePaths[index] || file.name
          }))
          .filter(({ file }) => file.name.toLowerCase().endsWith(".pdf"));

        if (pdfFiles.length === 0) {
          writeJson(response, 400, { error: "At least one PDF file is required." });
          return;
        }

        const batch = await batches.enqueueUploads(pdfFiles, workloadId);
        writeJson(response, 202, batch);
        return;
      }

      const artifactMatch = url.pathname.match(/^\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
      if (request.method === "GET" && artifactMatch) {
        const [, jobId, artifactName] = artifactMatch;
        const job = queue.get(jobId);
        const artifactPath = job?.artifacts?.[artifactName];

        if (!artifactPath) {
          writeJson(response, 404, { error: "Artifact not found" });
          return;
        }

        const body = await readFile(artifactPath);
        response.writeHead(200, {
          "Content-Type": getContentType(artifactPath),
          "Content-Disposition": `attachment; filename="${path.basename(artifactPath)}"`
        });
        response.end(body);
        return;
      }

      const batchMatch = url.pathname.match(/^\/batches\/([^/]+)$/);
      if (request.method === "GET" && batchMatch) {
        const batch = await batches.get(batchMatch[1]);
        if (!batch) {
          writeJson(response, 404, { error: "Batch not found" });
          return;
        }

        writeJson(response, 200, batch);
        return;
      }

      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
      if (request.method === "GET" && jobMatch) {
        const job = queue.get(jobMatch[1]);
        if (!job) {
          writeJson(response, 404, { error: "Job not found" });
          return;
        }

        writeJson(response, 200, await buildJobResponse(jobMatch[1], job));
        return;
      }

      if (request.method === "GET") {
        const assetPath = resolvePublicAsset(url.pathname);

        if (assetPath && (await serveStaticAsset(response, assetPath))) {
          return;
        }
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      writeJson(response, Number.isInteger(error.statusCode) ? error.statusCode : 500, { error: error.message });
    }
  });
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  const queue = createJobQueue({
    processor: runWorkload,
    outputRoot: path.join(repoRoot, "tmp", "jobs")
  });
  const server = createAppServer({
    queue,
    uploadRoot: path.join(repoRoot, "tmp", "uploads")
  });

  server.listen(port, () => {
    process.stdout.write(`Server listening on http://localhost:${port}\n`);
  });
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
