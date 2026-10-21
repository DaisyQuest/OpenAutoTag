import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildTagTree } from "../index.js";

test("checkbox list markers are emitted as labels rather than included in option text", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "checkbox-tags-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "semantic.json");
  await writeFile(input, JSON.stringify({ schemaVersion: "1.0.0", documentId: "form",
    source: { layoutDocumentId: "form-layout" },
    nodes: ["☐", "☑", "☒"].map((marker, i) => ({ id: `n${i}`, role: "LI", pageNumber: 1,
      sourceBlockId: `b${i}`, text: `${marker} Choice ${i}`, bbox: [72, 100 + i * 20, 240, 12],
      confidence: 1, readingOrder: i, listGroupId: "choices", listStyle: "unordered" })) }));
  const tree = await buildTagTree(input);
  const list = tree.root.children[0];
  assert.equal(list.type, "L");
  assert.equal(list.children.length, 3);
  list.children.forEach((item, i) => {
    assert.deepEqual(item.children.map((kid) => kid.type), ["Lbl", "LBody"]);
    assert.equal(item.children[0].label, ["☐", "☑", "☒"][i]);
    assert.equal(item.children[1].label, `Choice ${i}`);
  });
});
