import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { evaluatePreservation } from "../quality-cli.js";

const hash = "a".repeat(64), other = "b".repeat(64);
const snapshot = () => ({ schemaVersion: "1.0.0", scope: "preserved-objects-v1", sourceHash: hash,
  pages: [{ geometry: [0, 0, 612, 792, 0, 0, 612, 792, 0, 1], contentHash: hash, resourcesHash: hash, annotationsHash: hash }],
  fields: { field: hash }, widgets: { widget: { digest: hash, page: 1, owners: [{ form: "form", listItem: "item", inBody: false }] } },
  headings: [{ id: "heading", role: "H2", contentRefs: ["page:1:mcid:0"] }], issues: [], limitations: [] });
const validation = () => ({ status: "completed", pdfSha256: hash, isCompliant: true, overall: { status: "pass" }, findings: [], fontAudit: { status: "ok" } });
const evaluate = (changes = {}) => evaluatePreservation({ source: snapshot(), candidate: snapshot(), validation: validation(), identityPreserved: true, ...changes });
const codes = (report) => report.findings.map((f) => f.code);

test("font resource changes require an exact, valid saved-object proof", () => {
  const candidate = snapshot(); candidate.pages[0].resourcesHash = other; candidate.fields.field = other; candidate.widgets.widget.digest = other;
  const fontRepair = { sourceHash: hash, candidateHash: hash, repairLedger: [], verification: { status: "pass", scope: "catalog-and-info", reason: "fixture" } };
  assert.equal(evaluate({ candidate }).disposition, "rejected");
  assert.equal(evaluate({ candidate, fontRepair }).disposition, "review_required");
  for (const patch of [{ sourceHash: other }, { candidateHash: other }, { verification: { status: "fail", scope: "catalog-and-info", reason: "mutation" } }, { repairLedger: null }]) {
    assert.equal(evaluate({ candidate, fontRepair: { ...fontRepair, ...patch } }).disposition, "rejected");
  }
  candidate.pages[0].geometry[2]++;
  assert.equal(evaluate({ candidate, fontRepair }).disposition, "rejected");
});

test("link descriptions may be filled only from unchanged URI actions and ownership cannot be reassigned", () => {
  const source = snapshot(); source.links = { link: { digest: hash, page: 1, uri: "https://example.test", contents: "", owners: [] } };
  const candidate = structuredClone(source); candidate.links.link.contents = source.links.link.uri; candidate.links.link.owners = ["existing-link"];
  assert.equal(evaluate({ source, candidate }).disposition, "review_required");
  for (const [patch, expected] of [[{ contents: "invented" }, "LINK_DESCRIPTION_CHANGED"], [{ uri: "changed" }, "LINK_CHANGED"], [{ owners: ["one", "two"] }, "LINK_OWNER_CHANGED"]]) {
    const modified = structuredClone(candidate); Object.assign(modified.links.link, patch);
    assert.ok(codes(evaluate({ source, candidate: modified })).includes(expected));
  }
  source.links.link.owners = ["authored"]; assert.ok(codes(evaluate({ source, candidate })).includes("LINK_OWNER_CHANGED"));
});

test("successful bounded checks never certify overall accessibility", () => {
  const report = evaluate();
  assert.equal(report.disposition, "review_required");
  assert.ok(report.checks.every((c) => c.status === "pass"));
  assert.deepEqual(report.findings, []);
});

test("repairs may consolidate headings and place the same form in its existing list body", () => {
  const source = snapshot(), candidate = snapshot();
  source.headings.push({ id: "next", role: "H2", contentRefs: ["page:1:mcid:1"] });
  candidate.headings[0].contentRefs.push("page:1:mcid:1");
  candidate.widgets.widget.owners[0].inBody = true;
  assert.deepEqual(evaluate({ source, candidate }).findings, []);
});

test("content, geometry, field, widget and ownership regressions are rejected", () => {
  const cases = [
    ["PAGE_COUNT_CHANGED", (s) => s.pages.pop()],
    ["PAGE_CONTENT_CHANGED", (s) => s.pages[0].geometry[2]++],
    ["PAGE_CONTENT_CHANGED", (s) => { s.pages[0].contentHash = other; }],
    ["PAGE_CONTENT_CHANGED", (s) => { s.pages[0].resourcesHash = other; }],
    ["PAGE_CONTENT_CHANGED", (s) => { s.pages[0].annotationsHash = other; }],
    ["FIELD_CHANGED", (s) => { delete s.fields.field; }],
    ["FIELD_CHANGED", (s) => { s.fields.field = other; }],
    ["FIELD_CHANGED", (s) => { s.fields.extra = hash; }],
    ["WIDGET_CHANGED", (s) => { delete s.widgets.widget; }],
    ["WIDGET_CHANGED", (s) => { s.widgets.widget.digest = other; }],
    ["WIDGET_CHANGED", (s) => { s.widgets.widget.page = 2; }],
    ["WIDGET_OWNER_CHANGED", (s) => { s.widgets.widget.owners = []; }],
    ["WIDGET_OWNER_CHANGED", (s) => { s.widgets.widget.owners[0].listItem = "other"; }],
    ["HEADING_CONTENT_LOST", (s) => { s.headings = []; }],
    ["STRUCTURE_REGRESSION", (s) => s.issues.push("bad-parent")]
  ];
  for (const [code, mutate] of cases) {
    const candidate = snapshot(); mutate(candidate);
    const result = evaluate({ candidate });
    assert.equal(result.disposition, "rejected", code);
    assert.ok(codes(result).includes(code), code);
  }
  const source = snapshot(); source.widgets.widget.owners[0].inBody = true;
  assert.ok(codes(evaluate({ source })).includes("WIDGET_OWNER_CHANGED"));
});

