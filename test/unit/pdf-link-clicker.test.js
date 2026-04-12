import test from "node:test";
import assert from "node:assert/strict";
import { isPdfUrl, uniquePdfLinks } from "../../scripts/chrome-pdf-clicker-extension/link-utils.js";

test("isPdfUrl matches direct PDF URLs and query-string variants", () => {
  assert.equal(isPdfUrl("https://example.com/a.pdf"), true);
  assert.equal(isPdfUrl("https://example.com/a.PDF?download=1"), true);
  assert.equal(isPdfUrl("https://example.com/a.pdf#page=2"), true);
  assert.equal(isPdfUrl("https://example.com/a.html"), false);
});

test("uniquePdfLinks filters non-PDF links and removes duplicates", () => {
  const links = uniquePdfLinks([
    { href: "https://example.com/a.pdf", text: "A" },
    { href: "https://example.com/a.pdf#page=2", text: "A duplicate" },
    { href: "https://example.com/b.pdf?dl=1", text: "B" },
    { href: "https://example.com/index.html", text: "Not a PDF" }
  ]);

  assert.deepEqual(links, [
    { href: "https://example.com/a.pdf", text: "A" },
    { href: "https://example.com/b.pdf?dl=1", text: "B" }
  ]);
});
