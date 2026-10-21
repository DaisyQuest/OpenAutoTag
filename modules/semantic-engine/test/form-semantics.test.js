import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildSemanticDocument } from "../index.js";

test("semantic conversion preserves checkbox markers, field relationships and source title", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "form-semantics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "layout.json");
  await writeFile(input, JSON.stringify({ schemaVersion: "1.0.0", documentId: "form",
    source: { filePath: "form.pdf", title: "Original title" },
    pages: [{ pageNumber: 1, width: 612, height: 792, textBlocks: [
      { id: "choice", text: "☐ First option", bbox: [72, 100, 240, 12], fontSize: 12,
        blockType: "paragraph", listMarker: "☐", formFieldIds: ["widget"] }
    ] }] }));
  const semantic = await buildSemanticDocument(input);
  assert.equal(semantic.source.title, "Original title");
  assert.equal(semantic.nodes[0].role, "LI");
  assert.equal(semantic.nodes[0].listMarker, "☐");
  assert.deepEqual(semantic.nodes[0].formFieldIds, ["widget"]);
});
