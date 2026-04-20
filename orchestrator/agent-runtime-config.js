import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(__dirname, "agent-runtime.config.json");

export const MAX_WORKER_CONCURRENCY = 5;
export const DEFAULT_WORKER_CONCURRENCY = 1;

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

export function clampWorkerConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_WORKER_CONCURRENCY;
  }

  return Math.min(MAX_WORKER_CONCURRENCY, Math.max(1, Math.floor(parsed)));
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function loadAgentRuntimeConfig({ env = process.env, filePath = defaultConfigPath } = {}) {
  const fileConfig = await readJsonFile(filePath);
  const endpoint =
    normalizeText(env.AGENT_MASTER_ENDPOINT) || normalizeText(fileConfig.masterEndpoint || fileConfig.endpoint);

  if (!endpoint) {
    return null;
  }

  const rawWorkerConcurrency =
    env.AGENT_WORKER_CONCURRENCY !== undefined && env.AGENT_WORKER_CONCURRENCY !== ""
      ? env.AGENT_WORKER_CONCURRENCY
      : fileConfig.workerConcurrency;

  return {
    masterEndpoint: endpoint,
    apiKey:
      normalizeText(env.AGENT_API_KEY) ||
      normalizeText(env.BUILD_EVERYTHING_API_KEY) ||
      normalizeText(fileConfig.apiKey),
    adminKey: normalizeText(env.AGENT_ADMIN_KEY) || normalizeText(fileConfig.adminKey),
    label: normalizeText(env.AGENT_LABEL) || normalizeText(fileConfig.label),
    pollIntervalMs: Number(env.AGENT_POLL_INTERVAL_MS || fileConfig.pollIntervalMs || 5000),
    heartbeatIntervalMs: Number(env.AGENT_HEARTBEAT_INTERVAL_MS || fileConfig.heartbeatIntervalMs || 5000),
    checkInIntervalMs: Number(env.AGENT_CHECKIN_INTERVAL_MS || fileConfig.checkInIntervalMs || 5000),
    workerConcurrency: clampWorkerConcurrency(rawWorkerConcurrency)
  };
}

export function getDefaultAgentRuntimeConfigPath() {
  return defaultConfigPath;
}
