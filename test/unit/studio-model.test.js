import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStructureModel,
  createDownloadHtml,
  defaultStudioHtml,
  studioSnippets,
  studioTemplates,
  summarizeStudioDocument,
  validateStudioHtml
} from "../../orchestrator/public/studio-model.js";

test("default Studio HTML is publishable and produces a rich structure model", () => {
  const validation = validateStudioHtml(defaultStudioHtml);
  const summary = summarizeStudioDocument(defaultStudioHtml);
  const structure = buildStructureModel(defaultStudioHtml);

  assert.equal(validation.status, "ready");
  assert.equal(validation.summary.errors, 0);
  assert.equal(summary.score >= 90, true);
  assert.equal(summary.headingCount >= 3, true);
  assert.equal(summary.tableCount, 1);
  assert.equal(summary.figureCount, 1);
  assert.equal(structure.some((item) => item.role === "Table"), true);
  assert.equal(structure.some((item) => item.role === "Figure"), true);
  assert.equal(structure.some((item) => item.role === "Artifact"), true);
});

test("Studio validator blocks common PDF/UA authoring mistakes", () => {
  const source = `<!doctype html>
<html>
  <head><title></title></head>
  <body>
    <main>
      <h1>Broken document</h1>
      <h3>Skipped heading</h3>
      <img src="chart.png">
      <table><tr><td>Value</td></tr></table>
      <p><a href="#">click here</a></p>
      <form><input id="name" type="text"></form>
    </main>
  </body>
</html>`;

  const validation = validateStudioHtml(source);
  const issueIds = validation.issues.map((issue) => issue.id);

  assert.equal(validation.status, "blocked");
  assert.match(issueIds.join(","), /document-language/);
  assert.match(issueIds.join(","), /document-title/);
  assert.match(issueIds.join(","), /heading-order/);
  assert.match(issueIds.join(","), /image-alt/);
  assert.match(issueIds.join(","), /table-caption/);
  assert.match(issueIds.join(","), /table-headers/);
  assert.match(issueIds.join(","), /link-purpose/);
  assert.match(issueIds.join(","), /form-label/);
});

test("templates and snippets expose semantic authoring blocks", () => {
  assert.equal(studioTemplates.length >= 3, true);
  assert.equal(studioSnippets.some((snippet) => snippet.id === "table" && snippet.source.includes("<caption>")), true);
  assert.equal(studioSnippets.some((snippet) => snippet.id === "figure" && snippet.source.includes("alt=")), true);
});

test("download helper normalizes missing doctype", () => {
  const html = createDownloadHtml("<html lang=\"en\"><head><title>x</title></head><body></body></html>");

  assert.match(html, /^<!doctype html>\n<html/);
  assert.match(html, /\n$/);
});
