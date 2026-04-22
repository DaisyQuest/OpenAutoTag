import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldmasterTestFile = path.join(repoRoot, "test", "integration", "goldmaster.test.js");
const fontCorpusTestFile = path.join(repoRoot, "test", "integration", "font-embedding.test.js");
const perfectStudioJavaGateFile = path.join(repoRoot, "test", "unit", "perfect-studio-java.test.js");
const excludedFiles = new Set();
const goldmasterStrict = process.env.GOLDMASTER_STRICT === "1";
const fontCorpusStrict = process.env.FONT_CORPUS_STRICT === "1";

const fontCorpusDir = process.env.FONT_CORPUS_DIR || "C:\\LRBTest";
async function pathExists(target) {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const fontCorpusExists = await pathExists(fontCorpusDir);

if (!goldmasterStrict) {
  excludedFiles.add(goldmasterTestFile);
}

excludedFiles.add(perfectStudioJavaGateFile);

if (!fontCorpusExists && fontCorpusStrict) {
  throw new Error(`FONT_CORPUS_DIR not reachable at ${fontCorpusDir} while FONT_CORPUS_STRICT=1.`);
}

if (!fontCorpusExists) {
  excludedFiles.add(fontCorpusTestFile);
}

function reportSuiteSelection() {
  process.stdout.write(
    goldmasterStrict
      ? "# goldmaster suite enabled via GOLDMASTER_STRICT=1.\n"
      : `# goldmaster suite skipped in default CI; set GOLDMASTER_STRICT=1 to include ${path.relative(repoRoot, goldmasterTestFile)}.\n`
  );

  process.stdout.write(
    `# perfect-studio Java compile gate runs separately via ${path.relative(repoRoot, perfectStudioJavaGateFile)}.\n`
  );

  if (fontCorpusExists) {
    process.stdout.write(`# font corpus found at ${fontCorpusDir}; running ${path.relative(repoRoot, fontCorpusTestFile)}.\n`);
    return;
  }

  process.stdout.write(
    `# font corpus skipped because FONT_CORPUS_DIR is unavailable at ${fontCorpusDir}; set FONT_CORPUS_STRICT=1 to fail instead.\n`
  );
}

async function listTestFiles(directoryPath) {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const testFiles = [];

    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        testFiles.push(...(await listTestFiles(fullPath)));
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".test.js") && !excludedFiles.has(fullPath)) {
        testFiles.push(fullPath);
      }
    }

    return testFiles;
  } catch {
    return [];
  }
}

async function listModuleTests() {
  const moduleEntries = await readdir(path.join(repoRoot, "modules"), { withFileTypes: true });
  const testFiles = [];

  for (const entry of moduleEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    testFiles.push(...(await listTestFiles(path.join(repoRoot, "modules", entry.name, "test"))));
  }

  return testFiles;
}

function runTests(testFiles) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...testFiles], {
      cwd: repoRoot,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`CI test run failed with exit code ${code}.`));
    });
  });
}

async function main() {
  reportSuiteSelection();

  const testFiles = [
    ...(await listModuleTests()),
    ...(await listTestFiles(path.join(repoRoot, "test", "unit"))),
    ...(await listTestFiles(path.join(repoRoot, "test", "integration")))
  ].sort();

  if (testFiles.length === 0) {
    throw new Error("No CI test files were found.");
  }

  await runTests(testFiles);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
