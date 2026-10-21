import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { checkReaderQualification } from "../../scripts/check-reader-qualification.js";
test("reader evidence requires all checks, identifies failures and becomes stale after byte changes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reader-qualification-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "candidate.pdf"); await writeFile(file, "fixture");
  assert.equal((await checkReaderQualification(file, {})).status, "incomplete");
  const evidence = { candidateHash: createHash("sha256").update("fixture").digest("hex"), reviewer: "Test fixture only", testedAt: "2026-10-21", sessions: [{ reader: "Fixture", version: "1", platform: "Test",
    checks: Object.fromEntries(["readingOrder", "headings", "lists", "tables", "links", "labels", "tabOrder", "fillSaveReopen"].map((name) => [name, { status: "pass", evidence: "Synthetic test; not a real reader observation" }])) }] };
  assert.equal((await checkReaderQualification(file, evidence)).status, "recorded");
  evidence.sessions[0].checks.readingOrder.status = "not_applicable";
  assert.equal((await checkReaderQualification(file, evidence)).status, "incomplete");
  evidence.sessions[0].checks.readingOrder.status = "pass";
  evidence.sessions[0].checks.labels.status = "fail"; assert.equal((await checkReaderQualification(file, evidence)).status, "failed");
  evidence.sessions[0].checks.tables = { status: "not_applicable", evidence: "" }; assert.equal((await checkReaderQualification(file, evidence)).status, "incomplete");
  evidence.sessions[0].checks.tables.evidence = "No tables in fixture";
  await writeFile(file, "modified"); assert.equal((await checkReaderQualification(file, evidence)).status, "stale");
});
