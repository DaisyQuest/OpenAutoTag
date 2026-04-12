import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const buildDir = path.join(scriptDir, ".build");
const javaSourcePath = path.join(scriptDir, "java", "LowLevelPdfInspectorCli.java");
const javaClassPath = path.join(buildDir, "LowLevelPdfInspectorCli.class");
const pdfboxJarPath = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    pdfPath: args.get("--pdf")
  };
}

function execCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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
  await mkdir(buildDir, { recursive: true });

  if (!(await needsCompilation())) {
    return;
  }

  await execCommand("javac", [
    "-encoding",
    "UTF-8",
    "-cp",
    pdfboxJarPath,
    "-d",
    buildDir,
    javaSourcePath
  ]);
}

export async function inspectPdfLowLevel({ pdfPath }) {
  if (!pdfPath) {
    throw new Error("Usage: node scripts/inspect-pdf-low-level.js --pdf <input.pdf>");
  }

  await ensureJavaHelperCompiled();
  const stdout = await execCommand("java", [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "LowLevelPdfInspectorCli",
    "--pdf",
    path.resolve(pdfPath)
  ]);

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
