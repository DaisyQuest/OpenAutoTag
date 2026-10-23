import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import auditSchema from "../../contracts/repair-audit.schema.json" with { type: "json" };
import reportSchema from "../../contracts/font-repair-report.schema.json" with { type: "json" };
import donorSchema from "../../contracts/font-donors.schema.json" with { type: "json" };
import { ensureJavaHelperCompiled } from "./index.js";
import { buildJavaExecEnv, resolveJavaTool } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundledJavaHome = path.join(root, "modules/validator/vendor/java");
const validate = new Ajv2020({ allErrors: true }).addSchema(auditSchema).compile(reportSchema);
const validateDonors = new Ajv2020({ allErrors: true }).compile(donorSchema);
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

/** Opt-in, incremental repairs only. Verification replays the qualified rules from the source. */
export async function repairFonts({ sourcePdf, outputPdf, candidatePdf, donorsPath, fontDir = path.join(root, "node_modules/pdfjs-dist/standard_fonts") } = {}) {
  if (!sourcePdf || Boolean(outputPdf) === Boolean(candidatePdf)) throw new Error("Required: --pdf and exactly one of --output or --verify");
  const target = path.resolve(outputPdf || candidatePdf), source = path.resolve(sourcePdf);
  if (source.toLowerCase() === target.toLowerCase()) throw new Error("Font repair must not overwrite its source");
  const sourceHash = await hash(source);
  let donorManifestHash;
  const donorArgs = [];
  if (donorsPath) {
    const manifestPath = path.resolve(donorsPath);
    if ([source, target].some(p => p.toLowerCase() === manifestPath.toLowerCase())) throw new Error("Donor manifest must differ from PDF paths");
    if ((await stat(manifestPath)).size > 256 * 1024) throw new Error("Donor manifest exceeds limit");
    const bytes = await readFile(manifestPath), donors = JSON.parse(bytes);
    if (!validateDonors(donors)) throw new Error(`Invalid font donor manifest: ${JSON.stringify(validateDonors.errors)}`);
    if (donors.sourceHash !== sourceHash) throw new Error("Font donor manifest has a stale source hash");
    if (new Set(donors.donors.map(d => d.fontRef)).size !== donors.donors.length) throw new Error("Duplicate font donor target");
    donorManifestHash = createHash("sha256").update(bytes).digest("hex");
    donorArgs.push(sourceHash);
    let total = 0;
    for (const donor of donors.donors) {
      const file = path.resolve(path.dirname(manifestPath), donor.programPath), size = (await stat(file)).size;
      if (size < 12 || size > 64 * 1024 * 1024 || (total += size) > 128 * 1024 * 1024) throw new Error("Font donor program size limit exceeded");
      if (await hash(file) !== donor.programSha256) throw new Error("Font donor program hash mismatch");
      donorArgs.push(donor.fontRef, file, donor.programSha256);
    }
  }
  const beforeCandidate = candidatePdf ? await hash(target) : null;
  if (outputPdf) await mkdir(path.dirname(target), { recursive: true });
  await ensureJavaHelperCompiled();
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  // The supported Windows JDK 21.0.6 C2 compiler can crash compiling FontBox's
  // Type2CharString. This short-lived pass uses tier 1 to avoid that VM fault.
  const { stdout } = await exec(java, ["-XX:TieredStopAtLevel=1", "-cp", [getRuntimeBuildDir("modules-pdf-writer", { repoRoot: root }),
    path.join(root, "modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar")].join(path.delimiter),
    "QualifiedFontRepairs", outputPdf ? "repair" : "verify", source, target, path.resolve(fontDir), ...donorArgs],
  { env: await buildJavaExecEnv({ bundledJavaHome }), windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const candidateHash = await hash(target);
  if (sourceHash !== await hash(source) || (beforeCandidate && beforeCandidate !== candidateHash)) throw new Error("PDF changed during font repair verification");
  if (donorsPath && await hash(donorsPath) !== donorManifestHash) throw new Error("Font donor manifest changed during verification");
  for (let i = 1; i < donorArgs.length; i += 3) if (await hash(donorArgs[i + 1]) !== donorArgs[i + 2]) throw new Error("Font donor program changed during verification");
  const report = { sourceHash, candidateHash, ...(donorManifestHash ? { donorManifestHash } : {}), ...JSON.parse(stdout) };
  if (!validate(report)) throw new Error(`Invalid font repair report: ${JSON.stringify(validate.errors)}`);
  return report;
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!["--pdf", "--output", "--verify", "--font-dir", "--donors"].includes(process.argv[i]) || !process.argv[i + 1] || args.has(process.argv[i])) throw new Error("Invalid font repair arguments");
    args.set(process.argv[i], process.argv[i + 1]);
  }
  const report = await repairFonts({ sourcePdf: args.get("--pdf"), outputPdf: args.get("--output"), candidatePdf: args.get("--verify"), donorsPath: args.get("--donors"), fontDir: args.get("--font-dir") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verification.status !== "pass") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
