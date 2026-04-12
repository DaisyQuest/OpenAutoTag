import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(fixtureDir, ".build");
const javaSourcePath = path.join(fixtureDir, "java", "HellPdfFixtureCli.java");
const javaClassPath = path.join(buildDir, "HellPdfFixtureCli.class");
const pdfboxJarPath = path.join(
  fixtureDir,
  "..",
  "..",
  "modules",
  "pdf-writer",
  "vendor",
  "pdfbox-app-3.0.7.jar"
);

function execCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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

export async function createHellishPdf(filePath) {
  await ensureJavaHelperCompiled();
  await execCommand("java", [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "HellPdfFixtureCli",
    "--output",
    path.resolve(filePath)
  ]);
}
