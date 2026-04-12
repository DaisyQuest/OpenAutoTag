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
const javaClassPath = path.join(buildDir, "LowLevelPdfInspectorCli.class");
const pdfboxJarPath = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    pdfPath: args.get("--pdf")
  };
}

function execCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, env, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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
    const [sourceStats, classStats] = await Promise.all([stat(javaSourcePath), stat(javaClassPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
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
            javaSourcePath
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

export async function inspectPdfLowLevel({ pdfPath }) {
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
        path.resolve(pdfPath)
      ],
      {
        env: await buildJavaExecEnv({ bundledJavaHome })
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
