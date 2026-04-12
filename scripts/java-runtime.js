import os from "node:os";
import { access, chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const DEFAULT_BUILD_LOCK_TIMEOUT_MS = 120000;
const DEFAULT_BUILD_LOCK_STALE_MS = 300000;
const BUILD_LOCK_RETRY_MS = 200;

function executableName(commandName) {
  return process.platform === "win32" ? `${commandName}.exe` : commandName;
}

async function isReadable(targetPath) {
  try {
    await access(targetPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureExecutable(targetPath) {
  if (process.platform !== "win32") {
    await chmod(targetPath, 0o755).catch(() => {});
  }
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function getBuildLockDir(buildDir) {
  return `${buildDir}.lock`;
}

async function isBuildLockPresent(lockDir) {
  try {
    await access(lockDir, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isBuildLockStale(lockDir, staleMs) {
  try {
    const ownerPath = path.join(lockDir, "owner.json");
    const lockStats = await stat(ownerPath).catch(() => stat(lockDir));
    return Date.now() - lockStats.mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

async function clearBuildLock(lockDir) {
  await rm(lockDir, { recursive: true, force: true }).catch(() => {});
}

async function releaseStaleBuildLock(lockDir, staleMs) {
  if (!(await isBuildLockStale(lockDir, staleMs))) {
    return false;
  }

  await clearBuildLock(lockDir);
  return true;
}

async function waitForBuildLockRelease(lockDir, { timeoutMs, staleMs }) {
  const deadline = Date.now() + timeoutMs;

  while (await isBuildLockPresent(lockDir)) {
    if (await releaseStaleBuildLock(lockDir, staleMs)) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Java helper build lock at ${lockDir}.`);
    }

    await wait(BUILD_LOCK_RETRY_MS);
  }
}

async function acquireBuildLock(buildDir, { timeoutMs, staleMs }) {
  const lockDir = getBuildLockDir(buildDir);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify(
          {
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString()
          },
          null,
          2
        )
      );
      return lockDir;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (await releaseStaleBuildLock(lockDir, staleMs)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring Java helper build lock at ${lockDir}.`);
      }

      await wait(BUILD_LOCK_RETRY_MS);
    }
  }
}

async function resolveConfiguredPath(envVarName, description) {
  const configuredPath = process.env[envVarName];
  if (!configuredPath) {
    return null;
  }

  const resolvedPath = path.resolve(configuredPath);
  if (!(await isReadable(resolvedPath))) {
    throw new Error(`${description} not found at ${resolvedPath}.`);
  }

  await ensureExecutable(resolvedPath);
  return resolvedPath;
}

export async function resolveJavaHome({
  bundledJavaHome,
  javaHomeEnvVar = "PIPELINE_JAVA_HOME",
  javaPathEnvVar = "JAVA_HOME"
} = {}) {
  const configuredJavaHome = process.env[javaHomeEnvVar];
  if (configuredJavaHome) {
    const resolvedJavaHome = path.resolve(configuredJavaHome);
    if (!(await isReadable(path.join(resolvedJavaHome, "bin", executableName("java"))))) {
      throw new Error(`Java home not found at ${resolvedJavaHome}.`);
    }
    return resolvedJavaHome;
  }

  const envJavaHome = process.env[javaPathEnvVar] ? path.resolve(process.env[javaPathEnvVar]) : null;
  if (envJavaHome && (await isReadable(path.join(envJavaHome, "bin", executableName("java"))))) {
    return envJavaHome;
  }

  if (bundledJavaHome && (await isReadable(path.join(bundledJavaHome, "bin", executableName("java"))))) {
    return bundledJavaHome;
  }

  return null;
}

export async function resolveJavaTool(commandName, envVarName, { bundledJavaHome } = {}) {
  const configuredPath = await resolveConfiguredPath(envVarName, `${commandName} executable`);
  if (configuredPath) {
    return configuredPath;
  }

  const javaHome = await resolveJavaHome({ bundledJavaHome });
  if (javaHome) {
    const javaToolPath = path.join(javaHome, "bin", executableName(commandName));
    if (await isReadable(javaToolPath)) {
      await ensureExecutable(javaToolPath);
      return javaToolPath;
    }
  }

  return commandName;
}

export async function buildJavaExecEnv({ bundledJavaHome } = {}) {
  const javaHome = await resolveJavaHome({ bundledJavaHome });
  if (!javaHome) {
    return process.env;
  }

  return {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`
  };
}

export async function ensureJavaBuildArtifact({
  buildDir,
  isCurrent,
  compile,
  timeoutMs = DEFAULT_BUILD_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_BUILD_LOCK_STALE_MS
}) {
  const lockDir = getBuildLockDir(buildDir);
  await mkdir(buildDir, { recursive: true });

  if (await isCurrent()) {
    await waitForBuildLockRelease(lockDir, { timeoutMs, staleMs });
    if (await isCurrent()) {
      return;
    }
  }

  const acquiredLockDir = await acquireBuildLock(buildDir, { timeoutMs, staleMs });

  try {
    if (await isCurrent()) {
      return;
    }

    try {
      await compile();
    } catch (error) {
      await rm(buildDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(buildDir, { recursive: true });
      throw error;
    }
  } finally {
    await clearBuildLock(acquiredLockDir);
  }
}
