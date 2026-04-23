import { createHash } from "node:crypto";

export const ROLE_CLASSIFIER_MODEL_TYPE = "openautotag-role-naive-bayes";
export const ROLE_CLASSIFIER_VERSION = "0.2.0";
export const ROLE_CLASSIFIER_TASK_HEAD = "role-classification";
export const FEATURE_EXTRACTOR_VERSION = "0.2.0";

const SEMANTIC_COMPATIBLE_ROLES = new Set([
  "Document",
  "H1",
  "H2",
  "H3",
  "P",
  "L",
  "LI",
  "Table",
  "TH",
  "TD",
  "Artifact"
]);

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function bucket(value, boundaries) {
  const numeric = numberOr(value, 0);
  for (let index = 0; index < boundaries.length; index += 1) {
    if (numeric < boundaries[index]) {
      return String(index);
    }
  }
  return String(boundaries.length);
}

function quantileBucket(value, maxValue, buckets = 4) {
  const denominator = Math.max(numberOr(maxValue, 1), 1);
  return String(clamp(Math.floor((numberOr(value, 0) / denominator) * buckets), 0, buckets - 1));
}

function textShape(text) {
  const value = String(text || "").trim();
  const lowerValue = value.toLowerCase();
  const letters = value.replace(/[^A-Za-z]/g, "");
  const digits = value.replace(/\D/g, "");
  const words = value.split(/\s+/).filter(Boolean);
  const upperLetters = letters.replace(/[^A-Z]/g, "");
  const firstToken = words[0] || "";
  const lastToken = words[words.length - 1] || "";

  return {
    value,
    lowerValue,
    words,
    firstToken,
    lastToken,
    wordCount: words.length,
    charCount: value.length,
    digitRatio: value.length > 0 ? digits.length / value.length : 0,
    upperRatio: letters.length > 0 ? upperLetters.length / letters.length : 0
  };
}

function fontFamilyClass(fontName) {
  const name = String(fontName || "").toLowerCase();
  if (!name) return "unknown";
  if (/mono|courier|consolas|code/.test(name)) return "mono";
  if (/serif|times|georgia|garamond/.test(name)) return "serif";
  if (/symbol|dingbat|zapf/.test(name)) return "symbol";
  return "sans-or-other";
}

function tokenClass(token) {
  const value = String(token || "");
  if (!value) return "none";
  if (/^[A-Z]{2,}$/.test(value)) return "upper";
  if (/^\d+$/.test(value)) return "number";
  if (/^\d+[.,]\d+$/.test(value)) return "decimal";
  if (/^[A-Za-z]+:$/.test(value)) return "label";
  if (/^https?:/i.test(value)) return "url";
  if (/^[A-Za-z]/.test(value)) return "word";
  return "symbol";
}

function verticalGapClass(currentNode, neighborNode) {
  if (!neighborNode || !Array.isArray(currentNode?.bbox) || !Array.isArray(neighborNode?.bbox)) {
    return "none";
  }

  const currentTop = numberOr(currentNode.bbox[1], 0);
  const neighborBottom = numberOr(neighborNode.bbox[1], 0) + numberOr(neighborNode.bbox[3], 0);
  return bucket(Math.abs(currentTop - neighborBottom), [3, 8, 16, 32, 64, 128]);
}

function horizontalRelation(currentNode, neighborNode) {
  if (!neighborNode || !Array.isArray(currentNode?.bbox) || !Array.isArray(neighborNode?.bbox)) {
    return "none";
  }

  const delta = numberOr(currentNode.bbox[0], 0) - numberOr(neighborNode.bbox[0], 0);
  if (Math.abs(delta) < 4) return "aligned";
  return delta > 0 ? "indented" : "outdented";
}

function buildSemanticNeighbors(semanticDocument = {}) {
  const nodes = [...(semanticDocument.nodes || [])].sort((left, right) =>
    numberOr(left.readingOrder, 0) - numberOr(right.readingOrder, 0) ||
    numberOr(left.pageNumber, 0) - numberOr(right.pageNumber, 0) ||
    numberOr(left.bbox?.[1], 0) - numberOr(right.bbox?.[1], 0) ||
    numberOr(left.bbox?.[0], 0) - numberOr(right.bbox?.[0], 0)
  );
  const neighbors = new Map();

  for (let index = 0; index < nodes.length; index += 1) {
    neighbors.set(nodes[index].id, {
      previous: nodes[index - 1] || null,
      next: nodes[index + 1] || null
    });
  }

  return neighbors;
}

