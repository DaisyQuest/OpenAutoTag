import Ajv2020 from "ajv/dist/2020.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPipeline } from "./pipeline-runner.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaSearchDirs = [path.join(repoRoot, "contracts"), path.join(repoRoot, "perfect-studio")];
const defaultNormalizedComplianceSchemaPath = path.join(repoRoot, "contracts", "normalized-compliance.schema.json");
let cachedValidationContractValidatorPromise = null;

export function normalizeValidationContract(validationReport) {
  const findings = Array.isArray(validationReport?.findings) ? validationReport.findings : [];
  const errors = findings
    .filter((finding) => String(finding.severity || "").toLowerCase() === "error")
    .map((finding) => ({
      code: finding.code || "VALIDATION_ERROR",
      message: finding.message || finding.description || "Validation error",
      source: finding.source || "validator",
      page: finding.page ?? finding.pageNumber ?? null
    }));

  const pdfUaPassed =
    validationReport?.isCompliant === true &&
    (validationReport?.overall?.status == null || validationReport.overall.status === "pass") &&
    errors.length === 0;

  return {
    errors,
    compliance: {
      pdfUA: pdfUaPassed,
      wcagAA: errors.length === 0
    },
    engine: validationReport?.engine || null,
    summary: validationReport?.summary || null
  };
}

async function loadValidationContractValidator(validationContractSchemaPath) {
  if (validationContractSchemaPath) {
    return compileValidationContractValidator(validationContractSchemaPath);
  }

  if (cachedValidationContractValidatorPromise === null) {
    cachedValidationContractValidatorPromise = (async () => {
      const defaultValidator = await compileValidationContractValidator(defaultNormalizedComplianceSchemaPath);
      if (defaultValidator && isNormalizedComplianceSchema(defaultValidator.schema)) {
        return defaultValidator;
      }

      for (const schemaDir of schemaSearchDirs) {
        let entries = [];
        try {
          entries = await readdir(schemaDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".schema.json")) {
            continue;
          }

          const schemaPath = path.join(schemaDir, entry.name);
          const validator = await compileValidationContractValidator(schemaPath);
          if (validator && isNormalizedComplianceSchema(validator.schema)) {
            return validator;
          }
        }
      }

      return null;
    })();
  }

  return cachedValidationContractValidatorPromise;
}

function isNormalizedComplianceSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return false;
  }

  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const title = String(schema.title || "").toLowerCase();
  const description = String(schema.description || "").toLowerCase();

  if (required.has("status") || required.has("isCompliant") || required.has("findings")) {
    return false;
  }

  return (
    (title.includes("normalized") && title.includes("compliance")) ||
    (description.includes("normalized") && description.includes("compliance")) ||
    (required.has("errors") && required.has("compliance") && properties.errors && properties.compliance)
  );
}

async function compileValidationContractValidator(schemaPath) {
  try {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    if (!schema || typeof schema !== "object") {
      return null;
    }

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    return ajv.compile(schema);
  } catch {
    return null;
  }
}

function createValidationContractError(code, message, details = null) {
  return {
    code,
    message,
    source: "orchestrator",
    page: null,
    details
  };
}

function summarizeAjvErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }

  return errors.slice(0, 3).map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    message: error.message
  }));
}

