import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import donorSchema from "../contracts/font-donors.schema.json" with { type: "json" };
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectPdfLowLevel } from "./inspect-pdf-low-level.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validateDonors = new Ajv2020({ allErrors: true }).compile(donorSchema);
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function retainsPrefix(sourcePath, candidatePath) {
  const a = await open(sourcePath, "r"); let b;
  try {
    b = await open(candidatePath, "r");
    const source = Buffer.alloc(65536), candidate = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await a.read(source, 0, source.length, offset);
      if (!bytesRead) return true;
      let total = 0;
      while (total < bytesRead) {
        const next = await b.read(candidate, total, bytesRead - total, offset + total);
        if (!next.bytesRead) return false;
        total += next.bytesRead;
      }
      if (!source.subarray(0, bytesRead).equals(candidate.subarray(0, bytesRead))) return false;
      offset += bytesRead;
    }
  } finally { await a.close(); await b?.close(); }
}

export async function checkPdfPreservation({ sourcePdf, candidatePdf, validationReport, semanticPath, outputPath, fontRepairs = false, fontDonorsPath, structureRepairs = false, structureDecisions }) {
  if (!sourcePdf || !candidatePdf || !validationReport || !outputPath) throw new Error("Required: --source-pdf --candidate-pdf --validation-report --output");
  const dir = path.dirname(path.resolve(outputPath));
  const base = path.basename(outputPath, path.extname(outputPath));
  const sourcePath = path.join(dir, `${base}.source.json`), candidatePath = path.join(dir, `${base}.candidate.json`);
  const structureProofPath = path.join(dir, `${base}.structure.json`);
  const fontProofPath = path.join(dir, `${base}.fonts.json`);
  const normalized = (file) => path.resolve(file).toLowerCase();
  if (structureDecisions && !structureRepairs) throw new Error("Structure decisions require structure repair verification");
  if (fontDonorsPath && !fontRepairs) throw new Error("Font donors require font repair verification");
  const donorInputs = [];
  if (fontDonorsPath) {
    if ((await stat(fontDonorsPath)).size > 256 * 1024) throw new Error("Font donor manifest exceeds limit");
    const donors = JSON.parse(await readFile(fontDonorsPath, "utf8"));
    if (!validateDonors(donors)) throw new Error("Invalid font donor manifest");
    donorInputs.push(fontDonorsPath, ...donors.donors.map(d => path.resolve(path.dirname(path.resolve(fontDonorsPath)), d.programPath)));
  }
  const inputs = [sourcePdf, candidatePdf, validationReport, ...(semanticPath ? [semanticPath] : []), ...(structureDecisions ? [structureDecisions] : []), ...donorInputs].map(normalized);
  if ([outputPath, sourcePath, candidatePath, ...(fontRepairs ? [fontProofPath] : []), ...(structureRepairs ? [structureProofPath] : [])].some((file) => inputs.includes(normalized(file)))) throw new Error("Quality output must not overwrite an input");
  await mkdir(dir, { recursive: true });
  let identityPreserved = false, inspectionError;
  try {
    const source = await inspectPdfLowLevel({ pdfPath: sourcePdf, preservation: true });
    const candidate = await inspectPdfLowLevel({ pdfPath: candidatePdf, preservation: true });
    identityPreserved = await retainsPrefix(sourcePdf, candidatePdf);
    if (source.sourceHash !== await hashFile(sourcePdf) || candidate.sourceHash !== await hashFile(candidatePdf)) throw new Error("PDF changed during inspection");
    await writeFile(sourcePath, JSON.stringify(source));
    await writeFile(candidatePath, JSON.stringify(candidate));
    if (fontRepairs) {
      // Execute against the saved PDFs; never accept an unverified writer ledger as a waiver.
      const { stdout } = await execFileAsync(process.execPath, [path.join(root, "modules/pdf-writer/font-repair.js"),
        "--pdf", path.resolve(sourcePdf), "--verify", path.resolve(candidatePdf), ...(fontDonorsPath ? ["--donors", path.resolve(fontDonorsPath)] : [])], { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const proof = JSON.parse(stdout);
      if (proof.sourceHash !== source.sourceHash || proof.candidateHash !== candidate.sourceHash) throw new Error("PDF changed during font verification");
      await writeFile(fontProofPath, JSON.stringify(proof));
    }
    if (structureRepairs) {
      const decisions = structureDecisions ? JSON.parse(await readFile(structureDecisions, "utf8")) : { paragraphs: [] };
      if (!Array.isArray(decisions.paragraphs) || decisions.paragraphs.some((v) => typeof v !== "string") ||
          structureDecisions && decisions.sourceSha256 !== source.sourceHash) throw new Error("Invalid or stale structure decisions");
      const { stdout } = await execFileAsync(process.execPath, [path.join(root, "modules/pdf-writer/structure-repair.js"),
        "--pdf", path.resolve(sourcePdf), "--verify", path.resolve(candidatePdf), "--split-forms", "true",
        ...(structureDecisions ? ["--source-sha256", decisions.sourceSha256, ...decisions.paragraphs.flatMap((ref) => ["--paragraph", ref])] : [])],
      { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const proof = JSON.parse(stdout);
      if (proof.sourceHash !== source.sourceHash || proof.candidateHash !== candidate.sourceHash) throw new Error("PDF changed during structure verification");
      await writeFile(structureProofPath, JSON.stringify(proof));
    }
  } catch (error) { inspectionError = String(error.message).slice(0, 2000); }
  const args = [path.join(root, "modules", "validator", "quality-cli.js"), "--validation", path.resolve(validationReport),
    ...(!inspectionError && structureRepairs ? ["--structure-repair", structureProofPath] : []),
    ...(!inspectionError && fontRepairs ? ["--font-repair", fontProofPath] : []),
    ...(semanticPath ? ["--semantic", path.resolve(semanticPath)] : []),
    ...(inspectionError ? ["--inspection-error", inspectionError] : ["--source", sourcePath, "--candidate", candidatePath, "--identity-preserved", String(identityPreserved)])];
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const report = await checkPdfPreservation({ sourcePdf: args.get("--source-pdf"), candidatePdf: args.get("--candidate-pdf"),
    validationReport: args.get("--validation-report"), semanticPath: args.get("--semantic"), outputPath: args.get("--output"), fontRepairs: args.get("--font-repairs") === "true", fontDonorsPath: args.get("--font-donors"), structureRepairs: args.get("--structure-repairs") === "true", structureDecisions: args.get("--structure-decisions") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
