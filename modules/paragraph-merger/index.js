import Ajv2020 from "ajv/dist/2020.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };
import {
  preFilterArtifacts,
  detectHangingIndent,
  isContinuationLine,
  isLegalCitation
} from "./lib/heuristics.js";
import { textStructureMerge } from "./lib/text-structure-merge.js";
// TODO: import { runAllValidators } from "./lib/validators.js";

const ajv = new Ajv2020({ allErrors: true });
const validateSemantic = ajv.compile(semanticSchema);

const DEFAULT_CONFIG = {
  enabled: true,
  gapMultiplier: 1.8,
  xAlignmentTolerance: 12,
  heightVarianceTolerance: 0.3,
  minConfidence: 0.5,
  sentenceBoundaryPenalty: 0.3,
  reportUnmerged: true
};

function getNodeBottom(node) {
  return (node.bbox?.[1] ?? 0) + (node.bbox?.[3] ?? 0);
}

function getNodeTop(node) {
  return node.bbox?.[1] ?? 0;
}

function getNodeLeft(node) {
  return node.bbox?.[0] ?? 0;
}

function getNodeHeight(node) {
  return node.bbox?.[3] ?? 0;
}

function getNodeWidth(node) {
  return node.bbox?.[2] ?? 0;
}

function isRotatedNode(node) {
  const writingMode = String(node.writingMode || "horizontal").toLowerCase();
  const textRotation = Number(node.textRotation || 0);
  return writingMode !== "horizontal" || Math.abs(textRotation % 180) > 1;
}

function endsSentence(text) {
  const trimmed = (text || "").trimEnd();
  return /[.!?:;]["'\u201D\u2019)]*$/.test(trimmed);
}

function startsCapital(text) {
  const trimmed = (text || "").trimStart();
  return /^[A-Z\u00C0-\u00D6]/.test(trimmed);
}

function computeMergeConfidence(prev, curr, config) {
  const reasons = [];
  let confidence = 1.0;
  const heuristics = config.heuristics || {};

  if (isRotatedNode(prev) || isRotatedNode(curr)) {
    return {
      confidence: 0,
      merge: false,
      reasons: ["rotated text boundary"]
    };
  }

  const prevH = getNodeHeight(prev);
  const currH = getNodeHeight(curr);
  const lineHeight = Math.max(prevH, currH, 1);

  const gap = getNodeTop(curr) - getNodeBottom(prev);
  const maxGap = lineHeight * config.gapMultiplier;

  if (gap > maxGap) {
    const excess = (gap - maxGap) / maxGap;
    const penalty = Math.min(0.8, excess * 0.6);
    confidence -= penalty;
    reasons.push(`gap=${gap.toFixed(1)}px exceeds ${maxGap.toFixed(1)}px (${lineHeight.toFixed(0)}×${config.gapMultiplier})`);
  }

  if (gap < 0) {
    confidence -= 0.4;
    reasons.push(`negative gap=${gap.toFixed(1)}px (overlapping blocks)`);
  }

  const xShift = Math.abs(getNodeLeft(curr) - getNodeLeft(prev));
  if (xShift > config.xAlignmentTolerance) {
    let penalty = Math.min(0.4, (xShift - config.xAlignmentTolerance) / 60);
    if (heuristics.hangingIndentDetection && detectHangingIndent(prev, curr)) {
      penalty *= 0.4;
      reasons.push(`hanging indent detected: x-alignment penalty reduced by 60%`);
    }
    confidence -= penalty;
    reasons.push(`x-shift=${xShift.toFixed(1)}px exceeds tolerance=${config.xAlignmentTolerance}px`);
  }

  if (prevH > 0 && currH > 0) {
    const variance = Math.abs(prevH - currH) / Math.max(prevH, currH);
    if (variance > config.heightVarianceTolerance) {
      confidence -= 0.3;
      reasons.push(`height variance=${(variance * 100).toFixed(0)}% exceeds ${(config.heightVarianceTolerance * 100).toFixed(0)}%`);
    }
  }

  if (endsSentence(prev.text) && startsCapital(curr.text)) {
    let sentencePenalty = config.sentenceBoundaryPenalty;
    if (heuristics.legalCitationAwareness && isLegalCitation(prev.text)) {
      sentencePenalty *= 0.2;
      reasons.push(`legal citation detected: sentence-boundary penalty reduced by 80%`);
    }
    confidence -= sentencePenalty;
    reasons.push(`sentence boundary: prev ends with terminal punctuation, next starts capital`);
  }

  if (heuristics.continuationLineDetection && isContinuationLine(prev, curr)) {
    confidence += 0.15;
    reasons.push(`continuation line detected: confidence boosted by 0.15`);
  }

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    confidence,
    merge: confidence >= config.minConfidence,
    reasons: reasons.length > 0 ? reasons : ["all signals consistent"]
  };
}

