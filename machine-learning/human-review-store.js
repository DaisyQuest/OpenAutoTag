import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parsePathList } from "./ml-artifacts.js";

export const HUMAN_REVIEW_DECISIONS = Object.freeze(["yes", "no", "review"]);

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

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeNote(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, 4000);
}

function normalizeDecision(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!HUMAN_REVIEW_DECISIONS.includes(normalized)) {
    throw new Error(`decision must be one of: ${HUMAN_REVIEW_DECISIONS.join(", ")}`);
  }
  return normalized;
}

async function pathStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function looksLikePredictionReport(filePath) {
  const baseName = path.basename(filePath).toLowerCase();
  return (
    baseName.endsWith(".json") &&
    (/ml.*predictions/.test(baseName) || /predictions.*ml/.test(baseName) || baseName === "04b-ml-predictions.json")
  );
}

async function walkPredictionReports(rootPath, files) {
  const currentStat = await pathStat(rootPath);
  if (!currentStat) {
    return;
  }

  if (currentStat.isFile()) {
    if (looksLikePredictionReport(rootPath)) {
      files.push(path.resolve(rootPath));
    }
    return;
  }

  if (!currentStat.isDirectory()) {
    return;
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkPredictionReports(childPath, files);
    } else if (entry.isFile() && looksLikePredictionReport(childPath)) {
      files.push(path.resolve(childPath));
    }
  }
}

