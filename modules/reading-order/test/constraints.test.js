import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPrecedence, assignStableLines } from "../constraints.js";
import { assignReadingOrder } from "../index.js";

test("explicit precedence is stable and rejects missing, duplicate, self and cyclic identities", () => {
  const nodes = ["a", "b", "c"].map((id) => ({ id }));
  const edge = (from, to) => ({ type: "precedes", from, to });
  assert.deepEqual(applyPrecedence(nodes, [edge("c", "a"), edge("c", "a")]).map((n) => n.id), ["b", "c", "a"]);
  for (const edges of [[edge("x", "a")], [edge("a", "a")], [edge("a", "b"), edge("b", "a")]]) assert.throws(() => applyPrecedence(nodes, edges));
  assert.throws(() => applyPrecedence([nodes[0], nodes[0]]), /Duplicate/);
  assert.deepEqual(applyPrecedence(nodes, [{ type: "labels", from: "a", to: "widget" }]), nodes);
});

test("line anchors are deterministic under permutations and do not chain epsilon matches", () => {
  const units = [0, 4, 8].map((top, i) => ({ pageNumber: 1, phase: 0, top, left: 100 - i * 50, sortKey: String(i), nodes: [{ direction: "rtl" }] }));
  for (const order of [units, [...units].reverse(), [units[1], units[2], units[0]]]) {
    const copy = structuredClone(order); assignStableLines(copy, 5);
    assert.deepEqual(copy.sort((a,b) => a.top-b.top).map((u) => u.lineIndex), [0,0,1]);
    assert.ok(copy.every((u) => u.lineDirection === "rtl"));
  }
});

test("full reading-order output honors explicit RTL and precedence", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "order-constraints-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "semantic.json");
  const doc = { schemaVersion: "1.0.0", documentId: "test", source: { layoutDocumentId: "test" },
    nodes: [0,1].map((i) => ({ id: String(i), sourceBlockId: String(i), role: "P", text: "text", pageNumber: 1, bbox: [72+i*100,100,90,12], confidence: 1, direction: "rtl" })) };
  await writeFile(input, JSON.stringify(doc));
  assert.deepEqual((await assignReadingOrder(input)).orderedNodeIds, ["1", "0"]);
  doc.relations = [{ type: "precedes", from: "0", to: "1", evidence: "authored" }];
  await writeFile(input, JSON.stringify(doc));
  assert.deepEqual((await assignReadingOrder(input)).orderedNodeIds, ["0", "1"]);
});
