import Ajv2020 from "ajv/dist/2020.js";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile, access as fsAccess } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };
import redactionPlanSchema from "../../contracts/redaction-plan.schema.json" with { type: "json" };
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../scripts/runtime-paths.js";

const ajv = new Ajv2020({ allErrors: true });
const validateTagging = ajv.compile(taggingSchema);
const validateSemantic = ajv.compile(semanticSchema);
const validateRedactionPlan = ajv.compile(redactionPlanSchema);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot });
const javaSourcePath = path.join(moduleDir, "java", "PdfTagWriterCli.java");
const javaClassPath = path.join(buildDir, "PdfTagWriterCli.class");
const pdfboxJarPath = path.join(moduleDir, "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");

const nativeJavaDir = path.join(moduleDir, "java");
const nativeParserSource = path.join(nativeJavaDir, "NativeContentStreamParser.java");
const nativeMatcherSource = path.join(nativeJavaDir, "NativeTagMatcher.java");
const nativeRewriterSource = path.join(nativeJavaDir, "NativeContentStreamRewriter.java");

const VALID_MODES = new Set(["native", "raster", "auto"]);
const DEFAULT_MODE = "raster";
const DEFAULT_NATIVE_MATCH_THRESHOLD = 0.8;

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  const rawMode = args.get("--mode") || DEFAULT_MODE;
  const mode = VALID_MODES.has(rawMode) ? rawMode : DEFAULT_MODE;
  return {
    pdfPath: args.get("--pdf"),
    tagsPath: args.get("--tags"),
    semanticPath: args.get("--semantic"),
    redactionsPath: args.get("--redactions"),
    outputPath: args.get("--output"),
    mode,
    nativeMatchThreshold: args.has("--native-match-threshold")
      ? Number(args.get("--native-match-threshold"))
      : DEFAULT_NATIVE_MATCH_THRESHOLD
  };
}

export { parseArgs, VALID_MODES, DEFAULT_MODE, DEFAULT_NATIVE_MATCH_THRESHOLD };

function execCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function needsCompilation() {
  try {
    const [sourceStats, classStats] = await Promise.all([stat(javaSourcePath), stat(javaClassPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
  } catch {
    return true;
  }
}

function collectNativeJavaSources() {
  const sources = [];
  if (existsSync(nativeParserSource)) {
    sources.push(nativeParserSource);
  }
  if (existsSync(nativeMatcherSource)) {
    sources.push(nativeMatcherSource);
  }
  if (existsSync(nativeRewriterSource)) {
    sources.push(nativeRewriterSource);
  }
  return sources;
}

async function ensureJavaHelperCompiled() {
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => !(await needsCompilation()),
    compile: async () => {
      const javacCommand = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      const nativeSources = collectNativeJavaSources();
      await execCommand(
        javacCommand,
        [
          "-encoding",
          "UTF-8",
          "-cp",
          pdfboxJarPath,
          "-d",
          buildDir,
          javaSourcePath,
          ...nativeSources
        ],
        {
          env: await buildJavaExecEnv({ bundledJavaHome })
        }
      );
    }
  });
}

function countTagNodes(node) {
  return 1 + node.children.reduce((total, child) => total + countTagNodes(child), 0);
}

function flattenTagTree(node, semanticById, records, parentId = "") {
  const sourceNodes = (node.sourceNodeIds || []).map((id) => semanticById.get(id)).filter(Boolean);
  const firstSourceNode = sourceNodes[0];
  const text = sourceNodes.length > 0 ? sourceNodes.map((item) => item.text).join(" ").trim() : node.label || "";
  const bbox = firstSourceNode?.bbox || [];
  const rowSpan = node.rowSpan || firstSourceNode?.tableRowSpan || "";
  const columnSpan = node.columnSpan || firstSourceNode?.tableColumnSpan || "";
  const tableRowIndex = firstSourceNode?.tableRowIndex ?? "";
  const tableColumnIndex = firstSourceNode?.tableColumnIndex ?? "";
  const tableSection = node.tableSection || firstSourceNode?.tableSection || "";
  const scope = inferTableScope(node, firstSourceNode, rowSpan, columnSpan);

  records.push({
    id: node.id,
    parentId,
    type: node.type,
    pageNumber: firstSourceNode?.pageNumber ?? "",
    bbox,
    rowSpan,
    columnSpan,
    tableRowIndex,
    tableColumnIndex,
    tableSection,
    scope,
    text
  });

  for (const child of node.children) {
    flattenTagTree(child, semanticById, records, node.id);
  }
}

function encodeField(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function inferTableScope(node, sourceNode, rowSpan, columnSpan) {
  const type = node.type || sourceNode?.role || "";
  if (type !== "TH") {
    return "";
  }

  if (Number(columnSpan || 1) > 1 && Number(rowSpan || 1) > 1) {
    return "Both";
  }

  if ((node.tableSection || sourceNode?.tableSection) === "head" || sourceNode?.tableRowIndex === 0) {
    return "Column";
  }

  if (sourceNode?.tableColumnIndex === 0) {
    return "Row";
  }

  return "";
}

function findFirstHeadingNode(node) {
  if (/^H\d$/.test(node.type) && node.label) {
    return node.label;
  }

  for (const child of node.children || []) {
    const heading = findFirstHeadingNode(child);
    if (heading) {
      return heading;
    }
  }

  return "";
}

function deriveTitle(taggingDocument, semanticDocument, pdfPath) {
  const headingFromSemantic = semanticDocument?.nodes?.find((node) => /^H\d$/.test(node.role) && node.text.trim())?.text;
  const headingFromTags = findFirstHeadingNode(taggingDocument.root);
  return headingFromSemantic || headingFromTags || path.basename(pdfPath, path.extname(pdfPath));
}

function normalizeDocumentLanguageTag(value, fallback = "en-US") {
  const normalized = String(value || "").trim().replace(/_/g, "-").toLowerCase();

  if (normalized === "es" || normalized === "es-es") {
    return "es-ES";
  }

  if (normalized === "en" || normalized === "en-us") {
    return "en-US";
  }

  if (/^[a-z]{2}-[a-z]{2}$/u.test(normalized)) {
    const [language, region] = normalized.split("-");
    return `${language.toLowerCase()}-${region.toUpperCase()}`;
  }

  return fallback;
}

function deriveDocumentLanguage(semanticDocument) {
  return normalizeDocumentLanguageTag(semanticDocument?.source?.language, "en-US");
}

async function buildInstructionFile({ outputPath, taggingDocument, semanticDocument }) {
  const semanticById = new Map((semanticDocument?.nodes || []).map((node) => [node.id, node]));
  const records = [];
  flattenTagTree(taggingDocument.root, semanticById, records);

  const instructionPath = `${outputPath}.instructions.tsv`;
  const lines = records.map((record) => {
    const [x = "", y = "", width = "", height = ""] = record.bbox;
    return [
      record.id,
      record.parentId,
      record.type,
      record.pageNumber,
      x,
      y,
      width,
      height,
      record.rowSpan,
      record.columnSpan,
      record.tableRowIndex,
      record.tableColumnIndex,
      record.tableSection,
      record.scope,
      encodeField(record.text)
    ].join("\t");
  });

  await writeFile(instructionPath, `${lines.join("\n")}\n`);
  return {
    instructionPath,
    records
  };
}

async function buildRedactionInstructionFile({ outputPath, redactionsPath }) {
  const redactionPlan = JSON.parse(await readFile(redactionsPath, "utf8"));
  if (!validateRedactionPlan(redactionPlan)) {
    throw new Error(`PDF writer redaction input failed schema validation: ${ajv.errorsText(validateRedactionPlan.errors)}`);
  }

  const instructionPath = `${outputPath}.redactions.tsv`;
  const lines = (redactionPlan.matches || []).map((match) => {
    const [x = "", y = "", width = "", height = ""] = match.bbox || [];
    return [match.pageNumber, x, y, width, height].join("\t");
  });

  await writeFile(instructionPath, `${lines.join("\n")}\n`);

  return {
    instructionPath,
    redactionPlan
  };
}

async function writeSidecarFallback({ pdfPath, taggingDocument, outputPath, manifestPath }) {
  await copyFile(pdfPath, outputPath);
  const manifest = {
    schemaVersion: "1.0.0",
    writerMode: "sidecar-manifest",
    nativeTaggingApplied: false,
    sourcePdf: path.resolve(pdfPath),
    outputPdf: path.resolve(outputPath),
    tagging: taggingDocument
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    status: "completed",
    outputPath: path.resolve(outputPath),
    manifestPath: path.resolve(manifestPath),
    nativeTaggingApplied: false,
    language: "en-US",
    tagNodeCount: countTagNodes(taggingDocument.root),
    structureElementCount: 0,
    markedContentCount: 0
  };
}

async function runJavaWriter({ pdfPath, outputPath, instructionPath, redactionInstructionPath, title, language }) {
  await ensureJavaHelperCompiled();
  const args = [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "PdfTagWriterCli",
    "--pdf",
    pdfPath,
    "--instructions",
    instructionPath,
    "--output",
    outputPath,
    "--title",
    title,
    "--language",
    language
  ];

  if (redactionInstructionPath) {
    args.push("--redactions", redactionInstructionPath);
  }

  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const stdout = await execCommand(javaCommand, args, {
    env: await buildJavaExecEnv({ bundledJavaHome })
  });

  return JSON.parse(stdout);
}

async function runNativeParser({ pdfPath, operatorsPath }) {
  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const stdout = await execCommand(
    javaCommand,
    [
      "-cp",
      `${buildDir}${path.delimiter}${pdfboxJarPath}`,
      "NativeContentStreamParser",
      "--pdf",
      pdfPath,
      "--output",
      operatorsPath
    ],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );
  return stdout;
}

async function runNativeMatcher({ operatorsPath, semanticPath, tagsPath, tagPlanPath }) {
  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const stdout = await execCommand(
    javaCommand,
    [
      "-cp",
      `${buildDir}${path.delimiter}${pdfboxJarPath}`,
      "NativeTagMatcher",
      "--operators",
      operatorsPath,
      "--semantic",
      semanticPath,
      "--tags",
      tagsPath,
      "--output",
      tagPlanPath
    ],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );
  return stdout;
}

async function runNativeRewriter({ pdfPath, tagPlanPath, outputPath }) {
  const javaCommand = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const stdout = await execCommand(
    javaCommand,
    [
      "-cp",
      `${buildDir}${path.delimiter}${pdfboxJarPath}`,
      "NativeContentStreamRewriter",
      "--pdf",
      pdfPath,
      "--tag-plan",
      tagPlanPath,
      "--output",
      outputPath
    ],
    { env: await buildJavaExecEnv({ bundledJavaHome }) }
  );
  return stdout;
}

function isNativeRewriterAvailable() {
  return existsSync(nativeRewriterSource);
}

async function runNativeFlow({ pdfPath, tagsPath, semanticPath, outputPath }) {
  await ensureJavaHelperCompiled();

  const tempBase = `${outputPath}.native`;
  const operatorsPath = `${tempBase}-operators.json`;
  const tagPlanPath = `${tempBase}-tag-plan.json`;

  await runNativeParser({ pdfPath: path.resolve(pdfPath), operatorsPath });
  await runNativeMatcher({
    operatorsPath,
    semanticPath: path.resolve(semanticPath),
    tagsPath: path.resolve(tagsPath),
    tagPlanPath
  });

  const tagPlan = JSON.parse(await readFile(tagPlanPath, "utf8"));

  const rewriterStdout = await runNativeRewriter({
    pdfPath: path.resolve(pdfPath),
    tagPlanPath,
    outputPath: path.resolve(outputPath)
  });

  let rewriterReport;
  try {
    rewriterReport = JSON.parse(rewriterStdout);
  } catch {
    rewriterReport = {};
  }

  const overall = tagPlan.overall || {};
  const operatorCount = overall.operatorCount || 0;
  const matchedOperators = overall.matchedOperators || 0;
  const matchRate = operatorCount > 0 ? matchedOperators / operatorCount : 0;

  return {
    writerMode: "native",
    operatorCount,
    matchedOperators,
    matchRate: Math.round(matchRate * 1000) / 1000,
    nativeViable: true,
    pagesNative: rewriterReport.pagesNative || overall.pageCount || 0,
    pagesRaster: 0,
    structureElementCount: rewriterReport.structureElementCount || 0,
    markedContentCount: rewriterReport.markedContentCount || 0,
    tagPlan
  };
}

async function resolveWriterMode({ mode, nativeMatchThreshold, pdfPath, tagsPath, semanticPath, outputPath }) {
  if (mode === "raster") {
    return { effectiveMode: "raster" };
  }

  if (mode === "native") {
    if (!isNativeRewriterAvailable()) {
      throw new Error("Native mode requested but NativeContentStreamRewriter.java is not available.");
    }
    return { effectiveMode: "native" };
  }

  // auto mode: probe match rate, decide
  if (!isNativeRewriterAvailable()) {
    return { effectiveMode: "raster", autoFallbackReason: "NativeContentStreamRewriter.java not available" };
  }

  await ensureJavaHelperCompiled();

  const tempBase = `${outputPath}.auto-probe`;
  const operatorsPath = `${tempBase}-operators.json`;
  const tagPlanPath = `${tempBase}-tag-plan.json`;

  try {
    await runNativeParser({ pdfPath: path.resolve(pdfPath), operatorsPath });
    await runNativeMatcher({
      operatorsPath,
      semanticPath: path.resolve(semanticPath),
      tagsPath: path.resolve(tagsPath),
      tagPlanPath
    });

    const tagPlan = JSON.parse(await readFile(tagPlanPath, "utf8"));
    const overall = tagPlan.overall || {};
    const operatorCount = overall.operatorCount || 0;
    const matchedOperators = overall.matchedOperators || 0;
    const meanMatchRate = operatorCount > 0 ? matchedOperators / operatorCount : 0;

    if (meanMatchRate >= nativeMatchThreshold) {
      return { effectiveMode: "native", probeMatchRate: meanMatchRate, probePlan: tagPlan };
    }
    return {
      effectiveMode: "raster",
      autoFallbackReason: `Match rate ${meanMatchRate.toFixed(3)} below threshold ${nativeMatchThreshold}`,
      probeMatchRate: meanMatchRate
    };
  } catch (error) {
    return {
      effectiveMode: "raster",
      autoFallbackReason: `Native probe failed: ${error.message}`
    };
  }
}

export async function writeTaggedArtifacts({ pdfPath, tagsPath, semanticPath, redactionsPath, outputPath, mode = DEFAULT_MODE, nativeMatchThreshold = DEFAULT_NATIVE_MATCH_THRESHOLD }) {
  if (!pdfPath || !tagsPath || !outputPath) {
    throw new Error(
      "Usage: node modules/pdf-writer/index.js --pdf <input.pdf> --tags <tagging.json> [--semantic <semantic.ordered.json>] [--redactions <redaction-plan.json>] --output <tagged.pdf>"
    );
  }

  const taggingDocument = JSON.parse(await readFile(tagsPath, "utf8"));
  if (!validateTagging(taggingDocument)) {
    throw new Error(`PDF writer input failed schema validation: ${ajv.errorsText(validateTagging.errors)}`);
  }

  const semanticDocument = semanticPath ? JSON.parse(await readFile(semanticPath, "utf8")) : null;
  if (semanticDocument && !validateSemantic(semanticDocument)) {
    throw new Error(`PDF writer semantic input failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const manifestPath = `${outputPath}.tags.json`;
  const hasSemanticContext = semanticDocument && semanticDocument.nodes.length > 0;

  if (!hasSemanticContext) {
    return writeSidecarFallback({ pdfPath, taggingDocument, outputPath, manifestPath });
  }

  const title = deriveTitle(taggingDocument, semanticDocument, pdfPath);
  const language = deriveDocumentLanguage(semanticDocument);

  // --- Mode resolution ---
  const modeDecision = await resolveWriterMode({
    mode,
    nativeMatchThreshold,
    pdfPath,
    tagsPath,
    semanticPath,
    outputPath
  });

  // --- Native flow ---
  if (modeDecision.effectiveMode === "native") {
    const nativeReport = await runNativeFlow({ pdfPath, tagsPath, semanticPath, outputPath });

    const manifest = {
      schemaVersion: "1.0.0",
      writerMode: "native",
      nativeTaggingApplied: true,
      sourcePdf: path.resolve(pdfPath),
      outputPdf: path.resolve(outputPath),
      tagging: taggingDocument,
      semanticSource: path.resolve(semanticPath),
      summary: {
        writerMode: "native",
        operatorCount: nativeReport.operatorCount,
        matchedOperators: nativeReport.matchedOperators,
        matchRate: nativeReport.matchRate,
        nativeViable: nativeReport.nativeViable,
        pagesNative: nativeReport.pagesNative,
        pagesRaster: nativeReport.pagesRaster,
        structureElementCount: nativeReport.structureElementCount,
        markedContentCount: nativeReport.markedContentCount,
        language,
        autoFallbackReason: modeDecision.autoFallbackReason || null,
        requestedMode: mode
      }
    };

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    return {
      status: "completed",
      writerMode: "native",
      outputPath: path.resolve(outputPath),
      manifestPath: path.resolve(manifestPath),
      nativeTaggingApplied: true,
      language,
      tagNodeCount: countTagNodes(taggingDocument.root),
      operatorCount: nativeReport.operatorCount,
      matchedOperators: nativeReport.matchedOperators,
      matchRate: nativeReport.matchRate,
      nativeViable: nativeReport.nativeViable,
      pagesNative: nativeReport.pagesNative,
      pagesRaster: nativeReport.pagesRaster,
      structureElementCount: nativeReport.structureElementCount,
      markedContentCount: nativeReport.markedContentCount,
      title,
      requestedMode: mode
    };
  }

  // --- Raster flow (default / fallback) ---
  const { instructionPath, records } = await buildInstructionFile({ outputPath, taggingDocument, semanticDocument });
  const redactions = redactionsPath
    ? await buildRedactionInstructionFile({ outputPath, redactionsPath })
    : null;
  const javaReport = await runJavaWriter({
    pdfPath: path.resolve(pdfPath),
    outputPath: path.resolve(outputPath),
    instructionPath: path.resolve(instructionPath),
    redactionInstructionPath: redactions?.instructionPath ? path.resolve(redactions.instructionPath) : null,
    title,
    language
  });

  const manifest = {
    schemaVersion: "1.0.0",
    writerMode: "pdfbox-native-structure",
    nativeTaggingApplied: javaReport.nativeTaggingApplied,
    markedContentOverlayApplied: javaReport.markedContentCount > 0,
    sourcePdf: path.resolve(pdfPath),
    outputPdf: path.resolve(outputPath),
    instructionPath: path.resolve(instructionPath),
    tagging: taggingDocument,
    semanticSource: path.resolve(semanticPath),
    summary: {
      writerMode: "raster",
      instructionRecordCount: records.length,
      structureElementCount: javaReport.structureElementCount,
      markedContentCount: javaReport.markedContentCount,
      metadataApplied: javaReport.metadataApplied,
      tableAttributeCount: javaReport.tableAttributeCount || 0,
      redactionCount: javaReport.redactionCount || 0,
      accessibilityTreeRedacted: Boolean(redactions?.redactionPlan?.matches?.length),
      language,
      autoFallbackReason: modeDecision.autoFallbackReason || null,
      requestedMode: mode
    }
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    status: "completed",
    writerMode: "raster",
    outputPath: path.resolve(outputPath),
    manifestPath: path.resolve(manifestPath),
    nativeTaggingApplied: javaReport.nativeTaggingApplied,
    language,
    tagNodeCount: countTagNodes(taggingDocument.root),
    structureElementCount: javaReport.structureElementCount,
    markedContentCount: javaReport.markedContentCount,
    tableAttributeCount: javaReport.tableAttributeCount || 0,
    redactionCount: javaReport.redactionCount || 0,
    metadataApplied: javaReport.metadataApplied,
    title,
    requestedMode: mode,
    autoFallbackReason: modeDecision.autoFallbackReason || null
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await writeTaggedArtifacts(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