export function createLayoutBlockIndex(layoutDocument = {}) {
  const blocks = new Map();
  const pages = new Map();

  for (const page of layoutDocument.pages || []) {
    pages.set(page.pageNumber, page);
    for (const block of page.textBlocks || []) {
      blocks.set(block.id, {
        block,
        page
      });
    }
  }

  return { blocks, pages };
}

export function buildFeatureContext({ semanticDocument = {}, layoutDocument = {} } = {}) {
  const layoutIndex = createLayoutBlockIndex(layoutDocument);
  const fontSizes = [];

  for (const page of layoutDocument.pages || []) {
    for (const block of page.textBlocks || []) {
      const fontSize = Number(block.fontSize);
      if (Number.isFinite(fontSize) && fontSize > 0) {
        fontSizes.push(fontSize);
      }
    }
  }

  fontSizes.sort((left, right) => left - right);
  const medianFontSize = fontSizes.length > 0
    ? fontSizes[Math.floor(fontSizes.length / 2)]
    : 10;
  const totalNodes = Array.isArray(semanticDocument.nodes) ? semanticDocument.nodes.length : 0;

  return {
    layoutIndex,
    medianFontSize,
    totalNodes,
    semanticNeighbors: buildSemanticNeighbors(semanticDocument)
  };
}

