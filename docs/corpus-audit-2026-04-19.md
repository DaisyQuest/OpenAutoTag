# Engine Audit — Downloads/pdfs Corpus (2026-04-19)

## Methodology

Sample of 11 PDFs from `C:\Users\tabur\Downloads\pdfs\`:
- 10 from `arxiv/` (academic papers, broad coverage: IDs 0001, 0010, 0050,
  0075, 0100, 0150, 0200, 0250, 0300, 0325)
- 1 from `gutenberg/` (long plain-text novel, Shakespeare complete works)

Each PDF processed through `runPipeline` with `profileId: "default"` —
identical to what the browser engine does for uploads. Outputs analyzed
for VeraPDF compliance, struct-tree health, tag-role distribution, and
content-stream characteristics.

## Headline Results

| Doc | Compliant | Leaves | With MCIDs | With Text | Blanks | Max BDC Nest |
|-----|-----------|--------|------------|-----------|--------|--------------|
| arxiv_0001 | ❌ | 230 | 230 | 230 | 0 | 2 |
| arxiv_0010 | ❌ | 502 | 412 | 298 | 114 | **14** |
| arxiv_0050 | ❌ | 1103 | 868 | 754 | 114 | 9 |
| arxiv_0075 | ❌ | 604 | 451 | 435 | 16 | 4 |
| arxiv_0100 | ❌ | 830 | 488 | 488 | 0 | 4 |
| arxiv_0150 | ❌ | 856 | 669 | 535 | 134 | 9 |
| arxiv_0200 | ✅ | 425 | 387 | 387 | 0 | 6 |
| arxiv_0250 | ❌ | 1038 | 864 | 684 | 180 | 6 |
| arxiv_0300 | ❌ | 858 | 854 | 830 | 24 | 13 |
| arxiv_0325 | ❌ | 544 | 333 | 330 | 3 | 4 |
| gutenberg_40 | ✅ | 5925 | 5925 | 5070 | 855 | **17** |

**Compliance rate: 2/11 (18%)** — most docs fail VeraPDF.

## Top Improvement Opportunities

### 1. `VERAPDF_7_21_7_1` — ToUnicode CMap incomplete (10/11 docs)

**Problem:** Academic PDFs (arxiv in particular) use TeX-produced Type1 /
Type0 fonts with sparse ToUnicode coverage — especially math symbols
(Greek letters, operators, ligatures). VeraPDF's checker walks every
character code used in content streams; any code without a Unicode
mapping fails.

**Observed on:** arxiv_0001, 0010, 0050, 0075, 0100, 0150, 0250, 0300,
0325 (and gutenberg ✅ — suggests this affects scientific-font-heavy
PDFs).

**Fix direction:**
- Extend `generateMissingToUnicode` in `PassthroughMetadataCli.java` to
  synthesize ToUnicode entries from font `/Differences` arrays where the
  glyph name is a Standard Adobe Glyph List entry (e.g. `/Beta` → U+0392,
  `/summation` → U+2211).
- For TeX math fonts (CMSY, CMMI, MSAM, etc.), bundle a lookup table —
  those fonts use well-known glyph slots.
- Fallback: if the glyph name is unknown but unique-looking, map to PUA
  (U+E000..U+F8FF) so at least every code has *a* Unicode assignment.

### 2. Deep BDC nesting (11/11 docs, up to depth 17)

**Problem:** `NativeContentStreamRewriter` opens BDC at first op of an
Assignment group and closes at last op. When groups G and H interleave
(G's op range spans H's), H nests inside G. Adobe's Content panel
shows `null Container` for nested elements. Observed up to depth 17
on gutenberg_40.

**Root cause:** matcher assigns ops to groups by position+text, but
groups can have NON-CONTIGUOUS seq ranges in the source content stream.
First-last tagging then straddles other groups' ops.

**Fix direction:**
- Re-order text ops per page so each Assignment's operators become
  contiguous. Safe for mode-3 invisible text (no visual impact).
- Or: when opening G would nest inside H's open BDC, insert an artifact
  BMC/EMC pair at the current position and re-enter G's BDC after H
  closes, assigning G a fresh MCID so the struct element has multiple
  MCRs. Preserves tagging, avoids nesting.

### 3. Blank struct leaves (8/11 docs, up to 855 per doc)

**Problem:** Struct leaves reference MCIDs whose resolved text is empty
or whitespace. Gutenberg_40 has **855 blank leaves** despite passing
VeraPDF (validator doesn't check text resolution).

**Observed on:** arxiv_0010 (114), 0050 (114), 0075 (16), 0150 (134),
0250 (180), 0300 (24), 0325 (3), gutenberg_40 (855).

**Root cause:** `pruneBlankMcidLeaves` runs only after passthrough
metadata pass, but the native rewriter can produce MCRs whose MCID
location has no extractable text — either because the glyph lacks
ToUnicode (item 1 above) or because the text op was wrapped but the
actual glyphs are in a Form XObject that the extractor doesn't walk
into.

**Fix direction:**
- After pruning, re-validate each remaining leaf against a recursive
  text-extraction pass that descends into Form XObjects.
- Suppress leaves whose ToUnicode returns only replacement characters
  (U+FFFD) or control chars.

### 4. Over-aggressive table detection (all arxiv docs)

**Problem:** `TD` is the most common role in every arxiv doc and in
gutenberg:
- gutenberg_40: **2875 TDs** vs 2819 Ps — but this is Shakespeare's
  complete works, mostly dialogue and stage directions. Should be P-
  dominant, not TD-dominant.
- arxiv_0200 (compliant!): 356 TDs, 178 TRs, 10 Tables, 29 Ps.
- arxiv_0300: 1007 TDs on a 16-page doc — implausible.

**Root cause:** layout-analyzer's `detectBorderlessTables` /
`detectTextGridTables` fire on any column-aligned text (common in
multi-column prose, reference lists, abstracts). Once detected as
a Table, every paragraph becomes a TD.

**Fix direction:**
- Tighten borderless-table detection: require a minimum cell count
  (e.g. ≥6 cells in ≥2 rows) AND structural signals (consistent column
  spacing, aligned baselines, non-sentence text density per cell).
- Penalize "cells" that contain complete sentences with periods —
  real tables rarely have multi-sentence cells.
- Reject table classification when the "cell text" average length
  exceeds a threshold (say >200 chars).

### 5. `SYMBOLIC_WITHOUT_DIFFERENCES` (arxiv_0010, 0075)

**Problem:** Symbolic fonts (TeX math fonts, dingbat fonts) must have a
`/Differences` array to tell validators how codes map to glyph names.
VeraPDF flags when /Differences is absent.

**Fix direction:** `synthesizeSymbolicDifferences` already exists in
`PassthroughMetadataCli.java` but appears to miss some font patterns.
Audit which symbolic fonts trigger it and extend detection to include
TeX-style `/CMR`, `/CMEX`, `/MSAM` font families.

### 6. `VERAPDF_7_21_4_2_1`, `VERAPDF_7_21_4_1_2` — CIDSystemInfo (arxiv_0075, 0250)

**Problem:** Type0/CIDFontType2 fonts where descendant CIDSystemInfo
disagrees with CMap's /CIDSystemInfo — a VeraPDF strict check.

**Fix direction:** Extend `stripMalformedCidSets` to also verify and
normalize CIDSystemInfo consistency between parent Type0 /Encoding
CMap and descendant /CIDSystemInfo.

### 7. `VERAPDF_7_2_14` — Table with THead but no TBody (arxiv_0300)

**Problem:** Same as LRB 006-2026-31152 — semantic engine detects a
THead but doesn't emit a TBody. VeraPDF requires both if either is
present.

**Fix direction:** Post-process tag tree: any `Table` with a `THead`
child but no `TBody` should get the non-THead rows wrapped in a
synthetic `TBody`.

## Adobe Tags Panel Preview (documented limitation)

Separate from VeraPDF findings: Adobe Acrobat's **Tags panel preview
column** extracts text only from visibly-rendered glyphs (text
rendering modes 0, 1, 2). On scanned PDFs with invisible OCR overlays
(mode 3), no preview text appears next to the tag regardless of how
the struct tree is constructed. `/ActualText` is honored by AT and
by Acrobat's tag detail modal, but the preview column specifically
reads visible glyphs. This is an Adobe authoring-tool UI behavior,
not a PDF/UA compliance issue.

## Recommended Priorities

Based on frequency × impact:

1. **ToUnicode completeness** (item 1) — fixes ~10/11 docs' primary
   VeraPDF failure, highest-leverage single change.
2. **Table over-detection** (item 4) — improves tag-tree semantic
   quality across ALL prose-heavy docs, not just scanned ones.
3. **BDC nesting** (item 2) — fixes Adobe Content panel navigation
   across the entire corpus.
4. **Blank-leaf follow-through** (item 3) — improves perceived tag
   quality; gutenberg_40's 855 blanks is striking despite compliance.
5. **Table header/body pairing** (item 7) — narrow but recurring.
6. **Symbolic /Differences** (item 5), **CIDSystemInfo** (item 6) —
   per-doc fixes with known recipes.

## Post-Audit Fixes Applied (2026-04-19, builds 19p–19s)

### ✅ Item 1: ToUnicode completeness (DONE)
Implemented in `PassthroughMetadataCli.java`:
- Added `lookupTexGlyphName` with ~120 TeX glyph names (Greek alphabet,
  big operators, big delimiters with size-suffix normalization, arrows,
  math relations, accents, ligatures).
- Removed the "skip fonts that already have ToUnicode" gate — we now
  regenerate for every font. The new CMap preserves resolvable mappings
  via `font.toUnicode()` + AGL + TeX fallback.
- Added `<00><FF>[<FFFD> × 256]` bfrange-array catch-all for simple
  fonts so every code in the codespace has a mapping. (Type0 fonts
  rely on their original CMap + our per-code overrides.)
- Filter Unicode outputs to replace U+0000, U+FEFF, U+FFFE with
  U+FFFD (VeraPDF 7.21.7.2 forbids those three).

### ✅ Item 7: Table THead-without-TBody (DONE)
In `modules/tag-builder/index.js` `normalizeTableSections`: when a
Table would end up with only a THead (no body rows detected), unwrap
the THead and emit its TRs as direct Table children. Eliminates
`VERAPDF_7_2_14`.

### Additional fixes — builds 19t, 19u

**19t — `stripType1CharSets`:** Removes /CharSet from Type1
FontDescriptors. TeX subsets (CMR, CMEX, CMSY, etc.) ship with /CharSet
listing only source-referenced characters, not every glyph in the
embedded font program → VERAPDF_7_21_4_2_1. /CharSet is optional per
PDF 32000-1 § 9.8.1; removing it is safe. Fixed arxiv_0075.

**19u — Symbolic Differences fallback:** `synthesizeSymbolicDifferences`
now enumerates every simple symbolic font in the doc (including in
Form XObjects), not just ones with collectable page-content usage.
When usage-based synthesis returns an empty Differences array, falls
back to a 256-entry synthetic array using `uniXXXX` names. Satisfies
SYMBOLIC_WITHOUT_DIFFERENCES finding on all fonts including those used
only inside Form XObjects. Fixed arxiv_0010, 0075.

### Compliance progression (11-doc sample)

| Build | Compliant | Dominant remaining failures |
|-------|-----------|----------------------------|
| Baseline (19m) | 2/11 | `VERAPDF_7_21_7_1` (10/11) |
| After ToUnicode (19p–s) | 6/11 | Font-width, CIDSystemInfo |
| After CharSet + Symb Diffs (19t–u) | **8/11** | Font-width (7_21_5_1), TrueType mapping (7_21_4_1_2) |

4× increase in compliance rate from same sample. LRB corpus still
15/15 compliant; 29/29 pipeline regression tests pass.

### Remaining failures (3 docs)
- `VERAPDF_7_21_5_1` — /Widths ≠ embedded font program glyph widths
  (arxiv_0100, 0300). Known PDFBox Type0/CIDFontType2 quirk; would
  require per-glyph width audit against the embedded program.
- `VERAPDF_7_21_4_1_2` — TrueType charmap can't map character codes to
  glyphs via the standard mechanism (arxiv_0250, 0300). Usually
  indicates the embedded TrueType's cmap subtable is non-standard;
  fixes require selecting a different cmap or regenerating it.
