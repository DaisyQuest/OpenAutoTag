import Ajv2020 from "ajv/dist/2020.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import profileSchema from "../contracts/profile.schema.json" with { type: "json" };

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(moduleDir, "profiles");

const ajv = new Ajv2020({ allErrors: true });
const validateProfile = ajv.compile(profileSchema);

let cachedRegistry = null;

function deepMerge(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function loadProfileFile(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  if (!validateProfile(raw)) {
    throw new Error(`Invalid profile at ${filePath}: ${ajv.errorsText(validateProfile.errors)}`);
  }
  return raw;
}

export async function loadRegistry() {
  if (cachedRegistry) return cachedRegistry;

  const files = (await readdir(PROFILES_DIR)).filter((f) => f.endsWith(".json"));
  const profiles = new Map();

  for (const file of files) {
    const profile = await loadProfileFile(path.join(PROFILES_DIR, file));
    profiles.set(profile.profileId, profile);
  }

  cachedRegistry = profiles;
  return profiles;
}

export function clearRegistryCache() {
  cachedRegistry = null;
}

export async function listProfiles() {
  const registry = await loadRegistry();
  return [...registry.values()].map((p) => ({
    profileId: p.profileId,
    label: p.label,
    description: p.description || "",
    tags: p.tags || [],
    extends: p.extends || null
  }));
}

export async function getProfile(profileId) {
  const registry = await loadRegistry();
  const profile = registry.get(profileId);
  if (!profile) throw new Error(`Profile '${profileId}' not found. Available: ${[...registry.keys()].join(", ")}`);
  return profile;
}

export async function resolveProfile(profileId, overrides = {}) {
  const registry = await loadRegistry();
  const chain = [];
  let current = profileId;
  const visited = new Set();

  while (current) {
    if (visited.has(current)) {
      throw new Error(`Circular profile inheritance: ${[...visited, current].join(" -> ")}`);
    }
    visited.add(current);
    const profile = registry.get(current);
    if (!profile) {
      throw new Error(`Profile '${current}' not found in inheritance chain for '${profileId}'.`);
    }
    chain.unshift(profile);
    current = profile.extends || null;
  }

  let resolved = {};
  for (const profile of chain) {
    resolved = deepMerge(resolved, profile);
  }

  if (Object.keys(overrides).length > 0) {
    resolved = deepMerge(resolved, overrides);
  }

  delete resolved.extends;
  resolved._resolvedFrom = chain.map((p) => p.profileId);
  resolved._overridesApplied = Object.keys(overrides).length > 0;

  return resolved;
}

export async function getProfileForStage(profileId, stageName, overrides = {}) {
  const resolved = await resolveProfile(profileId, overrides);
  return resolved[stageName] || {};
}
