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
const fontJavaSourcePath = path.join(moduleDir, "java", "FontRepairCli.java");
const fontJavaClassPath = path.join(buildDir, "FontRepairCli.class");
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

async function needsCompilation(sourcePath, classPath) {
  try {
    const [sourceStats, classStats] = await Promise.all([stat(sourcePath), stat(classPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
  } catch {
    return true;
  }
}

async function ensureJavaCompiled(sourcePath, classPath) {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => !(await needsCompilation(sourcePath, classPath)),
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
          sourcePath,
        ],
        {
          env: await buildJavaExecEnv({ bundledJavaHome }),
        }
      );
    },
  });
}

async function ensureJavaHelperCompiled() {
  await ensureJavaCompiled(javaSourcePath, javaClassPath);
}

async function ensureFontHelperCompiled() {
  await ensureJavaCompiled(fontJavaSourcePath, fontJavaClassPath);
}

async function runStructuralRepair({ pdfPath, outputPath }) {
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

  return classifyRepairReport(JSON.parse(stdout));
}

export async function repairFonts({ pdfPath, outputPath }) {
  if (!pdfPath || !outputPath) {
    throw new Error(
      "Usage: repairFonts({ pdfPath, outputPath })"
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await ensureFontHelperCompiled();

  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const args = [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "FontRepairCli",
    "--pdf",
    path.resolve(pdfPath),
    "--output",
    path.resolve(outputPath),
  ];

  const stdout = await execCommand(javaCommand, args, {
    env: await buildJavaExecEnv({ bundledJavaHome }),
  });

  const fontReport = JSON.parse(stdout);
  const fontReportPath = `${outputPath}.font-report.json`;
  await writeFile(fontReportPath, JSON.stringify(fontReport, null, 2));

  return {
    status: "completed",
    fontReportPath: path.resolve(fontReportPath),
    ...fontReport,
  };
}

export async function repairPdf({ pdfPath, outputPath }) {
  if (!pdfPath || !outputPath) {
    throw new Error(
      "Usage: node modules/corruption-repairer/index.js --pdf <input.pdf> --output <repaired.pdf>"
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  // Stage 1: structural repair
  const structuralReport = await runStructuralRepair({ pdfPath, outputPath });

  const reportPath = `${outputPath}.repair-report.json`;
  await writeFile(reportPath, JSON.stringify(structuralReport, null, 2));

  // Stage 2: font health analysis (runs on repaired PDF)
  let fontHealth = null;
  let fontReportPath = null;
  try {
    await ensureFontHelperCompiled();

    const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
    const fontArgs = [
      "-cp",
      `${buildDir}${path.delimiter}${pdfboxJarPath}`,
      "FontRepairCli",
      "--pdf",
      path.resolve(outputPath),
      "--output",
      path.resolve(outputPath),
    ];

    const fontStdout = await execCommand(javaCommand, fontArgs, {
      env: await buildJavaExecEnv({ bundledJavaHome }),
    });

    fontHealth = JSON.parse(fontStdout);
    fontReportPath = `${outputPath}.font-report.json`;
    await writeFile(fontReportPath, JSON.stringify(fontHealth, null, 2));
  } catch {
    // Font analysis is best-effort; structural repair still succeeds
    fontHealth = null;
  }

  const combinedReport = {
    structuralRepairs: structuralReport,
    fontHealth,
  };

  return {
    status: "completed",
    outputPath: path.resolve(outputPath),
    reportPath: path.resolve(reportPath),
    fontReportPath: fontReportPath ? path.resolve(fontReportPath) : null,
    ...combinedReport,
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
