import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { collectRoleExamples } from "./role-classifier.js";

export function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

export async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function parsePathList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item || "").split(/[;,]/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashFraction(value) {
  const hash = createHash("sha256").update(String(value)).digest("hex");
  return parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function roundCoordinate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(3)) : 0;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function documentSignature({ semanticDocument = {}, layoutDocument = null } = {}) {
  const pages = Array.isArray(layoutDocument?.pages)
    ? layoutDocument.pages.map((page) => ({
        pageNumber: page.pageNumber,
        width: roundCoordinate(page.width),
        height: roundCoordinate(page.height),
        blockCount: Array.isArray(page.textBlocks) ? page.textBlocks.length : 0
      }))
    : [];
  const nodes = [...(semanticDocument.nodes || [])]
    .sort((left, right) =>
      Number(left.pageNumber || 0) - Number(right.pageNumber || 0) ||
      Number(left.readingOrder || 0) - Number(right.readingOrder || 0) ||
      roundCoordinate(left.bbox?.[1]) - roundCoordinate(right.bbox?.[1]) ||
      roundCoordinate(left.bbox?.[0]) - roundCoordinate(right.bbox?.[0]) ||
      normalizeText(left.text).localeCompare(normalizeText(right.text))
    )
    .map((node) => ({
      pageNumber: node.pageNumber,
      readingOrder: node.readingOrder ?? null,
      role: node.role,
      text: normalizeText(node.text),
      bbox: Array.isArray(node.bbox) ? node.bbox.map(roundCoordinate) : [],
      headingLevel: node.headingLevel ?? null,
      columnHint: node.columnHint ?? null,
      artifactType: node.artifactType ?? null,
      regionKind: node.regionKind ?? null
    }));

  return sha256(stableJson({
    schemaVersion: semanticDocument.schemaVersion,
    layoutPageShape: pages,
    nodes
  }));
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findSemanticArtifactPairs(rootDir) {
  const root = path.resolve(rootDir);
  const pairs = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const semanticPath = path.join(currentDir, "04-semantic-ordered.json");
    const layoutPath = path.join(currentDir, "02-layout-enriched.json");

    if (await pathExists(semanticPath)) {
      pairs.push({
        semanticPath,
        layoutPath: (await pathExists(layoutPath)) ? layoutPath : null,
        artifactDir: currentDir,
        relativeArtifactDir: path.relative(root, currentDir).replace(/\\/g, "/") || "."
      });
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name));
      }
    }
  }

  await walk(root);
  return pairs.sort((left, right) => left.relativeArtifactDir.localeCompare(right.relativeArtifactDir));
}

