import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeParagraphs } from "../index.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function makeDoc(nodes) {
  return {
    sourceFile: "test.pdf",
    pageCount: 1,
    nodes
  };
}

function makeNode(id, text, bbox, role = "P", extra = {}) {
  return { id, role, text, bbox, pageNumber: 1, ...extra };
}

const BASE_CONFIG = {
  enabled: true,
  gapMultiplier: 1.8,
  xAlignmentTolerance: 12,
  heightVarianceTolerance: 0.3,
  minConfidence: 0.5,
  sentenceBoundaryPenalty: 0.3,
  reportUnmerged: true
};

describe("artifactPreFilter heuristic", () => {
  it("removes Artifact nodes before merge when enabled", () => {
    const nodes = [
      makeNode("a1", "Header stamp", [50, 10, 200, 12], "Artifact", { artifactType: "Pagination" }),
      makeNode("p1", "First paragraph line.", [50, 50, 200, 12]),
      makeNode("p2", "Second paragraph line.", [50, 64, 200, 12])
    ];
    const doc = makeDoc(nodes);

    const withFilter = mergeParagraphs(doc, {
      ...BASE_CONFIG,
      heuristics: { artifactPreFilter: true }
    });

    const withoutFilter = mergeParagraphs(doc, {
      ...BASE_CONFIG,
      heuristics: { artifactPreFilter: false }
    });

    // With filter: artifact should be removed from output
    const artifactNodes = withFilter.document.nodes.filter(
      (n) => n.role === "Artifact"
    );
    assert.equal(artifactNodes.length, 0, "Artifact nodes should be removed when artifactPreFilter is true");

    // Without filter: artifact should still be present
    const artifactNodesWithout = withoutFilter.document.nodes.filter(
      (n) => n.role === "Artifact"
    );
    assert.equal(artifactNodesWithout.length, 1, "Artifact nodes should remain when artifactPreFilter is false");
  });
});

describe("hangingIndentDetection heuristic", () => {
  it("reduces x-alignment penalty so indented lines merge", () => {
    // x-shift of 50px exceeds tolerance of 12px
    // penalty without heuristic: min(0.4, (50-12)/60) = min(0.4, 0.633) = 0.4
    // confidence without heuristic: 1.0 - 0.4 = 0.6 (below 0.65 threshold)
    // penalty with heuristic: 0.4 * 0.4 = 0.16
    // confidence with heuristic: 1.0 - 0.16 = 0.84 (above 0.65 threshold)
    const nodes = [
      makeNode("p1", "First line of paragraph", [50, 50, 300, 12]),
      makeNode("p2", "continuation of paragraph", [100, 64, 250, 12])
    ];
    const doc = makeDoc(nodes);

    const sharedConfig = {
      ...BASE_CONFIG,
      minConfidence: 0.65,
      xAlignmentTolerance: 12
    };

    const withHeuristic = mergeParagraphs(doc, {
      ...sharedConfig,
      heuristics: { hangingIndentDetection: true }
    });

    const withoutHeuristic = mergeParagraphs(doc, {
      ...sharedConfig,
      heuristics: { hangingIndentDetection: false }
    });

    // With heuristic: the reduced penalty should allow merging
    assert.equal(
      withHeuristic.report.summary.totalMerges,
      1,
      "Should merge with hanging indent detection enabled"
    );

    // Without heuristic: the full penalty should prevent merging
    assert.equal(
      withoutHeuristic.report.summary.totalMerges,
      0,
      "Should skip merge without hanging indent detection"
    );
  });
});

