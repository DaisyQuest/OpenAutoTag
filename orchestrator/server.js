import crypto from "node:crypto";
import dns from "node:dns/promises";
import { createWriteStream } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getRuntimeRoot, getRuntimeSubdir, isAzureAppServiceRuntime } from "../scripts/runtime-paths.js";
import { createEnvironmentAuthController } from "./auth-controller.js";
import { createJobQueue } from "./job-queue.js";
import { getArtifactLabel } from "./public/report-renderers.js";
import { getPublicWorkload, listWorkloads, runWorkload, summarizeWorkloadJob } from "./workloads/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const runtimeRoot = getRuntimeRoot({ repoRoot });
const PDF_SIGNATURE = Buffer.from("%PDF-");
const DEFAULT_REMOTE_DOWNLOAD_POLICY = Object.freeze({
  allowPrivateHosts: false,
  maxBytes: 50 * 1024 * 1024,
  maxRedirects: 5,
  probeBytes: 1024,
  timeoutMs: 15000
});
const DEFAULT_JSON_BODY_LIMIT = 1024 * 1024;
const DEFAULT_TEXT_BODY_LIMIT = 16 * 1024;
const BASE_SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'; form-action 'self'"
});

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"]
]);

function buildResponseHeaders(headers = {}) {
  return {
    ...BASE_SECURITY_HEADERS,
    ...headers
  };
}

async function readJsonBody(request, { maxBytes = DEFAULT_JSON_BODY_LIMIT } = {}) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maxBytes) {
      throw createHttpError(413, `Request body exceeded the ${maxBytes} byte limit.`);
    }

    chunks.push(buffer);
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

async function readTextBody(request, { maxBytes = DEFAULT_TEXT_BODY_LIMIT } = {}) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maxBytes) {
      throw createHttpError(413, `Request body exceeded the ${maxBytes} byte limit.`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response, statusCode, payload, headers = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    })
  );
  response.end(JSON.stringify(payload, null, 2));
}

function writeText(response, statusCode, text, contentType = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders({
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...headers
    })
  );
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

function getCacheControl(contentType) {
  if (contentType.startsWith("text/html") || contentType.includes("json")) {
    return "no-store";
  }

  return "public, max-age=300";
}

function createAbortSignal(timeoutMs) {
  return AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_REMOTE_DOWNLOAD_POLICY.timeoutMs));
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

function isPdfContentType(value) {
  const contentType = String(value || "").toLowerCase();
  return (
    contentType.includes("application/pdf") ||
    contentType.includes("application/x-pdf") ||
    contentType.includes("application/octet-stream")
  );
}

function isPdfMetadata(url, response) {
  const decodedPath = decodeUriComponent(url.pathname || "").toLowerCase();
  const dispositionFileName = extractFilenameFromContentDisposition(response.headers.get("content-disposition")).toLowerCase();
  return decodedPath.endsWith(".pdf") || dispositionFileName.endsWith(".pdf") || isPdfContentType(response.headers.get("content-type"));
}

function getContentLength(response) {
  const rawValue = String(response.headers.get("content-length") || "").trim();
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : null;
}

function assertMaxContentLength(response, policy) {
  const contentLength = getContentLength(response);
  if (contentLength != null && contentLength > policy.maxBytes) {
    throw createHttpError(413, `Remote PDF exceeds the ${policy.maxBytes} byte safety limit.`);
  }
}

function ipv4ToInt(address) {
  return address
    .split(".")
    .map((part) => Number(part))
    .reduce((value, octet) => ((value << 8) | (octet & 0xff)) >>> 0, 0);
}

function isUnsafeIpv4Address(address) {
  const value = ipv4ToInt(address);
  const ranges = [
    [0x00000000, 0x00ffffff],
    [0x0a000000, 0x0affffff],
    [0x64400000, 0x647fffff],
    [0x7f000000, 0x7fffffff],
    [0xa9fe0000, 0xa9feffff],
    [0xac100000, 0xac1fffff],
    [0xc0000000, 0xc00000ff],
    [0xc0000200, 0xc00002ff],
    [0xc0a80000, 0xc0a8ffff],
    [0xc6120000, 0xc613ffff],
    [0xc6336400, 0xc63364ff],
    [0xcb007100, 0xcb0071ff],
    [0xe0000000, 0xffffffff]
  ];

  return ranges.some(([start, end]) => value >= start && value <= end);
}

