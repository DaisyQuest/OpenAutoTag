import test from "node:test";
import assert from "node:assert/strict";
import { compareWriterModes, computeVerdict } from "../index.js";
import {
  measureContentPreservation,
  measureFileSizeRatio,
  measureStructureFidelity
} from "../lib/metrics.js";
import { renderProofReportHtml } from "../lib/proof-report-renderer.js";

test("proof report has all required top-level fields", async () => {
  // Use estimatedNative to avoid needing real PDF files
  const report = await compareWriterModes({
    pdfPath: import.meta.dirname + "/fixture-stub.pdf",
    estimatedNative: {
      fileSize: 100000,
      textSelectable: true,
      operatorCount: 200,
      linkCount: 3
    }
  });

  // Verify all required top-level fields
  assert.ok(report.document, "should have document field");
  assert.ok(report.modes, "should have modes field");
  assert.ok(report.modes.raster, "should have modes.raster");
  assert.ok(report.modes.native, "should have modes.native");
  assert.ok(report.comparison, "should have comparison field");
  assert.ok(typeof report.verdict === "string", "should have verdict string");
  assert.ok(typeof report.confidence === "number", "should have confidence number");

  // Verify raster mode fields
  const raster = report.modes.raster;
  assert.ok("fileSize" in raster, "raster should have fileSize");
  assert.ok("textSelectable" in raster, "raster should have textSelectable");
  assert.ok("nativeTextPreserved" in raster, "raster should have nativeTextPreserved");
  assert.ok("totalTextOperators" in raster, "raster should have totalTextOperators");
  assert.ok("linksPreserved" in raster, "raster should have linksPreserved");
  assert.ok("formFieldsPreserved" in raster, "raster should have formFieldsPreserved");

  // Verify native mode fields
  const native = report.modes.native;
  assert.ok("fileSize" in native, "native should have fileSize");
  assert.ok("textSelectable" in native, "native should have textSelectable");
  assert.ok("nativeTextPreserved" in native, "native should have nativeTextPreserved");
  assert.ok("totalTextOperators" in native, "native should have totalTextOperators");
  assert.ok("linksPreserved" in native, "native should have linksPreserved");
  assert.ok("formFieldsPreserved" in native, "native should have formFieldsPreserved");

  // Verify comparison fields
  const comp = report.comparison;
  assert.ok("fileSizeRatio" in comp, "should have fileSizeRatio");
  assert.ok("contentPreservationScore" in comp, "should have contentPreservationScore");
  assert.ok("structureFidelity" in comp, "should have structureFidelity");
  assert.ok("veraPdfFindingsDelta" in comp, "should have veraPdfFindingsDelta");
  assert.ok(Array.isArray(comp.nativeAdvantages), "nativeAdvantages should be array");
  assert.ok(Array.isArray(comp.nativeRisks), "nativeRisks should be array");
});

test("verdict is native-recommended when preservation > 0.9 and fidelity >= 0.85", () => {
  const { verdict, confidence } = computeVerdict({
    contentPreservationScore: 0.95,
    structureFidelity: 0.90,
    fileSizeRatio: 0.2,
    nativeTextSelectable: true
  });

  assert.equal(verdict, "native-recommended");
  assert.ok(confidence > 0, "confidence should be positive");
  assert.ok(confidence <= 1.0, "confidence should not exceed 1.0");
});

test("verdict is raster-preferred when preservation <= 0.9", () => {
  const { verdict } = computeVerdict({
    contentPreservationScore: 0.85,
    structureFidelity: 0.90,
    fileSizeRatio: 0.2,
    nativeTextSelectable: true
  });

  assert.equal(verdict, "raster-preferred");
});

test("verdict is raster-preferred when fidelity < 0.85", () => {
  const { verdict } = computeVerdict({
    contentPreservationScore: 0.95,
    structureFidelity: 0.80,
    fileSizeRatio: 0.2,
    nativeTextSelectable: true
  });

  assert.equal(verdict, "raster-preferred");
});

test("file size ratio computed correctly", () => {
  assert.equal(measureFileSizeRatio(1000000, 50000), 0.05);
  assert.equal(measureFileSizeRatio(500000, 500000), 1.0);
  assert.equal(measureFileSizeRatio(100, 200), 2.0);
});

test("file size ratio handles zero raster size", () => {
  assert.equal(measureFileSizeRatio(0, 0), 1.0);
  assert.equal(measureFileSizeRatio(0, 100), Infinity);
});

test("content preservation score is ratio of operators", () => {
  assert.equal(measureContentPreservation(369, 369), 1.0);
  assert.equal(measureContentPreservation(0, 369), 0);
  assert.ok(Math.abs(measureContentPreservation(350, 369) - 350 / 369) < 0.001);
});

test("content preservation is 1.0 when both are zero", () => {
  assert.equal(measureContentPreservation(0, 0), 1.0);
});

test("content preservation is capped at 1.0", () => {
  assert.equal(measureContentPreservation(400, 369), 1.0);
});

test("structure fidelity returns 1.0 for identical trees", () => {
  const tree = {
    type: "Document",
    children: [
      { type: "H1", children: [] },
      { type: "P", children: [] }
    ]
  };
  assert.equal(measureStructureFidelity(tree, tree), 1.0);
});

test("structure fidelity returns 0.0 when one tree is null", () => {
  const tree = { type: "Document", children: [] };
  assert.equal(measureStructureFidelity(tree, null), 0.0);
  assert.equal(measureStructureFidelity(null, tree), 0.0);
});

test("structure fidelity returns 1.0 when both are null", () => {
  assert.equal(measureStructureFidelity(null, null), 1.0);
});

test("proof report HTML renderer produces valid HTML", () => {
  const report = {
    document: "test.pdf",
    modes: {
      raster: {
        fileSize: 5000000,
        textSelectable: false,
        nativeTextPreserved: 0,
        totalTextOperators: 0,
        linksPreserved: 0,
        formFieldsPreserved: 0
      },
      native: {
        fileSize: 200000,
        textSelectable: true,
        nativeTextPreserved: 100,
        totalTextOperators: 100,
        linksPreserved: 2,
        formFieldsPreserved: 0
      }
    },
    comparison: {
      fileSizeRatio: 0.04,
      contentPreservationScore: 1.0,
      structureFidelity: 0.95,
      veraPdfFindingsDelta: 0,
      nativeAdvantages: ["25x smaller file size"],
      nativeRisks: []
    },
    verdict: "native-recommended",
    confidence: 0.95
  };

  const html = renderProofReportHtml(report);
  assert.ok(html.includes("<!DOCTYPE html>"), "should be valid HTML document");
  assert.ok(html.includes("test.pdf"), "should include document name");
  assert.ok(html.includes("Native Recommended"), "should include verdict badge");
  assert.ok(html.includes("25x smaller file size"), "should include advantages");
});