function mergeTwoNodes(prev, curr) {
  const left = Math.min(getNodeLeft(prev), getNodeLeft(curr));
  const top = Math.min(getNodeTop(prev), getNodeTop(curr));
  const right = Math.max(
    getNodeLeft(prev) + getNodeWidth(prev),
    getNodeLeft(curr) + getNodeWidth(curr)
  );
  const bottom = Math.max(getNodeBottom(prev), getNodeBottom(curr));

  return {
    ...prev,
    text: `${prev.text} ${curr.text}`.trim(),
    bbox: [left, top, right - left, bottom - top],
    _mergedFrom: [...(prev._mergedFrom || [prev.id]), curr.id],
    _mergeConfidence: undefined
  };
}

function mergePageParagraphs(pageNodes, config) {
  const heuristics = config.heuristics || {};
  const filteredNodes = heuristics.artifactPreFilter
    ? preFilterArtifacts(pageNodes)
    : pageNodes;

  const pNodes = [];
  const nonPNodes = [];

  for (const node of filteredNodes) {
    if (node.role === "P") {
      pNodes.push(node);
    } else {
      nonPNodes.push(node);
    }
  }

  if (pNodes.length < 2) {
    return { nodes: pageNodes, merges: [], skips: [] };
  }

  const sorted = [...pNodes].sort((a, b) => getNodeTop(a) - getNodeTop(b) || getNodeLeft(a) - getNodeLeft(b));
  const merges = [];
  const skips = [];
  const result = [];
  let current = sorted[0];
  let paragraphGroupId = `pg-${current.pageNumber}-0`;
  let groupIndex = 0;

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const decision = computeMergeConfidence(current, next, config);

    if (decision.merge) {
      merges.push({
        from: [current.id, next.id],
        confidence: decision.confidence,
        reasons: decision.reasons
      });
      current = mergeTwoNodes(current, next);
      current.paragraphGroupId = paragraphGroupId;
    } else {
      current.paragraphGroupId = paragraphGroupId;
      result.push(current);

      if (config.reportUnmerged) {
        skips.push({
          between: [current.id, next.id],
          gap: getNodeTop(next) - getNodeBottom(current),
          confidence: decision.confidence,
          reasons: decision.reasons
        });
      }

      groupIndex++;
      paragraphGroupId = `pg-${next.pageNumber}-${groupIndex}`;
      current = next;
    }
  }

  current.paragraphGroupId = paragraphGroupId;
  result.push(current);

  return { nodes: [...result, ...nonPNodes], merges, skips };
}