function isUnsafeIpv6Address(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  const mappedIpv4Match = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4Match) {
    return isUnsafeIpv4Address(mappedIpv4Match[1]);
  }

  if (normalized.startsWith("2001:db8:")) {
    return true;
  }

  const firstSegment = normalized.startsWith("::") ? "0" : normalized.split(":")[0] || "0";
  const firstHextet = parseInt(firstSegment, 16);
  if (!Number.isFinite(firstHextet)) {
    return true;
  }

  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    (firstHextet >= 0xfec0 && firstHextet <= 0xfeff) ||
    (firstHextet >= 0xff00 && firstHextet <= 0xffff)
  );
}

function isUnsafeIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    return isUnsafeIpv4Address(address);
  }

  if (family === 6) {
    return isUnsafeIpv6Address(address);
  }

  return true;
}

async function assertSafeRemoteHost(url, policy) {
  if (policy.allowPrivateHosts) {
    return;
  }

  const hostname = String(url.hostname || "").trim().toLowerCase();
  if (!hostname) {
    throw createHttpError(400, "Remote URL is missing a hostname.");
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw createHttpError(403, "Remote URL host is blocked by download safety policy.");
  }

  const resolvedAddresses = [];
  if (net.isIP(hostname)) {
    resolvedAddresses.push(hostname);
  } else {
    let lookupRecords;
    try {
      lookupRecords = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw createHttpError(502, `Unable to resolve remote host: ${error.message}`);
    }

    resolvedAddresses.push(...lookupRecords.map((record) => record.address));
  }

  if (!resolvedAddresses.length) {
    throw createHttpError(502, "Remote host did not resolve to any IP addresses.");
  }

  if (resolvedAddresses.some((address) => isUnsafeIpAddress(address))) {
    throw createHttpError(403, "Remote URL host is blocked by download safety policy.");
  }
}

async function followRemoteRequest(startUrl, { method, headers = {}, policy }) {
  let currentUrl = new URL(startUrl.toString());
  let currentMethod = method;
  const visited = new Set();

  for (let redirectCount = 0; redirectCount <= policy.maxRedirects; redirectCount += 1) {
    const visitKey = `${currentMethod}:${currentUrl.toString()}`;
    if (visited.has(visitKey)) {
      throw createHttpError(502, "Remote URL redirect loop detected.");
    }
    visited.add(visitKey);

    await assertSafeRemoteHost(currentUrl, policy);

    let response;
    try {
      response = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        redirect: "manual",
        signal: createAbortSignal(policy.timeoutMs)
      });
    } catch (error) {
      throw createHttpError(502, `Unable to fetch remote PDF: ${error.message}`);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw createHttpError(502, "Remote server returned a redirect without a location header.");
      }

      currentUrl = new URL(location, currentUrl);
      currentMethod = response.status === 303 ? "GET" : currentMethod;
      continue;
    }

    return {
      response,
      finalUrl: currentUrl
    };
  }

  throw createHttpError(502, `Remote URL redirected more than ${policy.maxRedirects} times.`);
}

async function readProbeBuffer(response, maxBytes) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (totalBytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      const remainingBytes = maxBytes - totalBytes;
      const slice = chunk.subarray(0, remainingBytes);
      chunks.push(slice);
      totalBytes += slice.length;

      if (slice.length < chunk.length) {
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from already-finished streams.
    }
  }

  return Buffer.concat(chunks);
}

function assertPdfSignature(buffer, policy) {
  const headerOffset = buffer.indexOf(PDF_SIGNATURE);
  if (headerOffset === -1 || headerOffset >= policy.probeBytes) {
    throw createHttpError(415, "Remote file failed PDF signature validation.");
  }
}

