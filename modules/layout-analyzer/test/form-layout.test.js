import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { analyzeLayout } from "../index.js";

test("form headings and checkbox options stay distinct from labels and header tables", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "form-layout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const block = (id, text, x, y, width, fontSize = 12, bold = false) => ({
    id, text, bbox: [x, y, width, fontSize], fontSize,
    fontName: bold ? "ABCDEF+Arial-BoldMT" : "ABCDEF+ArialMT"
  });
  const file = path.join(dir, "layout.json");
  await writeFile(file, JSON.stringify({
    schemaVersion: "1.0.0", documentId: "form", source: { filePath: "form.pdf" },
    pages: [{ pageNumber: 1, width: 612, height: 792,
      formFields: [{ id: "checkbox-1", bbox: [54, 208, 12, 12] }],
      textBlocks: [
        block("institution", "New York State Unified Court System", 122, 17, 213, 12, true),
        block("url", "nycourts.gov", 502, 17, 68),
        block("title", "Supplemental Affirmation in", 122, 35, 240, 18, true),
        block("subtitle", "Support of Order to Show Cause", 122, 57, 281, 18, true),
        block("page", "Page 1 of 2", 508, 57, 56),
        { ...block("label", "County Name", 36, 130, 100, 12, true), formFieldIds: ["county"] },
        block("section", "Personal Delivery", 36, 190, 120, 12, true),
        block("option", "☐ I was not served.", 54, 208, 240),
        block("option2", "☑ The address was wrong.", 54, 229, 240),
        block("option3", "☒ Other reason.", 54, 249, 240),
        block("body", "Ordinary instructions remain a paragraph.", 36, 280, 320),
        block("section-es", "Explicación", 36, 320, 120, 12, true)
      ] }]
  }));
  const output = (await analyzeLayout(file)).pages[0];
  const blocks = new Map(output.textBlocks.map((b) => [b.id, b]));
  assert.equal(blocks.get("title").blockType, "heading");
  assert.equal(blocks.get("subtitle").blockType, "heading");
  assert.equal(blocks.get("section").blockType, "heading");
  assert.equal(blocks.get("section-es").blockType, "heading");
  assert.equal(blocks.get("label").blockType, "paragraph");
  assert.equal(blocks.get("body").blockType, "paragraph");
  for (const id of ["option", "option2", "option3"]) {
    assert.equal(blocks.get(id).blockType, "list-item");
    assert.equal(blocks.get(id).listMarker, blocks.get(id).text[0]);
  }
  assert.equal(blocks.get("subtitle").tableId, undefined);
});

test("form metadata is optional for legacy input but validates field IDs and rectangles", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "form-layout-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "layout.json");
  const document = { schemaVersion: "1.0.0", documentId: "legacy", source: { filePath: "form.pdf" },
    pages: [{ pageNumber: 1, width: 612, height: 792, textBlocks: [
      { id: "a", text: "Instructions", bbox: [72, 100, 240, 12], fontSize: 12 }
    ] }] };
  await writeFile(input, JSON.stringify(document));
  assert.equal((await analyzeLayout(input)).pages.length, 1);
  for (const change of [
    (page) => { page.textBlocks[0].formFieldIds = "wrong-type"; },
    (page) => { page.textBlocks[0].formFieldIds = ["duplicate", "duplicate"]; },
    (page) => { page.formFields = [{ id: "field", bbox: [0, 0, -1, 12] }]; }
  ]) {
    const invalid = structuredClone(document);
    change(invalid.pages[0]);
    await writeFile(input, JSON.stringify(invalid));
    await assert.rejects(analyzeLayout(input), /schema validation/);
  }
});