export function mergeParagraphs(semanticDocument, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      document: semanticDocument,
      report: { enabled: false, pages: [], summary: { totalMerges: 0, totalSkips: 0, totalLinesIn: 0, totalNodesOut: 0 } }
    };
  }

  const pageGroups = new Map();
  for (const node of semanticDocument.nodes) {
    const pg = node.pageNumber;
    const nodes = pageGroups.get(pg) || [];
    nodes.push(node);
    pageGroups.set(pg, nodes);
  }

  const allNodes = [];
  const pageReports = [];
  let totalMerges = 0;
  let totalSkips = 0;

  for (const pageNumber of [...pageGroups.keys()].sort((a, b) => a - b)) {
    const { nodes, merges, skips } = mergePageParagraphs(pageGroups.get(pageNumber), cfg);
    allNodes.push(...nodes);
    totalMerges += merges.length;
    totalSkips += skips.length;

    pageReports.push({
      pageNumber,
      linesIn: pageGroups.get(pageNumber).length,
      nodesOut: nodes.length,
      merges,
      skips
    });
  }

  const output = {
    ...semanticDocument,
    nodes: allNodes
  };

  const report = {
    enabled: true,
    config: cfg,
    pages: pageReports,
    summary: {
      totalMerges,
      totalSkips,
      totalLinesIn: semanticDocument.nodes.length,
      totalNodesOut: allNodes.length,
      reductionPercent: semanticDocument.nodes.length > 0
        ? ((1 - allNodes.length / semanticDocument.nodes.length) * 100).toFixed(1)
        : "0.0"
    }
  };

  return { document: output, report };
}

export function mergeWithStrategy(semanticDocument, config = {}) {
  const enabled = config.enabled !== false;
  if (!enabled || config.strategy === "disabled") {
    return {
      document: semanticDocument,
      report: {
        strategy: "disabled",
        enabled: false,
        pages: [],
        summary: {
          totalMerges: 0,
          totalSkips: 0,
          totalLinesIn: semanticDocument.nodes.length,
          totalNodesOut: semanticDocument.nodes.length,
          reductionPercent: "0.0"
        }
      }
    };
  }

  const strategy = config.strategy || "text-structure";

  if (strategy === "text-structure") {
    return textStructureMerge(semanticDocument, config);
  }

  if (strategy === "pairwise") {
    return mergeParagraphs(semanticDocument, config);
  }

  throw new Error(`Unknown paragraph-merger strategy: ${strategy}`);
}

export async function run(inputPath, outputPath, reportPath, config = {}) {
  const semanticDocument = JSON.parse(await readFile(inputPath, "utf8"));

  if (!validateSemantic(semanticDocument)) {
    throw new Error(`Paragraph-merger input failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  const { document, report } = mergeWithStrategy(semanticDocument, config);

  if (!validateSemantic(document)) {
    throw new Error(`Paragraph-merger output failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  }

  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return { document, report };
}

async function main() {
  const args = process.argv.slice(2);
  const positional = [];
  let configPath = null;
  let strategyFlag = null;
  let reportFlag = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (args[i] === "--strategy" && i + 1 < args.length) {
      strategyFlag = args[++i];
    } else if (args[i] === "--report" && i + 1 < args.length) {
      reportFlag = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  const inputPath = positional[0];
  const reportPath = reportFlag || positional[2] || null;

  if (!inputPath) {
    throw new Error("Usage: node modules/paragraph-merger/index.js <semantic.json> [output.json] [report.json] [--config <path>] [--strategy <name>]");
  }

  let config = {};
  if (configPath) {
    config = JSON.parse(await readFile(configPath, "utf8"));
  }

  // CLI --strategy flag takes precedence over config file
  if (strategyFlag) {
    config.strategy = strategyFlag;
  }

  const { document, report } = await run(inputPath, null, reportPath, config);

  // IMPORTANT: always write document to stdout. The orchestrator's
  // execNodeToFile pipes stdout to the output file. Writing to a file
  // arg AND stdout causes execNodeToFile to overwrite the file with
  // empty stdout. Match the convention used by every other pipeline module.
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);

  const strategy = report.strategy || config.strategy || "unknown";
  const reduction = report.summary.reductionPercent ?? report.summary.overallReductionPercent ?? "0.0";
  process.stderr.write(
    `[paragraph-merger] strategy=${strategy} ${report.summary.totalLinesIn} lines → ${report.summary.totalNodesOut} nodes ` +
    `(${reduction}% reduction)\n`
  );
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