function createPdfSafetyTransform(policy) {
  let totalBytes = 0;
  let probeBuffer = Buffer.alloc(0);

  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;

      if (totalBytes > policy.maxBytes) {
        callback(createHttpError(413, `Remote PDF exceeds the ${policy.maxBytes} byte safety limit.`));
        return;
      }

      if (probeBuffer.length < policy.probeBytes) {
        const remainingBytes = policy.probeBytes - probeBuffer.length;
        probeBuffer = Buffer.concat([probeBuffer, buffer.subarray(0, remainingBytes)]);
      }

      callback(null, buffer);
    },
    flush(callback) {
      try {
        assertPdfSignature(probeBuffer, policy);
        callback();
      } catch (error) {
        callback(error);
      }
    }
  });
}

function buildRemoteFileName(sourceUrl, response) {
  const contentDispositionName = extractFilenameFromContentDisposition(response.headers.get("content-disposition"));
  const finalUrl = parseHttpUrl(response.url) || sourceUrl;
  const urlFileName = decodeUriComponent(path.basename(finalUrl.pathname || ""));
  const baseName = sanitizeSegment(contentDispositionName || urlFileName, "remote-document.pdf");
  return baseName.toLowerCase().endsWith(".pdf") ? baseName : `${baseName}.pdf`;
}

async function performRemotePdfPreflight(sourceUrl, policy) {
  const headResult = await followRemoteRequest(sourceUrl, {
    method: "HEAD",
    headers: {
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1"
    },
    policy
  });

  if (!headResult.response.ok && ![405, 501].includes(headResult.response.status)) {
    throw createHttpError(502, `Remote server returned ${headResult.response.status} ${headResult.response.statusText}.`);
  }

  if (headResult.response.ok) {
    assertMaxContentLength(headResult.response, policy);
    if (!isPdfMetadata(headResult.finalUrl, headResult.response)) {
      throw createHttpError(415, "Remote URL did not look like a PDF during preflight checks.");
    }
  }

  const probeResult = await followRemoteRequest(sourceUrl, {
    method: "GET",
    headers: {
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
      Range: `bytes=0-${policy.probeBytes - 1}`
    },
    policy
  });

  if (!probeResult.response.ok) {
    throw createHttpError(502, `Remote server returned ${probeResult.response.status} ${probeResult.response.statusText}.`);
  }

  assertMaxContentLength(probeResult.response, policy);
  if (!isPdfMetadata(probeResult.finalUrl, probeResult.response)) {
    throw createHttpError(415, "Remote URL did not resolve to a PDF.");
  }

  const probeBuffer = await readProbeBuffer(probeResult.response, policy.probeBytes);
  if (!probeBuffer.length) {
    throw createHttpError(502, "Remote server returned an empty response body.");
  }

  assertPdfSignature(probeBuffer, policy);

  return {
    finalUrl: probeResult.finalUrl
  };
}

