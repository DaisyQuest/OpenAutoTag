import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSemanticDocument } from "../index.js";

async function writeLayout(fixture) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "semantic-vocab-"));
  const inputPath = path.join(tempDir, "layout.json");
  await writeFile(inputPath, JSON.stringify(fixture, null, 2));
  return inputPath;
}

// ---------- A1: Em/Strong from run-level style ----------

test("A1: run-level italic run emits semanticRole=Em", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a1-em",
    source: { filePath: "a1-em.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "This is very important indeed.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica",
            blockType: "paragraph",
            inlineRuns: [
              { text: "This is ", fontName: "Helvetica" },
              { text: "very important", fontName: "Helvetica-Oblique", fontStyle: "italic" },
              { text: " indeed.", fontName: "Helvetica" }
            ]
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const [p] = semantic.nodes;
  assert.equal(p.role, "P");
  assert.ok(Array.isArray(p.inlineRuns), "inlineRuns should be emitted");
  const emRuns = p.inlineRuns.filter((r) => r.semanticRole === "Em");
  assert.equal(emRuns.length, 1);
  assert.equal(emRuns[0].text, "very important");
  assert.equal(emRuns[0].start, "This is ".length);
  assert.equal(emRuns[0].end, "This is very important".length);
});

test("A1: run-level bold run emits semanticRole=Strong", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a1-strong",
    source: { filePath: "a1-strong.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "Call NOW to subscribe.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica",
            blockType: "paragraph",
            inlineRuns: [
              { text: "Call ", fontName: "Helvetica" },
              { text: "NOW", fontName: "Helvetica-Bold", fontWeight: 700 },
              { text: " to subscribe.", fontName: "Helvetica" }
            ]
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const [p] = semantic.nodes;
  const strongRuns = (p.inlineRuns || []).filter((r) => r.semanticRole === "Strong");
  assert.equal(strongRuns.length, 1);
  assert.equal(strongRuns[0].text, "NOW");
});

test("A1: whole-paragraph bold is NOT emitted as Strong (gate)", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a1-gate",
    source: { filePath: "a1-gate.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "This whole paragraph is bold.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica-Bold",
            blockType: "paragraph",
            inlineRuns: [
              { text: "This whole paragraph is bold.", fontName: "Helvetica-Bold" }
            ]
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const [p] = semantic.nodes;
  // If inlineRuns were emitted, none should carry Strong because the entire
  // paragraph is bold (majority gate). The implementation returns null (no
  // inlineRuns field) in that case.
  const strongRuns = (p.inlineRuns || []).filter((r) => r.semanticRole === "Strong");
  assert.equal(strongRuns.length, 0);
});

test("A1: absent inlineRuns is a no-op (backward compat)", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a1-nopass",
    source: { filePath: "a1-nopass.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "Plain paragraph without run metadata.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica",
            blockType: "paragraph"
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const [p] = semantic.nodes;
  assert.equal(p.role, "P");
  assert.equal(p.inlineRuns, undefined);
  assert.equal(p.semanticRole, undefined);
});

// ---------- A2: Code from monospaced fonts ----------

test("A2: whole monospaced paragraph gets semanticRole=Code", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a2-block-code",
    source: { filePath: "a2.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "if (x) { return 42; }",
            bbox: [72, 100, 400, 12],
            fontSize: 10,
            fontName: "Consolas",
            blockType: "paragraph"
          },
          {
            id: "b2",
            text: "x = y + 1",
            bbox: [72, 120, 400, 12],
            fontSize: 10,
            fontName: "Courier-New",
            blockType: "paragraph"
          },
          {
            id: "b3",
            text: "Regular body text.",
            bbox: [72, 140, 400, 12],
            fontSize: 10,
            fontName: "Helvetica",
            blockType: "paragraph"
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  assert.equal(semantic.nodes[0].semanticRole, "Code");
  assert.equal(semantic.nodes[1].semanticRole, "Code");
  assert.equal(semantic.nodes[2].semanticRole, undefined);
});

test("A2: inline monospaced run inside a regular paragraph gets Code", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a2-inline",
    source: { filePath: "a2i.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "Use printf() to output text.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica",
            blockType: "paragraph",
            inlineRuns: [
              { text: "Use ", fontName: "Helvetica" },
              { text: "printf()", fontName: "FiraCode-Regular" },
              { text: " to output text.", fontName: "Helvetica" }
            ]
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const [p] = semantic.nodes;
  const codeRuns = (p.inlineRuns || []).filter((r) => r.semanticRole === "Code");
  assert.equal(codeRuns.length, 1);
  assert.equal(codeRuns[0].text, "printf()");
});

