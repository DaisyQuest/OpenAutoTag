import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excludedFiles = new Set([path.join(repoRoot, "test", "integration", "goldmaster.test.js")]);

// The font-embedding corpus runner sweeps FONT_CORPUS_DIR (default C:\LRBTest).
// In CI environments that do not host the corpus we exclude the file entirely
// to keep the run lean; the test itself also self-skips when the directory is
// absent, so this is purely a startup-time optimization.
const fontCorpusDir = process.env.FONT_CORPUS_DIR || "C:\\LRBTest";
async function pathExists(target) {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
if (!(await pathExists(fontCorpusDir))) {
  excludedFiles.add(path.join(repoRoot, "test", "integration", "font-embedding.test.js"));
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
