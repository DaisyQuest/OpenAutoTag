import Ajv2020 from "ajv/dist/2020.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import layoutSchema from "../../contracts/layout.schema.json" with { type: "json" };
import redactionReportSchema from "../../contracts/redaction-report.schema.json" with { type: "json" };
import {
  applySsnMasking,
  estimateMatchBbox,
  finalizeRedactionReport,
  findSsnMatchesInText,
  maskSsnMatch,
} from "./shared.js";

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);
const validateRedactionReport = ajv.compile(redactionReportSchema);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(moduleDir, ".build");
const javaSourcePath = path.join(moduleDir, "java", "PdfSsnRedactorCli.java");
const javaClassPath = path.join(buildDir, "PdfSsnRedactorCli.class");
const pdfboxJarCandidates = [
  path.join(moduleDir, "vendor", "pdfbox-app-3.0.7.jar"),
  path.join(moduleDir, "..", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar"),
  path.join(moduleDir, "..", "validator", "vendor", "pdfbox-app-3.0.7.jar")
];

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    pdfPath: args.get("--pdf"),
    layoutPath: args.get("--layout"),
    outputPath: args.get("--output")
  };
}

function execCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function resolvePdfboxJarPath() {
  for (const candidate of pdfboxJarCandidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("PDFBox runtime not found for SSN redaction.");
}

async function needsCompilation() {
  try {
    const [sourceStats, classStats] = await Promise.all([stat(javaSourcePath), stat(javaClassPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
  } catch {
    return true;
  }
}

async function ensureJavaHelperCompiled() {
  await mkdir(buildDir, { recursive: true });

  if (!(await needsCompilation())) {
    return;
  }

  const pdfboxJarPath = await resolvePdfboxJarPath();
  await execCommand("javac", [
    "-encoding",
    "UTF-8",
    "-cp",
    pdfboxJarPath,
    "-d",
    buildDir,
    javaSourcePath
  ]);
}

export function buildRedactionPlan(layoutDocument) {
  const matches = [];

  for (const page of layoutDocument.pages || []) {
    for (const block of page.textBlocks || []) {
      const blockMatches = findSsnMatchesInText(block.text);

      for (const [matchIndex, match] of blockMatches.entries()) {
        matches.push({
          matchId: `${block.id}:ssn:${matchIndex + 1}`,
          pageNumber: page.pageNumber,
          sourceBlockId: block.id,
          maskedText: match.maskedText,
          bbox: estimateMatchBbox(block, match, page)
        });
      }
    }
  }

  return {
    matches,
    pagesProcessed: layoutDocument.pages?.length || 0,
    pagesRedacted: new Set(matches.map((match) => match.pageNumber)).size
  };
}

async function buildInstructionFile(outputPath, matches) {
  const instructionPath = `${outputPath}.instructions.tsv`;
  const lines = matches.map((match) => {
    const [x, y, width, height] = match.bbox;
    return [match.pageNumber, x, y, width, height].join("\t");
  });

  await writeFile(instructionPath, `${lines.join("\n")}\n`);
  return instructionPath;
}

async function runJavaRedactor({ pdfPath, instructionPath, outputPath }) {
  await ensureJavaHelperCompiled();
  const pdfboxJarPath = await resolvePdfboxJarPath();
  const stdout = await execCommand("java", [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "PdfSsnRedactorCli",
    "--pdf",
    path.resolve(pdfPath),
    "--instructions",
    path.resolve(instructionPath),
    "--output",
    path.resolve(outputPath)
  ]);

  return JSON.parse(stdout);
}

export async function redactSsnArtifacts({ pdfPath, layoutPath, outputPath }) {
  if (!pdfPath || !layoutPath || !outputPath) {
    throw new Error(
      "Usage: node modules/redactor/index.js --pdf <input.pdf> --layout <layout.json> --output <redacted.pdf>"
    );
  }

  const layoutDocument = JSON.parse(await readFile(layoutPath, "utf8"));
  if (!validateLayout(layoutDocument)) {
    throw new Error(`Redactor input failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const redactionPlan = buildRedactionPlan(layoutDocument);
  const report = finalizeRedactionReport({
    workloadId: "ssn-redaction",
    sourcePdf: path.resolve(pdfPath),
    outputPdf: path.resolve(outputPath),
    plan: {
      summary: {
        pagesProcessed: redactionPlan.pagesProcessed,
        candidateMatches: redactionPlan.matches.length,
        redactedMatches: redactionPlan.matches.length,
        pagesRedacted: redactionPlan.pagesRedacted
      },
      matches: redactionPlan.matches
    },
    outputMode: redactionPlan.matches.length > 0 ? "raster-redaction" : "passthrough-copy",
    accessibilityTreeRedacted: false
  });

  if (redactionPlan.matches.length === 0) {
    await copyFile(pdfPath, outputPath);
  } else {
    const instructionPath = await buildInstructionFile(outputPath, redactionPlan.matches);
    const javaReport = await runJavaRedactor({
      pdfPath,
      instructionPath,
      outputPath
    });

    report.summary.pagesProcessed = javaReport.pagesProcessed ?? report.summary.pagesProcessed;
    report.summary.pagesRedacted = javaReport.pagesRedacted ?? report.summary.pagesRedacted;
    report.summary.redactedMatches = javaReport.redactionCount ?? report.summary.redactedMatches;
    report.summary.outputMode = javaReport.outputMode || report.summary.outputMode;
    report.instructionsPath = path.resolve(instructionPath);
  }

  if (!validateRedactionReport(report)) {
    throw new Error(`Redaction report failed schema validation: ${ajv.errorsText(validateRedactionReport.errors)}`);
  }

  return report;
}

export { applySsnMasking, estimateMatchBbox, findSsnMatchesInText, maskSsnMatch } from "./shared.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await redactSsnArtifacts(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
