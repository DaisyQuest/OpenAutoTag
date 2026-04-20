const STORAGE_KEYS = {
  api: "buildeverything.api-key",
  admin: "buildeverything.admin-key"
};

const FALLBACK_CONFIG = Object.freeze({
  publicMode: true,
  headers: {
    api: "X-API-KEY",
    admin: "X-ADMIN-KEY"
  },
  acceptsAdminForApi: true,
  bootstrap: {
    apiKeyConfigured: false,
    adminKeyConfigured: false
  }
});

let configPromise = null;

function canUseSessionStorage() {
  try {
    return typeof window !== "undefined" && Boolean(window.sessionStorage);
  } catch {
    return false;
  }
}

function readResponsePayload(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  return contentType.includes("application/json") ? response.json() : response.text();
}

function extractFilename(response, fallback = "download") {
  const contentDisposition = String(response.headers.get("content-disposition") || "");
  const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    try {
      return decodeURIComponent(encodedMatch[1].replace(/^"(.*)"$/, "$1"));
    } catch {
      return encodedMatch[1];
    }
  }

  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1] : fallback;
}

export async function loadAuthConfig() {
  if (!configPromise) {
    configPromise = fetch("/auth/config", { cache: "no-store" })
      .then(async (response) => {
        const payload = await readResponsePayload(response);
        if (!response.ok || typeof payload !== "object" || !payload) {
          return FALLBACK_CONFIG;
        }

        return {
          ...FALLBACK_CONFIG,
          ...payload,
          headers: {
            ...FALLBACK_CONFIG.headers,
            ...(payload.headers || {})
          },
          bootstrap: {
            ...FALLBACK_CONFIG.bootstrap,
            ...(payload.bootstrap || {})
          }
        };
      })
      .catch(() => FALLBACK_CONFIG);
  }

  return configPromise;
}

export function getStoredKey(kind) {
  if (!canUseSessionStorage()) {
    return "";
  }

  return String(window.sessionStorage.getItem(STORAGE_KEYS[kind]) || "");
}

export function setStoredKey(kind, value) {
  if (!canUseSessionStorage()) {
    return;
  }

  const normalized = String(value || "").trim();
  if (!normalized) {
    window.sessionStorage.removeItem(STORAGE_KEYS[kind]);
    return;
  }

  window.sessionStorage.setItem(STORAGE_KEYS[kind], normalized);
}

export function clearStoredKeys() {
  if (!canUseSessionStorage()) {
    return;
  }

  window.sessionStorage.removeItem(STORAGE_KEYS.api);
  window.sessionStorage.removeItem(STORAGE_KEYS.admin);
}

export function getSessionAccess() {
  const apiKey = getStoredKey("api");
  const adminKey = getStoredKey("admin");

  return {
    api: Boolean(apiKey || adminKey),
    admin: Boolean(adminKey)
  };
}

export function getRequestHeaders(mode = "api") {
  if (mode === "none") {
    return {};
  }

  const apiKey = getStoredKey("api");
  const adminKey = getStoredKey("admin");

  if (mode === "admin") {
    return adminKey ? { "X-ADMIN-KEY": adminKey } : {};
  }

  if (adminKey) {
    return { "X-ADMIN-KEY": adminKey };
  }

  return apiKey ? { "X-API-KEY": apiKey } : {};
}

export async function fetchWithAuth(url, { auth = "api", headers = {}, cache = "no-store", ...options } = {}) {
  return fetch(url, {
    ...options,
    cache,
    headers: {
      ...headers,
      ...getRequestHeaders(auth)
    }
  });
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithAuth(url, options);
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    const error = new Error(
      typeof payload === "object" && payload?.error
        ? payload.error
        : typeof payload === "string" && payload
          ? payload
          : `${response.status} ${response.statusText}`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function verifyAndStoreAccess({ key, admin = false }) {
  const candidate = String(key || "").trim();
  if (!candidate) {
    throw new Error(admin ? "Enter an admin key." : "Enter an API or admin key.");
  }

  const headers = admin
    ? { "X-ADMIN-KEY": candidate }
    : {
        "X-API-KEY": candidate,
        "X-ADMIN-KEY": candidate
      };

  const response = await fetch("/auth/access", {
    cache: "no-store",
    headers
  });
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw new Error(
      typeof payload === "object" && payload?.error ? payload.error : admin ? "The admin key was not accepted." : "The key was not accepted."
    );
  }

  if (payload?.access?.admin) {
    setStoredKey("admin", candidate);
    setStoredKey("api", "");
  }

  if (payload?.access?.api && !payload?.access?.admin) {
    setStoredKey("api", candidate);
  }

  return payload;
}

export async function downloadWithAuth(url, { auth = "api", filename } = {}) {
  const response = await fetchWithAuth(url, { auth });

  if (!response.ok) {
    const payload = await readResponsePayload(response);
    throw new Error(typeof payload === "object" && payload?.error ? payload.error : "The download could not be completed.");
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename || extractFilename(response, "artifact");
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export function formatDurationSeconds(value) {
  const totalSeconds = Math.max(0, Number(value || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function sanitizeStatusToken(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
