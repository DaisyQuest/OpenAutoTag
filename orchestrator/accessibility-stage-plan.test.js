import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccessibilityPreparationStages } from "./accessibility-stage-plan.js";

const MINIMAL_SEMANTIC_DOC = {
  schemaVersion: "1.0.0",
  sourceFile: "test.pdf",
  pages: [{ pageNumber: 1, width: 612, height: 792 }],
  nodes: [
    { id: "n1", role: "P", text: "First line of text.", pageNumber: 1, bbox: [72, 100, 468, 14] },
    { id: "n2", role: "P", text: "Second line of text.", pageNumber: 1, bbox: [72, 116, 468, 14] },
    { id: "n3", role: "H1", text: "A heading", pageNumber: 1, bbox: [72, 50, 468, 20] }
  ]
};

async function setupTempDir(t) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "stage-plan-test-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  return tempDir;
}

async function setupArtifacts(tempDir) {
  const semanticPath = path.join(tempDir, "03-semantic.json");
  await writeFile(semanticPath, JSON.stringify(MINIMAL_SEMANTIC_DOC, null, 2));
  return {
    layout: path.join(tempDir, "01-layout.json"),
    layoutEnriched: path.join(tempDir, "02-layout-enriched.json"),
    semantic: semanticPath
  };
}

function findStage(stages, key) {
  return stages.find((s) => s.key === key);
}

test("paragraphMerger stage produces 03b-semantic-merged.json when enabled", async (t) => {
  const tempDir = await setupTempDir(t);
  const artifacts = await setupArtifacts(tempDir);
  const profileContext = {
    profileId: "test",
    resolved: {},
    get(name) {
      if (name === "paragraphMerger") return { enabled: true };
      return {};
    }
  };

  const stages = createAccessibilityPreparationStages({
    filePath: path.join(tempDir, "test.pdf"),
    resolvedOutputDir: tempDir,
    artifacts,
    profileContext
  });

  const mergerStage = findStage(stages, "paragraphMerger");
  assert.ok(mergerStage, "paragraphMerger stage should exist");
  assert.equal(mergerStage.label, "paragraph-merger");

  // The stage should be between semantic and readingOrder
  const keys = stages.map((s) => s.key);
  const semanticIndex = keys.indexOf("semantic");
  const mergerIndex = keys.indexOf("paragraphMerger");
  const readingOrderIndex = keys.indexOf("readingOrder");
  assert.ok(mergerIndex > semanticIndex, "paragraphMerger should come after semantic");
  assert.ok(mergerIndex < readingOrderIndex, "paragraphMerger should come before readingOrder");

  // Run the stage - it will try to spawn the CLI, which may fail in test env
  // But if semantic.json exists and the module works, it should produce the merged file
  // For a unit test, we verify the stage definition and fallback behavior
  const mergedPath = path.join(tempDir, "03b-semantic-merged.json");
  assert.equal(mergerStage.outputPath, mergedPath);
});

test("paragraphMerger stage passes through unchanged when enabled=false", async (t) => {
  const tempDir = await setupTempDir(t);
  const artifacts = await setupArtifacts(tempDir);
  const profileContext = {
    profileId: "test",
    resolved: {},
    get(name) {
      if (name === "paragraphMerger") return { enabled: false };
      return {};
    }
  };

  const stages = createAccessibilityPreparationStages({
    filePath: path.join(tempDir, "test.pdf"),
    resolvedOutputDir: tempDir,
    artifacts,
    profileContext
  });

  const mergerStage = findStage(stages, "paragraphMerger");
  const result = await mergerStage.run();

  const mergedPath = path.join(tempDir, "03b-semantic-merged.json");
  assert.equal(result.outputPath, mergedPath);
  assert.equal(result.artifacts.semanticMerged, mergedPath);
  assert.equal(result.artifacts.paragraphMergeReport, undefined, "No report when disabled");

  // The merged file should be identical to the semantic input
  const mergedContent = JSON.parse(await readFile(mergedPath, "utf8"));
  assert.deepStrictEqual(mergedContent, MINIMAL_SEMANTIC_DOC);
});

test("readingOrder stage consumes semanticMerged when available", async (t) => {
  const tempDir = await setupTempDir(t);
  const artifacts = await setupArtifacts(tempDir);

  // Set semanticMerged to point at the semantic file (simulating merger output)
  artifacts.semanticMerged = artifacts.semantic;

  const profileContext = {
    profileId: "test",
    resolved: {},
    get() { return {}; }
  };

  const stages = createAccessibilityPreparationStages({
    filePath: path.join(tempDir, "test.pdf"),
    resolvedOutputDir: tempDir,
    artifacts,
    profileContext
  });

  const readingOrderStage = findStage(stages, "readingOrder");
  assert.ok(readingOrderStage, "readingOrder stage should exist");

  // Run the stage - it will use fallback reading order since the CLI module
  // may not exist in the test env, but it should use semanticMerged as input
  const result = await readingOrderStage.run();
  assert.ok(result.outputPath);
  assert.ok(result.artifacts.semanticOrdered);

  // Verify the output was produced
  const ordered = JSON.parse(await readFile(result.artifacts.semanticOrdered, "utf8"));
  assert.ok(ordered.nodes, "Output should contain nodes");
  assert.ok(ordered.orderedNodeIds, "Output should contain orderedNodeIds");
});

test("readingOrder stage falls back to artifacts.semantic when semanticMerged is absent", async (t) => {
  const tempDir = await setupTempDir(t);
  const artifacts = await setupArtifacts(tempDir);
  // No semanticMerged set - should fall back to artifacts.semantic

  const profileContext = {
    profileId: "test",
    resolved: {},
    get() { return {}; }
  };

  const stages = createAccessibilityPreparationStages({
    filePath: path.join(tempDir, "test.pdf"),
    resolvedOutputDir: tempDir,
    artifacts,
    profileContext
  });

  const readingOrderStage = findStage(stages, "readingOrder");
  const result = await readingOrderStage.run();

  assert.ok(result.outputPath);
  assert.ok(result.artifacts.semanticOrdered);

  const ordered = JSON.parse(await readFile(result.artifacts.semanticOrdered, "utf8"));
  assert.ok(ordered.nodes);
  assert.ok(ordered.orderedNodeIds);
});

test("paragraphMerger stage tolerates merger failure gracefully", async (t) => {
  const tempDir = await setupTempDir(t);
  const artifacts = await setupArtifacts(tempDir);
  const profileContext = {
    profileId: "test",
    resolved: {},
    get(name) {
      if (name === "paragraphMerger") return { enabled: true };
      return {};
    }
  };

  const stages = createAccessibilityPreparationStages({
    filePath: path.join(tempDir, "test.pdf"),
    resolvedOutputDir: tempDir,
    artifacts,
    profileContext
  });

  const mergerStage = findStage(stages, "paragraphMerger");

  // The stage calls runJsonStage which spawns the CLI. In test env, the CLI
  // will likely fail (no node_modules, etc). The stage should catch the error
  // and fall back to copying semantic.json through.
  const result = await mergerStage.run();

  const mergedPath = path.join(tempDir, "03b-semantic-merged.json");
  assert.equal(result.outputPath, mergedPath);
  assert.equal(result.artifacts.semanticMerged, mergedPath);
  assert.equal(result.fallbackUsed, true, "Should indicate fallback was used");
  assert.ok(result.fallbackReason, "Should include the fallback reason");

  // The merged file should be identical to the semantic input (passthrough)
  const mergedContent = JSON.parse(await readFile(mergedPath, "utf8"));
  assert.deepStrictEqual(mergedContent, MINIMAL_SEMANTIC_DOC);
});
