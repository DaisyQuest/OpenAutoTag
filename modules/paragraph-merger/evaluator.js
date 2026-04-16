import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeParagraphs } from "./index.js";
import { scoreMergeResult } from "./lib/scorer.js";
import { autoSelectVersion } from "./lib/auto-selector.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_DIR = path.join(moduleDir, "versions");

export async function loadVersions() {
  const files = (await readdir(VERSIONS_DIR)).filter((f) => f.endsWith(".json"));
  const versions = [];
  for (const file of files) {
    const v = JSON.parse(await readFile(path.join(VERSIONS_DIR, file), "utf8"));
    versions.push(v);
  }
  return versions.sort((a, b) => a.versionId.localeCompare(b.versionId));
}

function buildImprovementReport(docId, original, versionResults, autoSelection) {
  const report = {
    documentId: docId,
    originalNodeCount: original.nodes.length,
    originalParagraphCount: original.nodes.filter((n) => n.role === "P").length,
    versions: [],
    bestVersion: null,
    comparison: []
  };

  let bestScore = -1;
  let bestVersionId = null;

  for (const vr of versionResults) {
    const entry = {
      versionId: vr.versionId,
      label: vr.label,
      nodesOut: vr.merged.nodes.length,
      paragraphsOut: vr.merged.nodes.filter((n) => n.role === "P").length,
      mergeCount: vr.mergeReport.summary.totalMerges,
      skipCount: vr.mergeReport.summary.totalSkips,
      reductionPercent: vr.mergeReport.summary.reductionPercent,
      scores: vr.scores,
      interestingMerges: [],
      interestingSkips: []
    };

    for (const page of vr.mergeReport.pages) {
      for (const m of page.merges) {
        if (m.confidence < 0.7) {
          entry.interestingMerges.push({
            page: page.pageNumber,
            blocks: m.from,
            confidence: m.confidence,
            reasons: m.reasons,
            flag: "risky-merge"
          });
        }
      }
      for (const s of page.skips) {
        if (s.confidence > 0.3) {
          entry.interestingSkips.push({
            page: page.pageNumber,
            blocks: s.between,
            confidence: s.confidence,
            gap: s.gap,
            reasons: s.reasons,
            flag: "borderline-skip"
          });
        }
      }
    }

    if (vr.scores.aggregate > bestScore) {
      bestScore = vr.scores.aggregate;
      bestVersionId = vr.versionId;
    }

    report.versions.push(entry);
  }

  report.bestVersion = {
    versionId: bestVersionId,
    aggregateScore: bestScore
  };

  const sorted = [...report.versions].sort((a, b) => b.scores.aggregate - a.scores.aggregate);
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    const comparison = {
      rank: i + 1,
      versionId: curr.versionId,
      aggregate: curr.scores.aggregate.toFixed(3),
      nodeReduction: (curr.scores.nodeReduction * 100).toFixed(1) + "%",
      coherence: (curr.scores.paragraphCoherence * 100).toFixed(1) + "%",
      overMerge: (curr.scores.overMergeRate * 100).toFixed(1) + "%",
      underMerge: (curr.scores.underMergeRate * 100).toFixed(1) + "%",
      riskyMerges: curr.interestingMerges.length,
      borderlineSkips: curr.interestingSkips.length
    };
    report.comparison.push(comparison);
  }

  if (autoSelection) {
    const autoResult = versionResults.find(vr => vr.versionId === autoSelection.selectedVersionId);
    report.autoSelector = {
      selectedVersionId: autoSelection.selectedVersionId,
      confidence: autoSelection.confidence,
      reasoning: autoSelection.reasoning,
      features: autoSelection.features,
      selectedScore: autoResult?.scores.aggregate ?? null,
      oracleVersionId: report.bestVersion.versionId,
      oracleScore: report.bestVersion.aggregateScore,
      matchesOracle: autoSelection.selectedVersionId === report.bestVersion.versionId,
      regretVsOracle: report.bestVersion.aggregateScore - (autoResult?.scores.aggregate ?? 0)
    };
  }

  return report;
}

export async function evaluateDocument(docId, semanticDocument, versions) {
  const versionResults = [];

  for (const version of versions) {
    const { document: merged, report: mergeReport } = mergeParagraphs(
      semanticDocument,
      { ...version.config, heuristics: version.heuristics }
    );
    const scores = scoreMergeResult(semanticDocument, merged, mergeReport);
    versionResults.push({
      versionId: version.versionId,
      label: version.label,
      merged,
      mergeReport,
      scores
    });
  }

  const autoSelection = autoSelectVersion(semanticDocument, versions.map(v => v.versionId));
  const improvementReport = buildImprovementReport(docId, semanticDocument, versionResults, autoSelection);
  return { versionResults, improvementReport };
}

