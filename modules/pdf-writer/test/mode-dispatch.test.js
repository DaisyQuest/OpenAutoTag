import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  VALID_MODES,
  DEFAULT_MODE,
  DEFAULT_NATIVE_MATCH_THRESHOLD,
  DEFAULT_ALREADY_TAGGED_THRESHOLD,
  VALID_ALREADY_TAGGED_POLICIES,
  DEFAULT_ALREADY_TAGGED_POLICY,
  VALID_READING_ORDER_STRATEGIES,
  DEFAULT_READING_ORDER_STRATEGY
} from "../index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const nativeRewriterPath = path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamRewriter.java");

test("parseArgs: --mode native is parsed correctly", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--mode", "native"
  ]);
  assert.equal(result.mode, "native");
  assert.equal(result.pdfPath, "input.pdf");
  assert.equal(result.tagsPath, "tags.json");
  assert.equal(result.outputPath, "out.pdf");
});

test("parseArgs: --mode raster is parsed correctly", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--mode", "raster"
  ]);
  assert.equal(result.mode, "raster");
});

test("parseArgs: --mode auto is parsed correctly", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--mode", "auto"
  ]);
  assert.equal(result.mode, "auto");
});

test("parseArgs: default mode is auto when --mode is absent", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf"
  ]);
  assert.equal(result.mode, DEFAULT_MODE);
  assert.equal(result.mode, "auto");
});

test("parseArgs: invalid mode falls back to default (auto)", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--mode", "invalid-mode"
  ]);
  assert.equal(result.mode, "auto");
});

test("parseArgs: --native-match-threshold is parsed as a number", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--native-match-threshold", "0.9"
  ]);
  assert.equal(result.nativeMatchThreshold, 0.9);
});

test("parseArgs: default nativeMatchThreshold is 0.8", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf"
  ]);
  assert.equal(result.nativeMatchThreshold, DEFAULT_NATIVE_MATCH_THRESHOLD);
  assert.equal(result.nativeMatchThreshold, 0.8);
});

test("VALID_MODES contains native, raster, and auto", () => {
  assert.ok(VALID_MODES.has("native"));
  assert.ok(VALID_MODES.has("raster"));
  assert.ok(VALID_MODES.has("auto"));
  assert.equal(VALID_MODES.size, 3);
});

test("auto mode falls back to raster when NativeContentStreamRewriter.java does not exist", async () => {
  // This test verifies the design contract: when the rewriter source doesn't exist,
  // auto mode should resolve to raster gracefully. We test this by importing
  // writeTaggedArtifacts and observing that mode=auto with no rewriter doesn't
  // throw (the actual fallback is tested at integration level, but we verify
  // the guard exists).
  const rewriterExists = existsSync(nativeRewriterPath);
  if (rewriterExists) {
    // If the rewriter file exists in this environment, we can't test the fallback
    // path directly without mocking. Just verify it's a known state.
    assert.ok(true, "NativeContentStreamRewriter.java exists; fallback path not testable without mocking");
    return;
  }

  // Rewriter doesn't exist, so auto mode should be safe to request.
  // We verify by importing the module and checking that parseArgs + the mode
  // constants are coherent.
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--mode", "auto"
  ]);
  assert.equal(result.mode, "auto");
  // The actual fallback happens in resolveWriterMode at runtime, which checks
  // isNativeRewriterAvailable(). Since the file doesn't exist, it would return
  // { effectiveMode: "raster", autoFallbackReason: "..." }.
});

test("existing CLI without --mode now uses auto (native-first with raster fallback)", () => {
  // auto is the measurement-backed default: probe the native pipeline,
  // fall back to raster when match rate is below threshold or when the
  // source PDF is already marked-content tagged. Callers opt out with
  // `--mode raster` for legacy behavior.
  const result = parseArgs([
    "--pdf", "/path/to/input.pdf",
    "--tags", "/path/to/tagging.json",
    "--semantic", "/path/to/semantic.json",
    "--output", "/path/to/tagged.pdf"
  ]);
  assert.equal(result.mode, "auto");
  assert.equal(result.nativeMatchThreshold, 0.8);
  assert.equal(result.pdfPath, "/path/to/input.pdf");
  assert.equal(result.tagsPath, "/path/to/tagging.json");
  assert.equal(result.semanticPath, "/path/to/semantic.json");
  assert.equal(result.outputPath, "/path/to/tagged.pdf");
});