export function extractRoleFeatures(node, context = {}) {
  const blockRecord = context.layoutIndex?.blocks?.get(node.sourceBlockId);
  const block = blockRecord?.block || {};
  const page = blockRecord?.page || context.layoutIndex?.pages?.get(node.pageNumber) || {};
  const bbox = Array.isArray(node.bbox) ? node.bbox : [0, 0, 0, 0];
  const pageWidth = numberOr(page.width, 612);
  const pageHeight = numberOr(page.height, 792);
  const [x, y, width, height] = bbox;
  const shape = textShape(node.text);
  const fontSize = numberOr(block.fontSize, 0);
  const medianFontSize = Math.max(numberOr(context.medianFontSize, 10), 1);
  const readingOrder = numberOr(node.readingOrder, 0);
  const totalNodes = Math.max(numberOr(context.totalNodes, 1), 1);
  const neighbors = context.semanticNeighbors?.get(node.id) || {};
  const previousShape = textShape(neighbors.previous?.text || "");
  const nextShape = textShape(neighbors.next?.text || "");
  const features = new Set();

  features.add(`page:xq:${quantileBucket(x, pageWidth, 5)}`);
  features.add(`page:yq:${quantileBucket(y, pageHeight, 8)}`);
  features.add(`page:w:${bucket(width / Math.max(pageWidth, 1), [0.08, 0.18, 0.35, 0.65, 0.9])}`);
  features.add(`page:h:${bucket(height / Math.max(pageHeight, 1), [0.015, 0.03, 0.06, 0.12])}`);
  features.add(`page:left:${bucket(x / Math.max(pageWidth, 1), [0.08, 0.18, 0.32, 0.5])}`);
  features.add(`page:top:${y / Math.max(pageHeight, 1) < 0.12 ? "yes" : "no"}`);
  features.add(`page:bottom:${(y + height) / Math.max(pageHeight, 1) > 0.88 ? "yes" : "no"}`);

  features.add(`text:chars:${bucket(shape.charCount, [1, 8, 20, 60, 140, 320])}`);
  features.add(`text:words:${bucket(shape.wordCount, [1, 3, 8, 18, 40, 90])}`);
  features.add(`text:digits:${bucket(shape.digitRatio, [0.02, 0.15, 0.4, 0.75])}`);
  features.add(`text:upper:${bucket(shape.upperRatio, [0.2, 0.55, 0.85])}`);
  features.add(`text:empty:${shape.charCount === 0 ? "yes" : "no"}`);
  features.add(`text:bullet:${/^\s*[\u2022*+\-o]\s+/.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:numbered:${/^\s*(\(?\d+[\).]|\(?[A-Za-z][\).]|[ivxlcdm]+[\).])\s+/i.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:ends-colon:${/:$/.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:ends-period:${/[.!?]$/.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:contains-url:${/(https?:\/\/|www\.|\.gov|\.org|\.edu)/i.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:punct-heavy:${/[|]{1,}|\s{3,}/.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:table-markers:${/\b(total|amount|rate|date|code|description|item|qty|quantity)\b/i.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:note-marker:${/^\s*(\*|\u2020|\[\d+\]|\d{1,2})\s*$/.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:currency:${/[$\u20ac\u00a3]/.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:percent:${/%/.test(shape.value) ? "yes" : "no"}`);
  features.add(`text:first-token:${tokenClass(shape.firstToken)}`);
  features.add(`text:last-token:${tokenClass(shape.lastToken)}`);
  features.add(`text:publication-notice:${/\b(federal register|scheduled to be published|govinfo|billing code)\b/i.test(shape.value) ? "yes" : "no"}`);

  features.add(`layout:block-type:${block.blockType || "unknown"}`);
  features.add(`layout:heading-level:${block.headingLevel || node.headingLevel || "none"}`);
  features.add(`layout:font-class:${fontFamilyClass(block.fontName)}`);
  features.add(`layout:font-ratio:${bucket(fontSize / medianFontSize, [0.82, 0.96, 1.08, 1.3, 1.7])}`);
  features.add(`layout:synthetic:${block.synthetic === true ? "yes" : "no"}`);
  features.add(`layout:table-role:${block.tableRole || "none"}`);
  features.add(`layout:table-section:${block.tableSection || "none"}`);
  features.add(`layout:table-row:${block.tableRowIndex == null ? "none" : bucket(block.tableRowIndex, [1, 2, 4, 8, 16])}`);
  features.add(`layout:table-column:${block.tableColumnIndex == null ? "none" : bucket(block.tableColumnIndex, [1, 2, 4, 8, 16])}`);
  features.add(`layout:table-confidence:${block.tableCellConfidence == null ? "none" : bucket(block.tableCellConfidence, [0.45, 0.7, 0.86, 0.94])}`);
  features.add(`layout:table-detection:${block.tableDetectionMethod || "none"}`);

  features.add(`node:heading-level:${node.headingLevel || "none"}`);
  features.add(`node:column:${node.columnHint ?? "none"}`);
  features.add(`node:confidence:${bucket(node.confidence, [0.35, 0.55, 0.75, 0.9])}`);
  features.add(`node:order:${bucket(readingOrder / totalNodes, [0.08, 0.2, 0.5, 0.8, 0.95])}`);
  features.add(`node:source-block-type:${node.sourceBlockType || "none"}`);
  features.add(`node:region-kind:${node.regionKind || "none"}`);
  features.add(`node:artifact-type:${node.artifactType || "none"}`);
  features.add(`node:merged:${Array.isArray(node._mergedFrom) && node._mergedFrom.length > 1 ? "yes" : "no"}`);
  features.add(`neighbor:prev-words:${bucket(previousShape.wordCount, [1, 3, 8, 18, 40])}`);
  features.add(`neighbor:next-words:${bucket(nextShape.wordCount, [1, 3, 8, 18, 40])}`);
  features.add(`neighbor:prev-gap:${verticalGapClass(node, neighbors.previous)}`);
  features.add(`neighbor:next-gap:${neighbors.next ? verticalGapClass(neighbors.next, node) : "none"}`);
  features.add(`neighbor:prev-x:${horizontalRelation(node, neighbors.previous)}`);
  features.add(`neighbor:next-x:${horizontalRelation(neighbors.next, node)}`);

  return [...features].sort();
}

export function collectRoleExamples({ semanticDocument, layoutDocument = null, sourcePath = null } = {}) {
  const context = buildFeatureContext({ semanticDocument, layoutDocument: layoutDocument || {} });
  const examples = [];

  for (const node of semanticDocument?.nodes || []) {
    if (!node?.role || !SEMANTIC_COMPATIBLE_ROLES.has(node.role)) {
      continue;
    }

    examples.push({
      documentId: semanticDocument.documentId,
      sourcePath,
      nodeId: node.id,
      sourceBlockId: node.sourceBlockId,
      role: node.role,
      pageNumber: node.pageNumber,
      bbox: node.bbox,
      features: extractRoleFeatures(node, context)
    });
  }

  return examples;
}

