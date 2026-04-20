import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getRuntimeRoot } from "../scripts/runtime-paths.js";
import {
  clampWorkerConcurrency,
  loadAgentRuntimeConfig,
  MAX_WORKER_CONCURRENCY
} from "./agent-runtime-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultWorkerModulePath = path.join(__dirname, "agent-worker.js");

const DEFAULT_BACKOFF = Object.freeze({
  initialMs: 1000,
  maxMs: 30_000,
  stabilityThresholdMs: 60_000
});
const DEFAULT_WORKER_WATCHDOG_MS = 45_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function normalizeText(value) {
  return String(value || "").trim();
}

function nextBackoff({ lastBackoffMs, stableSinceMs, now, backoff }) {
  if (lastBackoffMs === 0) {
    return backoff.initialMs;
  }

  if (stableSinceMs && now - stableSinceMs >= backoff.stabilityThresholdMs) {
    return backoff.initialMs;
  }

  return Math.min(backoff.maxMs, lastBackoffMs * 2);
}

async function ensureBaseAgentId({ runtimeRoot, env = process.env }) {
  const fromEnv = normalizeText(env.AGENT_ID) || normalizeText(env.WEBSITE_INSTANCE_ID);
  if (fromEnv) {
    return fromEnv;
  }

  const identityPath = path.join(runtimeRoot, "supervisor-id.txt");
  try {
    const existing = normalizeText(await readFile(identityPath, "utf8"));
    if (existing) {
      return existing;
    }
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

function buildWorkerEnv({ baseEnv, baseAgentId, baseLabel, workerIndex, workerTotal, workerRuntimeRoot }) {
  const { PORT, ...rest } = baseEnv;
  const labelRoot = baseLabel || normalizeText(baseEnv.WEBSITE_SITE_NAME) || "agent";
  return {
    ...rest,
    AGENT_WORKER_INDEX: String(workerIndex),
    AGENT_WORKER_TOTAL: String(workerTotal),
    AGENT_ID: `${baseAgentId}-w${workerIndex}`,
    AGENT_LABEL: `${labelRoot}.w${workerIndex}`,
    AGENT_RUNTIME_ROOT: workerRuntimeRoot
  };
}

function buildAggregatePage({ summary, slots, masterEndpoint }) {
  const rows = slots
    .map(
      (slot) => `
        <tr>
          <td>w${slot.index}</td>
          <td>${slot.label || "(unknown)"}</td>
          <td>${slot.status}</td>
          <td>${slot.currentJobId || "idle"}</td>
          <td>${slot.restarts}</td>
          <td>${slot.lastError ? String(slot.lastError).slice(0, 80) : ""}</td>
        </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BuildEverything Agent Cluster</title>
    <style>
      body { font-family: "Segoe UI", sans-serif; background: #04131d; color: #ecfbff; margin: 0; padding: 2rem; }
      main { max-width: 960px; margin: 0 auto; background: rgba(10, 33, 48, 0.88); padding: 1.5rem; border-radius: 1rem; border: 1px solid rgba(132, 215, 214, 0.22); }
      h1 { margin: 0 0 0.5rem; }
      dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
      dl > div { padding: 0.75rem; border-radius: 0.75rem; background: rgba(4, 19, 29, 0.68); border: 1px solid rgba(132, 215, 214, 0.14); }
      dt { color: #95b9c4; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.12em; }
      dd { margin: 0.35rem 0 0; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
      th, td { padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(132, 215, 214, 0.14); text-align: left; font-size: 0.9rem; }
      th { color: #95b9c4; font-weight: 500; }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent cluster online</h1>
      <p style="color:#95b9c4">Master endpoint: <code>${masterEndpoint}</code></p>
      <dl>
        <div><dt>Workers</dt><dd>${summary.running}/${summary.total}</dd></div>
        <div><dt>Busy</dt><dd>${summary.busy}</dd></div>
        <div><dt>Idle</dt><dd>${summary.idle}</dd></div>
        <div><dt>Restarts</dt><dd>${summary.totalRestarts}</dd></div>
      </dl>
      <table>
        <thead><tr><th>Slot</th><th>Label</th><th>Status</th><th>Job</th><th>Restarts</th><th>Last error</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

export function createAgentSupervisor({
  config,
  concurrency,
  runtimeRoot,
  baseAgentId,
  baseLabel,
  env = process.env,
  forkFn = fork,
  workerModulePath = defaultWorkerModulePath,
  backoff = DEFAULT_BACKOFF,
  workerWatchdogMs = DEFAULT_WORKER_WATCHDOG_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  logger = console,
  now = () => Date.now()
} = {}) {
  if (!config?.masterEndpoint) {
    throw new Error("Agent supervisor requires a config with masterEndpoint.");
  }

  if (!baseAgentId) {
    throw new Error("Agent supervisor requires a baseAgentId.");
  }

  const resolvedRuntimeRoot = path.resolve(runtimeRoot || getRuntimeRoot({ repoRoot, appName: "openautotag-agent" }));
  const resolvedConcurrency = clampWorkerConcurrency(concurrency ?? config.workerConcurrency ?? 1);
  const resolvedBaseLabel = normalizeText(baseLabel || config.label || env.WEBSITE_SITE_NAME || "");
  const resolvedBackoff = { ...DEFAULT_BACKOFF, ...(backoff || {}) };

  const startedAt = new Date().toISOString();
  const slots = Array.from({ length: resolvedConcurrency }, (_unused, index) => ({
    index,
    child: null,
    pid: null,
    label: `${resolvedBaseLabel || "agent"}.w${index}`,
    status: "pending",
    currentJobId: null,
    currentWorkloadId: null,
    currentMessage: null,
    restarts: 0,
    lastBackoffMs: 0,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
    startedAt: null,
    lastStateAt: null,
    lastPublishedAt: null,
    state: null
  }));

  let shuttingDown = false;
  let server = null;
  let watchdogTimer = null;
  const pendingRestartTimers = new Set();

  function summarize() {
    const summary = {
      total: slots.length,
      running: 0,
      busy: 0,
      idle: 0,
      error: 0,
      totalRestarts: 0
    };

    for (const slot of slots) {
      summary.totalRestarts += slot.restarts;
      if (slot.child) {
        summary.running += 1;
      }

      if (slot.status === "busy") {
        summary.busy += 1;
      } else if (slot.status === "idle") {
        summary.idle += 1;
      } else if (slot.status === "error") {
        summary.error += 1;
      }
    }

    return summary;
  }

  function getSnapshot() {
    return {
      ok: !shuttingDown,
      startedAt,
      masterEndpoint: config.masterEndpoint,
      concurrency: resolvedConcurrency,
      maxConcurrency: MAX_WORKER_CONCURRENCY,
      baseLabel: resolvedBaseLabel || null,
      shuttingDown,
      summary: summarize(),
      slots: slots.map((slot) => ({
        index: slot.index,
        pid: slot.pid,
        label: slot.state?.label || slot.label,
        status: slot.status,
        currentJobId: slot.currentJobId,
        currentWorkloadId: slot.currentWorkloadId,
        currentMessage: slot.currentMessage,
        restarts: slot.restarts,
        lastExitCode: slot.lastExitCode,
        lastExitSignal: slot.lastExitSignal,
        lastError: slot.lastError,
        startedAt: slot.startedAt,
        lastStateAt: slot.lastStateAt
      }))
    };
  }

  function spawnSlot(slot) {
    if (shuttingDown) {
      return;
    }

    const workerRuntimeRoot = path.join(resolvedRuntimeRoot, "workers", `worker-${slot.index}`);
    const workerEnv = buildWorkerEnv({
      baseEnv: env,
      baseAgentId,
      baseLabel: resolvedBaseLabel,
      workerIndex: slot.index,
      workerTotal: resolvedConcurrency,
      workerRuntimeRoot
    });

    const child = forkFn(workerModulePath, [], {
      env: workerEnv,
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    });

    slot.child = child;
    slot.pid = child.pid || null;
    slot.status = "starting";
    slot.startedAt = new Date().toISOString();
    slot.lastStateAt = now();
    slot.lastError = null;

    child.on("message", (message) => handleWorkerMessage(slot, message));
    child.on("exit", (code, signal) => handleWorkerExit(slot, code, signal));
    child.on("error", (error) => {
      slot.lastError = error?.message || String(error);
      logger.warn?.(`[agent-supervisor] worker ${slot.index} error: ${slot.lastError}`);
    });
  }

  function handleWorkerMessage(slot, message) {
    if (!message || typeof message !== "object") {
      return;
    }

    slot.lastStateAt = now();

    if (message.type === "state" && message.state) {
      slot.state = message.state;
      slot.status = message.state.status || slot.status;
      slot.currentJobId = message.state.currentJobId || null;
      slot.currentWorkloadId = message.state.currentWorkloadId || null;
      slot.currentMessage = message.state.currentMessage || null;
      slot.lastError = message.state.lastError || null;
      slot.lastPublishedAt = message.reportedAt || new Date().toISOString();
      return;
    }

    if (message.type === "ready") {
      slot.status = "idle";
      return;
    }

    if (message.type === "fatal") {
      slot.lastError = message.message || "Worker reported fatal error.";
      logger.error?.(`[agent-supervisor] worker ${slot.index} fatal: ${slot.lastError}`);
    }
  }

  function handleWorkerExit(slot, code, signal) {
    slot.child = null;
    slot.pid = null;
    slot.lastExitCode = code;
    slot.lastExitSignal = signal;

    if (shuttingDown) {
      slot.status = "stopped";
      return;
    }

    const ranForMs = slot.startedAt ? now() - Date.parse(slot.startedAt) : 0;
    const stableSinceMs = ranForMs >= resolvedBackoff.stabilityThresholdMs ? now() - ranForMs : null;
    const delayMs = nextBackoff({
      lastBackoffMs: slot.lastBackoffMs,
      stableSinceMs,
      now: now(),
      backoff: resolvedBackoff
    });

    slot.restarts += 1;
    slot.lastBackoffMs = delayMs;
    slot.status = "restarting";
    slot.currentMessage = `Worker exited (code=${code}, signal=${signal || "none"}). Restart in ${delayMs}ms.`;

    logger.warn?.(
      `[agent-supervisor] worker ${slot.index} exited (code=${code}, signal=${signal || "none"}); restart #${slot.restarts} in ${delayMs}ms`
    );

    const timer = setTimeout(() => {
      pendingRestartTimers.delete(timer);
      spawnSlot(slot);
    }, delayMs);

    pendingRestartTimers.add(timer);
    timer.unref?.();
  }

  function runWatchdog() {
    if (shuttingDown) {
      return;
    }

    const threshold = now() - workerWatchdogMs;

    for (const slot of slots) {
      if (!slot.child || !slot.lastStateAt || slot.lastStateAt >= threshold) {
        continue;
      }

      logger.warn?.(
        `[agent-supervisor] worker ${slot.index} unresponsive (no state in ${workerWatchdogMs}ms); killing`
      );
      slot.lastError = `Worker unresponsive; no state for ${workerWatchdogMs}ms.`;
      try {
        slot.child.kill("SIGKILL");
      } catch (error) {
        logger.warn?.(`[agent-supervisor] failed to kill worker ${slot.index}: ${error?.message}`);
      }
    }
  }

  function createHealthServer() {
    return http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        const snapshot = getSnapshot();
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end(`${JSON.stringify(snapshot, null, 2)}\n`);
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        const snapshot = getSnapshot();
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end(
          buildAggregatePage({
            summary: snapshot.summary,
            slots: snapshot.slots,
            masterEndpoint: snapshot.masterEndpoint
          })
        );
        return;
      }

      response.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(`${JSON.stringify({ error: "Not found" }, null, 2)}\n`);
    });
  }

  async function start({ port, enableHttpServer = true } = {}) {
    await mkdir(resolvedRuntimeRoot, { recursive: true });

    for (const slot of slots) {
      spawnSlot(slot);
    }

    if (workerWatchdogMs > 0) {
      watchdogTimer = setInterval(runWatchdog, Math.max(1000, Math.floor(workerWatchdogMs / 3)));
      watchdogTimer.unref?.();
    }

    if (enableHttpServer) {
      server = createHealthServer();
      const resolvedPort = Number(port ?? env.PORT ?? 3000);
      await new Promise((resolve) => server.listen(resolvedPort, resolve));
    }

    return {
      port: server?.address?.()?.port ?? null
    };
  }

  async function close({ timeoutMs = shutdownTimeoutMs } = {}) {
    shuttingDown = true;

    for (const timer of pendingRestartTimers) {
      clearTimeout(timer);
    }
    pendingRestartTimers.clear();

    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }

    const exits = slots
      .filter((slot) => slot.child)
      .map(
        (slot) =>
          new Promise((resolve) => {
            const child = slot.child;
            const timer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // Child may already be gone.
              }
            }, timeoutMs);

            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });

            try {
              child.send({ type: "shutdown" });
            } catch {
              // IPC may be closed; fall back to SIGTERM.
            }

            try {
              child.kill("SIGTERM");
            } catch {
              // Already exiting.
            }
          })
      );

    await Promise.allSettled(exits);

    if (server) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      server = null;
    }
  }

  return {
    start,
    close,
    getSnapshot,
    slots,
    concurrency: resolvedConcurrency
  };
}

