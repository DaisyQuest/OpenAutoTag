import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRuntimeRoot } from "../scripts/runtime-paths.js";
import { runWorkload } from "./workloads/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function normalizeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function buildAuthHeaders({ apiKey, adminKey }) {
  if (adminKey) {
    return { "X-ADMIN-KEY": adminKey };
  }

  if (apiKey) {
    return { "X-API-KEY": apiKey };
  }

  return {};
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(typeof payload === "object" && payload?.error ? payload.error : `${response.status} ${response.statusText}`);
  }

  return payload;
}

async function fetchBuffer(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    headers: response.headers
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFailureSnapshot({ assignment, inputPath, outputDir, error, heartbeatIntervalMs }) {
  const timestamp = new Date().toISOString();
  return {
    jobId: assignment.jobId,
    status: "failed",
    workload: assignment.workload,
    input: {
      filePath: inputPath,
      outputDir,
      workloadId: assignment?.workload?.id,
      options: assignment?.options || {}
    },
    artifacts: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    error: String(error?.message || error || "Remote agent execution failed."),
    statusDetail: {
      state: "failed",
      message: String(error?.message || error || "Remote agent execution failed."),
      completedStages: 0,
      totalStages: null,
      currentStage: null,
      heartbeatIntervalMs
    }
  };
}

function contentTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return "application/pdf";
  }

  if (extension === ".json") {
    return "application/json";
  }

  if (extension === ".txt" || extension === ".log") {
    return "text/plain; charset=utf-8";
  }

  return "application/octet-stream";
}

async function collectWorkspaceFiles(rootDir, baseDir = rootDir) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectWorkspaceFiles(absolutePath, baseDir)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push({
      absolutePath,
      relativePath: path.relative(baseDir, absolutePath).replace(/\\/g, "/")
    });
  }

  return files;
}

