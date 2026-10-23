import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "./java-runtime.js";
import { getRuntimeBuildDir } from "./runtime-paths.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const buildDir = getRuntimeBuildDir("scripts-low-level-inspector", { repoRoot });
const javaSourcePath = path.join(scriptDir, "java", "LowLevelPdfInspectorCli.java");
const preservationSourcePath = path.join(scriptDir, "java", "PreservationInspector.java");
const contentSourcePath = path.join(scriptDir, "java", "SavedContentInspector.java");
const navigationSourcePath = path.join(scriptDir, "java", "NavigationInspector.java");
const choiceSourcePath = path.join(scriptDir, "java", "ChoiceControlInspector.java");
const nativePreservationSourcePath = path.join(scriptDir, "java", "NativePreservationVerifier.java");
const javaClassPath = path.join(buildDir, "LowLevelPdfInspectorCli.class");
const pdfboxJarPath = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.8.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    pdfPath: args.get("--pdf"),
    preservation: args.get("--preservation") === "true",
    sourcePdfPath: args.get("--compare-source")
  };
}

function execCommand(command, args, { env, timeout } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function needsCompilation() {
  try {
    const [sourceStats, preservationStats, contentStats, navigationStats, choiceStats, nativeStats, classStats, helperStats, contentClass, navigationClass, choiceClass, nativeClass] = await Promise.all([
      stat(javaSourcePath), stat(preservationSourcePath), stat(contentSourcePath),stat(navigationSourcePath),stat(choiceSourcePath),stat(nativePreservationSourcePath), stat(javaClassPath), stat(path.join(buildDir, "PreservationInspector.class")), stat(path.join(buildDir, "SavedContentInspector.class")),stat(path.join(buildDir,"NavigationInspector.class")),stat(path.join(buildDir,'ChoiceControlInspector.class')),stat(path.join(buildDir,'NativePreservationVerifier.class'))]);
    return Math.max(sourceStats.mtimeMs, preservationStats.mtimeMs, contentStats.mtimeMs,navigationStats.mtimeMs,choiceStats.mtimeMs,nativeStats.mtimeMs) > Math.min(classStats.mtimeMs, helperStats.mtimeMs, contentClass.mtimeMs,navigationClass.mtimeMs,choiceClass.mtimeMs,nativeClass.mtimeMs);
  } catch {
    return true;
  }
}

async function ensureJavaHelperCompiled() {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => !(await needsCompilation()),
    compile: async () => {
      const javacCommand = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      try {
        await execCommand(
          javacCommand,
          [
            "-encoding",
            "UTF-8",
            "-cp",
            pdfboxJarPath,
            "-d",
            buildDir,
            javaSourcePath, preservationSourcePath, contentSourcePath, navigationSourcePath,choiceSourcePath,nativePreservationSourcePath
          ],
          {
            env: await buildJavaExecEnv({ bundledJavaHome })
          }
        );
      } catch (error) {
        throw new Error(
          `Unable to compile low-level PDF inspector helper. Install a JDK, set PIPELINE_JAVAC_PATH, or bundle Java under ${bundledJavaHome}. ${error.message}`
        );
      }
    }
  });
}

export async function inspectPdfLowLevel({ pdfPath, preservation = false, sourcePdfPath }) {
  if (!pdfPath) {
    throw new Error("Usage: node scripts/inspect-pdf-low-level.js --pdf <input.pdf>");
  }

  await ensureJavaHelperCompiled();
  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  let stdout;
  try {
    stdout = await execCommand(
      javaCommand,
      [
        "-cp",
        `${buildDir}${path.delimiter}${pdfboxJarPath}`,
        "LowLevelPdfInspectorCli",
        "--pdf",
        path.resolve(pdfPath),
        ...(preservation ? ["--preservation", "true"] : []),
        ...(sourcePdfPath ? ["--compare-source", path.resolve(sourcePdfPath)] : [])
      ],
      {
        env: await buildJavaExecEnv({ bundledJavaHome }),
        timeout: sourcePdfPath ? 120000 : undefined
      }
    );
  } catch (error) {
    throw new Error(
      `Unable to run low-level PDF inspector. Set PIPELINE_JAVA_PATH, JAVA_HOME, or bundle Java under ${bundledJavaHome}. ${error.message}`
    );
  }

  return JSON.parse(stdout);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await inspectPdfLowLevel(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
