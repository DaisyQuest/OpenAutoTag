import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDocumentReport, renderCorpusSummary } from "../lib/report-renderer.js";

const sampleDocReport = {
  documentId: "test-doc-001",
  originalNodeCount: 120,
  originalParagraphCount: 40,
  versions: [
    {
      versionId: "v1-baseline",
      label: "Baseline",
      nodesOut: 80,
      paragraphsOut: 25,
      mergeCount: 15,
      skipCount: 5,
      reductionPercent: 33.3,
      scores: {
        nodeReduction: 0.333,
        paragraphCoherence: 0.85,
        overMergeRate: 0.05,
        underMergeRate: 0.1,
        skipExplainability: 0.9,
        aggregate: 0.72
      },
      interestingMerges: [
        { page: 1, blocks: ["B1", "B2"], confidence: 0.45, reasons: ["Font mismatch"], flag: "risky-merge" }
      ],
      interestingSkips: [
        { page: 2, blocks: ["B5", "B6"], confidence: 0.55, gap: 12, reasons: ["Large gap"], flag: "borderline-skip" }
      ]
    },
    {
      versionId: "v2-aggressive",
      label: "Aggressive",
      nodesOut: 60,
      paragraphsOut: 18,
      mergeCount: 22,
      skipCount: 3,
      reductionPercent: 50,
      scores: {
        nodeReduction: 0.5,
        paragraphCoherence: 0.7,
        overMergeRate: 0.15,
        underMergeRate: 0.05,
        skipExplainability: 0.8,
        aggregate: 0.65
      },
      interestingMerges: [],
      interestingSkips: []
    }
  ],
  bestVersion: { versionId: "v1-baseline", aggregateScore: 0.72 },
  comparison: [
    { rank: 1, versionId: "v1-baseline", aggregate: "0.720", nodeReduction: "33.3%", coherence: "85.0%", overMerge: "5.0%", underMerge: "10.0%", riskyMerges: 1, borderlineSkips: 1 },
    { rank: 2, versionId: "v2-aggressive", aggregate: "0.650", nodeReduction: "50.0%", coherence: "70.0%", overMerge: "15.0%", underMerge: "5.0%", riskyMerges: 0, borderlineSkips: 0 }
  ]
};

const sampleCorpusSummary = {
  documentsEvaluated: 3,
  versionsCompared: 2,
  versionWins: { "v1-baseline": 2, "v2-aggressive": 1 },
  versionAggregates: {
    "v1-baseline": {
      label: "Baseline", wins: 2, meanAggregate: 0.72,
      meanReduction: 0.33, meanCoherence: 0.85, meanOverMerge: 0.05, meanUnderMerge: 0.1,
      totalRiskyMerges: 2, totalBorderlineSkips: 1
    },
    "v2-aggressive": {
      label: "Aggressive", wins: 1, meanAggregate: 0.65,
      meanReduction: 0.5, meanCoherence: 0.7, meanOverMerge: 0.15, meanUnderMerge: 0.05,
      totalRiskyMerges: 0, totalBorderlineSkips: 0
    }
  },
  perDocument: [
    { documentId: "doc-A", bestVersion: "v1-baseline", bestScore: 0.75, comparison: [
      { rank: 1, versionId: "v1-baseline", aggregate: "0.750" },
      { rank: 2, versionId: "v2-aggressive", aggregate: "0.600" }
    ]},
    { documentId: "doc-B", bestVersion: "v1-baseline", bestScore: 0.71, comparison: [
      { rank: 1, versionId: "v1-baseline", aggregate: "0.710" },
      { rank: 2, versionId: "v2-aggressive", aggregate: "0.690" }
    ]},
    { documentId: "doc-C", bestVersion: "v2-aggressive", bestScore: 0.68, comparison: [
      { rank: 1, versionId: "v2-aggressive", aggregate: "0.680" },
      { rank: 2, versionId: "v1-baseline", aggregate: "0.640" }
    ]}
  ]
};

describe("renderDocumentReport", () => {
  it("returns HTML with a table and version IDs", () => {
    const html = renderDocumentReport(sampleDocReport);
    assert.ok(html.includes("<table"), "should contain a <table");
    assert.ok(html.includes("v1-baseline"), "should contain version v1-baseline");
    assert.ok(html.includes("v2-aggressive"), "should contain version v2-aggressive");
    assert.ok(html.includes("test-doc-001"), "should contain document ID");
  });

  it("renders confidence badges and flags", () => {
    const html = renderDocumentReport(sampleDocReport);
    assert.ok(html.includes("badge-red"), "should have red badge for confidence 0.45");
    assert.ok(html.includes("risky-merge"), "should have risky-merge flag");
    assert.ok(html.includes("borderline-skip"), "should have borderline-skip flag");
  });
});

describe("renderCorpusSummary", () => {
  it("returns HTML containing Version Leaderboard", () => {
    const html = renderCorpusSummary(sampleCorpusSummary);
    assert.ok(html.includes("Version Leaderboard"), "should contain 'Version Leaderboard'");
    assert.ok(html.includes("<table"), "should contain a <table");
    assert.ok(html.includes("v1-baseline"), "should contain version v1-baseline");
    assert.ok(html.includes("v2-aggressive"), "should contain version v2-aggressive");
  });

  it("renders per-document matrix", () => {
    const html = renderCorpusSummary(sampleCorpusSummary);
    assert.ok(html.includes("doc-A"), "should contain document doc-A");
    assert.ok(html.includes("Per-Document Matrix"), "should contain matrix heading");
  });

  it("renders improvement opportunities", () => {
    const html = renderCorpusSummary(sampleCorpusSummary);
    assert.ok(html.includes("Improvement Opportunities"), "should contain opportunities section");
  });
});
