import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRasterDataUri, renderHumanReviewPageRaster } from "./human-review-raster.js";
import { createHumanReviewProject } from "./human-review-store.js";
import { buildHumanReviewSampleSvg } from "./human-review-visuals.js";
import { parseArgs, parsePathList } from "./ml-artifacts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(__dirname, "review-ui");
const DEFAULT_PORT = 4387;
const DEFAULT_LABEL_PATH = path.resolve("output", "ml-human-review", "human-classification-reviews.jsonl");
const DEFAULT_RASTER_CACHE_DIR = path.resolve("output", "ml-human-review", "raster-cache");
const DEFAULT_MODEL_PATH = path.resolve("output", "ml-pilot", "role-baseline-large-v4-matrix.json");
const DEFAULT_MATRIX_CORPUS_DIR = path.resolve("output", "ml-fine-tuned-corpus", "v2", "pdfs");
const DEFAULT_MATRIX_MANIFEST_PATH = path.resolve("output", "ml-fine-tuned-corpus", "v2", "pdfs", "fine-tuned-testcase-manifest.json");
const DEFAULT_ML_EXPERIMENT_OUTPUT_DIR = path.resolve("output", "ml-experiments", "ml-vs-vanilla-matrix-smoke");
const JSON_BODY_LIMIT = 64 * 1024;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

function usage() {
  return [
    "Usage: node machine-learning/human-review-server.js --reports <ml-prediction-report-or-dir>[;<dir>...] [--labels <reviews.jsonl>] [--raster-cache <dir>] [--model <model.json>] [--matrix-manifest <manifest.json>] [--port <port>]",
    "",
    "Examples:",
    "  node machine-learning/human-review-server.js --reports output/ml-pilot --labels output/ml-human-review/reviews.jsonl",
    "  npm run ml:review -- --reports output/ml-pilot"
  ].join("\n");
}