async function downloadRemotePdf({ fileUrl, downloadRoot, policy = DEFAULT_REMOTE_DOWNLOAD_POLICY }) {
  const sourceUrl = parseHttpUrl(fileUrl);
  if (!sourceUrl) {
    throw createHttpError(400, "fileUrl must be an absolute http or https URL.");
  }

  if (sourceUrl.username || sourceUrl.password) {
    throw createHttpError(400, "Remote PDF URLs with embedded credentials are not allowed.");
  }

  const resolvedPolicy = {
    ...DEFAULT_REMOTE_DOWNLOAD_POLICY,
    ...(policy || {})
  };
  const preflight = await performRemotePdfPreflight(sourceUrl, resolvedPolicy);
  const downloadResult = await followRemoteRequest(sourceUrl, {
    method: "GET",
    headers: {
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1"
    },
    policy: resolvedPolicy
  });

  if (!downloadResult.response.ok) {
    throw createHttpError(502, `Remote server returned ${downloadResult.response.status} ${downloadResult.response.statusText}.`);
  }

  assertMaxContentLength(downloadResult.response, resolvedPolicy);
  if (!isPdfMetadata(downloadResult.finalUrl, downloadResult.response)) {
    throw createHttpError(415, "Remote URL did not resolve to a PDF.");
  }

  if (!downloadResult.response.body) {
    throw createHttpError(502, "Remote server returned an empty response body.");
  }

  await mkdir(downloadRoot, { recursive: true });
  const downloadDir = path.join(downloadRoot, crypto.randomUUID());
  await mkdir(downloadDir, { recursive: true });

  const fileName = buildRemoteFileName(sourceUrl, downloadResult.response);
  const targetPath = path.join(downloadDir, fileName);

  try {
    await pipeline(
      Readable.fromWeb(downloadResult.response.body),
      createPdfSafetyTransform(resolvedPolicy),
      createWriteStream(targetPath, { flags: "wx" })
    );
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {});
    await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    absolutePath: targetPath,
    fileName,
    sourceUrl: sourceUrl.toString(),
    finalUrl: (preflight.finalUrl || downloadResult.finalUrl).toString()
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
    const contentType = getContentType(assetPath);
    response.writeHead(
      200,
      buildResponseHeaders({
        "Content-Type": contentType,
        "Cache-Control": getCacheControl(contentType)
      })
    );
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

function classifyArtifactKind(contentType) {
  if (contentType.includes("json")) {
    return "json";
  }

  if (contentType.includes("pdf")) {
    return "pdf";
  }

  return "binary";
}

async function buildArtifactDescriptor(jobId, jobResponse, artifactName, artifactPath) {
  const contentType = getContentType(artifactPath);
  let fileStats = null;

  try {
    fileStats = await stat(artifactPath);
  } catch {
    fileStats = null;
  }

  const kind = classifyArtifactKind(contentType);

  return {
    id: `${jobId}:${artifactName}`,
    jobId,
    documentName: jobResponse.fileName,
    documentPath: jobResponse.relativePath,
    sourceUrl: jobResponse.sourceUrl,
    jobStatus: jobResponse.status,
    jobUpdatedAt: jobResponse.updatedAt,
    workload: jobResponse.workload || null,
    summary: jobResponse.summary || null,
    validation: jobResponse.validation || null,
    name: artifactName,
    label: getArtifactLabel(artifactName),
    artifactFileName: path.basename(artifactPath),
    url: `/jobs/${jobId}/artifacts/${artifactName}`,
    reportUrl: `/report.html?jobId=${encodeURIComponent(jobId)}&artifact=${encodeURIComponent(artifactName)}`,
    contentType,
    kind,
    previewMode: kind === "json" ? "report" : "download",
    browserPreviewable: kind === "json",
    available: Boolean(fileStats),
    sizeBytes: fileStats?.size ?? null,
    updatedAt: fileStats?.mtime ? fileStats.mtime.toISOString() : jobResponse.updatedAt
  };
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

async function buildJobList(queue) {
  const jobs = queue.list().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return Promise.all(
    jobs.map(async (job) => ({
      ...(await buildJobResponse(job.jobId, job)),
      hasArtifacts: Object.keys(job?.artifacts || {}).length > 0
    }))
  );
}

async function buildQueueSnapshot(queue, batches) {
  const [jobs, batchList] = await Promise.all([buildJobList(queue), batches.list()]);

  return {
    generatedAt: new Date().toISOString(),
    queue: queue.stats(),
    totalBatches: batchList.length,
    activeJobs: jobs.filter((job) => job.status === "queued" || job.status === "running"),
    recentJobs: jobs.slice(0, 24),
    batches: batchList.slice(0, 12)
  };
}

async function buildHistorySnapshot(queue) {
  const jobs = await buildJobList(queue);
  const jobsByStatus = jobs.reduce(
    (summary, job) => {
      summary.total += 1;
      summary[job.status] = (summary[job.status] || 0) + 1;
      return summary;
    },
    {
      total: 0,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    summary: jobsByStatus,
    jobs
  };
}

async function buildArtifactInventorySnapshot(queue) {
  const jobs = queue.list();
  const artifacts = (
    await Promise.all(
      jobs.map(async (job) => {
        const jobResponse = await buildJobResponse(job.jobId, job);
        return Promise.all(
          Object.entries(job?.artifacts || {})
            .filter(([, artifactPath]) => Boolean(artifactPath))
            .map(([artifactName, artifactPath]) => buildArtifactDescriptor(job.jobId, jobResponse, artifactName, artifactPath))
        );
      })
    )
  )
    .flat()
    .sort(
      (left, right) =>
        String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) ||
        String(right.jobUpdatedAt || "").localeCompare(String(left.jobUpdatedAt || "")) ||
        left.documentName.localeCompare(right.documentName) ||
        left.label.localeCompare(right.label)
    );

  const summary = artifacts.reduce(
    (current, artifact) => {
      current.totalArtifacts += 1;
      current.totalBytes += Number(artifact.sizeBytes || 0);
      current.jobsWithArtifacts.add(artifact.jobId);

      if (artifact.browserPreviewable) {
        current.previewableArtifacts += 1;
      }

      if (artifact.kind === "json") {
        current.jsonArtifacts += 1;
      } else if (artifact.kind === "pdf") {
        current.pdfArtifacts += 1;
      } else {
        current.binaryArtifacts += 1;
      }

      if (!artifact.available) {
        current.missingArtifacts += 1;
      }

      return current;
    },
    {
      totalArtifacts: 0,
      previewableArtifacts: 0,
      jsonArtifacts: 0,
      pdfArtifacts: 0,
      binaryArtifacts: 0,
      missingArtifacts: 0,
      totalBytes: 0,
      jobsWithArtifacts: new Set()
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      jobsTracked: jobs.length,
      jobsWithArtifacts: summary.jobsWithArtifacts.size,
      totalArtifacts: summary.totalArtifacts,
      previewableArtifacts: summary.previewableArtifacts,
      jsonArtifacts: summary.jsonArtifacts,
      pdfArtifacts: summary.pdfArtifacts,
      binaryArtifacts: summary.binaryArtifacts,
      missingArtifacts: summary.missingArtifacts,
      totalBytes: summary.totalBytes
    },
    artifacts
  };
}

async function buildSystemSnapshot({ queue, batches, auth, uploadRoot }) {
  await mkdir(runtimeRoot, { recursive: true });
  const [authSnapshot, queueSnapshot] = await Promise.all([auth.getManagementSnapshot(), buildQueueSnapshot(queue, batches)]);
  const memory = process.memoryUsage();

  return {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
      memory
    },
    runtime: {
      root: runtimeRoot,
      jobsRoot: getRuntimeSubdir("jobs", { repoRoot }),
      uploadRoot,
      home: process.env.HOME || null,
      azureAppService: isAzureAppServiceRuntime(),
      runFromPackage: process.env.WEBSITE_RUN_FROM_PACKAGE || null
    },
    auth: authSnapshot,
    queue: queueSnapshot.queue,
    batchCount: queueSnapshot.totalBatches
  };
}

function createBatchRegistry({ queue, uploadRoot = getRuntimeSubdir("uploads", { repoRoot }) }) {
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
          statusDetail: job?.statusDetail || null,
          error: job?.error || null,
          createdAt: job?.createdAt || batch.createdAt,
          updatedAt: job?.updatedAt || batch.createdAt,
          stageSummary: job?.stageSummary || null,
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
    },
    async list() {
      const snapshots = await Promise.all([...batches.values()].map((batch) => buildBatchSnapshot(batch)));
      return snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
  };
}