export function trainRoleClassifier(documents, options = {}) {
  const alpha = Number.isFinite(Number(options.alpha)) ? Number(options.alpha) : 1;
  const classPriorExponent = Number.isFinite(Number(options.classPriorExponent)) ? Number(options.classPriorExponent) : 0.35;
  const minFeatureCount = Math.max(1, Math.round(Number(options.minFeatureCount || 1)));
  const classifierId = String(options.classifierId || "openautotag-role-baseline").trim() || "openautotag-role-baseline";
  const trainingDatasetVersion = String(options.trainingDatasetVersion || options.datasetVersion || "pilot").trim() || "pilot";
  const examples = documents.flatMap((document) => collectRoleExamples(document));
  const classes = [...new Set(examples.map((example) => example.role))].sort();
  const classCounts = Object.fromEntries(classes.map((role) => [role, 0]));
  const featureCounts = Object.fromEntries(classes.map((role) => [role, {}]));
  const totalFeatureCounts = Object.fromEntries(classes.map((role) => [role, 0]));
  const corpusFeatureCounts = {};
  const vocabulary = new Set();

  for (const example of examples) {
    for (const feature of example.features) {
      corpusFeatureCounts[feature] = (corpusFeatureCounts[feature] || 0) + 1;
    }
  }

  for (const example of examples) {
    classCounts[example.role] += 1;
    for (const feature of example.features) {
      if (corpusFeatureCounts[feature] < minFeatureCount) {
        continue;
      }
      vocabulary.add(feature);
      featureCounts[example.role][feature] = (featureCounts[example.role][feature] || 0) + 1;
      totalFeatureCounts[example.role] += 1;
    }
  }

  const trainingSummary = {
    documentCount: documents.length,
    exampleCount: examples.length,
    roleCounts: classCounts,
    featureCount: vocabulary.size,
    rawFeatureCount: Object.keys(corpusFeatureCounts).length,
    prunedFeatureCount: Object.keys(corpusFeatureCounts).length - vocabulary.size
  };

  return {
    schemaVersion: "0.1.0",
    modelType: ROLE_CLASSIFIER_MODEL_TYPE,
    modelVersion: ROLE_CLASSIFIER_VERSION,
    classifierId,
    taskHead: ROLE_CLASSIFIER_TASK_HEAD,
    featureExtractorVersion: FEATURE_EXTRACTOR_VERSION,
    labelSource: "engine-projected-semantic-role",
    trainingDatasetVersion,
    trainedAt: new Date().toISOString(),
    alpha,
    classPriorExponent,
    minFeatureCount,
    classes,
    classCounts,
    featureCounts,
    totalFeatureCounts,
    vocabulary: [...vocabulary].sort(),
    trainingSummary,
    modelHash: null
  };
}

export function finalizeRoleClassifierModel(model) {
  const copy = {
    ...model,
    modelHash: null,
    trainedAt: null
  };
  return {
    ...model,
    modelHash: sha256(stableJson(copy))
  };
}

function softmax(logScores) {
  const maxScore = Math.max(...Object.values(logScores));
  const expScores = Object.fromEntries(
    Object.entries(logScores).map(([label, score]) => [label, Math.exp(score - maxScore)])
  );
  const total = Object.values(expScores).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(expScores).map(([label, value]) => [label, value / total]));
}