test("A2: trailing -Mono in font name is detected as monospace", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a2-mono-suffix",
    source: { filePath: "a2m.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "code",
            bbox: [72, 100, 400, 12],
            fontSize: 10,
            fontName: "SomeCustomFont-Mono",
            blockType: "paragraph"
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  assert.equal(semantic.nodes[0].semanticRole, "Code");
});

// ---------- A3: Abbreviations ----------

test("A3: dictionary abbreviations are marked with /E expansion", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a3",
    source: { filePath: "a3.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "The W3C publishes HTML and HTTP specs; see also the USA PDF guidelines.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica",
            blockType: "paragraph"
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const [p] = semantic.nodes;
  assert.ok(Array.isArray(p.abbreviations));
  const tokens = p.abbreviations.map((a) => a.token);
  assert.deepEqual(tokens.sort(), ["HTML", "HTTP", "PDF", "USA", "W3C"]);
  const w3c = p.abbreviations.find((a) => a.token === "W3C");
  assert.equal(w3c.expansion, "World Wide Web Consortium");
  assert.equal(w3c.semanticRole, "Span");
  assert.equal(p.text.slice(w3c.start, w3c.end), "W3C");
});

test("A3: all-caps tokens not in dictionary are ignored", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a3-neg",
    source: { filePath: "a3n.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "I bought a TSLA share and a GOOG one.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica",
            blockType: "paragraph"
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  assert.equal(semantic.nodes[0].abbreviations, undefined);
});

test("A3: longer all-caps words (>6 chars) are not matched", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a3-long",
    source: { filePath: "a3l.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          {
            id: "b1",
            text: "A paragraph with NOTANABBREV in it.",
            bbox: [72, 100, 400, 12],
            fontSize: 12,
            fontName: "Helvetica",
            blockType: "paragraph"
          }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  assert.equal(semantic.nodes[0].abbreviations, undefined);
});

// ---------- A4: BlockQuote from indented paragraph blocks ----------

