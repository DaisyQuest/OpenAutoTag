import { access, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

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