function createRootLabel(rootDir, index) {
  const base = path.basename(path.resolve(rootDir)) || `root-${index + 1}`;
  return `${index + 1}-${base.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

async function loadArtifactDocument(pair) {
  const semanticDocument = await readJsonFile(pair.semanticPath);
  const layoutDocument = pair.layoutPath ? await readJsonFile(pair.layoutPath) : null;
  const corpusSignature = documentSignature({ semanticDocument, layoutDocument });
  return {
    semanticDocument,
    layoutDocument,
    sourcePath: semanticDocument.source?.filePath || layoutDocument?.source?.filePath || pair.semanticPath,
    artifactRoot: pair.artifactRoot,
    artifactRootLabel: pair.artifactRootLabel,
    artifactDir: pair.artifactDir,
    semanticPath: pair.semanticPath,
    layoutPath: pair.layoutPath,
    relativeArtifactDir: pair.relativeArtifactDir,
    rootRelativeArtifactDir: pair.rootRelativeArtifactDir,
    corpusSignature,
    splitKey: corpusSignature
  };
}

export async function loadArtifactDocumentCorpus(rootDirs, { limit = null, dedupe = true } = {}) {
  const roots = parsePathList(rootDirs);
  if (roots.length === 0) {
    throw new Error("At least one artifact directory is required.");
  }

  const artifactRoots = [];
  const pairs = [];

  for (let index = 0; index < roots.length; index += 1) {
    const artifactRoot = path.resolve(roots[index]);
    const artifactRootLabel = createRootLabel(artifactRoot, index);
    const rootPairs = await findSemanticArtifactPairs(artifactRoot);
    artifactRoots.push({
      root: artifactRoot,
      label: artifactRootLabel,
      discoveredArtifactCount: rootPairs.length
    });
    pairs.push(...rootPairs.map((pair) => ({
      ...pair,
      artifactRoot,
      artifactRootLabel,
      rootRelativeArtifactDir: pair.relativeArtifactDir,
      relativeArtifactDir: roots.length > 1
        ? `${artifactRootLabel}/${pair.relativeArtifactDir}`
        : pair.relativeArtifactDir
    })));
  }

  const selectedPairs = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? pairs.slice(0, Number(limit))
    : pairs;
  const documents = [];
  const retainedBySignature = new Map();
  const duplicates = [];

  for (const pair of selectedPairs) {
    const document = await loadArtifactDocument(pair);
    const retained = retainedBySignature.get(document.corpusSignature);
    if (dedupe && retained) {
      duplicates.push({
        corpusSignature: document.corpusSignature,
        duplicateRelativeArtifactDir: document.relativeArtifactDir,
        retainedRelativeArtifactDir: retained.relativeArtifactDir
      });
      continue;
    }

    retainedBySignature.set(document.corpusSignature, document);
    documents.push(document);
  }

  return {
    documents,
    inventory: {
      artifactRoots,
      dedupeEnabled: Boolean(dedupe),
      discoveredArtifactCount: pairs.length,
      selectedArtifactCount: selectedPairs.length,
      loadedDocumentCount: documents.length,
      duplicateArtifactCount: duplicates.length,
      duplicates: duplicates.slice(0, 100)
    }
  };
}

export async function loadArtifactDocuments(rootDir, options = {}) {
  const corpus = await loadArtifactDocumentCorpus(rootDir, options);
  return corpus.documents;
}

function roleCountsForDocument(document) {
  const counts = {};
  for (const example of collectRoleExamples(document)) {
    counts[example.role] = (counts[example.role] || 0) + 1;
  }
  return counts;
}

function addRoleCounts(target, counts) {
  for (const [role, count] of Object.entries(counts || {})) {
    target[role] = (target[role] || 0) + count;
  }
  return target;
}

function scoreEvaluationCandidate({ roleCounts, corpusRoleCounts, currentEvalCounts }) {
  let score = 0;
  for (const [role, count] of Object.entries(roleCounts)) {
    const corpusCount = corpusRoleCounts[role] || 0;
    const currentCount = currentEvalCounts[role] || 0;
    const target = Math.min(3, corpusCount);
    if (currentCount < target) {
      score += Math.min(count, target - currentCount) * (1 / Math.max(corpusCount, 1));
    }
  }
  return score;
}

function buildSplitDiagnostics(train, evaluation, allDocuments) {
  const roleCountsByDocument = Object.fromEntries(
    allDocuments.map((document) => [document.relativeArtifactDir || document.semanticDocument?.documentId, roleCountsForDocument(document)])
  );
  const trainRoleCounts = train.reduce((counts, document) => addRoleCounts(counts, roleCountsForDocument(document)), {});
  const evaluationRoleCounts = evaluation.reduce((counts, document) => addRoleCounts(counts, roleCountsForDocument(document)), {});
  const corpusRoleCounts = allDocuments.reduce((counts, document) => addRoleCounts(counts, roleCountsForDocument(document)), {});

  return {
    roleCountsByDocument,
    trainRoleCounts,
    evaluationRoleCounts,
    corpusRoleCounts,
    evaluationZeroSupportRoles: Object.keys(corpusRoleCounts).filter((role) => !evaluationRoleCounts[role])
  };
}

export function splitDocuments(documents, { trainRatio = 0.8 } = {}) {
  const ratio = Math.min(0.95, Math.max(0.05, Number(trainRatio) || 0.8));
  if (documents.length <= 1) {
    return {
      train: [...documents],
      evaluation: [],
      diagnostics: buildSplitDiagnostics(documents, [], documents)
    };
  }

  const trainCount = Math.min(documents.length - 1, Math.max(1, Math.round(documents.length * ratio)));
  const evaluationCount = documents.length - trainCount;
  const scored = documents
    .map((document) => ({
      document,
      roleCounts: roleCountsForDocument(document),
      score: hashFraction(document.splitKey || document.semanticDocument?.documentId || document.semanticPath)
    }))
    .sort((left, right) => left.score - right.score);
  const corpusRoleCounts = scored.reduce((counts, entry) => addRoleCounts(counts, entry.roleCounts), {});
  const selectedEvaluation = [];
  const selected = new Set();
  const currentEvalCounts = {};

  while (selectedEvaluation.length < evaluationCount) {
    const candidate = scored
      .filter((entry) => !selected.has(entry.document))
      .map((entry) => ({
        ...entry,
        evalScore: scoreEvaluationCandidate({
          roleCounts: entry.roleCounts,
          corpusRoleCounts,
          currentEvalCounts
        })
      }))
      .sort((left, right) => right.evalScore - left.evalScore || right.score - left.score)[0];

    if (!candidate) {
      break;
    }

    selected.add(candidate.document);
    selectedEvaluation.push(candidate.document);
    addRoleCounts(currentEvalCounts, candidate.roleCounts);
  }

  const train = scored.filter((entry) => !selected.has(entry.document)).map((entry) => entry.document);
  const evaluation = selectedEvaluation.sort((left, right) =>
    String(left.relativeArtifactDir || "").localeCompare(String(right.relativeArtifactDir || ""))
  );

  return {
    train,
    evaluation,
    diagnostics: buildSplitDiagnostics(train, evaluation, documents)
  };
}
