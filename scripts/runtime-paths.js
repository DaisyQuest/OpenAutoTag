import os from "node:os";
import path from "node:path";

function resolveEnvPath(envVarName) {
  const value = String(process.env[envVarName] || "").trim();
  return value ? path.resolve(value) : null;
}

export function isAzureAppServiceRuntime() {
  return Boolean(
    process.env.WEBSITE_SITE_NAME ||
      process.env.WEBSITE_INSTANCE_ID ||
      process.env.WEBSITE_RUN_FROM_PACKAGE ||
      process.env.WEBSITES_ENABLE_APP_SERVICE_STORAGE
  );
}

export function getRuntimeRoot({ repoRoot, appName = "openautotag" } = {}) {
  const configuredRoot = resolveEnvPath("PIPELINE_DATA_ROOT") || resolveEnvPath("APP_RUNTIME_ROOT");
  if (configuredRoot) {
    return configuredRoot;
  }

  if (isAzureAppServiceRuntime()) {
    const homeRoot = resolveEnvPath("HOME") || os.tmpdir();
    return path.join(homeRoot, "data", appName);
  }

  return path.resolve(repoRoot || process.cwd(), "tmp");
}

export function getRuntimeSubdir(subdirectory, options = {}) {
  return path.join(getRuntimeRoot(options), subdirectory);
}

export function getRuntimeBuildDir(namespace, options = {}) {
  return path.join(getRuntimeRoot(options), "build", namespace, String(process.pid));
}

export function getRuntimeCacheDir(namespace, options = {}) {
  return path.join(getRuntimeRoot(options), "cache", namespace);
}
