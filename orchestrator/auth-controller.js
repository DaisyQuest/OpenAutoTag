import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const API_HEADER = "x-api-key";
const ADMIN_HEADER = "x-admin-key";
const MANAGED_KEY_PREFIX = "bea";
const REGISTRY_VERSION = 1;
const MANAGED_KEY_SECRET_BYTES = 32;
const ENV_API_KEY_NAMES = ["API_KEY", "X_API_KEY", "BUILD_EVERYTHING_API_KEY"];
const ENV_ADMIN_KEY_NAMES = ["ADMIN_KEY"];
const DEFAULT_LOCAL_ADMIN_KEY = "testing";

function parseBoolean(value, defaultValue) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function readConfiguredSecrets(names, env = process.env) {
  const values = [];

  for (const name of names) {
    const rawValue = String(env?.[name] || "");
    const parts = rawValue
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    for (const part of parts) {
      if (!values.includes(part)) {
        values.push(part);
      }
    }
  }

  return values;
}

function createSecretDigest(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function timingSafeMatch(expected, actual) {
  if (!expected || !actual) {
    return false;
  }

  const expectedDigest = createSecretDigest(String(expected));
  const actualDigest = createSecretDigest(String(actual));
  return crypto.timingSafeEqual(expectedDigest, actualDigest);
}

function hashManagedSecret(secret, salt) {
  return crypto.scryptSync(secret, salt, 64).toString("hex");
}

function createEmptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    managedKeys: []
  };
}

function normalizeRegistry(payload) {
  if (!payload || typeof payload !== "object") {
    return createEmptyRegistry();
  }

  return {
    version: REGISTRY_VERSION,
    managedKeys: Array.isArray(payload.managedKeys)
      ? payload.managedKeys
          .filter((item) => item && typeof item === "object" && typeof item.id === "string")
          .map((item) => ({
            id: String(item.id),
            label: String(item.label || "Managed API key"),
            description: String(item.description || ""),
            prefix: String(item.prefix || ""),
            salt: String(item.salt || ""),
            hash: String(item.hash || ""),
            createdAt: String(item.createdAt || new Date().toISOString()),
            lastUsedAt: item.lastUsedAt ? String(item.lastUsedAt) : null,
            revokedAt: item.revokedAt ? String(item.revokedAt) : null
          }))
      : []
  };
}

function sanitizeLabel(value, fallback = "Managed API key") {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || fallback;
}

