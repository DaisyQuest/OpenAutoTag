import test from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, compareDocuments, extractDocumentMetrics, summarizeComparison } from "../../orchestrator/diff-engine.js";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function makeValidationReport(overrides = {}) {
  return {
    isCompliant: false,
    engine: { name: "veraPDF", version: "1.28.2" },
    summary: { failedRules: 4, failedChecks: 7 },
    metadataDiagnostics: {
      metadataPresent: true,
      dcTitleDetected: true,
      pdfUaIdentificationDetected: false,
      infoMatchesXmp: true,
      suspectedVeraPdfMetadataMismatch: false
    },
    findings: [
      { code: "TAG-001", description: "Missing tag", clause: "1.1", failedChecks: 2, severity: "error" },
      { code: "META-001", description: "No language", clause: "1.2", failedChecks: 1, severity: "warning" }
    ],
    ...overrides
  };
}

function makeCompliantReport() {
  return makeValidationReport({
    isCompliant: true,
    summary: { failedRules: 0, failedChecks: 0 },
    metadataDiagnostics: {
      metadataPresent: true,
      dcTitleDetected: true,
      pdfUaIdentificationDetected: true,
      infoMatchesXmp: true,
      suspectedVeraPdfMetadataMismatch: false
    },
    findings: []
  });
}

function makeWriterReport(overrides = {}) {
  return {
    writerMode: "auto",
    pagesNative: 5,
    pagesRaster: 1,
    matchRate: 0.85,
    ...overrides
  };
}

function makeFontReport(overrides = {}) {
  return {
    grade: "B+",
    issues: [{ type: "missing-tounicode" }],
    fonts: [{}, {}, {}],
    ...overrides
  };
}