export async function evaluateCorpus(semanticPaths, outputDir) {
  const versions = await loadVersions();
  await mkdir(outputDir, { recursive: true });

  const MAX_NODES = 50000;
  const documents = [];
  for (const semPath of semanticPaths) {
    const docId = path.basename(path.dirname(semPath));
    try {
      const doc = JSON.parse(await readFile(semPath, "utf8"));
      if (doc.nodes && doc.nodes.length > MAX_NODES) {
        process.stderr.write(`[evaluator] skip ${docId}: ${doc.nodes.length} nodes exceeds ${MAX_NODES} cap (run separately with --no-cap)\n`);
        continue;
      }
      documents.push({ docId, doc, path: semPath });
    } catch {
      process.stderr.write(`[evaluator] skip ${semPath}: unreadable\n`);
    }
  }

  const allReports = [];
  const versionWins = {};

  for (const { docId, doc } of documents) {
    process.stderr.write(`[evaluator] ${docId}...\n`);
    const { improvementReport } = await evaluateDocument(docId, doc, versions);

    await writeFile(
      path.join(outputDir, `${docId}-report.json`),
      JSON.stringify(improvementReport, null, 2) + "\n"
    );

    allReports.push(improvementReport);
    const winner = improvementReport.bestVersion.versionId;
    versionWins[winner] = (versionWins[winner] || 0) + 1;
  }

  const versionAggregates = {};
  for (const version of versions) {
    const vid = version.versionId;
    const entries = allReports.map((r) => r.versions.find((v) => v.versionId === vid)).filter(Boolean);
    if (entries.length === 0) continue;
    versionAggregates[vid] = {
      label: version.label,
      wins: versionWins[vid] || 0,
      meanAggregate: mean(entries.map((e) => e.scores.aggregate)),
      meanReduction: mean(entries.map((e) => e.scores.nodeReduction)),
      meanCoherence: mean(entries.map((e) => e.scores.paragraphCoherence)),
      meanOverMerge: mean(entries.map((e) => e.scores.overMergeRate)),
      meanUnderMerge: mean(entries.map((e) => e.scores.underMergeRate)),
      totalRiskyMerges: entries.reduce((s, e) => s + e.interestingMerges.length, 0),
      totalBorderlineSkips: entries.reduce((s, e) => s + e.interestingSkips.length, 0)
    };
  }

  // --- Auto-selector aggregate stats ---
  const autoReports = allReports.filter(r => r.autoSelector);
  const autoMatchCount = autoReports.filter(r => r.autoSelector.matchesOracle).length;
  const autoRegrets = autoReports.map(r => r.autoSelector.regretVsOracle);
  const selectionDistribution = {};
  const reasoningCounts = {};
  for (const r of autoReports) {
    const vid = r.autoSelector.selectedVersionId;
    selectionDistribution[vid] = (selectionDistribution[vid] || 0) + 1;
    for (const reason of r.autoSelector.reasoning) {
      reasoningCounts[reason] = (reasoningCounts[reason] || 0) + 1;
    }
  }
  const topReasons = Object.entries(reasoningCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  const autoSelectorStats = {
    oracleMatchRate: autoReports.length > 0 ? autoMatchCount / autoReports.length : 0,
    meanRegret: autoRegrets.length > 0 ? autoRegrets.reduce((s, v) => s + v, 0) / autoRegrets.length : 0,
    maxRegret: autoRegrets.length > 0 ? Math.max(...autoRegrets) : 0,
    selectionDistribution,
    reasoning: topReasons
  };

  const corpusSummary = {
    documentsEvaluated: documents.length,
    versionsCompared: versions.length,
    versionWins,
    versionAggregates,
    autoSelector: autoSelectorStats,
    perDocument: allReports.map((r) => ({
      documentId: r.documentId,
      bestVersion: r.bestVersion.versionId,
      bestScore: r.bestVersion.aggregateScore,
      comparison: r.comparison
    }))
  };

  await writeFile(
    path.join(outputDir, "corpus-summary.json"),
    JSON.stringify(corpusSummary, null, 2) + "\n"
  );

  return corpusSummary;
}

function mean(arr) {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const jobsRoot = args[0];
  const outputDir = args[1] || "tmp/paragraph-eval";

  if (!jobsRoot) {
    throw new Error("Usage: node modules/paragraph-merger/evaluator.js <jobs-root-or-semantic-paths...> [output-dir]");
  }

  let semanticPaths = [];
  const { statSync, readdirSync } = await import("node:fs");

  if (statSync(jobsRoot).isDirectory()) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "03-semantic.json") semanticPaths.push(full);
      }
    };
    walk(jobsRoot);
  } else {
    semanticPaths = args.slice(0, -1);
  }

  process.stderr.write(`[evaluator] Found ${semanticPaths.length} semantic documents\n`);
  const summary = await evaluateCorpus(semanticPaths, outputDir);

  console.log("\n=== CORPUS EVALUATION SUMMARY ===\n");
  console.log(`Documents: ${summary.documentsEvaluated}`);
  console.log(`Versions:  ${summary.versionsCompared}`);
  console.log("");

  console.log("VERSION WINS:");
  for (const [vid, wins] of Object.entries(summary.versionWins).sort((a, b) => b[1] - a[1])) {
    const agg = summary.versionAggregates[vid];
    console.log(`  ${vid.padEnd(22)} ${String(wins).padStart(3)} wins  avg=${agg.meanAggregate.toFixed(3)}  reduction=${(agg.meanReduction * 100).toFixed(1)}%  coherence=${(agg.meanCoherence * 100).toFixed(1)}%  overMerge=${(agg.meanOverMerge * 100).toFixed(1)}%`);
  }

  if (summary.autoSelector) {
    console.log("\nAUTO-SELECTOR PERFORMANCE:");
    console.log(`  Oracle match rate: ${(summary.autoSelector.oracleMatchRate * 100).toFixed(1)}%`);
    console.log(`  Mean regret: ${summary.autoSelector.meanRegret.toFixed(3)}`);
    console.log(`  Max regret: ${summary.autoSelector.maxRegret.toFixed(3)}`);
    const dist = Object.entries(summary.autoSelector.selectionDistribution)
      .sort((a, b) => b[1] - a[1])
      .map(([vid, count]) => `${vid}: ${count}`)
      .join(", ");
    console.log(`  Selection distribution: ${dist}`);
  }

  console.log("\nPER-DOCUMENT BEST:");
  for (const doc of summary.perDocument) {
    console.log(`  ${doc.documentId.padEnd(40)} → ${doc.bestVersion} (${doc.bestScore.toFixed(3)})`);
  }

  console.log(`\nFull reports: ${outputDir}/`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
