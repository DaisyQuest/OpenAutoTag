// Auto-profile front-loader. When a CLI/MCP caller asks for
// `--profile auto`, we run the NativeContentStreamParser once up
// front (reading only source metadata + a text sample) and feed the
// result to modules/profile-detector. The chosen profile is then
// used for the actual pipeline run.
//
// Parser reuse: we emit the operators.json to a well-known path
// under outputDir so the full pipeline's parser stage can reuse
// it if the stage-plan wants to — though in the current shape the
// accessibility-stage-plan re-parses anyway. Re-parsing is cheap
// (~1-2s for typical docs) and avoids coupling the detector to the
// stage-plan's artifact layout.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detectProfileFromOperatorsFile } from "../modules/profile-detector/index.js";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../scripts/runtime-paths.js";

const execFileP = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

async function compileParser(buildDir) {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => false,
    compile: async () => {
      const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      const src = path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamParser.java");
      await execFileP(javac, ["-encoding", "UTF-8", "-cp", pdfboxJar, "-d", buildDir, src], {
        env: await buildJavaExecEnv({ bundledJavaHome })
      });
    }
  });
  await mkdir(buildDir, { recursive: true });
}

export async function autoDetectProfile({ pdfPath, outputDir }) {
  const buildDir = getRuntimeBuildDir("auto-profile", { repoRoot });
  await compileParser(buildDir);
  const resolvedOutputDir = outputDir ? path.resolve(outputDir) : path.resolve(path.dirname(pdfPath), ".auto-profile");
  await mkdir(resolvedOutputDir, { recursive: true });
  const opsPath = path.join(resolvedOutputDir, ".auto-profile-operators.json");

  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome });
  await execFileP(
    java,
    ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
     "--pdf", path.resolve(pdfPath), "--output", opsPath],
    { env, maxBuffer: 500 * 1024 * 1024, timeout: 240_000 }
  );

  return detectProfileFromOperatorsFile(opsPath);
}