async function ensureAgentId(runtimeRoot, env = process.env) {
  const configured = normalizeText(env.AGENT_ID) || normalizeText(env.WEBSITE_INSTANCE_ID);
  if (configured) {
    return configured;
  }

  const identityPath = path.join(runtimeRoot, "agent-id.txt");

  try {
    return normalizeText(await readFile(identityPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const generated = crypto.randomUUID();
  await mkdir(path.dirname(identityPath), { recursive: true });
  await writeFile(identityPath, `${generated}\n`, "utf8");
  return generated;
}

function createState({
  agentId,
  label,
  masterEndpoint,
  heartbeatIntervalMs,
  checkInIntervalMs,
  runtimeRoot,
  workRoot
}) {
  const startedAt = new Date().toISOString();

  return {
    ok: true,
    agentId,
    label,
    masterEndpoint,
    heartbeatIntervalMs,
    checkInIntervalMs,
    startedAt,
    runtime: {
      root: runtimeRoot,
      workRoot
    },
    status: "starting",
    lastCheckInAt: null,
    lastMasterResponseAt: null,
    currentJobId: null,
    currentWorkloadId: null,
    currentStage: null,
    currentMessage: "Starting agent runtime.",
    jobsClaimed: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    lastError: null
  };
}

function buildRootPage(state) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BuildEverything Agent</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #04131d;
        --panel: rgba(10, 33, 48, 0.88);
        --line: rgba(132, 215, 214, 0.22);
        --ink: #ecfbff;
        --muted: #95b9c4;
        --signal: #59f3d4;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem;
        background:
          radial-gradient(circle at top, rgba(89, 243, 212, 0.18), transparent 28rem),
          linear-gradient(180deg, #04131d 0%, #091f2c 100%);
        color: var(--ink);
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      }
      main {
        width: min(100%, 42rem);
        padding: 1.5rem;
        border-radius: 1.5rem;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 6vw, 3.2rem);
      }
      p { color: var(--muted); line-height: 1.7; }
      dl {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1rem;
        margin: 1.5rem 0 0;
      }
      div {
        padding: 0.9rem 1rem;
        border-radius: 1rem;
        border: 1px solid rgba(132, 215, 214, 0.14);
        background: rgba(4, 19, 29, 0.68);
      }
      dt { color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.12em; }
      dd { margin: 0.35rem 0 0; font-weight: 700; }
      code {
        display: inline-block;
        margin-top: 1rem;
        padding: 0.65rem 0.8rem;
        border-radius: 999px;
        background: rgba(89, 243, 212, 0.1);
        color: var(--signal);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent online</h1>
      <p>This App Service instance is running as a BuildEverything worker agent. Health and runtime status are available from <code>/health</code>.</p>
      <dl>
        <div><dt>Agent</dt><dd>${state.label}</dd></div>
        <div><dt>Status</dt><dd>${state.status}</dd></div>
        <div><dt>Current job</dt><dd>${state.currentJobId || "Idle"}</dd></div>
        <div><dt>Master</dt><dd>${state.masterEndpoint}</dd></div>
      </dl>
    </main>
  </body>
</html>`;
}

export async function createAgentService({
  masterEndpoint,
  apiKey = "",
  adminKey = "",
  label = "",
  pollIntervalMs = 5000,
  heartbeatIntervalMs = 5000,
  checkInIntervalMs = 5000,
  runtimeRoot = getRuntimeRoot({ repoRoot, appName: "openautotag-agent" }),
  workRoot = path.join(getRuntimeRoot({ repoRoot, appName: "openautotag-agent" }), "jobs"),
  runJob = runWorkload,
  env = process.env
} = {}) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedWorkRoot = path.resolve(workRoot);
  await mkdir(resolvedWorkRoot, { recursive: true });
  const agentId = await ensureAgentId(resolvedRuntimeRoot, env);
  const resolvedLabel = normalizeText(label) || normalizeText(env.WEBSITE_SITE_NAME) || `agent-${agentId.slice(0, 8)}`;
  const resolvedMasterEndpoint = new URL(masterEndpoint).toString();
  const resolvedHeartbeatIntervalMs = normalizeInteger(heartbeatIntervalMs, 5000);
  const resolvedCheckInIntervalMs = normalizeInteger(checkInIntervalMs, normalizeInteger(pollIntervalMs, 5000));
  const authHeaders = buildAuthHeaders({ apiKey: normalizeText(apiKey), adminKey: normalizeText(adminKey) });
  const supportedWorkloads = ["accessibility-tagging", "ssn-redaction", "tag-and-ssn-redact"];
  const state = createState({
    agentId,
    label: resolvedLabel,
    masterEndpoint: resolvedMasterEndpoint,
    heartbeatIntervalMs: resolvedHeartbeatIntervalMs,
    checkInIntervalMs: resolvedCheckInIntervalMs,
    runtimeRoot: resolvedRuntimeRoot,
    workRoot: resolvedWorkRoot
  });

  let shuttingDown = false;
  let loopPromise = null;
  let serverClosePromise = null;

  async function sendHeartbeat(assignment, statusDetail) {
    try {
      state.lastCheckInAt = new Date().toISOString();
      state.lastMasterResponseAt = state.lastCheckInAt;
      await fetchJson(new URL(assignment.heartbeatUrl, resolvedMasterEndpoint), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders
        },
        body: JSON.stringify({
          agentId,
          statusDetail
        })
      });
    } catch (error) {
      state.lastError = error.message;
    }
  }

  async function uploadCompletion(assignment, snapshot, outputDir) {
    const workspaceFiles = await collectWorkspaceFiles(outputDir);
    const formData = new FormData();
    formData.append("agentId", agentId);
    formData.append("snapshot", JSON.stringify(snapshot));

    for (const file of workspaceFiles) {
      const body = await readFile(file.absolutePath);
      formData.append("relativePaths", file.relativePath);
      formData.append("files", new File([body], path.basename(file.relativePath), { type: contentTypeForFile(file.absolutePath) }));
    }

    state.currentMessage = `Uploading ${workspaceFiles.length} workspace artifact${workspaceFiles.length === 1 ? "" : "s"} to the master.`;
    await sendHeartbeat(assignment, {
      state: "agent_uploading_artifacts",
      message: state.currentMessage,
      completedStages: snapshot?.stageSummary?.completedStages ?? snapshot?.statusDetail?.completedStages ?? 0,
      totalStages: snapshot?.stageSummary?.total ?? snapshot?.statusDetail?.totalStages ?? null,
      currentStage: null,
      lastStage: snapshot?.statusDetail?.lastStage ?? null,
      heartbeatIntervalMs: resolvedHeartbeatIntervalMs
    });

    return fetchJson(new URL(assignment.completeUrl, resolvedMasterEndpoint), {
      method: "POST",
      headers: {
        ...authHeaders
      },
      body: formData
    });
  }

  async function processAssignment(assignment) {
    const jobWorkspace = await mkdtemp(path.join(resolvedWorkRoot, `${assignment.jobId}-`));
    const outputDir = path.join(jobWorkspace, "output");
    const sourceFileName = normalizeText(assignment?.input?.sourceFileName) || `${assignment.jobId}.pdf`;
    const inputPath = path.join(jobWorkspace, sourceFileName);

    state.status = "busy";
    state.currentJobId = assignment.jobId;
    state.currentWorkloadId = assignment?.workload?.id || null;
    state.currentMessage = "Downloading source workspace from the master.";
    state.currentStage = null;
    state.jobsClaimed += 1;

    try {
      await sendHeartbeat(assignment, {
        state: "agent_downloading_input",
        message: state.currentMessage,
        completedStages: 0,
        totalStages: null,
        currentStage: null,
        heartbeatIntervalMs: resolvedHeartbeatIntervalMs
      });

      const inputResponse = await fetchBuffer(new URL(assignment.downloadUrl, resolvedMasterEndpoint), {
        headers: authHeaders
      });
      await mkdir(path.dirname(inputPath), { recursive: true });
      await writeFile(inputPath, inputResponse.buffer);

      const snapshot = await runJob({
        filePath: inputPath,
        outputDir,
        jobId: assignment.jobId,
        workloadId: assignment?.workload?.id,
        workload: assignment?.workload,
        options: assignment?.options || {},
        heartbeatIntervalMs: resolvedHeartbeatIntervalMs,
        onProgress: async (statusDetail) => {
          state.currentMessage = statusDetail?.message || "Processing assigned job.";
          state.currentStage = statusDetail?.currentStage || null;
          await sendHeartbeat(assignment, statusDetail);
        }
      });

      await uploadCompletion(assignment, snapshot, outputDir);
      state.jobsCompleted += 1;
      state.lastError = null;
      state.currentMessage = `Completed job ${assignment.jobId}.`;
    } catch (error) {
      const snapshot = error?.snapshot || error?.jobSnapshot;
      state.lastError = error.message;
      state.currentMessage = `Job ${assignment.jobId} failed.`;
      state.jobsFailed += 1;

      if (snapshot?.jobId === assignment.jobId) {
        await uploadCompletion(
          assignment,
          {
            ...snapshot,
            updatedAt: snapshot.updatedAt || new Date().toISOString()
          },
          outputDir
        ).catch(() => {});
      } else {
        await uploadCompletion(
          assignment,
          buildFailureSnapshot({
            assignment,
            inputPath,
            outputDir,
            error,
            heartbeatIntervalMs: resolvedHeartbeatIntervalMs
          }),
          outputDir
        ).catch(() => {});
      }
    } finally {
      state.status = "idle";
      state.currentJobId = null;
      state.currentWorkloadId = null;
      state.currentStage = null;
      await rm(jobWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function pollLoop() {
    while (!shuttingDown) {
      try {
        state.status = state.currentJobId ? "busy" : "idle";
        state.currentMessage = state.currentJobId ? state.currentMessage : "Checking in with the master.";
        const payload = await fetchJson(new URL("/agents/check-in", resolvedMasterEndpoint), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders
          },
          body: JSON.stringify({
            agentId,
            label: resolvedLabel,
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            startedAt: state.startedAt,
            checkInIntervalMs: resolvedCheckInIntervalMs,
            heartbeatIntervalMs: resolvedHeartbeatIntervalMs,
            currentJobId: state.currentJobId,
            currentWorkloadId: state.currentWorkloadId,
            currentMessage: state.currentMessage,
            currentStage: state.currentStage,
            status: state.status,
            capabilities: {
              mode: "poll-download-upload",
              workloads: supportedWorkloads
            },
            runtime: {
              platform: process.platform,
              arch: process.arch,
              nodeVersion: process.version
            }
          })
        });

        state.lastCheckInAt = new Date().toISOString();
        state.lastMasterResponseAt = state.lastCheckInAt;
        state.lastError = null;

        if (payload?.assignment) {
          await processAssignment(payload.assignment);
        } else {
          state.currentMessage = "Idle and waiting for work.";
          await sleep(resolvedCheckInIntervalMs);
        }
      } catch (error) {
        state.status = "error";
        state.lastError = error.message;
        state.currentMessage = `Master check-in failed: ${error.message}`;
        await sleep(normalizeInteger(pollIntervalMs, 5000));
      }
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(
        `${JSON.stringify(
          {
            ok: true,
            ...state
          },
          null,
          2
        )}\n`
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(buildRootPage(state));
      return;
    }

    response.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(`${JSON.stringify({ error: "Not found" }, null, 2)}\n`);
  });

  return {
    state,
    server,
    async start({ port = Number(env.PORT || 3000) } = {}) {
      await new Promise((resolve) => server.listen(port, resolve));
      state.status = "idle";
      state.currentMessage = "Agent runtime is online.";
      loopPromise = pollLoop();
      return server;
    },
    async close() {
      shuttingDown = true;
      if (!serverClosePromise) {
        serverClosePromise = new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }

      await serverClosePromise;
      await loopPromise?.catch(() => {});
    }
  };
}

export async function startAgentService(options = {}) {
  const service = await createAgentService(options);
  await service.start();
  return service;
}
