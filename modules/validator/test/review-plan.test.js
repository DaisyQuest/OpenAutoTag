import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewPlan } from "../review-plan.js";
test("review task IDs bind object context to candidate bytes and font decisions require evidence", () => {
  const input = { candidateHash: "a", validation: { findings: [{ code: "FONT", checks: [{ context: "font 12" }, { context: "font 12" }] }], fonts: [
    { fontKey: "a", embedded: true, hasToUnicode: true, toUnicodeCoverage: 1 }, { fontKey: "b", embedded: false }] } };
  const a = buildReviewPlan(input), b = buildReviewPlan(input);
  assert.deepEqual(a, b); assert.equal(a.reviewTasks.length, 2);
  assert.notEqual(a.reviewTasks[0].id, buildReviewPlan({ ...input, candidateHash: "b" }).reviewTasks[0].id);
  assert.deepEqual(a.fontRepairPlan.map((f) => f.decision), ["preserve", "review"]);
  assert.equal(buildReviewPlan({ validation: { findings: [null, { checks: {} }], fonts: {} }, semantic: { semanticReviewTasks: {} } }).reviewTasks.length, 2);
});
