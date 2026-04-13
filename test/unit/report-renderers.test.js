import test from "node:test";
import assert from "node:assert/strict";
import { buildArtifactView } from "../../orchestrator/public/report-renderers.js";

test("compact validation renderer summarizes findings without requiring standalone navigation", () => {
  const report = {
    isCompliant: false,
    profileName: "PDF/UA-1 validation profile",
    statement: "Validation finished with findings.",
    engine: { name: "veraPDF", version: "1.28.2" },
    summary: {
      failedRules: 4,
      failedChecks: 7
    },
    metadataDiagnostics: {
      metadataPresent: true,
      infoMatchesXmp: true,
      dcTitleDetected: true,
      pdfUaIdentificationDetected: true,
      suspectedVeraPdfMetadataMismatch: true
    },
    findings: [
      { code: "A", description: "A finding", clause: "1.1", specification: "PDF/UA", failedChecks: 1, severity: "error", test: "A test" },
      { code: "B", description: "B finding", clause: "1.2", specification: "PDF/UA", failedChecks: 2, severity: "error", test: "B test" },
      { code: "C", description: "C finding", clause: "1.3", specification: "PDF/UA", failedChecks: 3, severity: "warning", test: "C test" },
      { code: "D", description: "D finding", clause: "1.4", specification: "PDF/UA", failedChecks: 1, severity: "error", test: "D test" }
    ]
  };

  const view = buildArtifactView(report, "validationReport", { compact: true });

  assert.equal(view.summaryCards[0].value, "Needs work");
  assert.match(view.contentHtml, /Key findings/);
  assert.match(view.contentHtml, /Showing 3 of 4 findings/);
  assert.match(view.contentHtml, /Metadata diagnostics/);
});

test("validation renderer includes tag delta when provided", () => {
  const report = {
    isCompliant: false,
    engine: { name: "veraPDF", version: "1.28.2" },
    summary: { failedRules: 2, failedChecks: 2 },
    metadataDiagnostics: {},
    findings: []
  };
  const tagDelta = {
    delta: {
      structTreeAdded: true,
      totalTypedNodesDelta: 24,
      markedContentOperatorCountDelta: 10,
      artifactMarkedContentCountDelta: 5,
      tableAttributeNodeCountDelta: 2,
      imageXObjectCountDelta: 1
    }
  };

  const view = buildArtifactView(report, "validationReport", { compact: true, tagDelta });

  assert.match(view.contentHtml, /Tag delta/);
  assert.match(view.contentHtml, /\+24/);
  assert.match(view.contentHtml, /\+10/);
});

test("compact tag-manifest renderer exposes a tree overview and trims large trees", () => {
  const report = {
    writerMode: "pdfbox-native-structure",
    nativeTaggingApplied: true,
    summary: {
      structureElementCount: 11,
      markedContentCount: 9,
      instructionRecordCount: 12,
      metadataApplied: true
    },
    sourcePdf: "C:/input.pdf",
    outputPdf: "C:/output.pdf",
    tagging: {
      documentId: "tagging:sample",
      root: {
        type: "Document",
        children: Array.from({ length: 7 }, (_, index) => ({
          id: `n-${index + 1}`,
          type: index === 0 ? "H1" : "P",
          label: `Node ${index + 1}`,
          children: []
        }))
      }
    }
  };

  const view = buildArtifactView(report, "tagManifest", { compact: true });

  assert.equal(view.summaryCards[1].value, "Yes");
  assert.match(view.contentHtml, /Tree overview/);
  assert.match(view.contentHtml, /Top-level nodes/);
  assert.match(view.contentHtml, /Showing 6 of 7 top-level nodes/);
});

test("tag delta renderer summarizes before and after metrics", () => {
  const report = {
    source: {
      totalTypedNodes: 2,
      markedContentOperatorCount: 0,
      tableAttributeNodeCount: 0
    },
    tagged: {
      totalTypedNodes: 26,
      markedContentOperatorCount: 10,
      tableAttributeNodeCount: 2
    },
    delta: {
      structTreeAdded: true,
      totalTypedNodesDelta: 24,
      markedContentOperatorCountDelta: 10,
      artifactMarkedContentCountDelta: 5,
      tableAttributeNodeCountDelta: 2,
      imageXObjectCountDelta: 1
    }
  };

  const view = buildArtifactView(report, "tagDeltaReport", { compact: false });

  assert.equal(view.summaryCards[0].value, "Yes");
  assert.match(view.contentHtml, /Before \/ after/);
  assert.match(view.contentHtml, /Source typed nodes/);
  assert.match(view.contentHtml, /Tagged typed nodes/);
});

test("compact redaction renderer keeps masked SSN previews inline", () => {
  const report = {
    status: "completed",
    sourcePdf: "C:/input.pdf",
    outputPdf: "C:/output.pdf",
    accessibilityTreeRedacted: true,
    summary: {
      pagesProcessed: 2,
      candidateMatches: 2,
      redactedMatches: 2,
      pagesRedacted: 1,
      outputMode: "raster-redaction"
    },
    matches: [
      { pageNumber: 1, maskedText: "***-**-6789" },
      { pageNumber: 1, maskedText: "***-**-4321" }
    ]
  };
  const tagDelta = {
    delta: {
      structTreeAdded: true,
      totalTypedNodesDelta: 24,
      markedContentOperatorCountDelta: 10,
      artifactMarkedContentCountDelta: 5,
      tableAttributeNodeCountDelta: 2,
      imageXObjectCountDelta: 1
    }
  };

  const view = buildArtifactView(report, "redactionReport", { compact: true, tagDelta });

  assert.equal(view.summaryCards[0].value, "2");
  assert.match(view.contentHtml, /Redaction summary/);
  assert.match(view.contentHtml, /Accessibility tree/);
  assert.match(view.contentHtml, /\*\*\*-\*\*-6789/);
  assert.match(view.contentHtml, /visible page content and the accessibility layer/);
  assert.match(view.contentHtml, /Tag delta/);
  assert.match(view.contentHtml, /\+24/);
});

test("generic artifact renderer beautifies arbitrary JSON artifacts", () => {
  const report = {
    schemaVersion: "1.0.0",
    status: "completed",
    pageCount: 2,
    detectedTables: 1,
    pages: [
      {
        pageNumber: 1,
        tableCount: 1
      }
    ]
  };

  const view = buildArtifactView(report, "tableStructureMap", { compact: false });

  assert.equal(view.summaryCards[0].value, "Table structure map");
  assert.match(view.contentHtml, /Artifact overview/);
  assert.match(view.contentHtml, /Quick facts/);
  assert.match(view.contentHtml, /Structured preview/);
  assert.match(view.contentHtml, /Browser JSON explorer/);
  assert.match(view.contentHtml, /Schema Version/);
  assert.doesNotMatch(view.contentHtml, /No specialized renderer exists/);
});
