import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot });
const pdfboxJarPath = path.join(moduleDir, "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

const parserSourcePath = path.join(moduleDir, "java", "NativeContentStreamParser.java");
const parserClassPath = path.join(buildDir, "NativeContentStreamParser.class");
const matcherSourcePath = path.join(moduleDir, "java", "NativeTagMatcher.java");
const matcherClassPath = path.join(buildDir, "NativeTagMatcher.class");

function execCommand(command, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
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

async function ensureCompiled(sourcePath, classPath) {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => !(await needsCompilation(sourcePath, classPath)),
    compile: async () => {
      const javacCommand = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      await execCommand(
        javacCommand,
        ["-encoding", "UTF-8", "-cp", pdfboxJarPath, "-d", buildDir, sourcePath],
        { env: await buildJavaExecEnv({ bundledJavaHome }) }
      );
    }
  });
}

async function runParser(pdfPath) {
  await ensureCompiled(parserSourcePath, parserClassPath);
  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const stdout = await execCommand(
    javaCommand,
    [
      "-cp", `${buildDir}${path.delimiter}${pdfboxJarPath}`,
      "NativeContentStreamParser",
      "--pdf", pdfPath
    ],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );
  return stdout;
}

async function runMatcher({ operatorsJson, semanticPath, tagsPath, pageHeight, tolerance }) {
  await ensureCompiled(matcherSourcePath, matcherClassPath);
  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const args = [
    "-cp", `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "NativeTagMatcher",
    "--semantic", semanticPath,
    "--tags", tagsPath
  ];
  if (pageHeight != null) {
    args.push("--page-height", String(pageHeight));
  }
  if (tolerance != null) {
    args.push("--tolerance", String(tolerance));
  }
  // Pipe operator JSON via stdin (no --operators flag means read from stdin)
  const stdout = await execCommand(javaCommand, args, {
    env: await buildJavaExecEnv({ bundledJavaHome }),
    input: operatorsJson
  });
  return JSON.parse(stdout);
}

/**
 * Run the full native tag matching pipeline:
 *  1. Parse operators from the PDF using NativeContentStreamParser
 *  2. Match operators to semantic nodes and tag tree using NativeTagMatcher
 *
 * @param {object} options
 * @param {string} options.pdfPath   - path to the input PDF
 * @param {string} options.semanticPath - path to semantic-ordered.json (stage 04)
 * @param {string} options.tagsPath  - path to tagging.json (stage 05)
 * @param {number} [options.pageHeight=792] - page height for y-coordinate conversion
 * @param {number} [options.tolerance=5]    - position matching tolerance in points
 * @returns {Promise<object>} the native tag plan
 */
export async function matchNativeTags({ pdfPath, semanticPath, tagsPath, pageHeight, tolerance }) {
  if (!pdfPath || !semanticPath || !tagsPath) {
    throw new Error(
      "Usage: node native-tag-matcher.js --pdf <input.pdf> --semantic <semantic.json> --tags <tags.json> [--page-height <792>] [--tolerance <5>]"
    );
  }

  // Step 1: parse operators from the PDF
  const operatorsJson = await runParser(path.resolve(pdfPath));

  // Step 2: match operators to tags
  const tagPlan = await runMatcher({
    operatorsJson,
    semanticPath: path.resolve(semanticPath),
    tagsPath: path.resolve(tagsPath),
    pageHeight,
    tolerance
  });

  return tagPlan;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  return {
    pdfPath: args.get("--pdf"),
    semanticPath: args.get("--semantic"),
    tagsPath: args.get("--tags"),
    pageHeight: args.has("--page-height") ? Number(args.get("--page-height")) : undefined,
    tolerance: args.has("--tolerance") ? Number(args.get("--tolerance")) : undefined
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await matchNativeTags(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
