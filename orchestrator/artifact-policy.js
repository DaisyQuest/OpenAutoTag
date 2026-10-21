import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import qualitySchema from "../contracts/quality-report.schema.json" with { type: "json" };
const validQuality = new Ajv2020().compile(qualitySchema);

export async function artifactDownloadPolicy(job, artifactName, reviewCandidate = false, servedBytes) {
  const file = job?.artifacts?.[artifactName];
  if (!file || path.extname(file).toLowerCase() !== ".pdf") return { allowed: true };
  const source = job.input?.stagedFilePath;
  const canonical = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (source && canonical(file) === canonical(source)) return { allowed: true };
  const gated = job.input?.options?.productionChecks || job.artifacts?.candidatePdf || job.artifacts?.qualityReport;
  if (!gated) return { allowed: true };
  if (!job.artifacts?.qualityReport) return { allowed: false, reason: "Candidate quality checks have not completed." };
  let report;
  try { report = JSON.parse(await readFile(job.artifacts.qualityReport, "utf8")); }
  catch { return { allowed: false, reason: "Candidate quality report is unavailable." }; }
  if (!validQuality(report) || report.disposition !== "review_required") return { allowed: false, reason: "Candidate failed quality checks or has an invalid quality report." };
  if (!reviewCandidate) return { allowed: false, reason: "This is a review candidate. Request candidate=1 explicitly; it is not an accepted output." };
  const hash = createHash("sha256");
  if (servedBytes !== undefined) hash.update(servedBytes);
  else for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== report.candidateHash) return { allowed: false, reason: "Candidate changed after inspection." };
  return { allowed: true, disposition: "review_required" };
}