export function createAppServer({
  queue,
  uploadRoot = getRuntimeSubdir("uploads", { repoRoot }),
  remoteDownloadPolicy = DEFAULT_REMOTE_DOWNLOAD_POLICY,
  auth = createEnvironmentAuthController({ runtimeRoot })
}) {
  const batches = createBatchRegistry({ queue, uploadRoot });
  const remoteDownloadRoot = path.join(uploadRoot, "remote");

  async function authenticate(request, policy = {}) {
    return auth.requireAccess(request, policy);
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, buildResponseHeaders({ "Cache-Control": "public, max-age=300" }));
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/config") {
        writeJson(response, 200, auth.getClientConfig());
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/access") {
        const access = await auth.describeAccess(request);
        const ok = access.publicMode || access.apiAuthorized || access.adminAuthorized;

        writeJson(response, ok ? 200 : 401, {
          ok,
          publicMode: access.publicMode,
          ...(ok ? {} : { error: "The provided key was not accepted." }),
          access: {
            api: Boolean(access.apiAuthorized || access.adminAuthorized),
            admin: Boolean(access.adminAuthorized),
            mode: access.mode
          },
          headers: auth.headers
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        await authenticate(request, { admin: true });
        await mkdir(runtimeRoot, { recursive: true });
        writeJson(response, 200, {
          ok: true,
          runtime: {
            root: runtimeRoot,
            jobsRoot: getRuntimeSubdir("jobs", { repoRoot }),
            uploadRoot,
            azureAppService: isAzureAppServiceRuntime(),
            home: process.env.HOME || null,
            runFromPackage: process.env.WEBSITE_RUN_FROM_PACKAGE || null
          }
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/workloads") {
        await authenticate(request, { api: true });
        writeJson(response, 200, { workloads: listWorkloads() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/process-pdf") {
        await authenticate(request, { api: true });
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
        await authenticate(request, { api: true });
        const body = await readJsonBody(request);
        if (!body.fileUrl) {
          writeJson(response, 400, { error: "fileUrl is required" });
          return;
        }

        const workload = getPublicWorkload(body.workloadId);
        const remotePdf = await downloadRemotePdf({
          fileUrl: body.fileUrl,
          downloadRoot: remoteDownloadRoot,
          policy: remoteDownloadPolicy
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
        await authenticate(request, { api: true });
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
        await authenticate(request, { api: true });
        const [, jobId, artifactName] = artifactMatch;
        const job = queue.get(jobId);
        const artifactPath = job?.artifacts?.[artifactName];

        if (!artifactPath) {
          writeJson(response, 404, { error: "Artifact not found" });
          return;
        }

        const body = await readFile(artifactPath);
        response.writeHead(
          200,
          buildResponseHeaders({
            "Content-Type": getContentType(artifactPath),
            "Content-Disposition": `attachment; filename="${path.basename(artifactPath)}"`,
            "Cache-Control": "no-store"
          })
        );
        response.end(body);
        return;
      }

      const batchMatch = url.pathname.match(/^\/batches\/([^/]+)$/);
      if (request.method === "GET" && batchMatch) {
        await authenticate(request, { api: true });
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
        await authenticate(request, { api: true });
        const job = queue.get(jobMatch[1]);
        if (!job) {
          writeJson(response, 404, { error: "Job not found" });
          return;
        }

        writeJson(response, 200, await buildJobResponse(jobMatch[1], job));
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin/system") {
        await authenticate(request, { admin: true });
        writeJson(response, 200, await buildSystemSnapshot({ queue, batches, auth, uploadRoot }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin/queue") {
        await authenticate(request, { admin: true });
        writeJson(response, 200, await buildQueueSnapshot(queue, batches));
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin/history") {
        await authenticate(request, { admin: true });
        writeJson(response, 200, await buildHistorySnapshot(queue));
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin/artifacts") {
        await authenticate(request, { admin: true });
        writeJson(response, 200, await buildArtifactInventorySnapshot(queue));
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin/api-keys") {
        await authenticate(request, { admin: true });
        writeJson(response, 200, await auth.getManagementSnapshot());
        return;
      }

      if (request.method === "POST" && url.pathname === "/admin/api-keys") {
        await authenticate(request, { admin: true });
        const body = await readJsonBody(request);
        const created = await auth.createManagedKey({
          label: body.label,
          description: body.description
        });
        writeJson(response, 201, created);
        return;
      }

      const apiKeyMatch = url.pathname.match(/^\/admin\/api-keys\/([^/]+)$/);
      if (request.method === "DELETE" && apiKeyMatch) {
        await authenticate(request, { admin: true });
        writeJson(response, 200, {
          record: await auth.revokeManagedKey(apiKeyMatch[1])
        });
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
  const jobsRoot = getRuntimeSubdir("jobs", { repoRoot });
  const queue = createJobQueue({
    processor: runWorkload,
    outputRoot: jobsRoot
  });
  const server = createAppServer({
    queue,
    uploadRoot: getRuntimeSubdir("uploads", { repoRoot })
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
