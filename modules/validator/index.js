import Ajv2020 from "ajv/dist/2020.js";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { access, chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };
import { ensureJavaBuildArtifact } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";

const ajv = new Ajv2020({ allErrors: true });
const validateTagging = ajv.compile(taggingSchema);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(moduleDir, "vendor");
const bundledJavaHome = path.join(vendorDir, "java");
const repoRoot = path.resolve(moduleDir, "..", "..");
const defaultVeraPdfPaths =
  process.platform === "win32"
    ? [path.join(vendorDir, "verapdf", "app", "verapdf.bat")]
    : [
        path.join(vendorDir, "verapdf", "app", "verapdf"),
        path.join(vendorDir, "verapdf", "app", "bin", "verapdf")
      ];
const buildDir = getRuntimeBuildDir("modules-validator", { repoRoot });
const metadataProbeSourcePath = path.join(moduleDir, "java", "MetadataProbeCli.java");
const metadataProbeClassPath = path.join(buildDir, "MetadataProbeCli.class");
const fontAuditSourcePath = path.join(moduleDir, "java", "FontAuditCli.java");
const fontAuditClassPath = path.join(buildDir, "FontAuditCli.class");
const fontAuditPdfboxJarPath = path.join(vendorDir, "pdfbox-app-3.0.8.jar");

function parseArgs(argv) {
  const args = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--skip-font-audit") {
      flags.add("skipFontAudit");
      continue;
    }
    args.set(token, argv[index + 1]);
    index += 1;
  }
  return {
    pdfPath: args.get("--pdf"),
    manifestPath: args.get("--manifest"),
    skipFontAudit: flags.has("skipFontAudit")
  };
}

function execCommand(command, args, { allowExitCodes = [], env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env,
        maxBuffer: 1024 * 1024 * 20,
        shell: process.platform === "win32" && /\.bat$/i.test(command)
      },
      (error, stdout, stderr) => {
        if (error && !allowExitCodes.includes(error.code)) {
          const wrapped = new Error(stderr || stdout || error.message);
          wrapped.stderr = stderr || "";
          wrapped.stdout = stdout || "";
          wrapped.exitCode = error.code;
          reject(wrapped);
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: error ? error.code : 0
        });
      }
    );
  });
}

function executableName(commandName) {
  return process.platform === "win32" ? `${commandName}.exe` : commandName;
}