export async function startAgentSupervisor({ config, env = process.env, ...rest } = {}) {
  const runtimeRoot = rest.runtimeRoot || getRuntimeRoot({ repoRoot, appName: "openautotag-agent" });
  await mkdir(runtimeRoot, { recursive: true });
  const baseAgentId = rest.baseAgentId || (await ensureBaseAgentId({ runtimeRoot, env }));
  const supervisor = createAgentSupervisor({
    ...rest,
    runtimeRoot,
    baseAgentId,
    config,
    env
  });

  const result = await supervisor.start({ port: rest.port });
  return { supervisor, port: result.port };
}

async function main() {
  const config = await loadAgentRuntimeConfig();
  if (!config?.masterEndpoint) {
    process.stderr.write("Agent supervisor requires AGENT_MASTER_ENDPOINT or agent-runtime.config.json.\n");
    process.exitCode = 1;
    return;
  }

  const { supervisor } = await startAgentSupervisor({ config });
  const shutdown = async (signal) => {
    process.stdout.write(`\nAgent supervisor received ${signal}; shutting down ${supervisor.concurrency} worker(s).\n`);
    await supervisor.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.stdout.write(
    `Agent supervisor online: ${supervisor.concurrency} worker(s) against ${config.masterEndpoint}\n`
  );
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