describe("continuationLineDetection heuristic", () => {
  it("boosts confidence when prev ends with conjunction", () => {
    // Create a borderline case that needs the boost to merge
    const nodes = [
      makeNode("p1", "The court held that the defendant and", [50, 50, 300, 12]),
      makeNode("p2", "The plaintiff were both liable.", [50, 64, 300, 12])
    ];
    const doc = makeDoc(nodes);

    const withHeuristic = mergeParagraphs(doc, {
      ...BASE_CONFIG,
      minConfidence: 0.75,
      sentenceBoundaryPenalty: 0.3,
      heuristics: { continuationLineDetection: true }
    });

    // "and" at end => continuation detected => +0.15 boost
    assert.equal(
      withHeuristic.report.summary.totalMerges,
      1,
      "Should merge when continuation line detection finds trailing conjunction"
    );
  });

  it("does not boost when prev ends normally", () => {
    const nodes = [
      makeNode("p1", "The court held that the defendant lost.", [50, 50, 300, 12]),
      makeNode("p2", "The plaintiff won the case.", [50, 64, 300, 12])
    ];
    const doc = makeDoc(nodes);

    const result = mergeParagraphs(doc, {
      ...BASE_CONFIG,
      heuristics: { continuationLineDetection: true }
    });

    // Sentence boundary detected (period + capital), no continuation signal
    const reasons = result.report.pages[0]?.merges[0]?.reasons || [];
    const hasBoost = reasons.some((r) => r.includes("continuation line"));
    assert.equal(hasBoost, false, "Should not boost when line ends with period and next starts capital");
  });
});

describe("legalCitationAwareness heuristic", () => {
  it("reduces sentence-boundary penalty for legal citations", () => {
    // Use a citation that matches the isLegalCitation regex: \d+\s+N.Y.\d
    // "See 123 N.Y.2d 456." matches \b123\s+N\.?Y\.?\s*2 => true
    const nodes = [
      makeNode("p1", "See 123 N.Y.2d 456.", [50, 50, 300, 12]),
      makeNode("p2", "The court found that the evidence was sufficient.", [50, 64, 300, 12])
    ];
    const doc = makeDoc(nodes);

    const sharedConfig = {
      ...BASE_CONFIG,
      sentenceBoundaryPenalty: 0.5,
      minConfidence: 0.55
    };

    const withHeuristic = mergeParagraphs(doc, {
      ...sharedConfig,
      heuristics: { legalCitationAwareness: true }
    });

    const withoutHeuristic = mergeParagraphs(doc, {
      ...sharedConfig,
      heuristics: { legalCitationAwareness: false }
    });

    assert.equal(
      withHeuristic.report.summary.totalMerges,
      1,
      "Should merge with legal citation awareness (penalty reduced by 80%)"
    );

    assert.equal(
      withoutHeuristic.report.summary.totalMerges,
      0,
      "Should not merge without legal citation awareness (full penalty applied)"
    );
  });
});

describe("v6-hybrid config", () => {
  it("loads and has valid structure", async () => {
    const configPath = path.join(moduleDir, "..", "versions", "v6-hybrid.json");
    const raw = await readFile(configPath, "utf8");
    const v6 = JSON.parse(raw);

    assert.equal(v6.versionId, "v6-hybrid");
    assert.equal(v6.config.enabled, true);
    assert.equal(v6.config.gapMultiplier, 2.0);
    assert.equal(v6.config.xAlignmentTolerance, 18);
    assert.equal(v6.config.heightVarianceTolerance, 0.35);
    assert.equal(v6.config.minConfidence, 0.35);
    assert.equal(v6.config.sentenceBoundaryPenalty, 0.2);
    assert.equal(v6.config.reportUnmerged, true);

    assert.equal(v6.heuristics.hangingIndentDetection, true);
    assert.equal(v6.heuristics.artifactPreFilter, true);
    assert.equal(v6.heuristics.continuationLineDetection, true);
    assert.equal(v6.heuristics.legalCitationAwareness, true);
  });

  it("works with mergeParagraphs", async () => {
    const configPath = path.join(moduleDir, "..", "versions", "v6-hybrid.json");
    const v6 = JSON.parse(await readFile(configPath, "utf8"));

    const doc = makeDoc([
      makeNode("p1", "First line", [50, 50, 300, 12]),
      makeNode("p2", "second line", [50, 64, 300, 12])
    ]);

    const result = mergeParagraphs(doc, {
      ...v6.config,
      heuristics: v6.heuristics
    });

    assert.ok(result.document, "Should return a document");
    assert.ok(result.report, "Should return a report");
    assert.equal(result.report.enabled, true);
  });
});