test("preexisting structural findings cannot hide additional occurrences", () => {
  const source = snapshot(), candidate = snapshot();
  source.issues = candidate.issues = ["bad-parent"];
  assert.equal(evaluate({ source, candidate }).disposition, "review_required");
  candidate.issues = ["bad-parent", "bad-parent"];
  assert.equal(evaluate({ source, candidate }).disposition, "rejected");
  candidate.issues = [];
  assert.equal(evaluate({ source, candidate }).disposition, "review_required");
});

test("missing heading references and unqualified object identities require review", () => {
  const candidate = snapshot(); candidate.headings.push({ id: "empty", role: "H1", contentRefs: [] });
  assert.ok(codes(evaluate({ candidate })).includes("HEADING_REFERENCE_REQUIRES_REVIEW"));
  const source = snapshot(); source.headings[0].contentRefs = [];
  assert.ok(codes(evaluate({ source })).includes("HEADING_REFERENCE_REQUIRES_REVIEW"));
  candidate.fields = {};
  const report = evaluate({ candidate, identityPreserved: false });
  assert.equal(report.disposition, "review_required");
  assert.ok(codes(report).includes("IDENTITY_MAPPING_REQUIRED"));
  assert.ok(!report.checks.some((c) => c.id === "fields"), "unsupported comparison must not be marked pass");
});

test("missing, malformed or failed mandatory checks fail closed", () => {
  for (const invalid of [undefined, null, {}, { ...snapshot(), sourceHash: 1 }]) {
    assert.equal(evaluate({ source: invalid }).disposition, "error");
    assert.equal(evaluate({ candidate: invalid }).disposition, "error");
  }
  assert.equal(evaluate({ inspectionError: "decoder failed" }).disposition, "error");
  for (const invalid of [undefined, {}, { ...validation(), status: "skipped" },
    { ...validation(), pdfSha256: undefined }, { ...validation(), pdfSha256: other },
    { ...validation(), isCompliant: "true" }, { ...validation(), findings: null },
    { ...validation(), findings: [null] }, { ...validation(), findings: [{}] },
    { ...validation(), overall: {} }, { ...validation(), fontAudit: { status: "skipped" } },
    { ...validation(), engine: { executionError: "crashed" } },
    { ...validation(), findings: [{ code: "VALIDATOR_EXECUTION_FAILED", severity: "error" }] }]) {
    assert.equal(evaluate({ validation: invalid }).disposition, "error", JSON.stringify(invalid));
  }
  assert.equal(evaluatePreservation().disposition, "error");
});

test("completed validation findings retain review status without misreporting checker failure", () => {
  for (const invalid of [{ ...validation(), isCompliant: false }, { ...validation(), overall: { status: "fail" } },
    { ...validation(), findings: [{ code: "RULE", severity: "error" }] }]) {
    const report = evaluate({ validation: invalid });
    assert.equal(report.disposition, "review_required");
    assert.deepEqual(codes(report), ["VALIDATION_REQUIRES_REVIEW"]);
  }
});

test("quality CLI emits typed results for valid, missing and malformed inputs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quality-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.json"), candidate = path.join(dir, "candidate.json"), checker = path.join(dir, "checker.json");
  await writeFile(source, JSON.stringify(snapshot())); await writeFile(candidate, JSON.stringify(snapshot()));
  await writeFile(checker, JSON.stringify(validation()));
  const run = async (args) => JSON.parse((await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../quality-cli.js", import.meta.url)), ...args], { windowsHide: true })).stdout);
  const args = ["--source", source, "--candidate", candidate, "--validation", checker, "--identity-preserved", "true"];
  assert.equal((await run(args)).disposition, "review_required");
  await writeFile(source, "broken-json");
  assert.equal((await run(args)).disposition, "error");
  assert.equal((await run([])).disposition, "error");
});