export async function findPredictionReportFiles(inputs) {
  const roots = parsePathList(inputs);
  const files = [];

  for (const root of roots) {
    const resolved = path.resolve(root);
    const currentStat = await pathStat(resolved);
    if (currentStat?.isFile() && path.extname(resolved).toLowerCase() === ".json") {
      files.push(resolved);
      continue;
    }

    await walkPredictionReports(resolved, files);
  }

  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

async function readJsonIfPresent(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function buildSemanticNodeIndex(semanticDocument) {
  const nodes = Array.isArray(semanticDocument?.nodes) ? semanticDocument.nodes : [];
  const byId = new Map();
  const bySourceBlockId = new Map();

  for (const node of nodes) {
    if (node?.id) {
      byId.set(node.id, node);
    }
    if (node?.sourceBlockId) {
      bySourceBlockId.set(node.sourceBlockId, node);
    }
  }

  return { byId, bySourceBlockId };
}

function buildItemKey({ report, prediction, semanticNode }) {
  return sha256(stableJson({
    documentId: report.documentId,
    sourcePdf: report.source?.filePath || null,
    modelHash: report.model?.modelHash || report.model?.id || null,
    taskHead: prediction.taskHead || "role-classification",
    predictionId: prediction.id || null,
    sourceNodeId: prediction.target?.sourceNodeId || semanticNode?.id || null,
    sourceBlockId: prediction.target?.sourceBlockId || semanticNode?.sourceBlockId || null,
    predictedLabel: prediction.prediction?.label || prediction.finalDecision || null
  }));
}

function buildReviewItem({ report, reportPath, prediction, semanticNode }) {
  const itemKey = buildItemKey({ report, prediction, semanticNode });
  const alternatives = Array.isArray(prediction.prediction?.alternatives)
    ? prediction.prediction.alternatives.slice(0, 8)
    : [];

  return {
    itemKey,
    reportPath,
    documentId: report.documentId || "unknown-document",
    sourcePdf: report.source?.filePath || null,
    semanticPath: report.source?.semanticPath || null,
    model: {
      id: report.model?.id || "unknown-model",
      modelHash: report.model?.modelHash || null,
      trainingDatasetVersion: report.model?.trainingDatasetVersion || null
    },
    taskHead: prediction.taskHead || "role-classification",
    predictionId: prediction.id || itemKey,
    target: {
      sourceNodeId: prediction.target?.sourceNodeId || semanticNode?.id || null,
      sourceBlockId: prediction.target?.sourceBlockId || semanticNode?.sourceBlockId || null,
      pageNumber: prediction.target?.pageNumber || semanticNode?.pageNumber || null,
      bbox: prediction.target?.bbox || semanticNode?.bbox || null
    },
    text: normalizeWhitespace(semanticNode?.text || prediction.evidence?.text || ""),
    deterministicDecision: prediction.deterministicDecision || semanticNode?.role || null,
    predictedLabel: prediction.prediction?.label || null,
    finalDecision: prediction.finalDecision || null,
    confidence: Number.isFinite(Number(prediction.confidence)) ? Number(prediction.confidence) : null,
    calibratedConfidence: Number.isFinite(Number(prediction.calibratedConfidence))
      ? Number(prediction.calibratedConfidence)
      : null,
    abstention: prediction.abstention || null,
    fallbackReason: prediction.fallbackReason || null,
    wouldChangeOutput: Boolean(prediction.shadowDecision?.wouldChangeOutput),
    alternatives,
    featureSummary: prediction.evidence?.featureSummary || null
  };
}

async function loadPredictionReportItems(reportPath) {
  const report = await readJsonIfPresent(reportPath);
  if (!report || !Array.isArray(report.predictions)) {
    return [];
  }

  const semanticDocument = await readJsonIfPresent(report.source?.semanticPath);
  const nodeIndex = buildSemanticNodeIndex(semanticDocument);

  return report.predictions.map((prediction) => {
    const semanticNode =
      nodeIndex.byId.get(prediction.target?.sourceNodeId) ||
      nodeIndex.bySourceBlockId.get(prediction.target?.sourceBlockId) ||
      null;
    return buildReviewItem({ report, reportPath, prediction, semanticNode });
  });
}

export async function loadHumanReviewItems(inputs) {
  const reportFiles = await findPredictionReportFiles(inputs);
  const items = [];

  for (const reportPath of reportFiles) {
    items.push(...(await loadPredictionReportItems(reportPath)));
  }

  const seen = new Set();
  return items
    .filter((item) => {
      if (seen.has(item.itemKey)) {
        return false;
      }
      seen.add(item.itemKey);
      return true;
    })
    .sort((left, right) =>
      String(left.documentId).localeCompare(String(right.documentId)) ||
      Number(left.target.pageNumber || 0) - Number(right.target.pageNumber || 0) ||
      String(left.predictionId).localeCompare(String(right.predictionId))
    );
}

export async function loadReviewRecords(labelPath) {
  const records = [];
  if (!labelPath) {
    return records;
  }

  let contents = "";
  try {
    contents = await readFile(labelPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return records;
    }
    throw error;
  }

  for (const line of contents.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    records.push(JSON.parse(trimmed));
  }

  return records;
}

function buildLatestReviewMap(records) {
  const latest = new Map();
  for (const record of records) {
    if (record?.itemKey) {
      latest.set(record.itemKey, record);
    }
  }
  return latest;
}

export function summarizeReviews(items, latestReviews) {
  const summary = {
    totalItems: items.length,
    reviewedItems: 0,
    unreviewedItems: 0,
    decisions: {
      yes: 0,
      no: 0,
      review: 0
    },
    notesForAgents: 0
  };

  for (const item of items) {
    const review = latestReviews.get(item.itemKey);
    if (!review) {
      summary.unreviewedItems += 1;
      continue;
    }

    summary.reviewedItems += 1;
    if (summary.decisions[review.decision] != null) {
      summary.decisions[review.decision] += 1;
    }
    if (review.notesForAgents) {
      summary.notesForAgents += 1;
    }
  }

  return summary;
}

function matchesFilter(item, review, status) {
  if (status === "all") {
    return true;
  }

  if (status === "unreviewed") {
    return !review;
  }

  if (status === "reviewed") {
    return Boolean(review);
  }

  return review?.decision === status;
}

export async function createHumanReviewProject({ reports, labelPath }) {
  const resolvedLabelPath = path.resolve(labelPath || path.join("output", "ml-human-review", "human-classification-reviews.jsonl"));
  const items = await loadHumanReviewItems(reports);
  const records = await loadReviewRecords(resolvedLabelPath);
  const latestReviews = buildLatestReviewMap(records);
  const itemByKey = new Map(items.map((item) => [item.itemKey, item]));

  async function recordReview({ itemKey, decision, notes = "", reviewer = "human" }) {
    const item = itemByKey.get(itemKey);
    if (!item) {
      throw new Error("Unknown review item.");
    }

    const normalizedDecision = normalizeDecision(decision);
    const notesForAgents = sanitizeNote(notes);
    const reviewedAt = new Date().toISOString();
    const record = {
      schemaVersion: "0.1.0",
      recordId: sha256(stableJson({
        itemKey,
        decision: normalizedDecision,
        notesForAgents,
        reviewedAt
      })),
      itemKey,
      reviewedAt,
      reviewer: normalizeWhitespace(reviewer || "human") || "human",
      decision: normalizedDecision,
      acceptedLabel: normalizedDecision === "yes" ? item.predictedLabel : null,
      rejectedLabel: normalizedDecision === "no" ? item.predictedLabel : null,
      notesForAgents,
      source: {
        reportPath: item.reportPath,
        documentId: item.documentId,
        sourcePdf: item.sourcePdf,
        semanticPath: item.semanticPath,
        predictionId: item.predictionId,
        sourceNodeId: item.target.sourceNodeId,
        sourceBlockId: item.target.sourceBlockId
      },
      model: item.model,
      classifierEvidence: {
        taskHead: item.taskHead,
        predictedLabel: item.predictedLabel,
        deterministicDecision: item.deterministicDecision,
        confidence: item.confidence,
        alternatives: item.alternatives
      },
      humanLabelPolicy: {
        yes: "accept predictedLabel as a human-confirmed training label",
        no: "reject predictedLabel and route the item for correction",
        review: "defer to a human or agent review pass before using for training"
      }
    };

    await mkdir(path.dirname(resolvedLabelPath), { recursive: true });
    await appendFile(resolvedLabelPath, `${JSON.stringify(record)}\n`, "utf8");
    records.push(record);
    latestReviews.set(itemKey, record);
    return record;
  }

  function listItems({ status = "unreviewed", limit = 50, offset = 0 } = {}) {
    const normalizedStatus = String(status || "unreviewed").trim().toLowerCase();
    const resolvedLimit = Math.min(500, Math.max(1, Number(limit) || 50));
    const resolvedOffset = Math.max(0, Number(offset) || 0);
    const filtered = items.filter((item) => matchesFilter(item, latestReviews.get(item.itemKey), normalizedStatus));

    return {
      status: normalizedStatus,
      total: filtered.length,
      offset: resolvedOffset,
      limit: resolvedLimit,
      items: filtered.slice(resolvedOffset, resolvedOffset + resolvedLimit).map((item) => ({
        ...item,
        review: latestReviews.get(item.itemKey) || null
      }))
    };
  }

  function getItem(itemKey) {
    return itemByKey.get(String(itemKey || "")) || null;
  }

  function summary() {
    return {
      labelPath: resolvedLabelPath,
      reportCount: [...new Set(items.map((item) => item.reportPath))].length,
      ...summarizeReviews(items, latestReviews)
    };
  }

  function exportRecords() {
    return {
      schemaVersion: "0.1.0",
      generatedAt: new Date().toISOString(),
      labelPath: resolvedLabelPath,
      summary: summary(),
      records: [...latestReviews.values()].sort((left, right) => String(left.itemKey).localeCompare(String(right.itemKey)))
    };
  }

  return {
    labelPath: resolvedLabelPath,
    items,
    records,
    latestReviews,
    listItems,
    getItem,
    recordReview,
    summary,
    exportRecords
  };
}
