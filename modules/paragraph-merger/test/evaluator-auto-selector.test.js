import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateDocument, loadVersions } from "../evaluator.js";

/**
 * Build a minimal semantic document that passes the schema validation
 * required by mergeParagraphs.
 */
function makeSemanticDoc(nodeCount, { pages = 2, textLen = 80, columnHint = 0, confidence = 0.95 } = {}) {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const page = (i % pages) + 1;
    nodes.push({
      id: `node-${i}`,
      pageNumber: page,
      sourceBlockId: `block-${i}`,
      role: "P",
      text: "The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(textLen / 46)).slice(0, textLen),
      bbox: [50, 50 + i * 20, 400, 14],
      confidence,
      columnHint,
    });
  }
  return {
    schemaVersion: "1.0.0",
    documentId: "test-doc-auto-selector",
    source: { layoutDocumentId: "layout-test" },
    nodes,
  };
}

describe("evaluateDocument — autoSelector section", () => {
  let versions;

  it("loads versions successfully", async () => {
    versions = await loadVersions();
    assert.ok(versions.length > 0, "should load at least one version");
  });

  it("includes autoSelector in the improvement report", async () => {
    if (!versions) versions = await loadVersions();

    const doc = makeSemanticDoc(30, { pages: 3 });
    const { improvementReport } = await evaluateDocument("test-doc", doc, versions);

    // autoSelector section must exist
    assert.ok(improvementReport.autoSelector, "report should have autoSelector section");

    const auto = improvementReport.autoSelector;

    // Required fields
    assert.ok(typeof auto.selectedVersionId === "string", "selectedVersionId must be a string");
    assert.ok(typeof auto.confidence === "number", "confidence must be a number");
    assert.ok(Array.isArray(auto.reasoning), "reasoning must be an array");
    assert.ok(auto.reasoning.length > 0, "reasoning must not be empty");
    assert.ok(auto.features, "features must be present");
    assert.ok(typeof auto.features.totalNodes === "number", "features.totalNodes must be a number");

    // Oracle comparison fields
    assert.ok(typeof auto.oracleVersionId === "string", "oracleVersionId must be a string");
    assert.ok(typeof auto.oracleScore === "number", "oracleScore must be a number");
    assert.ok(typeof auto.matchesOracle === "boolean", "matchesOracle must be a boolean");
    assert.ok(typeof auto.regretVsOracle === "number", "regretVsOracle must be a number");
    assert.ok(auto.regretVsOracle >= 0, "regretVsOracle must be non-negative");

    // selectedScore is either a number or null
    assert.ok(auto.selectedScore === null || typeof auto.selectedScore === "number",
      "selectedScore must be a number or null");
  });

  it("selectedVersionId matches one of the loaded versions", async () => {
    if (!versions) versions = await loadVersions();

    const doc = makeSemanticDoc(30, { pages: 3 });
    const { improvementReport } = await evaluateDocument("test-doc-2", doc, versions);

    const versionIds = versions.map(v => v.versionId);
    assert.ok(
      versionIds.includes(improvementReport.autoSelector.selectedVersionId),
      `selectedVersionId '${improvementReport.autoSelector.selectedVersionId}' must be one of the loaded versions`
    );
  });

  it("regretVsOracle is zero when autoSelector matches oracle", async () => {
    if (!versions) versions = await loadVersions();

    // Run on a document; if it happens to match oracle, regret should be 0
    const doc = makeSemanticDoc(30, { pages: 3 });
    const { improvementReport } = await evaluateDocument("test-doc-3", doc, versions);
    const auto = improvementReport.autoSelector;

    if (auto.matchesOracle) {
      assert.equal(auto.regretVsOracle, 0, "regret must be 0 when matching oracle");
      assert.equal(auto.selectedScore, auto.oracleScore, "scores must match when matching oracle");
    } else {
      // Regret is >= 0; could be 0 if scores happen to tie
      assert.ok(auto.regretVsOracle >= 0, "regret must be non-negative when not matching oracle");
    }
  });
});