export function predictRole(model, node, context = {}, options = {}) {
  if (!model || model.modelType !== ROLE_CLASSIFIER_MODEL_TYPE) {
    throw new Error(`Unsupported role classifier model: ${model?.modelType || "unknown"}`);
  }

  const classes = Array.isArray(model.classes) ? model.classes : [];
  const alpha = Number.isFinite(Number(model.alpha)) ? Number(model.alpha) : 1;
  const classPriorExponent = Number.isFinite(Number(model.classPriorExponent)) ? Number(model.classPriorExponent) : 0.35;
  const vocabulary = new Set(model.vocabulary || []);
  const vocabularySize = Math.max(vocabulary.size, 1);
  const classPriorWeights = Object.fromEntries(
    classes.map((role) => [role, Math.pow(Number(model.classCounts?.[role] || 0) + alpha, classPriorExponent)])
  );
  const totalPriorWeight = Object.values(classPriorWeights).reduce((sum, value) => sum + value, 0) || 1;
  const features = extractRoleFeatures(node, context);
  const knownFeatureCount = features.filter((feature) => vocabulary.has(feature)).length;
  const knownFeatureRatio = features.length > 0 ? knownFeatureCount / features.length : 0;
  const logScores = {};

  for (const role of classes) {
    const roleFeatureCounts = model.featureCounts?.[role] || {};
    const roleFeatureTotal = Number(model.totalFeatureCounts?.[role] || 0);
    let score = Math.log(classPriorWeights[role] / totalPriorWeight);
    for (const feature of features) {
      score += Math.log((Number(roleFeatureCounts[feature] || 0) + alpha) / (roleFeatureTotal + alpha * vocabularySize));
    }
    logScores[role] = score;
  }

  const distribution = softmax(logScores);
  const alternatives = Object.entries(distribution)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((left, right) => right.confidence - left.confidence);
  const best = alternatives[0] || { label: "Unknown", confidence: 0 };
  const threshold = Number.isFinite(Number(options.confidenceThreshold)) ? Number(options.confidenceThreshold) : 0.55;
  const minKnownFeatureRatio = Number.isFinite(Number(options.minKnownFeatureRatio)) ? Number(options.minKnownFeatureRatio) : 0.35;
  let abstentionReason = "none";

  if (knownFeatureRatio < minKnownFeatureRatio) {
    abstentionReason = "missing-required-features";
  } else if (best.confidence < threshold) {
    abstentionReason = "low-confidence";
  }

  return {
    label: best.label,
    confidence: best.confidence,
    calibratedConfidence: best.confidence,
    alternatives,
    abstention: {
      abstained: abstentionReason !== "none",
      reason: abstentionReason,
      threshold
    },
    features,
    knownFeatureRatio
  };
}

function createEmptyConfusion(classes) {
  return Object.fromEntries(
    classes.map((actual) => [
      actual,
      Object.fromEntries(classes.map((predicted) => [predicted, 0]))
    ])
  );
}

function roundMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

