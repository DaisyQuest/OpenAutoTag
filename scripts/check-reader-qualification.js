import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../contracts/reader-qualification.schema.json" with { type: "json" };
const ajv = new Ajv2020({ allErrors: true }), validate = ajv.compile(schema);

// Validates the supplied human record, not the truth of observations or overall conformance.
export async function checkReaderQualification(pdfPath, evidence) {
  if (!validate(evidence)) return { status: "incomplete", reason: ajv.errorsText(validate.errors) };
  if (evidence.sessions.every((s) => s.checks.readingOrder.status === "not_applicable"))
    return { status: "incomplete", reason: "At least one session must record an observed reading-order result" };
  const hash = createHash("sha256"); for await (const chunk of createReadStream(pdfPath)) hash.update(chunk);
  const candidateHash = hash.digest("hex");
  if (evidence.candidateHash !== candidateHash) return { status: "stale", candidateHash, reason: "Evidence belongs to different PDF bytes." };
  const failures = evidence.sessions.flatMap((session) => Object.entries(session.checks).filter(([, check]) => check.status === "fail").map(([name]) => `${session.reader} ${session.version}: ${name}`));
  return { status: failures.length ? "failed" : "recorded", candidateHash, failures,
    limitation: "This verifies completeness and byte binding of human observations; it does not certify accessibility or approve delivery." };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Map(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i+1]);
  try {
    if (!args.get("--pdf") || !args.get("--evidence")) throw new Error("Required: --pdf <candidate.pdf> --evidence <reader-evidence.json>");
    const result = await checkReaderQualification(args.get("--pdf"), JSON.parse(await readFile(args.get("--evidence"), "utf8")));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (result.status !== "recorded") process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
