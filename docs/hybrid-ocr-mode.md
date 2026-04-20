# Hybrid OCR Mode

**Problem**: Scanned legal PDFs (e.g., NY Civil Court filings) embed an
invisible OCR text layer of poor quality — stylized letterheads become
`_Cou_nty_of K_ing_s`, horizontal rules become runs of `1`s. Our
accessibility pipeline faithfully tags this garbage because the text
layer exists. AT reads nonsense; sighted users see a perfectly legible
scanned image.

**Goal**: combine the best of both worlds.
1. Keep the native PDF rendering (scanned image + original content
   stream, unchanged for sighted-user viewing).
2. Replace the garbage-OCR accessible text with Tesseract-fresh text
   so AT reads what sighted users see.

## Detection

A page is "bad OCR" (hybrid-eligible) if ANY of:
- It references a font whose base name matches `/Hidden.*OCR/i`,
  `/OCR-?[AB]$/`, or `/Invisible.*Text/i` (producer signals).
- `byteStripOcrTextOps` found `.notdef` references on that page (font-
  level .notdef rule is already tripping).
- Token-quality heuristic: ≥30% of source-OCR tokens on the page fail
  a basic word-shape check (runs of `_`, consecutive single chars,
  high ratio of non-alphanumeric chars).

Detection lives in `modules/parser/index.js` as a new helper
`detectBadSourceOcr(page)` that returns `true | false`.

## Pipeline flow in hybrid mode

When a page is flagged:

1. **Parser**: force Tesseract OCR on that page (overrides the sparse-
   text heuristic in `shouldRunOcrForPage`). Tesseract returns text
   blocks with page-coord bboxes and confidence.

2. **Text-source replacement**: the page's `textBlocks` in the parser
   output come from Tesseract, not the source content stream's Tj
   operators. Other downstream modules (semantic-engine, matcher,
   tag-builder) now see clean text.

3. **Semantic engine**: groups the Tesseract blocks into paragraphs,
   headings, lists, tables — same as it does for a born-digital PDF.
   Produces a clean semantic tree with proper prose.

4. **Matcher**: this is the key integration step. The matcher today
   maps semantic nodes → content stream operators by text similarity.
   On hybrid pages, text similarity fails because the content stream
   has garbled source OCR. Use bbox-based matching: each semantic
   node's bbox overlaps some content-stream text-op bbox. Associate
   them by bbox IoU rather than text.

5. **Tag builder**: produces struct tree from clean semantic nodes,
   references matched MCIDs.

6. **Rewriter**: wraps the source content stream ops in tagged BDC
   with MCIDs. Content stream operators are the SAME (garbled source
   OCR still renders). Struct tree leaves carry `/ActualText` with
   the Tesseract text for that region — AT reads that instead of the
   children.

## Key invariant

**The native PDF is preserved byte-for-byte at the content-stream
level** (except for our tagged BDC/EMC wrappers). Visual rendering is
identical to source. Only the struct tree + `/ActualText` are changed.

## Fallback path

If Tesseract fails or confidence is low (`<0.6`), hybrid mode falls
back to standard mode for that page — tag the source OCR as-is, user
still gets a valid PDF/UA structure (just with garbled text).

## Interaction with `pruneBlankMcidLeaves` (v1 complete)

The accessibility pass runs `byteStripOcrTextOps` (blanks Tj/TJ in
OCR fonts) followed by `pruneBlankMcidLeaves` (removes struct leaves
whose MCIDs resolve to empty text).

In hybrid mode, the struct tree is built from Tesseract text but
points to MCIDs in the source content stream — which
`byteStripOcrTextOps` has emptied. Without `/ActualText`, those
leaves would be stripped by `pruneBlankMcidLeaves`.

**v1 wiring (implemented):**

1. `modules/parser/index.js`: `buildSelectedPageResult` sets
   `page.hybrid = true` when Tesseract output is adopted via the
   hybrid trigger.
2. `modules/semantic-engine/index.js`: `buildNodesForPage`
   propagates `node.hybrid = true` onto each semantic node whose
   source page is hybrid.
3. `modules/tag-builder/index.js`: `createLeaf` sets
   `leaf.actualText = node.text` when the source node is hybrid
   and has non-empty text.
4. `NativeContentStreamRewriter.java:891` already wires
   `node.actualText → el.setActualText`, so struct leaves on
   hybrid pages now carry `/ActualText` with the Tesseract text.
5. `PassthroughMetadataCli.pruneBlankMcidLeaves` skips any leaf
   with non-empty `/ActualText` or `/Alt`, preserving hybrid leaves
   even when their backing MCIDs are blank.

**Result:** AT reads the Tesseract text via `/ActualText`; sighted
users see the scanned image (rendered from unchanged content
streams); no blank leaves.

## Config

New `profileOverrides.parser.hybridOcrMode` values:
- `"auto"` (default): detect + enable hybrid on flagged pages
- `"force"`: run Tesseract + hybrid-tag on every page (debug/testing)
- `"off"`: disable — current behavior, source OCR passes through
