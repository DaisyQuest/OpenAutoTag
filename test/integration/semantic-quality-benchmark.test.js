import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSemanticBenchmark, scoreSemanticCase } from "../../scripts/semantic-quality-benchmark.js";

test("semantic benchmark executes real stage CLIs and keeps unperformed human qualification pending", async () => {
  const report = await runSemanticBenchmark({ requireReader: true });
  assert.equal(report.automaticStatus, "pass", JSON.stringify(report.cases.filter((c) => c.status === "fail")));
  assert.ok(report.cases.length >= 15);
  for (const category of ["headings", "formLabels", "formInstructions", "readingOrder", "lists", "listNumbering", "paragraphs", "tableHeaders", "contentOwnership", "ambiguityReview"])
    assert.ok(report.dimensions[category].passed > 0, category);
  assert.equal(report.reader.status, "pending"); assert.equal(report.expertReviewComplete, false);
  assert.equal(report.disposition, "review_required");
});
test("semantic scoring detects missing nodes, incorrect order, wrong headers and duplicate content ownership", () => {
  const semantic = { nodes: [{ id: "n-a", sourceBlockId: "a", role: "P" }, { id: "n-b", sourceBlockId: "b", role: "P" }], orderedNodeIds: ["n-b", "n-a"], relations: [], semanticReviewTasks: [] };
  const tagging = { root: { type: "Document", children: [{ sourceNodeIds: ["n-a"], children: [] }, { sourceNodeIds: ["n-a"], children: [] }] } };
  const checks = scoreSemanticCase({ roles: { a: "H1" }, order: [["a", "b"]], headers: { b: ["a"] } }, semantic, tagging);
  assert.ok(checks.every((c) => c.status === "fail"));
});
test("benchmark rejects empty references rather than reporting an empty pass", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bad-benchmark-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "manifest.json"); await writeFile(manifestPath, JSON.stringify({ cases: [] }));
  await assert.rejects(runSemanticBenchmark({ manifestPath }), /nonempty cases/);
});