async function readJsonFileIfPresent(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function inferTrainingReportPath(modelPath) {
  const resolved = path.resolve(modelPath);
  const directory = path.dirname(resolved);
  const baseName = path.basename(resolved, ".json");
  if (baseName.startsWith("role-baseline")) {
    return path.join(directory, `${baseName.replace(/^role-baseline/, "role-training-report")}.json`);
  }
  return path.join(directory, "role-classifier-training-report.json");
}

function inferModelCardPath(modelPath) {
  const resolved = path.resolve(modelPath);
  const directory = path.dirname(resolved);
  const baseName = path.basename(resolved, ".json");
  if (baseName.startsWith("role-baseline")) {
    return path.join(directory, `${baseName.replace(/^role-baseline/, "role-model-card")}.md`);
  }
  return path.join(directory, "role-classifier-model-card.md");
}

function summarizeTrainingReport({ modelPath, model, report }) {
  if (!model && !report) {
    return {
      modelPath: path.resolve(modelPath),
      available: false
    };
  }

  const metrics = report?.evaluation?.metrics || model?.evaluation?.metrics || {};
  return {
    modelPath: path.resolve(modelPath),
    reportPath: report ? inferTrainingReportPath(modelPath) : null,
    modelCardPath: inferModelCardPath(modelPath),
    available: true,
    classifierId: model?.classifierId || report?.model?.classifierId || "unknown",
    modelHash: model?.modelHash || report?.model?.modelHash || null,
    modelType: model?.modelType || report?.model?.modelType || null,
    modelVersion: model?.modelVersion || report?.model?.modelVersion || null,
    taskHead: model?.taskHead || "role-classification",
    trainingDatasetVersion: model?.trainingDatasetVersion || null,
    labelSource: model?.labelSource || "engine-projected-semantic-role",
    selectedHyperparameters: model?.selection?.selectedHyperparameters || report?.hyperparameterSweep?.selectedHyperparameters || {},
    input: report ? {
      artifactRoots: report.input?.artifactRoots || [],
      discoveredArtifactCount: report.input?.discoveredArtifactCount || 0,
      retainedDocumentCount: report.input?.documentCount || 0,
      duplicateArtifactCount: report.input?.duplicateArtifactCount || 0
    } : null,
    split: report ? {
      trainRatio: report.split?.trainRatio || null,
      trainDocuments: report.split?.trainDocuments || 0,
      evaluationDocuments: report.split?.evaluationDocuments || 0
    } : null,
    trainingSummary: report?.trainingSummary || model?.trainingSummary || null,
    metrics: {
      exampleCount: metrics.exampleCount || 0,
      accuracy: metrics.accuracy ?? null,
      macroF1: metrics.macroF1 ?? null,
      supportedMacroF1: metrics.supportedMacroF1 ?? null,
      balancedAccuracy: metrics.balancedAccuracy ?? null,
      brierScore: metrics.brierScore ?? null,
      expectedCalibrationError: metrics.expectedCalibrationError ?? null,
      majorityBaselineAccuracy: metrics.majorityBaseline?.accuracy ?? null,
      majorityBaselineRole: metrics.majorityBaseline?.role || null,
      zeroSupportRoles: metrics.zeroSupportRoles || []
    },
    releaseGateStatus: report?.releaseGateStatus || {
      mode: "research-only",
      deterministicOutputFinal: true,
      assistiveOutputAllowed: false,
      reason: "No training report was found for this model."
    }
  };
}

function summarizeMatrixManifest(manifestPath, manifest) {
  if (!manifest) {
    return {
      manifestPath: path.resolve(manifestPath),
      available: false
    };
  }

  const factors = Object.fromEntries(
    Object.entries(manifest.matrixFactors || {}).map(([name, values]) => [name, Array.isArray(values) ? values.length : 0])
  );
  return {
    manifestPath: path.resolve(manifestPath),
    available: true,
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    generator: manifest.generator || null,
    outputDir: manifest.outputDir || null,
    count: manifest.count || 0,
    archetypeCounts: manifest.archetypeCounts || {},
    factorValueCounts: factors,
    pairCoverageSummary: manifest.matrixCoverage?.pairCoverageSummary || null,
    weakestPairs: manifest.matrixCoverage?.pairCoverageSummary?.weakestPairs || []
  };
}

function buildModelDistribution(items) {
  const counts = new Map();
  for (const item of items || []) {
    const modelId = item.model?.id || "unknown-model";
    const modelHash = item.model?.modelHash || "no-hash";
    const key = `${modelId}\u0000${modelHash}`;
    const current = counts.get(key) || {
      modelId,
      modelHash,
      trainingDatasetVersion: item.model?.trainingDatasetVersion || null,
      itemCount: 0
    };
    current.itemCount += 1;
    counts.set(key, current);
  }

  return [...counts.values()].sort((left, right) => right.itemCount - left.itemCount || left.modelId.localeCompare(right.modelId));
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function writeSvg(response, statusCode, svg) {
  response.writeHead(statusCode, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(svg);
}

async function writePngFile(response, filePath, { cacheControl = "public, max-age=86400" } = {}) {
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": body.length,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > JSON_BODY_LIMIT) {
      throw createHttpError(413, "Review payload is too large.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function resolveUiAsset(urlPathname) {
  const requested = urlPathname === "/"
    ? "index.html"
    : urlPathname === "/machine-learning"
      ? "machine-learning.html"
      : decodeURIComponent(urlPathname.replace(/^\//, ""));
  const resolved = path.resolve(uiDir, requested);
  const relative = path.relative(uiDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

async function serveUiAsset(response, urlPathname) {
  const assetPath = resolveUiAsset(urlPathname);
  if (!assetPath) {
    return false;
  }

  try {
    const body = await readFile(assetPath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(assetPath).toLowerCase()) || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; object-src 'none'"
    });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

export async function createHumanReviewServer({
  reports,
  labelPath = DEFAULT_LABEL_PATH,
  rasterCacheDir = DEFAULT_RASTER_CACHE_DIR,
  modelPath = DEFAULT_MODEL_PATH,
  matrixManifestPath = DEFAULT_MATRIX_MANIFEST_PATH
} = {}) {
  if (!reports) {
    throw new Error("reports is required.");
  }

  const project = await createHumanReviewProject({ reports, labelPath });
  const resolvedModelPath = path.resolve(modelPath);
  const resolvedMatrixManifestPath = path.resolve(matrixManifestPath);
  const [model, trainingReport, matrixManifest] = await Promise.all([
    readJsonFileIfPresent(resolvedModelPath),
    readJsonFileIfPresent(inferTrainingReportPath(resolvedModelPath)),
    readJsonFileIfPresent(resolvedMatrixManifestPath)
  ]);
  const modelSummary = summarizeTrainingReport({ modelPath: resolvedModelPath, model, report: trainingReport });
  const matrixSummary = summarizeMatrixManifest(resolvedMatrixManifestPath, matrixManifest);
  const modelDistribution = buildModelDistribution(project.items);
  const config = {
    schemaVersion: "0.2.0",
    generatedAt: new Date().toISOString(),
    routes: {
      review: "/",
      configuration: "/machine-learning",
      summary: "/api/summary",
      items: "/api/items",
      export: "/api/export"
    },
    model: {
      defaultPath: resolvedModelPath,
      mode: "shadow",
      outputFinality: "deterministic-output-remains-final",
      training: modelSummary
    },
    review: {
      reportRoots: parsePathList(reports).map((entry) => path.resolve(entry)),
      labelPath: path.resolve(labelPath),
      rasterCacheDir: path.resolve(rasterCacheDir),
      decisions: ["yes", "no", "review"],
      notesForAgents: true,
      modelDistribution
    },
    preview: {
      renderer: "PDFBox",
      rasterDpi: 144,
      sampleEndpoint: "/api/items/{itemKey}/sample.svg",
      pageRasterEndpoint: "/api/items/{itemKey}/page.png",
      zoomRange: "60%-500%"
    },
    experiment: {
      defaultPreset: "matrix-smoke",
      defaultInputDir: DEFAULT_MATRIX_CORPUS_DIR,
      defaultOutputDir: DEFAULT_ML_EXPERIMENT_OUTPUT_DIR,
      defaultModelPath: resolvedModelPath,
      defaultLimit: 6,
      comparisonArms: [
        {
          label: "ML-enhanced",
          mlClassifierEnabled: true,
          mode: "shadow",
          outputSubdir: "with-ml"
        },
        {
          label: "vanilla-noML",
          mlClassifierEnabled: false,
          mode: "deterministic",
          outputSubdir: "without-ml"
        }
      ],
      reportFiles: [
        "ml-toggle-comparison-summary.json",
        "ml-toggle-comparison-report.html"
      ]
    },
    methodology: {
      operatingMode: "research-only-shadow-mode",
      deterministicOutputFinal: true,
      trainingSignal: {
        currentLabelSource: modelSummary.labelSource,
        humanGate: "Human review labels are append-only and are required before any classifier can be trusted beyond shadow evidence."
      },
      corpusMatrix: matrixSummary,
      pipeline: [
        "Generate deterministic, manifest-backed PDF cases with explicit structure intent.",
        "Run selected PDFs through the normal OpenAutoTag pipeline to create layout and semantic artifacts.",
        "Train the role classifier from deduped artifacts using deterministic document-level splitting and grid search.",
        "Emit shadow-mode prediction reports for human review while preserving deterministic engine output."
      ]
    }
  };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, {
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff"
        });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/summary") {
        writeJson(response, 200, project.summary());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        writeJson(response, 200, {
          ...config,
          summary: project.summary()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/items") {
        writeJson(response, 200, project.listItems({
          status: url.searchParams.get("status") || "unreviewed",
          limit: url.searchParams.get("limit") || 50,
          offset: url.searchParams.get("offset") || 0
        }));
        return;
      }

      const sampleMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/sample\.svg$/);
      if (request.method === "GET" && sampleMatch) {
        const item = project.getItem(decodeURIComponent(sampleMatch[1]));
        if (!item) {
          writeJson(response, 404, { error: "Review item not found." });
          return;
        }

        let rasterDataUri = null;
        let rasterSource = null;
        try {
          const rendered = await readRasterDataUri(item, { cacheDir: rasterCacheDir });
          rasterDataUri = rendered.dataUri;
          rasterSource = `PDFBox raster ${rendered.raster.dpi} DPI`;
        } catch {
          rasterDataUri = null;
          rasterSource = null;
        }

        writeSvg(response, 200, await buildHumanReviewSampleSvg(item, { rasterDataUri, rasterSource }));
        return;
      }

      const pagePngMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/page\.png$/);
      if (request.method === "GET" && pagePngMatch) {
        const item = project.getItem(decodeURIComponent(pagePngMatch[1]));
        if (!item) {
          writeJson(response, 404, { error: "Review item not found." });
          return;
        }

        const raster = await renderHumanReviewPageRaster(item, { cacheDir: rasterCacheDir });
        await writePngFile(response, raster.imagePath);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reviews") {
        const payload = await readJsonBody(request);
        const record = await project.recordReview({
          itemKey: payload.itemKey,
          decision: payload.decision,
          notes: payload.notes || "",
          reviewer: payload.reviewer || "human"
        });
        writeJson(response, 201, {
          record,
          summary: project.summary()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/export") {
        writeJson(response, 200, project.exportRecords());
        return;
      }

      if (request.method === "GET" && (await serveUiAsset(response, url.pathname))) {
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      writeJson(response, Number.isInteger(error.statusCode) ? error.statusCode : 500, { error: error.message });
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reports = args.get("--reports");
  const labelPath = args.get("--labels") || DEFAULT_LABEL_PATH;
  const rasterCacheDir = args.get("--raster-cache") || DEFAULT_RASTER_CACHE_DIR;
  const modelPath = args.get("--model") || DEFAULT_MODEL_PATH;
  const matrixManifestPath = args.get("--matrix-manifest") || DEFAULT_MATRIX_MANIFEST_PATH;
  const port = Number(args.get("--port") || DEFAULT_PORT);

  if (!reports) {
    throw new Error(usage());
  }

  const server = await createHumanReviewServer({ reports, labelPath, rasterCacheDir, modelPath, matrixManifestPath });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  process.stdout.write(`ML human review tool listening at http://127.0.0.1:${address.port}\n`);
  process.stdout.write(`Labels: ${path.resolve(labelPath)}\n`);
  process.stdout.write(`Raster cache: ${path.resolve(rasterCacheDir)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
