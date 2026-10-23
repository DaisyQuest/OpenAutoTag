import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { inspectPdfLowLevel } from "./inspect-pdf-low-level.js";
import { runJsonCommand } from "./run-json-command.js";
// Module boundaries stay CLI-based; validator owns the comparison implementation.
export async function checkSavedSemantics({ pdfPath, tagsPath, referencePath, outputPath, sourcePdfPath, ownershipPath }) {
  if (!pdfPath || Boolean(tagsPath) === Boolean(referencePath)) throw new Error("Required: --pdf and exactly one of --tags or --reference");
  if (Boolean(sourcePdfPath) !== Boolean(ownershipPath) || ownershipPath && !tagsPath) throw new Error("Source ownership requires --tags, --source-pdf and --ownership together");
  const inputs = [pdfPath, tagsPath, referencePath, sourcePdfPath, ownershipPath].filter(Boolean).map(p => path.resolve(p).toLowerCase());
  if (outputPath && inputs.includes(path.resolve(outputPath).toLowerCase())) throw new Error("Output must not overwrite an input");
  const inspection = await inspectPdfLowLevel({ pdfPath, preservation: true });
  const reference = referencePath ? await inspectPdfLowLevel({ pdfPath: referencePath, preservation: true }) : undefined;
  const tagsBytes = tagsPath ? await readFile(tagsPath) : null;
  const ownershipBytes = ownershipPath ? await readFile(ownershipPath) : null;
  const sourceOwnership = ownershipBytes ? JSON.parse(ownershipBytes) : undefined;
  const sourceInspection = sourcePdfPath ? await inspectPdfLowLevel({ pdfPath: sourcePdfPath, preservation: true }) : undefined;
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  if (sourceOwnership && (sourceOwnership.sourceHash !== sourceInspection.sourceHash || sourceOwnership.intentHash !== hash(tagsBytes)))
    throw new Error("Source ownership does not match the source PDF and tagging intent hashes");
  const payload = { inspection, reference, tagging: tagsBytes ? JSON.parse(tagsBytes) : undefined, sourceInspection, sourceOwnership };
  const temp = await mkdtemp(path.join(os.tmpdir(), "saved-semantics-"));
  let report;
  try {
    const file = path.join(temp, "comparison.json"); await writeFile(file, JSON.stringify(payload));
    report = await runJsonCommand(process.execPath, [path.resolve(import.meta.dirname, "../modules/validator/saved-semantics-cli.js"), file]);
  } finally { await rm(temp, { recursive: true, force: true }); }
  const candidateBytes=await readFile(pdfPath), referenceBytes=referencePath?await readFile(referencePath):null;
  if (hash(candidateBytes) !== inspection.sourceHash || referenceBytes && hash(referenceBytes) !== reference.sourceHash)
    throw new Error("PDF changed during semantic inspection");
  if(referenceBytes && !candidateBytes.subarray(0,referenceBytes.length).equals(referenceBytes)) throw new Error("Reference comparison requires unchanged source bytes as a prefix; a rewritten PDF requires tagging intent IDs");
  if(tagsBytes && !tagsBytes.equals(await readFile(tagsPath))) throw new Error("Tagging intent changed during semantic inspection");
  if (sourceInspection && (hash(await readFile(sourcePdfPath)) !== sourceInspection.sourceHash || !ownershipBytes.equals(await readFile(ownershipPath))))
    throw new Error("Source ownership inputs changed during semantic inspection");
  if (tagsBytes) report.intentHash = hash(tagsBytes);
  if (sourceInspection) { report.sourceHash = sourceInspection.sourceHash; report.ownershipHash = hash(ownershipBytes); }
  if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}
async function main() {
  const a = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!["--pdf", "--tags", "--reference", "--output", "--report-only", "--source-pdf", "--ownership"].includes(process.argv[i]) || !process.argv[i + 1] || a.has(process.argv[i])) throw new Error("Invalid comparison arguments");
    a.set(process.argv[i], process.argv[i + 1]);
  }
  const report = await checkSavedSemantics({ pdfPath: a.get("--pdf"), tagsPath: a.get("--tags"), referencePath: a.get("--reference"), outputPath: a.get("--output"), sourcePdfPath: a.get("--source-pdf"), ownershipPath: a.get("--ownership") });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (a.has("--report-only") && !["true","false"].includes(a.get("--report-only"))) throw new Error("Invalid report-only option");
  if (report.disposition === "rejected" && a.get("--report-only") !== "true") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { process.stderr.write(e.message + "\n"); process.exitCode = 1; });