function makeTagDeltaReport(overrides = {}) {
  return {
    delta: {
      structTreeAdded: true,
      totalTypedNodesDelta: 42,
      markedContentOperatorCountDelta: 88,
      tableAttributeNodeCountDelta: 3,
      ...overrides
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  extractDocumentMetrics                                                    */
/* -------------------------------------------------------------------------- */

test("extractDocumentMetrics returns metrics for all categories", () => {
  const doc = {
    id: "test",
    label: "Test",
    validationReport: makeValidationReport(),
    writerReport: makeWriterReport(),
    fontReport: makeFontReport(),
    tagDeltaReport: makeTagDeltaReport()
  };

  const metrics = extractDocumentMetrics(doc);

  for (const cat of CATEGORIES) {
    assert.ok(cat.id in metrics, `Missing metric for category ${cat.id}`);
  }
});

test("extractDocumentMetrics handles missing reports gracefully", () => {
  const doc = { id: "empty", label: "Empty" };
  const metrics = extractDocumentMetrics(doc);
  assert.ok(metrics["pdfua-compliance"] === null);
  assert.ok(metrics["metadata-quality"] === null);
  assert.ok(metrics["font-health"] === null);
});

test("extractDocumentMetrics extracts compliance metrics correctly", () => {
  const doc = {
    id: "t",
    label: "T",
    validationReport: makeValidationReport()
  };
  const metrics = extractDocumentMetrics(doc);
  assert.equal(metrics["pdfua-compliance"].isCompliant, false);
  assert.equal(metrics["pdfua-compliance"].failedRules, 4);
  assert.equal(metrics["pdfua-compliance"].failedChecks, 7);
});

test("metadata score is 1.0 when all checks pass", () => {
  const doc = {
    id: "t",
    label: "T",
    validationReport: makeCompliantReport()
  };
  const metrics = extractDocumentMetrics(doc);
  assert.equal(metrics["metadata-quality"].score, 1.0);
});

test("metadata score is 0.75 when 3 of 4 checks pass", () => {
  const doc = {
    id: "t",
    label: "T",
    validationReport: makeValidationReport()
  };
  const metrics = extractDocumentMetrics(doc);
  assert.equal(metrics["metadata-quality"].score, 0.75);
});

test("structure metrics include typed nodes from tag delta", () => {
  const doc = {
    id: "t",
    label: "T",
    validationReport: makeValidationReport(),
    tagDeltaReport: makeTagDeltaReport()
  };
  const metrics = extractDocumentMetrics(doc);
  assert.equal(metrics["structure-tree"].typedNodes, 42);
  assert.equal(metrics["structure-tree"].hasStructureTree, true);
});

test("font metrics compute grade score", () => {
  const doc = {
    id: "t",
    label: "T",
    fontReport: makeFontReport({ grade: "A" })
  };
  const metrics = extractDocumentMetrics(doc);
  assert.ok(metrics["font-health"].gradeScore > 0.8);
});

/* -------------------------------------------------------------------------- */
/*  compareDocuments                                                          */
/* -------------------------------------------------------------------------- */

test("compareDocuments returns empty report for no documents", () => {
  const report = compareDocuments([]);
  assert.deepEqual(report.documents, []);
  assert.deepEqual(report.categories, []);
  assert.equal(report.overallWinner, null);
});

test("compareDocuments identifies winner in each category", () => {
  const docs = [
    {
      id: "source",
      label: "Original",
      role: "source",
      validationReport: makeValidationReport()
    },
    {
      id: "ours",
      label: "AutoTagged",
      role: "ours",
      validationReport: makeCompliantReport(),
      writerReport: makeWriterReport(),
      fontReport: makeFontReport({ grade: "A" }),
      tagDeltaReport: makeTagDeltaReport()
    }
  ];

  const report = compareDocuments(docs);

  assert.equal(report.documents.length, 2);
  assert.equal(report.categories.length, CATEGORIES.length);

  const complianceCategory = report.categories.find((c) => c.id === "pdfua-compliance");
  assert.equal(complianceCategory.winner, "ours");

  assert.equal(report.overallWinner, "ours");
});

test("compareDocuments handles three-way comparison", () => {
  const docs = [
    {
      id: "source",
      label: "Original",
      role: "source",
      validationReport: makeValidationReport()
    },
    {
      id: "competitor",
      label: "Competitor",
      role: "competitor",
      validationReport: makeValidationReport({
        isCompliant: false,
        summary: { failedRules: 2, failedChecks: 3 }
      })
    },
    {
      id: "ours-auto",
      label: "AutoTag (Auto)",
      role: "ours",
      validationReport: makeCompliantReport(),
      writerReport: makeWriterReport(),
      fontReport: makeFontReport({ grade: "A+" }),
      tagDeltaReport: makeTagDeltaReport()
    }
  ];

  const report = compareDocuments(docs);

  assert.equal(report.documents.length, 3);
  assert.ok(report.overallWinner);
  assert.equal(report.overallWinner, "ours-auto");
});

test("compareDocuments reports ties correctly", () => {
  const sharedReport = makeCompliantReport();
  const docs = [
    { id: "a", label: "A", validationReport: sharedReport },
    { id: "b", label: "B", validationReport: sharedReport }
  ];

  const report = compareDocuments(docs);
  const complianceCategory = report.categories.find((c) => c.id === "pdfua-compliance");

  assert.equal(complianceCategory.winner, null);
  assert.deepEqual(complianceCategory.tied, ["a", "b"]);
});

test("compareDocuments includes overall scores", () => {
  const docs = [
    {
      id: "source",
      label: "Original",
      validationReport: makeValidationReport()
    }
  ];

  const report = compareDocuments(docs);
  assert.ok("overallScores" in report);
  assert.ok(typeof report.overallScores.source === "number");
});

test("category entries are sorted by score descending", () => {
  const docs = [
    {
      id: "bad",
      label: "Bad",
      validationReport: makeValidationReport({
        summary: { failedRules: 20, failedChecks: 50 }
      })
    },
    {
      id: "good",
      label: "Good",
      validationReport: makeCompliantReport()
    }
  ];

  const report = compareDocuments(docs);

  for (const cat of report.categories) {
    if (cat.entries.length >= 2) {
      assert.ok(cat.entries[0].score >= cat.entries[1].score, `${cat.id} entries not sorted`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  summarizeComparison                                                       */
/* -------------------------------------------------------------------------- */

test("summarizeComparison produces human-readable text", () => {
  const docs = [
    {
      id: "source",
      label: "Original",
      validationReport: makeValidationReport()
    },
    {
      id: "ours",
      label: "AutoTagged",
      validationReport: makeCompliantReport(),
      writerReport: makeWriterReport(),
      tagDeltaReport: makeTagDeltaReport()
    }
  ];

  const report = compareDocuments(docs);
  const summary = summarizeComparison(report);

  assert.ok(summary.includes("PDF Accessibility Comparison"));
  assert.ok(summary.includes("Overall Winner"));
  assert.ok(summary.includes("AutoTagged"));
});

test("summarizeComparison handles empty report", () => {
  const summary = summarizeComparison(compareDocuments([]));
  assert.ok(summary.includes("No documents to compare"));
});

/* -------------------------------------------------------------------------- */
/*  Edge cases                                                                */
/* -------------------------------------------------------------------------- */

test("compareDocuments with null input returns empty report", () => {
  const report = compareDocuments(null);
  assert.deepEqual(report.documents, []);
});

test("CATEGORIES array has expected length", () => {
  assert.equal(CATEGORIES.length, 5);
});

test("all categories have required properties", () => {
  for (const cat of CATEGORIES) {
    assert.ok(cat.id, "category missing id");
    assert.ok(cat.label, "category missing label");
    assert.ok(typeof cat.extract === "function", "category missing extract");
    assert.ok(typeof cat.score === "function", "category missing score");
    assert.ok(typeof cat.weight === "number", "category missing weight");
  }
});