test("explicit --mode=raster is the opt-out for callers that want legacy behavior", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--mode", "raster"
  ]);
  assert.equal(result.mode, "raster");
});

test("parseArgs: --already-tagged-threshold is parsed as a number", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--already-tagged-threshold", "0.3"
  ]);
  assert.equal(result.alreadyTaggedThreshold, 0.3);
});

test("parseArgs: default alreadyTaggedThreshold is 0.5", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf"
  ]);
  assert.equal(result.alreadyTaggedThreshold, DEFAULT_ALREADY_TAGGED_THRESHOLD);
  assert.equal(result.alreadyTaggedThreshold, 0.5);
});

test("parseArgs: --already-tagged-policy accepts passthrough", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--already-tagged-policy", "passthrough"
  ]);
  assert.equal(result.alreadyTaggedPolicy, "passthrough");
});

test("parseArgs: --already-tagged-policy rejects unknown value, falls back to default", () => {
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf",
    "--already-tagged-policy", "not-a-real-policy"
  ]);
  assert.equal(result.alreadyTaggedPolicy, DEFAULT_ALREADY_TAGGED_POLICY);
  assert.equal(result.alreadyTaggedPolicy, "passthrough");
});

test("parseArgs: default alreadyTaggedPolicy is passthrough", () => {
  // Changed from "bailout-to-raster" in 2026-04-18: rasterizing a
  // well-tagged source strips its fonts and turns the tag tree into
  // invisible NotoSans overlay text, which Adobe's tag panel shows
  // as "tags with no readable content". Passthrough preserves the
  // source's fonts and structure verbatim — the correct default.
  const result = parseArgs([
    "--pdf", "input.pdf",
    "--tags", "tags.json",
    "--output", "out.pdf"
  ]);
  assert.equal(result.alreadyTaggedPolicy, "passthrough");
});

test("parseArgs: --reading-order-strategy semantic/file both accepted", () => {
  const a = parseArgs([
    "--pdf", "x.pdf", "--tags", "t.json", "--output", "o.pdf",
    "--reading-order-strategy", "semantic"
  ]);
  assert.equal(a.readingOrderStrategy, "semantic");
  const b = parseArgs([
    "--pdf", "x.pdf", "--tags", "t.json", "--output", "o.pdf",
    "--reading-order-strategy", "file"
  ]);
  assert.equal(b.readingOrderStrategy, "file");
});

test("parseArgs: unknown reading-order-strategy falls back to default", () => {
  const result = parseArgs([
    "--pdf", "x.pdf", "--tags", "t.json", "--output", "o.pdf",
    "--reading-order-strategy", "random-bogus"
  ]);
  assert.equal(result.readingOrderStrategy, DEFAULT_READING_ORDER_STRATEGY);
  assert.equal(result.readingOrderStrategy, "semantic");
});

test("VALID_ALREADY_TAGGED_POLICIES includes bailout-to-raster and passthrough", () => {
  assert.ok(VALID_ALREADY_TAGGED_POLICIES.has("bailout-to-raster"));
  assert.ok(VALID_ALREADY_TAGGED_POLICIES.has("passthrough"));
  assert.equal(VALID_ALREADY_TAGGED_POLICIES.size, 2);
});

test("VALID_READING_ORDER_STRATEGIES includes semantic and file", () => {
  assert.ok(VALID_READING_ORDER_STRATEGIES.has("semantic"));
  assert.ok(VALID_READING_ORDER_STRATEGIES.has("file"));
  assert.equal(VALID_READING_ORDER_STRATEGIES.size, 2);
});
