import test from "node:test";
import assert from "node:assert/strict";
import { buildSemanticRedactionArtifacts } from "../semantic-redactor.js";

test("semantic redactor masks SSNs in semantic text while preserving redaction geometry", () => {
  const semanticDocument = {
    schemaVersion: "1.0.0",
    documentId: "semantic:ssn",
    source: {
      layoutDocumentId: "layout:ssn",
      filePath: "C:/sample.pdf"
    },
    nodes: [
      {
        id: "n-1-1",
        pageNumber: 1,
        sourceBlockId: "b1",
        role: "P",
        text: "Primary SSN: 123-45-6789 Backup 987654321",
        bbox: [72, 120, 280, 12],
        confidence: 0.94,
        readingOrder: 0
      }
    ],
    orderedNodeIds: ["n-1-1"]
  };

  const layoutDocument = {
    schemaVersion: "1.0.0",
    documentId: "layout:ssn",
    source: {
      filePath: "C:/sample.pdf",
      pageCount: 1
    },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "Primary SSN: 123-45-6789 Backup 987654321",
            bbox: [72, 120, 280, 12],
            fontSize: 12
          }
        ]
      }
    ]
  };

  const result = buildSemanticRedactionArtifacts({ semanticDocument, layoutDocument });

  assert.equal(result.plan.matches.length, 2);
  assert.equal(result.plan.redactedNodeIds.includes("n-1-1"), true);
  assert.equal(result.semanticRedacted.nodes[0].text.includes("123-45-6789"), false);
  assert.equal(result.semanticRedacted.nodes[0].text.includes("987654321"), false);
  assert.equal(result.semanticRedacted.nodes[0].text.includes("***-**-6789"), true);
  assert.equal(result.semanticRedacted.nodes[0].text.includes("***-**-4321"), true);
  assert.equal(result.plan.matches.every((match) => Array.isArray(match.bbox) && match.bbox.length === 4), true);
});
