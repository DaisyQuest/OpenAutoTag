import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import auditSchema from "../../contracts/repair-audit.schema.json" with { type: "json" };
import { ensureJavaHelperCompiled } from "./index.js";
import { buildJavaExecEnv, resolveJavaTool } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";

const exec = promisify(execFile), validate = new Ajv2020().compile(auditSchema);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundledJavaHome = path.join(root, "modules/validator/vendor/java");
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

/** The audit is emitted only after exact saved-object verification succeeds. */
export async function repairLinks({ sourcePdf, outputPdf, candidatePdf } = {}) {
  if (!sourcePdf || Boolean(outputPdf) === Boolean(candidatePdf)) throw new Error("Required: --pdf and exactly one of --output or --verify");
  const source = path.resolve(sourcePdf), target = path.resolve(outputPdf || candidatePdf);
  if (source.toLowerCase() === target.toLowerCase()) throw new Error("Link repair must not overwrite its source");
  const sourceHash = await hash(source), beforeCandidate = candidatePdf ? await hash(target) : null;
  if (outputPdf) await mkdir(path.dirname(target), { recursive: true });
  await ensureJavaHelperCompiled();
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const { stdout } = await exec(java, ["-XX:TieredStopAtLevel=1", "-cp", [getRuntimeBuildDir("modules-pdf-writer", { repoRoot: root }),
    path.join(root, "modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar")].join(path.delimiter),
    "QualifiedLinkRepairCli", outputPdf ? "repair" : "verify", source, target],
  { env: await buildJavaExecEnv({ bundledJavaHome }), windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const candidateHash = await hash(target);
  if (sourceHash !== await hash(source) || (beforeCandidate && beforeCandidate !== candidateHash)) throw new Error("PDF changed during link repair verification");
  const report = { sourceHash, candidateHash, ...JSON.parse(stdout) };
  if (!validate(report)) throw new Error(`Invalid repair audit: ${JSON.stringify(validate.errors)}`);
  return report;
}
async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!["--pdf", "--output", "--verify"].includes(process.argv[i]) || !process.argv[i + 1] || args.has(process.argv[i])) throw new Error("Invalid link repair arguments");
    args.set(process.argv[i], process.argv[i + 1]);
  }
  const report = await repairLinks({ sourcePdf: args.get("--pdf"), outputPdf: args.get("--output"), candidatePdf: args.get("--verify") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