async function readValidationContract(validationPath, validator) {
  let rawReport;
  try {
    rawReport = JSON.parse(await readFile(validationPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      contract: null,
      error: createValidationContractError(
        "VALIDATION_REPORT_INVALID",
        `Validation report at ${validationPath} could not be parsed: ${error.message || String(error)}`
      )
    };
  }

  const contract = normalizeValidationContract(rawReport);
  if (validator && !validator(contract)) {
    return {
      ok: false,
      contract,
      error: createValidationContractError(
        "VALIDATION_REPORT_INVALID",
        `Validation report at ${validationPath} did not match the normalized compliance schema.`,
        summarizeAjvErrors(validator.errors)
      )
    };
  }

  return { ok: true, contract, error: null };
}

export async function runPerfectStudioCorpus({
  corpusDir,
  outputDir,
  pipeline = runPipeline,
  profileId = "default",
  allowEmptyCorpus = false,
  validationContractSchemaPath = null
}) {
  if (!corpusDir || !outputDir) {
    throw new Error("runPerfectStudioCorpus requires corpusDir and outputDir");
  }

  const resolvedCorpusDir = path.resolve(corpusDir);
  const resolvedOutputDir = path.resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true });

  const entries = await readdir(resolvedCorpusDir, { withFileTypes: true });
  const pdfs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const validationContractValidator = await loadValidationContractValidator(validationContractSchemaPath);
  const results = [];
  if (pdfs.length === 0 && !allowEmptyCorpus) {
    const summary = {
      status: "fail",
      corpusDir: resolvedCorpusDir,
      outputDir: resolvedOutputDir,
      total: 0,
      passed: 0,
      failed: 0,
      reason: "empty-corpus",
      results
    };
    const summaryPath = path.join(resolvedOutputDir, "perfect-studio-validation-summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    return { ...summary, summaryPath };
  }

  for (const pdfName of pdfs) {
    const pdfPath = path.join(resolvedCorpusDir, pdfName);
    const jobOutputDir = path.join(resolvedOutputDir, path.basename(pdfName, ".pdf"));
    try {
      const job = await pipeline({
        filePath: pdfPath,
        outputDir: jobOutputDir,
        jobId: `perfect-studio-${path.basename(pdfName, ".pdf")}`,
        options: { profileId }
      });
      const validationPath = job.artifacts?.validationReport;
      if (!validationPath) {
        results.push({
          pdf: pdfName,
          status: "error",
          outputDir: jobOutputDir,
          validationReport: null,
          contract: {
            errors: [createValidationContractError(
              "VALIDATION_REPORT_MISSING",
              "No validation report artifact was emitted."
            )],
            compliance: { pdfUA: false, wcagAA: false },
            engine: null,
            summary: null
          }
        });
        continue;
      }

      const validationResult = await readValidationContract(validationPath, validationContractValidator);
      if (!validationResult.ok) {
        const errorContract = validationResult.contract || {
          errors: [validationResult.error],
          compliance: { pdfUA: false, wcagAA: false },
          engine: null,
          summary: null
        };
        if (errorContract.errors.length === 0) {
          errorContract.errors = [validationResult.error];
        }
        results.push({
          pdf: pdfName,
          status: "error",
          outputDir: jobOutputDir,
          validationReport: validationPath,
          contract: errorContract,
          error: validationResult.error
        });
        continue;
      }

      const contract = validationResult.contract;
      results.push({
        pdf: pdfName,
        status: contract.errors.length === 0 && contract.compliance.pdfUA ? "pass" : "fail",
        outputDir: jobOutputDir,
        validationReport: validationPath,
        contract
      });
    } catch (error) {
      results.push({
        pdf: pdfName,
        status: "error",
        outputDir: jobOutputDir,
        validationReport: null,
        contract: {
          errors: [{
            code: "PIPELINE_EXECUTION_FAILED",
            message: error.message || String(error),
            source: "orchestrator",
            page: null
          }],
          compliance: { pdfUA: false, wcagAA: false },
          engine: null,
          summary: null
        }
      });
    }
  }

  const summary = {
    status: results.length > 0 && results.every((result) => result.status === "pass") ? "pass" : allowEmptyCorpus ? "pass" : "fail",
    corpusDir: resolvedCorpusDir,
    outputDir: resolvedOutputDir,
    total: results.length,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status !== "pass").length,
    results
  };
  const summaryPath = path.join(resolvedOutputDir, "perfect-studio-validation-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { ...summary, summaryPath };
}

function parseArgs(argv) {
  const args = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-empty" || token === "--allow-empty-corpus") {
      flags.add("allowEmptyCorpus");
      continue;
    }
    if (token === "--corpus" || token === "--output-dir" || token === "--profile" || token === "--validation-contract") {
      args.set(token, argv[index + 1]);
      index += 1;
    }
  }
  return {
    corpusDir: args.get("--corpus"),
    outputDir: args.get("--output-dir"),
    profileId: args.get("--profile") || "default",
    allowEmptyCorpus: flags.has("allowEmptyCorpus"),
    validationContractSchemaPath: args.get("--validation-contract") || null
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.corpusDir || !options.outputDir) {
    throw new Error("Usage: node orchestrator/perfect-studio-ci-runner.js --corpus <dir> --output-dir <dir> [--profile <id>] [--allow-empty-corpus]");
  }
  const summary = await runPerfectStudioCorpus(options);
  await new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, resolve);
  });
  return summary.status === "pass" ? 0 : 1;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

export { repoRoot };