test("A4: indented contiguous paragraphs get a blockQuoteGroupId", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a4",
    source: { filePath: "a4.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          // 4 baseline paragraphs at x=72
          { id: "b1", text: "Body one.", bbox: [72, 100, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b2", text: "Body two.", bbox: [72, 120, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b3", text: "Body three.", bbox: [72, 140, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          // 2 indented paragraphs at x=144 (2x baseline)
          { id: "b4", text: "Quoted line one.", bbox: [144, 160, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b5", text: "Quoted line two.", bbox: [144, 180, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          // back to baseline
          { id: "b6", text: "Body four.", bbox: [72, 200, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const [b1, b2, b3, b4, b5, b6] = semantic.nodes;
  assert.equal(b1.blockQuoteGroupId, undefined);
  assert.equal(b2.blockQuoteGroupId, undefined);
  assert.equal(b3.blockQuoteGroupId, undefined);
  assert.ok(b4.blockQuoteGroupId, "b4 should be in a blockquote group");
  assert.equal(b5.blockQuoteGroupId, b4.blockQuoteGroupId);
  assert.equal(b6.blockQuoteGroupId, undefined);
});

test("A4: indented LI nodes are NOT marked as blockquote", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a4-list",
    source: { filePath: "a4l.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          { id: "b1", text: "Body one.", bbox: [72, 100, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b2", text: "Body two.", bbox: [72, 120, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b3", text: "Body three.", bbox: [72, 140, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b4", text: "- first item", bbox: [144, 160, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "list-item" },
          { id: "b5", text: "- second item", bbox: [144, 180, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "list-item" }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  for (const node of semantic.nodes) {
    assert.equal(node.blockQuoteGroupId, undefined, `${node.id} (${node.role}) should not be blockquoted`);
  }
});

test("A4: too few baseline paragraphs skips blockquote classification", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a4-sparse",
    source: { filePath: "a4s.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          { id: "b1", text: "Only paragraph.", bbox: [72, 100, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b2", text: "Indented.", bbox: [200, 120, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  for (const node of semantic.nodes) {
    assert.equal(node.blockQuoteGroupId, undefined);
  }
});

// ---------- A9: BibEntry state machine ----------

test("A9: paragraphs after 'References' heading get bibEntry=true", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a9",
    source: { filePath: "a9.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          { id: "b1", text: "Introduction", bbox: [72, 50, 200, 20], fontSize: 18, fontName: "Helvetica-Bold", blockType: "heading", headingLevel: 1 },
          { id: "b2", text: "Body paragraph.", bbox: [72, 80, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b3", text: "References", bbox: [72, 120, 200, 20], fontSize: 18, fontName: "Helvetica-Bold", blockType: "heading", headingLevel: 1 },
          { id: "b4", text: "Smith, J. (2024). A paper.", bbox: [72, 150, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b5", text: "Jones, A. (2023). Another paper.", bbox: [72, 170, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const byId = Object.fromEntries(semantic.nodes.map((n) => [n.sourceBlockId, n]));
  assert.equal(byId.b2.bibEntry, undefined, "body paragraph before References should not be BibEntry");
  assert.equal(byId.b4.bibEntry, true);
  assert.equal(byId.b4.semanticRole, "BibEntry");
  assert.equal(byId.b5.bibEntry, true);
  assert.equal(byId.b5.semanticRole, "BibEntry");
});

test("A9: BibEntry state ends at the next heading", async () => {
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:a9-end",
    source: { filePath: "a9e.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          { id: "b1", text: "Bibliography", bbox: [72, 50, 200, 20], fontSize: 18, fontName: "Helvetica-Bold", blockType: "heading", headingLevel: 1 },
          { id: "b2", text: "Entry one.", bbox: [72, 80, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b3", text: "Appendix", bbox: [72, 120, 200, 20], fontSize: 18, fontName: "Helvetica-Bold", blockType: "heading", headingLevel: 1 },
          { id: "b4", text: "Appendix body text.", bbox: [72, 150, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" }
        ]
      }
    ]
  });

  const semantic = await buildSemanticDocument(inputPath);
  const byId = Object.fromEntries(semantic.nodes.map((n) => [n.sourceBlockId, n]));
  assert.equal(byId.b2.bibEntry, true);
  assert.equal(byId.b4.bibEntry, undefined);
});

test("A9: alternate heading forms (Works Cited, Literature Cited) trigger state", async () => {
  for (const heading of ["Works Cited", "Literature Cited", "BIBLIOGRAPHY", "references"]) {
    const inputPath = await writeLayout({
      schemaVersion: "1.0.0",
      documentId: `layout:a9-${heading}`,
      source: { filePath: "a9alt.pdf", pageCount: 1 },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            { id: "b1", text: heading, bbox: [72, 50, 200, 20], fontSize: 18, fontName: "Helvetica-Bold", blockType: "heading", headingLevel: 1 },
            { id: "b2", text: "Entry one.", bbox: [72, 80, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" }
          ]
        }
      ]
    });
    const semantic = await buildSemanticDocument(inputPath);
    assert.equal(semantic.nodes[1].bibEntry, true, `heading '${heading}' should trigger BibEntry`);
  }
});

// ---------- Role-field compatibility ----------

test("all new classifier outputs preserve the existing role enum", async () => {
  // Bakes in the backward-compat contract: new semantics ride as annotation
  // fields; node.role always remains one of the tag-builder-known values.
  const inputPath = await writeLayout({
    schemaVersion: "1.0.0",
    documentId: "layout:compat",
    source: { filePath: "compat.pdf", pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        textBlocks: [
          { id: "b1", text: "Body.", bbox: [72, 100, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" },
          { id: "b2", text: "code();", bbox: [72, 120, 400, 12], fontSize: 10, fontName: "Consolas", blockType: "paragraph" },
          { id: "b3", text: "References", bbox: [72, 140, 200, 20], fontSize: 18, fontName: "Helvetica-Bold", blockType: "heading", headingLevel: 1 },
          { id: "b4", text: "Smith, J. (2024). Paper on W3C.", bbox: [72, 160, 400, 12], fontSize: 12, fontName: "Helvetica", blockType: "paragraph" }
        ]
      }
    ]
  });
  const semantic = await buildSemanticDocument(inputPath);
  const ALLOWED = new Set(["Document", "H1", "H2", "H3", "P", "L", "LI", "Table", "TH", "TD", "Artifact"]);
  for (const node of semantic.nodes) {
    assert.ok(ALLOWED.has(node.role), `role ${node.role} for ${node.id} must remain in the tag-builder enum`);
  }
});
