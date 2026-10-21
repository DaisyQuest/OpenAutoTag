import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readingOrderInversionCount } from "../lib/scorers.js";

const a = { id: "a", pageNumber: 1, bbox: [10, 20, 30, 10] };
const b = { id: "b", pageNumber: 1, bbox: [100, 20, 30, 10] };

async function score(t, document) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "order-contract-"));
  const file = path.join(dir, "semantic.json");
  await writeFile(file, JSON.stringify(document));
  t.after(async () => { await unlink(file); await rmdir(dir); });
  return readingOrderInversionCount(file);
}

test("declared order wins over storage order and stale numeric order", async (t) => {
  assert.equal(await score(t, { nodes: [a, b], orderedNodeIds: ["b", "a"] }), 1);
  assert.equal(await score(t, { nodes: [b, a], orderedNodeIds: ["a", "b"] }), 0);
  assert.equal(await score(t, { nodes: [{ ...a, readingOrder: 1 }, { ...b, readingOrder: 0 }], orderedNodeIds: ["a", "b"] }), 0);
});

test("numeric reading order is resolved when no explicit ID sequence exists", async (t) => {
  assert.equal(await score(t, { nodes: [{ ...a, readingOrder: 1 }, { ...b, readingOrder: 0 }] }), 1);
  assert.equal(await score(t, { nodes: [{ ...b, readingOrder: 1 }, { ...a, readingOrder: 0 }] }), 0);
  assert.equal(await score(t, { nodes: [b, a] }), 1, "legacy documents retain their array order");
});

test("invalid explicit orders are unavailable instead of falsely clean", async (t) => {
  for (const orderedNodeIds of [null, "a,b", [], ["a"], ["a", "a"], ["a", "missing"], ["a", "b", "c"]]) {
    assert.equal(await score(t, { nodes: [a, b], orderedNodeIds }), null);
  }
  for (const nodes of [[a, a], [{ ...a, id: "" }, b], [null, b]]) {
    assert.equal(await score(t, { nodes, orderedNodeIds: ["a", "b"] }), null);
  }
  for (const values of [[0, 0], [0, -1], [0, 1.5], [0, null], [0, undefined]]) {
    assert.equal(await score(t, { nodes: [{ ...a, readingOrder: values[0] }, { ...b, readingOrder: values[1] }] }), null);
  }
});

test("invalid geometry is unavailable", async (t) => {
  for (const node of [{ ...a, bbox: [1, 2] }, { ...a, bbox: [1, 2, -1, 5] },
    { ...a, bbox: [1, null, 4, 5] }, { ...a, pageNumber: 0 }]) {
    assert.equal(await score(t, { nodes: [node, b] }), null);
  }
});

test("horizontal inversion respects direction and semantic boundaries", async (t) => {
  assert.equal(await score(t, { nodes: [b, a], source: { direction: "rtl" } }), 0);
  assert.equal(await score(t, { nodes: [a, b], source: { direction: "rtl" } }), 1);
  for (const override of [{ role: "Artifact" }, { textRotation: 90 }, { writingMode: "vertical" },
    { direction: "rtl" }, { direction: "unknown" }, { pageNumber: 2 }, { bbox: [10, 80, 30, 10] }]) {
    assert.equal(await score(t, { nodes: [b, { ...a, ...override }] }), 0);
  }
  assert.equal(await score(t, { nodes: [{ ...b, columnHint: 1 }, { ...a, columnHint: 0 }] }), 0);
});
