import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(__dirname, "agent-runtime.config.json");

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
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
    checkInIntervalMs: Number(env.AGENT_CHECKIN_INTERVAL_MS || fileConfig.checkInIntervalMs || 5000)
  };
}

export function getDefaultAgentRuntimeConfigPath() {
  return defaultConfigPath;
}
