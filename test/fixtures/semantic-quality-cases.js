// Authored synthetic expectations. These are regression references, not human-reader evidence.
const block = (id, text, extra = {}) => ({ id, text, bbox: [72, 100, 220, 12], fontName: "FixtureSans", fontSize: 12, blockType: "paragraph", ...extra });
const page = (pageNumber, textBlocks, extra = {}) => ({ pageNumber, width: 612, height: 800, textBlocks, ...extra });
const layout = (pages) => ({ schemaVersion: "1.0.0", documentId: "semantic-quality-fixture", source: { filePath: "generated-reference.pdf", language: "en-US" }, pages });
const pair = (a, b, changes = {}) => layout([page(1, [block("first", a, { blockType: "list-item", listGroupId: "one", bbox: [72, 720, 220, 12] })]),
  page(2, [block("second", b, { blockType: "list-item", listGroupId: "two", ...changes })])]);
const cell = (id, text, row, col, extra = {}) => block(id, text, { blockType: "table-cell", tableId: "table", tableRowIndex: row, tableColumnIndex: col,
  bbox: [72 + col * 130, 100 + row * 25, 130, 12], ...extra });

export const semanticQualityCases = [
  { id: "heading-field-label", layout: layout([page(1, [block("title", "Supplemental Affirmation in Support of Order to Show Cause", { blockType: "heading", headingLevel: 1 }),
    block("label", "Index #:", { blockType: "heading", headingLevel: 2, formFieldIds: ["w"], bbox: [72, 150, 100, 12] })],
    { formFields: [{ id: "w", bbox: [175, 150, 100, 12], tooltip: "Index #" }] })]), expected: { roles: { title: "H1", label: "P" }, labels: { w: ["label"] } } },
  { id: "heading-sentence-review", layout: layout([page(1, [block("sentence", "This is an unusually long sentence which has been emphasized using typography but requires a reviewer to determine whether it introduces a section.", { blockType: "heading", headingLevel: 2 })])]),
    expected: { reviewCodes: ["HEADING_SENTENCE_REVIEW"] } },
  { id: "wrapped-label", layout: layout([page(1, [block("a", "Full legal", { formFieldIds: ["w"] }), block("b", "name:", { formFieldIds: ["w"], bbox: [72, 116, 220, 12] }),
    block("instruction", "Enter all names", { formFieldIds: ["w"], bbox: [72, 140, 220, 12] })], { formFields: [{ id: "w", bbox: [310, 100, 160, 24], tooltip: "Full legal name" }] })]),
    expected: { labels: { w: ["a", "b"] }, descriptions: { w: ["instruction"] } } },
  { id: "ambiguous-label", layout: layout([page(1, [block("a", "First label", { formFieldIds: ["w"] }), block("b", "Second label", { formFieldIds: ["w"], bbox: [72, 120, 220, 12] })],
    { formFields: [{ id: "w", bbox: [310, 100, 100, 24] }] })]), expected: { labels: { w: [] }, reviewCodes: ["FORM_LABEL_AMBIGUOUS"] } },
  ...[["decimal", "1. First", "2. Second"], ["alphabetic", "a) First", "b) Second"], ["roman", "iv. First", "v. Second"]]
    .map(([name, a, b]) => ({ id: `${name}-list-pages`, layout: pair(a, b), expected: { sameList: [["first", "second"]], order: [["first", "second"]],
      listNumbering: { first: name === "decimal" ? "Decimal" : name === "alphabetic" ? "LowerAlpha" : "LowerRoman" } } })),
  { id: "list-restart", layout: pair("1. First", "1. Restart"), expected: { separateLists: [["first", "second"]] } },
  { id: "list-style-change", layout: pair("a) First", "b) Second", { fontName: "DifferentFont" }), expected: { separateLists: [["first", "second"]] } },
  { id: "paragraph-pages", layout: layout([page(1, [block("first", "A sentence that continues", { bbox: [72, 720, 220, 12] })]), page(2, [block("second", "on the next page")])]),
    expected: { sameParagraph: [["first", "second"]], tagCounts: { P: 1 }, order: [["first", "second"]] } },
  { id: "paragraph-ended", layout: layout([page(1, [block("first", "A finished sentence.", { bbox: [72, 720, 220, 12] })]), page(2, [block("second", "another paragraph")])]),
    expected: { tagCounts: { P: 2 } } },
  { id: "list-paragraph-continuation", layout: layout([page(1, [block("first", "1. A sentence that continues", { blockType: "list-item", listGroupId: "one" }),
    block("second", "with a second paragraph", { bbox: [90, 120, 220, 12] })])]), expected: { listBodies: [["first", "second"]], tagCounts: { LI: 1 } } },
  { id: "explicit-caption-order", layout: layout([page(1, [block("caption", "Table 1: Example", { captionForId: "table-anchor", bbox: [72, 90, 220, 12] }),
    block("table-anchor", "Table content", { bbox: [72, 200, 220, 12] })])]), expected: { order: [["table-anchor", "caption"]] } },
  { id: "spanning-heading", layout: layout([page(1, [block("right", "Right column", { columnHint: 1, bbox: [330, 160, 210, 12] }),
    block("heading", "Shared heading", { blockType: "heading", headingLevel: 1, bbox: [72, 100, 468, 18] }),
    block("left", "Left column", { columnHint: 0, bbox: [72, 160, 210, 12] })])]), expected: { order: [["heading", "left"], ["heading", "right"], ["left", "right"]] } },
  { id: "spanning-heading-bands", layout: layout([page(1, [block("top-left", "First column before heading", { columnHint: 0, bbox: [72, 100, 210, 12] }),
    block("bottom-left", "First column after heading", { columnHint: 0, bbox: [72, 500, 210, 12] }),
    block("top-right", "Second column before heading", { columnHint: 1, bbox: [330, 100, 210, 12] }),
    block("bottom-right", "Second column after heading", { columnHint: 1, bbox: [330, 500, 210, 12] }),
    block("heading", "Shared heading", { blockType: "heading", headingLevel: 1, bbox: [72, 400, 468, 18] })])]),
    expected: { order: [["top-left", "top-right"], ["top-right", "heading"], ["heading", "bottom-left"], ["bottom-left", "bottom-right"]] } },
  { id: "multi-level-table", layout: layout([page(1, [cell("group", "Measurements", 0, 0, { cellRole: "header", tableSection: "head", tableColumnSpan: 2 }),
    cell("ha", "Length", 1, 0, { cellRole: "header", tableSection: "head" }), cell("hb", "Width", 1, 1, { cellRole: "header", tableSection: "head" }),
    cell("value", "1234", 2, 0, { tableColumnSpan: 2 })])]), expected: { headers: { value: ["group", "ha", "hb"], ha: ["group"], hb: ["group"] } } }
].map((c) => ({ ...c, provenance: "maintainer-authored-synthetic-reference", expertReview: "pending" }));