export function evaluateRoleClassifier(model, documents, options = {}) {
  const classes = Array.isArray(model.classes) ? model.classes : [];
  const confusion = createEmptyConfusion(classes);
  const perRole = Object.fromEntries(
    classes.map((role) => [
      role,
      {
        support: 0,
        truePositive: 0,
        falsePositive: 0,
        falseNegative: 0
      }
    ])
  );
  let correct = 0;
  let total = 0;
  let abstained = 0;
  let brierSum = 0;
  const calibrationBins = Array.from({ length: 10 }, () => ({ count: 0, confidenceSum: 0, correct: 0 }));

  for (const document of documents) {
    const context = buildFeatureContext({
      semanticDocument: document.semanticDocument,
      layoutDocument: document.layoutDocument || {}
    });
    for (const node of document.semanticDocument?.nodes || []) {
      if (!node?.role || !classes.includes(node.role)) {
        continue;
      }

      const prediction = predictRole(model, node, context, options);
      const predicted = prediction.label;
      const confidence = prediction.confidence;
      total += 1;
      if (prediction.abstention.abstained) {
        abstained += 1;
      }
      perRole[node.role].support += 1;
      confusion[node.role][predicted] = (confusion[node.role][predicted] || 0) + 1;
      if (predicted === node.role) {
        correct += 1;
        perRole[node.role].truePositive += 1;
      } else {
        perRole[node.role].falseNegative += 1;
        if (perRole[predicted]) {
          perRole[predicted].falsePositive += 1;
        }
      }

      for (const role of classes) {
        const target = role === node.role ? 1 : 0;
        const probability = prediction.alternatives.find((item) => item.label === role)?.confidence || 0;
        brierSum += (probability - target) ** 2;
      }

      const binIndex = clamp(Math.floor(confidence * 10), 0, 9);
      calibrationBins[binIndex].count += 1;
      calibrationBins[binIndex].confidenceSum += confidence;
      if (predicted === node.role) {
        calibrationBins[binIndex].correct += 1;
      }
    }
  }

  const roleMetrics = Object.fromEntries(
    Object.entries(perRole).map(([role, metrics]) => {
      const precision = metrics.truePositive / Math.max(metrics.truePositive + metrics.falsePositive, 1);
      const recall = metrics.truePositive / Math.max(metrics.truePositive + metrics.falseNegative, 1);
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
      return [
        role,
        {
          support: metrics.support,
          precision: roundMetric(precision),
          recall: roundMetric(recall),
          f1: roundMetric(f1)
        }
      ];
    })
  );

  const macroF1 = classes.reduce((sum, role) => sum + roleMetrics[role].f1, 0) / Math.max(classes.length, 1);
  const supportedRoles = classes.filter((role) => roleMetrics[role].support > 0);
  const supportedMacroF1 = supportedRoles.reduce((sum, role) => sum + roleMetrics[role].f1, 0) / Math.max(supportedRoles.length, 1);
  const balancedAccuracy = supportedRoles.reduce((sum, role) => sum + roleMetrics[role].recall, 0) / Math.max(supportedRoles.length, 1);
  let expectedCalibrationError = 0;
  const bins = calibrationBins.map((bin, index) => {
    const avgConfidence = bin.count > 0 ? bin.confidenceSum / bin.count : 0;
    const accuracy = bin.count > 0 ? bin.correct / bin.count : 0;
    expectedCalibrationError += (bin.count / Math.max(total, 1)) * Math.abs(avgConfidence - accuracy);
    return {
      bin: index,
      count: bin.count,
      avgConfidence: roundMetric(avgConfidence),
      accuracy: roundMetric(accuracy)
    };
  });

  const majorityRole = Object.entries(model.classCounts || {}).sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0] || null;
  const majorityCorrect = documents
    .flatMap((document) => document.semanticDocument?.nodes || [])
    .filter((node) => node.role && classes.includes(node.role) && node.role === majorityRole).length;

  return {
    exampleCount: total,
    accuracy: roundMetric(correct / Math.max(total, 1)),
    macroF1: roundMetric(macroF1),
    supportedMacroF1: roundMetric(supportedMacroF1),
    balancedAccuracy: roundMetric(balancedAccuracy),
    abstentionRate: roundMetric(abstained / Math.max(total, 1)),
    brierScore: roundMetric(brierSum / Math.max(total * Math.max(classes.length, 1), 1)),
    expectedCalibrationError: roundMetric(expectedCalibrationError),
    zeroSupportRoles: classes.filter((role) => roleMetrics[role].support === 0),
    majorityBaseline: {
      role: majorityRole,
      accuracy: roundMetric(majorityCorrect / Math.max(total, 1))
    },
    perRole: roleMetrics,
    confusion,
    calibrationBins: bins
  };
}