async function isReadable(targetPath) {
  try {
    await access(targetPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureExecutable(targetPath) {
  if (process.platform !== "win32") {
    await chmod(targetPath, 0o755).catch(() => {});
  }
}

async function resolveConfiguredPath(envVarName, description) {
  const configuredPath = process.env[envVarName];
  if (!configuredPath) {
    return null;
  }

  const resolvedPath = path.resolve(configuredPath);
  if (!(await isReadable(resolvedPath))) {
    throw new Error(`${description} not found at ${resolvedPath}.`);
  }

  await ensureExecutable(resolvedPath);
  return resolvedPath;
}

async function resolveJavaHome() {
  const configuredJavaHome = process.env.VALIDATOR_JAVA_HOME;
  if (configuredJavaHome) {
    const resolvedJavaHome = path.resolve(configuredJavaHome);
    if (!(await isReadable(path.join(resolvedJavaHome, "bin", executableName("java"))))) {
      throw new Error(`Validator Java home not found at ${resolvedJavaHome}.`);
    }
    return resolvedJavaHome;
  }

  const envJavaHome = process.env.JAVA_HOME ? path.resolve(process.env.JAVA_HOME) : null;
  if (envJavaHome && (await isReadable(path.join(envJavaHome, "bin", executableName("java"))))) {
    return envJavaHome;
  }

  if (await isReadable(path.join(bundledJavaHome, "bin", executableName("java")))) {
    return bundledJavaHome;
  }

  return null;
}

async function resolveJavaTool(commandName, envVarName) {
  const configuredPath = await resolveConfiguredPath(envVarName, `${commandName} executable`);
  if (configuredPath) {
    return configuredPath;
  }

  const javaHome = await resolveJavaHome();
  if (javaHome) {
    const javaToolPath = path.join(javaHome, "bin", executableName(commandName));
    if (await isReadable(javaToolPath)) {
      await ensureExecutable(javaToolPath);
      return javaToolPath;
    }
  }

  return commandName;
}

async function buildJavaExecEnv() {
  const javaHome = await resolveJavaHome();
  if (!javaHome) {
    return process.env;
  }

  return {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`
  };
}

async function resolveVeraPdfPath() {
  const configuredPath = await resolveConfiguredPath("VERAPDF_PATH", "veraPDF CLI");
  if (configuredPath) {
    return configuredPath;
  }

  for (const candidatePath of defaultVeraPdfPaths) {
    if (await isReadable(candidatePath)) {
      await ensureExecutable(candidatePath);
      return candidatePath;
    }
  }

  throw new Error(
    `veraPDF CLI not found at ${defaultVeraPdfPaths[0]}. Run 'npm run install:verapdf' or set VERAPDF_PATH.`
  );
}

async function needsJavaCompilation(sourcePath, classPath) {
  try {
    const [sourceStats, classStats] = await Promise.all([stat(sourcePath), stat(classPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
  } catch {
    return true;
  }
}

async function ensureMetadataProbeCompiled() {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => !(await needsJavaCompilation(metadataProbeSourcePath, metadataProbeClassPath)),
    compile: async () => {
      const javacCommand = await resolveJavaTool("javac", "VALIDATOR_JAVAC_PATH");
      try {
        await execCommand(
          javacCommand,
          [
            "-encoding",
            "UTF-8",
            "-cp",
            fontAuditPdfboxJarPath,
            "-d",
            buildDir,
            metadataProbeSourcePath
          ],
          {
            env: await buildJavaExecEnv()
          }
        );
      } catch (error) {
        throw new Error(
          `Unable to compile validator metadata probe. Install a JDK, set VALIDATOR_JAVAC_PATH, or bundle Java under ${bundledJavaHome}. ${error.message}`
        );
      }
    }
  });
}

async function ensureFontAuditCompiled() {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => !(await needsJavaCompilation(fontAuditSourcePath, fontAuditClassPath)),
    compile: async () => {
      const javacCommand = await resolveJavaTool("javac", "VALIDATOR_JAVAC_PATH");
      try {
        await execCommand(
          javacCommand,
          [
            "-encoding",
            "UTF-8",
            "-cp",
            fontAuditPdfboxJarPath,
            "-d",
            buildDir,
            fontAuditSourcePath
          ],
          {
            env: await buildJavaExecEnv()
          }
        );
      } catch (error) {
        throw new Error(
          `Unable to compile validator font audit. Install a JDK, set VALIDATOR_JAVAC_PATH, or bundle Java under ${bundledJavaHome}. ${error.message}`
        );
      }
    }
  });
}

function sanitizeCode(value) {
  return String(value || "UNKNOWN")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseVeraPdfReport(stdout) {
  const parsed = JSON.parse(stdout.trim());
  const job = parsed.report?.jobs?.[0];
  const validationResult = job?.validationResult?.[0];

  // veraPDF occasionally bombs inside its PDFBox validator on perfectly valid
  // PDFs (e.g. "Index 21 out of bounds for length 0"). When that happens the
  // job carries a taskException but no validationResult. Surface the exception
  // as a structured finding so the orchestrator can treat it as a visible
  // defect rather than a missing artifact.
  if (!validationResult) {
    if (job?.taskException) {
      const message = job.taskException.exceptionMessage || job.taskException.exception || "veraPDF task exception";
      return {
        raw: parsed,
        validationResult: {
          profileName: null,
          statement: `veraPDF threw during validation: ${message}`,
          details: { passedRules: 0, failedRules: 0, passedChecks: 0, failedChecks: 0, ruleSummaries: [] }
        },
        details: { passedRules: 0, failedRules: 0, passedChecks: 0, failedChecks: 0, ruleSummaries: [] },
        buildInformation: parsed.report?.buildInformation || {},
        taskException: {
          message,
          type: job.taskException.type || "VALIDATE",
          duration: job.taskException.duration || null
        }
      };
    }
    throw new Error("veraPDF did not return a validation result.");
  }

  return {
    raw: parsed,
    validationResult,
    details: validationResult.details || {},
    buildInformation: parsed.report?.buildInformation || {}
  };
}

async function runVeraPdf(pdfPath) {
  const veraPdfPath = await resolveVeraPdfPath();
  const flavour = process.env.VERAPDF_FLAVOUR || "ua1";
  let stdout;
  let stderr = "";
  try {
    // veraPDF documented exit codes:
    //   0 - valid
    //   1 - validation failures were detected (still a successful run)
    //   2 - file parsing problem but veraPDF produced a report
    //   7 - crash / JVM error
    // We accept 0, 1, 2 as "ran successfully" and try to parse stdout.
    // Anything else (or unparseable stdout) is surfaced as a runtime error
    // that the caller converts to VALIDATOR_EXECUTION_FAILED.
    ({ stdout, stderr = "" } = await execCommand(
      veraPdfPath,
      ["--format", "json", "--flavour", flavour, "--loglevel", "0", pdfPath],
      {
        // veraPDF exit codes we accept as "ran and produced a report":
        //   0  valid
        //   1  validation failures detected
        //   2  file-parse issues with a report
        //   7  CLI abort with partial JSON
        //   9  per-job exception (taskException in stdout JSON, still parseable)
        allowExitCodes: [0, 1, 2, 7, 9],
        env: await buildJavaExecEnv()
      }
    ));
  } catch (error) {
    // Filter PDFBox's non-fatal FlateFilter warnings from the diagnostic
    // so the root cause (Java/JVM/unreadable PDF) stays visible.
    const filteredStderr = (error.stderr || "")
      .split(/\r?\n/)
      .filter((line) => !/FlateFilter:decode:\d+ - FlateFilter: stop reading corrupt stream/.test(line))
      .join("\n")
      .trim();
    const detail = [error.message, filteredStderr].filter(Boolean).join(" | ");
    throw new Error(
      `veraPDF failed to execute. Install Java, set VALIDATOR_JAVA_HOME, or bundle Java under ${bundledJavaHome}. ${detail}`
    );
  }

  // If veraPDF emitted no usable JSON (e.g. it printed only errors before
  // crashing), treat that as an execution failure so the caller can surface
  // VALIDATOR_EXECUTION_FAILED rather than a confusing parse error.
  if (!stdout || !stdout.trim().startsWith("{")) {
    const filteredStderr = stderr
      .split(/\r?\n/)
      .filter((line) => !/FlateFilter:decode:\d+ - FlateFilter: stop reading corrupt stream/.test(line))
      .join("\n")
      .trim();
    throw new Error(
      `veraPDF produced no parseable JSON report${filteredStderr ? `: ${filteredStderr}` : "."}`
    );
  }

  return parseVeraPdfReport(stdout);
}

export async function runFontAuditCli(pdfPath) {
  return runFontAudit(pdfPath);
}

async function runFontAudit(pdfPath) {
  await ensureFontAuditCompiled();
  const javaCommand = await resolveJavaTool("java", "VALIDATOR_JAVA_PATH");
  let stdout;
  try {
    ({ stdout } = await execCommand(
      javaCommand,
      [
        "-cp",
        `${buildDir}${path.delimiter}${fontAuditPdfboxJarPath}`,
        "FontAuditCli",
        "--pdf",
        pdfPath
      ],
      {
        env: await buildJavaExecEnv()
      }
    ));
  } catch (error) {
    throw new Error(
      `Unable to run validator font audit. Set VALIDATOR_JAVA_PATH, JAVA_HOME, or bundle Java under ${bundledJavaHome}. ${error.message}`
    );
  }
  return JSON.parse(stdout.trim());
}

async function runMetadataProbe(pdfPath) {
  await ensureMetadataProbeCompiled();
  const javaCommand = await resolveJavaTool("java", "VALIDATOR_JAVA_PATH");
  let stdout;
  try {
    ({ stdout } = await execCommand(
      javaCommand,
      [
        "-cp",
        `${buildDir}${path.delimiter}${fontAuditPdfboxJarPath}`,
        "MetadataProbeCli",
        "--pdf",
        pdfPath
      ],
      {
        env: await buildJavaExecEnv()
      }
    ));
  } catch (error) {
    // Probe failures retain raw failures and are exposed as diagnostic errors.
    return {
      probeError: String(error.message || error).slice(0, 500),
      metadataPresent: null,
      infoMatchesXmp: null,
      dcTitleDetected: null,
      pdfUaIdentificationDetected: null,
      pdfUaIdentificationPart: null,
      linkAnnotCount: 0,
      linkAnnotsResolvingToLinkElement: 0,
      linkStructCorrect: false,
      widgetAnnotCount: 0,
      widgetsInFormStruct: 0,
      widgetStructCorrect: false
    };
  }
  return JSON.parse(stdout.trim());
}

function buildManifestFindings(manifest) {
  const findings = [];

  if (!manifest.tagging || !validateTagging(manifest.tagging)) {
    findings.push({
      severity: "error",
      code: "INVALID_TAGGING_MANIFEST",
      message: ajv.errorsText(validateTagging.errors)
    });
  }

  if (manifest.tagging?.root?.type !== "Document") {
    findings.push({
      severity: "error",
      code: "MISSING_DOCUMENT_ROOT",
      message: "Tagging tree root must be Document."
    });
  }

  if (manifest.nativeTaggingApplied !== true) {
    findings.push({
      severity: "warning",
      code: "NATIVE_TAGGING_NOT_APPLIED",
      message: "Writer manifest does not claim native tagging."
    });
  }

  return findings;
}

function buildVeraPdfFindings(report) {
  const findings = [];

  // Per-job taskException: veraPDF crashed internally on this PDF. Surface as
  // a single actionable finding so the job isn't reported as silently passing.
  if (report.taskException) {
    findings.push({
      severity: "error",
      code: "VERAPDF_TASK_EXCEPTION",
      description: report.taskException.message,
      clause: null,
      specification: null,
      source: "verapdf",
      test: report.taskException.type || "VALIDATE"
    });
  }

  const summaries = report.details.ruleSummaries || [];
  for (const summary of summaries) {
    if (summary.status !== "failed" && summary.ruleStatus !== "FAILED") continue;
    findings.push({
      severity: "error",
      code: `VERAPDF_${sanitizeCode(summary.clause)}_${summary.testNumber ?? "RULE"}`,
      clause: summary.clause,
      specification: summary.specification,
      description: summary.description,
      object: summary.object,
      test: summary.test,
      failedChecks: summary.failedChecks || 0,
      tags: summary.tags || [],
      checks: (summary.checks || []).map((check) => ({
        status: check.status,
        errorMessage: check.errorMessage || "",
        context: check.context,
        errorArguments: check.errorArguments || []
      }))
    });
  }
  return findings;
}

function extractEngineVersion(buildInformation) {
  const release = (buildInformation.releaseDetails || []).find((detail) => detail.id === "core");
  return release?.version || "unknown";
}

function hasMetadataMismatchSignals(findings) { return findings.some((f) => ["VERAPDF_5_1", "VERAPDF_7_1_9"].includes(f.code)); }
function hasLinkMismatchSignals(findings) { return findings.some((f) => f.code === "VERAPDF_7_18_5_1"); }
function hasWidgetMismatchSignals(findings) { return findings.some((f) => ["VERAPDF_7_18_4_1", "VERAPDF_7_18_4_2"].includes(f.code)); }

function buildMetadataDiagnostics(findings, metadataProbe) {
  if (!metadataProbe) {
    return null;
  }

  return {
    ...(metadataProbe.probeError ? { probeError: metadataProbe.probeError } : {}),
    metadataPresent: Boolean(metadataProbe.metadataPresent),
    infoMatchesXmp: Boolean(metadataProbe.infoMatchesXmp),
    dcTitleDetected: Boolean(metadataProbe.dcTitleDetected),
    dcTitleValue: metadataProbe.dcTitleValue || "",
    pdfUaIdentificationDetected: Boolean(metadataProbe.pdfUaIdentificationDetected),
    pdfUaIdentificationPart: metadataProbe.pdfUaIdentificationPart ?? null,
    suspectedVeraPdfMetadataMismatch:
      hasMetadataMismatchSignals(findings) &&
      metadataProbe.infoMatchesXmp === true &&
      metadataProbe.dcTitleDetected === true &&
      metadataProbe.pdfUaIdentificationDetected === true,
    linkAnnotCount: metadataProbe.linkAnnotCount ?? 0,
    linkAnnotsResolvingToLinkElement: metadataProbe.linkAnnotsResolvingToLinkElement ?? 0,
    linkStructCorrect: Boolean(metadataProbe.linkStructCorrect),
    suspectedVeraPdfLinkStubBug:
      hasLinkMismatchSignals(findings) && Boolean(metadataProbe.linkStructCorrect),
    widgetStructCorrect: Boolean(metadataProbe.widgetStructCorrect),
    formChildRuleCorrect: Boolean(metadataProbe.formChildRuleCorrect),
    invalidFormChildCount: metadataProbe.invalidFormChildCount ?? null,
    correctedByValidator: false,
    suppressedFindingCodes: []
  };
}

/**
 * Validation report shape (additive extensions for the font audit pre-pass).
 *
 * Existing top-level fields (unchanged): status, isCompliant, statement, rawStatement,
 *   profileName, findings, summary, rawSummary, metadataDiagnostics, engine.
 *
 * NEW top-level fields produced by the font audit:
 *
 *   fonts: Array<{
 *     fontKey: string,            // stable per-document identifier (subset-prefixed name + dict hash)
 *     name: string,
 *     subtype: string,            // "TrueType", "Type1", "Type0:CIDFontType2", "Type3", ...
 *     embedded: boolean,          // FontFile/FontFile2/FontFile3 present in /FontDescriptor
 *     hasToUnicode: boolean,
 *     toUnicodeCoverage: number,  // fraction in [0, 1] of *used* glyph codes that map to a Unicode string
 *     encoding: string,           // e.g. "WinAnsiEncoding", "Identity-H", "Custom+Differences"
 *     isSymbolic: boolean,
 *     standard14: boolean,        // true => unembedded Standard 14 (PDF/UA blocker)
 *     cidSystemInfoValid: boolean,
 *     usedGlyphCount: number,
 *     mappedGlyphCount: number,
 *     locations: string[]         // sorted: "page:N" entries plus optional "acroform:dr"
 *   }>
 *
 *   fontAudit: {
 *     status: "ok" | "skipped" | "failed",
 *     errorCount: number,         // count of severity=error findings from the audit
 *     warningCount: number,
 *     blockingPreVeraPdf: boolean // true if audit alone would force overall.status = "fail"
 *   }
 *
 * Findings appended by the font audit each carry `source: "font-audit"` and use these codes:
 *   FONT_NOT_EMBEDDED            (error)
 *   FONT_STANDARD_14             (error)  -- unembedded Standard 14, forbidden by PDF/UA
 *   TO_UNICODE_MISSING           (error)
 *   TO_UNICODE_INCOMPLETE        (error if coverage < 0.95, warning if 0.95 <= coverage < 0.99)
 *   SYMBOLIC_WITHOUT_DIFFERENCES (error)
 *   INVALID_CID_SYSTEM_INFO      (error)
 *   DA_FONT_NOT_IN_DR            (error)  -- form field /DA references a font absent from /AcroForm/DR/Font
 *   LICENSE_RESTRICTED           (warning, never promoted to error)
 *
 * Schema integration note (advisory; integration owner updates contracts/):
 *   contracts/validation-report.schema.json retains additive fonts/fontAudit fields.
 *   The preservation gate additionally requires pdfSha256 to match its saved candidate.
 */
async function pdfHash(pdfPath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pdfPath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function validateTaggedArtifacts({ pdfPath, manifestPath, skipFontAudit = false }) {
  if (!pdfPath || !manifestPath) {
    throw new Error("Usage: node modules/validator/index.js --pdf <tagged.pdf> --manifest <tagged.pdf.tags.json> [--skip-font-audit]");
  }

  await access(pdfPath, constants.R_OK);
  await access(manifestPath, constants.R_OK);
  const pdfSha256 = await pdfHash(pdfPath);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestFindings = buildManifestFindings(manifest);

  let fontAudit = null;
  let fontAuditFindings = [];
  let fontAuditError = null;
  if (!skipFontAudit) {
    try {
      fontAudit = await runFontAudit(pdfPath);
      fontAuditFindings = (fontAudit.findings || []).map((finding) => ({
        ...finding,
        source: "font-audit"
      }));
    } catch (error) {
      fontAuditError = error.message;
    }
  }

  // veraPDF can crash on severely malformed input (FlateFilter
  // DataFormatException, JVM OOM, missing Java, unsupported PDF feature).
  // Treat that as a per-document validator error rather than a pipeline-
  // stage abort: emit a VALIDATOR_EXECUTION_FAILED finding, retain all the
  // evidence we DID collect (manifest findings, font audit), and let the
  // job finish with a diagnostic artifact for manual review.
  let veraPdf = null;
  let veraPdfError = null;
  try {
    veraPdf = await runVeraPdf(pdfPath);
  } catch (error) {
    veraPdfError = error.message || String(error);
  }

  const rawVeraPdfFindings = veraPdf ? buildVeraPdfFindings(veraPdf) : [];
  // Gather independent diagnostics for metadata and annotation findings.
  // These explain reported failures without changing the validator result.
  const needsProbe = veraPdf && (
    hasMetadataMismatchSignals(rawVeraPdfFindings) ||
    hasLinkMismatchSignals(rawVeraPdfFindings) ||
    hasWidgetMismatchSignals(rawVeraPdfFindings)
  );
  const metadataProbe = needsProbe ? await runMetadataProbe(pdfPath) : null;
  // Diagnostics can explain a finding, but cannot turn a failed raw check into a pass.
  const veraPdfFindings = rawVeraPdfFindings;

  const executionFindings = veraPdfError
    ? [
        {
          severity: "error",
          code: "VALIDATOR_EXECUTION_FAILED",
          message: veraPdfError,
          source: "validator"
        }
      ]
    : [];

  const findings = [...manifestFindings, ...veraPdfFindings, ...fontAuditFindings, ...executionFindings,
    ...(fontAuditError ? [{ severity: "error", code: "FONT_AUDIT_EXECUTION_FAILED", source: "font-audit", description: fontAuditError }] : [])];
  const rawSummary = {
    passedRules: veraPdf?.details?.passedRules || 0,
    failedRules: veraPdf?.details?.failedRules || 0,
    passedChecks: veraPdf?.details?.passedChecks || 0,
    failedChecks: veraPdf?.details?.failedChecks || 0
  };
  const summary = { ...rawSummary };

  const fontAuditErrorCount = fontAuditFindings.filter((f) => f.severity === "error").length;
  const fontAuditWarningCount = fontAuditFindings.filter((f) => f.severity === "warning").length;
  const fontAuditBlockingPreVeraPdf = fontAuditErrorCount > 0;

  const isCompliant = !veraPdfError && !fontAuditError && veraPdf?.validationResult?.compliant === true && findings.length === 0;
  const overallStatus = veraPdfError
    ? "error"
    : !isCompliant || fontAuditBlockingPreVeraPdf
      ? "fail"
      : "pass";

  if (pdfSha256 !== await pdfHash(pdfPath)) throw new Error("PDF changed during validation; discard this report and retry against a stable candidate");
  return {
    status: "completed",
    pdfSha256,
    isCompliant,
    overall: { status: overallStatus },
    statement: veraPdfError
      ? `veraPDF could not be executed: ${veraPdfError}`
      : veraPdf.validationResult.statement,
    rawStatement: veraPdf?.validationResult?.statement ?? null,
    profileName: veraPdf?.validationResult?.profileName ?? null,
    findings,
    summary,
    rawSummary,
    rawFindings: rawVeraPdfFindings,
    metadataDiagnostics: veraPdf ? buildMetadataDiagnostics(rawVeraPdfFindings, metadataProbe) : null,
    fonts: fontAudit?.fonts || [],
    fontAudit: {
      status: skipFontAudit ? "skipped" : fontAuditError ? "failed" : "ok",
      errorCount: fontAuditErrorCount,
      warningCount: fontAuditWarningCount,
      blockingPreVeraPdf: fontAuditBlockingPreVeraPdf,
      ...(fontAuditError ? { error: fontAuditError } : {})
    },
    engine: {
      name: "veraPDF",
      version: veraPdf ? extractEngineVersion(veraPdf.buildInformation) : null,
      backend: veraPdf ? ((veraPdf.buildInformation.releaseDetails || []).some((d) => /pdfbox/i.test(d.id)) ? "pdfbox" : "greenfield") : null,
      executionError: veraPdfError
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await validateTaggedArtifacts(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.overall?.status === "fail") {
    process.exitCode = 0; // remain advisory; orchestrator decides hard-fail policy
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
