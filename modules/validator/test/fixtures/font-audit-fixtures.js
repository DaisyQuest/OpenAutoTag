// Test-only fixture helpers for the font-audit pre-pass.
// Compiles the bundled FontAuditFixturesCli.java on demand and shells out to it
// for fixtures that are easier to author with PDFBox than with pdf-lib.

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../../scripts/runtime-paths.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const validatorDir = path.resolve(moduleDir, "..", "..");
const repoRoot = path.resolve(validatorDir, "..", "..");
const pdfboxJarPath = path.join(validatorDir, "vendor", "pdfbox-app-3.0.7.jar");
const buildDir = getRuntimeBuildDir("modules-validator-test-fixtures", { repoRoot });
const sourcePath = path.join(moduleDir, "FontAuditFixturesCli.java");
const classPath = path.join(buildDir, "FontAuditFixturesCli.class");
const bundledJavaHome = path.join(validatorDir, "vendor", "java");

function execCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function isCurrent() {
  try {
    const [src, cls] = await Promise.all([stat(sourcePath), stat(classPath)]);
    return cls.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

async function ensureFixtureBuilderCompiled() {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent,
    compile: async () => {
      const javac = await resolveJavaTool("javac", "VALIDATOR_JAVAC_PATH", { bundledJavaHome });
      await execCommand(
        javac,
        ["-encoding", "UTF-8", "-cp", pdfboxJarPath, "-d", buildDir, sourcePath],
        await buildJavaExecEnv({ bundledJavaHome })
      );
    }
  });
}

async function runFixtureBuilder(subcommand, outputPath) {
  await ensureFixtureBuilderCompiled();
  await mkdir(path.dirname(outputPath), { recursive: true });
  const java = await resolveJavaTool("java", "VALIDATOR_JAVA_PATH", { bundledJavaHome });
  await execCommand(
    java,
    ["-cp", `${buildDir}${path.delimiter}${pdfboxJarPath}`, "FontAuditFixturesCli", subcommand, "--output", outputPath],
    await buildJavaExecEnv({ bundledJavaHome })
  );
}

export function buildPdfWithSubsetEmbeddedTtf(outputPath) {
  return runFixtureBuilder("clean-embedded", outputPath);
}

export function buildPdfWithIncompleteToUnicode(outputPath) {
  return runFixtureBuilder("incomplete-tounicode", outputPath);
}

export function buildPdfWithFormFieldDaMissingFont(outputPath) {
  return runFixtureBuilder("da-missing-font", outputPath);
}

// Reserved for future fixture types (e.g. INVALID_CID_SYSTEM_INFO) — the test file imports
// this name but does not currently call it; provided as a stable public surface.
export function buildPdfWithCustomFontDictionary() {
  throw new Error("buildPdfWithCustomFontDictionary fixture not yet implemented.");
}
