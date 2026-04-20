import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(moduleDir, "fixtures", "external-catalog");

test("external arxiv catalog manifest is broad, deterministic, and internally consistent", async () => {
  const categories = JSON.parse(await readFile(path.join(catalogDir, "arxiv-categories.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(catalogDir, "manifest.json"), "utf8"));

  assert.equal(categories.length, 50, "expected 50 curated categories");
  assert.equal(new Set(categories.map(category => category.id)).size, 50, "category ids must be unique");

  assert.equal(manifest.policy.primaryCategoryOnly, true);
  assert.equal(manifest.categories.length, 50);
  assert.equal(manifest.items.length, 5000);

  const categoryIds = new Set(categories.map(category => category.id));
  const manifestCategoryIds = new Set(manifest.categories.map(category => category.id));
  assert.deepEqual([...manifestCategoryIds].sort(), [...categoryIds].sort());

  const counts = new Map(categories.map(category => [category.id, 0]));
  const ids = new Set();

  for (const item of manifest.items) {
    assert.ok(categoryIds.has(item.primaryCategory), `unknown category for ${item.arxivId}`);
    assert.ok(item.pdfUrl.startsWith("https://arxiv.org/pdf/"), `bad pdf url for ${item.arxivId}`);
    assert.ok(item.abstractUrl.startsWith("https://arxiv.org/abs/"), `bad abstract url for ${item.arxivId}`);
    assert.ok(item.localRelativePath.startsWith(`downloads/${item.primaryCategory}/`));
    assert.equal(item.id, `arxiv:${item.arxivId}`);
    assert.ok(Array.isArray(item.authors) && item.authors.length > 0, `authors missing for ${item.arxivId}`);
    assert.ok(Array.isArray(item.categories) && item.categories.length > 0, `categories missing for ${item.arxivId}`);
    assert.ok(!ids.has(item.arxivId), `duplicate arXiv id ${item.arxivId}`);
    ids.add(item.arxivId);
    counts.set(item.primaryCategory, (counts.get(item.primaryCategory) || 0) + 1);
  }

  for (const category of categories) {
    assert.equal(counts.get(category.id), 100, `${category.id} must contribute exactly 100 items`);
  }
});
