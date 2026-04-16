import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";
import { classifyRepairReport } from "./lib/report-model.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const buildDir = getRuntimeBuildDir("modules-corruption-repairer", { repoRoot });
const javaSourcePath = path.join(moduleDir, "java", "PdfRepairCli.java");
const javaClassPath = path.join(buildDir, "PdfRepairCli.class");
const pdfboxJarPath = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  return {
    pdfPath: args.get("--pdf"),
    outputPath: args.get("--output"),
  };
}

function execCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
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
      await execCommand(
        javacCommand,
        [
          "-encoding",
          "UTF-8",
          "-cp",
          pdfboxJarPath,
          "-d",
          buildDir,
          javaSourcePath,
        ],
        {
          env: await buildJavaExecEnv({ bundledJavaHome }),
        }
      );
    },
  });
}

export async function repairPdf({ pdfPath, outputPath }) {
  if (!pdfPath || !outputPath) {
    throw new Error(
      "Usage: node modules/corruption-repairer/index.js --pdf <input.pdf> --output <repaired.pdf>"
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await ensureJavaHelperCompiled();

  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const args = [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "PdfRepairCli",
    "--pdf",
    path.resolve(pdfPath),
    "--output",
    path.resolve(outputPath),
  ];

  const stdout = await execCommand(javaCommand, args, {
    env: await buildJavaExecEnv({ bundledJavaHome }),
  });

  const rawReport = JSON.parse(stdout);
  const classifiedReport = classifyRepairReport(rawReport);

  const reportPath = `${outputPath}.repair-report.json`;
  await writeFile(reportPath, JSON.stringify(classifiedReport, null, 2));

  return {
    status: "completed",
    outputPath: path.resolve(outputPath),
    reportPath: path.resolve(reportPath),
    ...classifiedReport,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await repairPdf(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