export function buildMlPredictionDocument({
  semanticDocument,
  layoutDocument = null,
  model,
  predictions,
  semanticPath,
  outputPath,
  mode = "shadow",
  status = "completed"
}) {
  const knownRatios = predictions.map((prediction) => Number(prediction.evidence?.featureSummary?.knownFeatureRatio || 0));
  const meanKnownRatio = knownRatios.length > 0
    ? knownRatios.reduce((sum, value) => sum + value, 0) / knownRatios.length
    : 0;
  const oodScore = roundMetric(1 - meanKnownRatio);
  const oodDecision = oodScore > 0.65
    ? "out-of-distribution"
    : oodScore > 0.35
      ? "near-boundary"
      : "in-distribution";
  const modelMetrics = model.evaluation?.metrics || {};

  return {
    schemaVersion: "0.1.0-draft",
    status,
    generatedAt: new Date().toISOString(),
    documentId: semanticDocument.documentId,
    source: {
      layoutDocumentId: semanticDocument.source?.layoutDocumentId || layoutDocument?.documentId || "unknown-layout",
      semanticDocumentId: semanticDocument.documentId,
      filePath: semanticDocument.source?.filePath || null,
      semanticPath: semanticPath ? String(semanticPath) : null,
      tunedSemanticPath: outputPath ? String(outputPath) : null
    },
    model: {
      id: model.classifierId,
      version: model.modelVersion || ROLE_CLASSIFIER_VERSION,
      taskHeads: [ROLE_CLASSIFIER_TASK_HEAD, "ood-detection"],
      trainingDatasetVersion: model.trainingDatasetVersion || "unknown",
      modelHash: model.modelHash || null,
      featureExtractorVersion: model.featureExtractorVersion || FEATURE_EXTRACTOR_VERSION,
      modelType: model.modelType
    },
    runtimePolicy: {
      mode,
      fallbackBehavior: "deterministic-on-any-policy-fail",
      abstentionEnabled: true
    },
    documentProfile: {
      oodScore,
      oodDecision,
      matchedProfiles: []
    },
    predictions,
    calibration: {
      datasetVersion: model.trainingDatasetVersion || "unknown",
      globalExpectedCalibrationError: Number(modelMetrics.expectedCalibrationError || 0),
      globalBrierScore: Number(modelMetrics.brierScore || 0),
      sliceStatus: [
        {
          slice: "all",
          status: modelMetrics.exampleCount ? "not-measured" : "not-measured",
          expectedCalibrationError: Number(modelMetrics.expectedCalibrationError || 0)
        }
      ]
    },
    shadowMode: {
      enabled: mode === "shadow",
      wouldChangeOutput: predictions.some((prediction) => prediction.shadowDecision?.wouldChangeOutput === true),
      decisionLogs: predictions.map((prediction) => ({
        targetId: prediction.target.sourceNodeId,
        deterministicDecision: prediction.deterministicDecision,
        mlDecision: prediction.prediction.label,
        finalDecision: prediction.finalDecision,
        fallbackReason: prediction.fallbackReason
      }))
    },
    tuning: {
      applied: false,
      semanticNodesInput: Array.isArray(semanticDocument.nodes) ? semanticDocument.nodes.length : 0,
      semanticNodesOutput: Array.isArray(semanticDocument.nodes) ? semanticDocument.nodes.length : 0,
      reason: mode === "shadow"
        ? "Shadow mode preserves deterministic semantic output while emitting classifier evidence."
        : "Assistive mutation is gated off until release gates are met; deterministic semantic output was preserved."
    }
  };
}

export function createPredictionEntries({ semanticDocument, layoutDocument = null, model, mode = "shadow", options = {} }) {
  const context = buildFeatureContext({ semanticDocument, layoutDocument: layoutDocument || {} });
  return (semanticDocument.nodes || []).map((node) => {
    const rolePrediction = predictRole(model, node, context, options);
    const compatible = SEMANTIC_COMPATIBLE_ROLES.has(rolePrediction.label);
    const fallbackReason = rolePrediction.abstention.abstained
      ? rolePrediction.abstention.reason
      : mode === "shadow"
        ? "shadow-mode"
        : compatible
          ? "assistive-disabled"
          : "contract-gap";
    const finalDecision = node.role;
    const wouldChangeOutput = rolePrediction.label !== node.role && !rolePrediction.abstention.abstained && mode !== "shadow";

    return {
      id: `role-${node.id}`,
      taskHead: ROLE_CLASSIFIER_TASK_HEAD,
      target: {
        sourceBlockId: node.sourceBlockId,
        sourceNodeId: node.id,
        pageNumber: node.pageNumber,
        bbox: node.bbox
      },
      prediction: {
        label: rolePrediction.label,
        alternatives: rolePrediction.alternatives.slice(0, 5).map((alternative) => ({
          label: alternative.label,
          confidence: roundMetric(alternative.confidence)
        }))
      },
      confidence: roundMetric(rolePrediction.confidence),
      calibratedConfidence: roundMetric(rolePrediction.calibratedConfidence),
      abstention: rolePrediction.abstention,
      contractProjection: {
        status: compatible ? "semantic-compatible" : "contract-gap",
        targetContract: compatible ? "semantic.schema.json" : "machine-learning/contracts-draft/ml-ground-truth.schema.json",
        targetField: compatible ? "nodes[].role" : "roles"
      },
      deterministicDecision: node.role,
      finalDecision,
      fallbackReason,
      shadowDecision: {
        wouldChangeOutput
      },
      evidence: {
        featureSummary: {
          totalFeatures: rolePrediction.features.length,
          knownFeatureRatio: roundMetric(rolePrediction.knownFeatureRatio),
          sampleFeatures: rolePrediction.features.slice(0, 12)
        },
        explanation: "Naive Bayes role classifier over geometric, text-shape, layout, and confidence features."
      }
    };
  });
}