function sanitizeDescription(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function createManagedToken(id, secret) {
  return `${MANAGED_KEY_PREFIX}_${id}_${secret}`;
}

function createManagedPrefix(id) {
  return `${MANAGED_KEY_PREFIX}_${id.slice(0, 8)}`;
}

function parseManagedToken(token) {
  const match = String(token || "")
    .trim()
    .match(/^bea_([a-f0-9]{32})_([A-Za-z0-9_-]{32,})$/);

  if (!match) {
    return null;
  }

  return {
    id: match[1],
    secret: match[2]
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function serializeManagedKey(record) {
  return {
    id: record.id,
    label: record.label,
    description: record.description,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt
  };
}

export function createAuthController({
  publicMode = true,
  bootstrapApiKeys = [],
  adminKeys = [],
  registryPath
} = {}) {
  const resolvedPublicMode = parseBoolean(publicMode, true);
  const resolvedBootstrapApiKeys = [...new Set((bootstrapApiKeys || []).map((value) => String(value).trim()).filter(Boolean))];
  const resolvedAdminKeys = [...new Set((adminKeys || []).map((value) => String(value).trim()).filter(Boolean))];

  if (!registryPath) {
    throw new Error("registryPath is required");
  }

  if (!resolvedPublicMode && resolvedAdminKeys.length === 0) {
    throw new Error("PUBLIC_MODE=false requires an ADMIN_KEY (or X_ADMIN_KEY) to be configured.");
  }

  let registry = null;
  let registryLoadPromise = null;
  let registryWritePromise = Promise.resolve();

  async function loadRegistry() {
    if (registry) {
      return registry;
    }

    if (!registryLoadPromise) {
      registryLoadPromise = (async () => {
        try {
          const payload = JSON.parse(await readFile(registryPath, "utf8"));
          registry = normalizeRegistry(payload);
        } catch (error) {
          if (error.code === "ENOENT") {
            registry = createEmptyRegistry();
          } else {
            throw error;
          }
        }

        return registry;
      })();
    }

    return registryLoadPromise;
  }

  async function persistRegistry() {
    await loadRegistry();
    await mkdir(path.dirname(registryPath), { recursive: true });
    const payload = JSON.stringify(registry, null, 2);
    registryWritePromise = registryWritePromise.catch(() => {}).then(() => writeFile(registryPath, payload, "utf8"));
    await registryWritePromise;
  }

  async function markManagedKeyUsed(record) {
    const now = new Date();
    if (record.lastUsedAt && now.getTime() - new Date(record.lastUsedAt).getTime() < 60_000) {
      return;
    }

    record.lastUsedAt = now.toISOString();
    await persistRegistry();
  }

  async function verifyManagedApiKey(secret) {
    const parsed = parseManagedToken(secret);
    if (!parsed) {
      return null;
    }

    const state = await loadRegistry();
    const record = state.managedKeys.find((candidate) => candidate.id === parsed.id && !candidate.revokedAt);
    if (!record || !record.salt || !record.hash) {
      return null;
    }

    const candidateHash = hashManagedSecret(parsed.secret, record.salt);
    if (!timingSafeMatch(record.hash, candidateHash)) {
      return null;
    }

    await markManagedKeyUsed(record);
    return serializeManagedKey(record);
  }

  function verifyConfiguredSecret(allowedSecrets, candidate) {
    if (!candidate) {
      return false;
    }

    return allowedSecrets.some((secret) => timingSafeMatch(secret, candidate));
  }

  async function describeAccess(request) {
    if (resolvedPublicMode) {
      return {
        publicMode: true,
        apiAuthorized: true,
        adminAuthorized: true,
        mode: "public"
      };
    }

    const apiCandidate = String(request.headers[API_HEADER] || "").trim();
    const adminCandidate = String(request.headers[ADMIN_HEADER] || "").trim();
    const adminAuthorized = verifyConfiguredSecret(resolvedAdminKeys, adminCandidate);
    const managedKey = apiCandidate ? await verifyManagedApiKey(apiCandidate) : null;
    const apiAuthorized =
      adminAuthorized ||
      verifyConfiguredSecret(resolvedBootstrapApiKeys, apiCandidate) ||
      Boolean(managedKey);

    return {
      publicMode: false,
      apiAuthorized,
      adminAuthorized,
      mode: adminAuthorized ? "admin" : apiAuthorized ? "api" : "locked",
      managedKey
    };
  }

  async function requireAccess(request, { api = false, admin = false } = {}) {
    const access = await describeAccess(request);

    if (admin && !access.adminAuthorized) {
      const message = access.apiAuthorized
        ? "X-ADMIN-KEY is required for this operation."
        : "A valid X-ADMIN-KEY is required for this operation.";
      const error = new Error(message);
      error.statusCode = access.apiAuthorized ? 403 : 401;
      throw error;
    }

    if (api && !(access.apiAuthorized || access.adminAuthorized)) {
      const error = new Error("A valid X-API-KEY or X-ADMIN-KEY is required for this operation.");
      error.statusCode = 401;
      throw error;
    }

    return access;
  }

  async function listManagedKeys() {
    const state = await loadRegistry();
    return state.managedKeys.map(serializeManagedKey).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function createManagedKey({ label, description } = {}) {
    const state = await loadRegistry();
    const id = crypto.randomUUID().replace(/-/g, "");
    const secret = crypto.randomBytes(MANAGED_KEY_SECRET_BYTES).toString("base64url");
    const salt = crypto.randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    const record = {
      id,
      label: sanitizeLabel(label),
      description: sanitizeDescription(description),
      prefix: createManagedPrefix(id),
      salt,
      hash: hashManagedSecret(secret, salt),
      createdAt,
      lastUsedAt: null,
      revokedAt: null
    };

    state.managedKeys.unshift(record);
    await persistRegistry();

    return {
      key: createManagedToken(id, secret),
      record: serializeManagedKey(record)
    };
  }

  async function revokeManagedKey(keyId) {
    const state = await loadRegistry();
    const record = state.managedKeys.find((candidate) => candidate.id === keyId);

    if (!record) {
      const error = new Error("API key not found.");
      error.statusCode = 404;
      throw error;
    }

    if (!record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      await persistRegistry();
    }

    return serializeManagedKey(record);
  }

  async function getManagementSnapshot() {
    const managedKeys = await listManagedKeys();
    const activeManagedKeys = managedKeys.filter((key) => !key.revokedAt).length;

    return {
      publicMode: resolvedPublicMode,
      headers: {
        api: "X-API-KEY",
        admin: "X-ADMIN-KEY"
      },
      bootstrap: {
        apiKeyConfigured: resolvedBootstrapApiKeys.length > 0,
        adminKeyConfigured: resolvedAdminKeys.length > 0
      },
      managedKeys,
      summary: {
        activeManagedKeys,
        revokedManagedKeys: managedKeys.length - activeManagedKeys
      }
    };
  }

  return {
    headers: {
      api: "X-API-KEY",
      admin: "X-ADMIN-KEY"
    },
    registryPath,
    isPublicMode() {
      return resolvedPublicMode;
    },
    getClientConfig() {
      return {
        publicMode: resolvedPublicMode,
        headers: {
          api: "X-API-KEY",
          admin: "X-ADMIN-KEY"
        },
        acceptsAdminForApi: true,
        bootstrap: {
          apiKeyConfigured: resolvedBootstrapApiKeys.length > 0,
          adminKeyConfigured: resolvedAdminKeys.length > 0
        }
      };
    },
    describeAccess,
    requireAccess,
    listManagedKeys,
    createManagedKey,
    revokeManagedKey,
    getManagementSnapshot
  };
}

export function createEnvironmentAuthController({ runtimeRoot, env = process.env } = {}) {
  const configuredAdminKeys = readConfiguredSecrets(ENV_ADMIN_KEY_NAMES, env);

  return createAuthController({
    publicMode: env.PUBLIC_MODE,
    bootstrapApiKeys: readConfiguredSecrets(ENV_API_KEY_NAMES, env),
    adminKeys: configuredAdminKeys.length ? configuredAdminKeys : [DEFAULT_LOCAL_ADMIN_KEY],
    registryPath: path.join(runtimeRoot, "security", "api-keys.json")
  });
}

export function maskSecretPreview(secret) {
  const value = String(secret || "");
  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function cloneAccess(access) {
  return clone(access);
}
