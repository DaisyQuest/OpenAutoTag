# Native Tagging: 20-Point Improvement Plan

**Goal**: guarantee strong native tagging on 99%+ of PDFs in the wild by
closing measured gaps in our current pipeline, aligning output with
actual screen-reader behavior (not just PAC/VeraPDF pass), and
positioning for PDF/UA-2.

**Evidence base**:
- End-to-end measurement run 2026-04-18 across 27 corpus PDFs (15
  LRBTest + 12 external): 100% load success, 100% struct tree present,
  0 TH /Scope missing, but 16 distinct VeraPDF/font-audit finding codes
  remain. Font embedding dominates (9 of 16 codes, 354 of ~367
  findings, 20+ affected docs).
- PDF/UA-2 (ISO 14289-2:2024) and WTPDF 1.0 research.
- Matterhorn Protocol 1.1 coverage analysis: 89 of 136 conditions
  machine-checkable; 47 human-only we must NOT claim to solve
  (entire list semantics §16, reading-order §09-001, heading
  presence §14-001, table-header detection §15-001/002, formula
  detection §17-001, running-header classification §18-xxx).
- Screen-reader behavior survey (NVDA 2025, JAWS 2024-2025, VoiceOver,
  Narrator, TalkBack): PAC-pass / reader-broken failure modes
  catalogued.

**What our tests catch today**: matcher output quality (≥99% match
rate, zero bogus assignments across corpus) and end-to-end pipeline
output invariants (loads cleanly, struct tree present, findings within
pinned allowlist). What they DON'T catch: Adobe's proprietary
content-stream validation, screen-reader behavioral regressions,
reading-order semantics.

---

## Category A — Font embedding (9 codes, 20+ docs affected, highest lever)

### 1. Safe Form-XObject font replacement via content-stream rewriting
**What**: Replace unembedded Standard 14 Helvetica inside Form XObjects
by also rewriting the XObject's content stream Tj/TJ operators to use
the embedded TrueType font's correct character codes. Currently we
skip XObjects entirely (per the project-memory trade-off) to avoid the
"error in this PDF" Adobe regression; content-stream rewriting lifts
the trade-off.
**Evidence**: VERAPDF_7_21_4_1_1 fires on 21/27 corpus docs.
**Risk**: High — a bug here breaks rendering. Guard with
per-document before/after text-extraction equality test.

### 2. Synthesize ToUnicode CMaps even when `font.toUnicode()` returns null
**What**: For Type0/Identity-H fonts without any resolver path (no
/Encoding /Differences, no cmap fallback, no AGL reachability), emit a
best-effort CMap using glyph-name-to-Unicode heuristics + /ActualText
on enclosing spans as a fallback for readers that ignore ToUnicode.
**Evidence**: TO_UNICODE_MISSING on 5 docs.

### 3. SYMBOLIC_WITHOUT_DIFFERENCES fix: emit minimal /Encoding /Differences
**What**: When a symbolic (non-Latin) font is referenced without a
/Differences array, synthesize one covering only the codes used in the
content stream, mapping each to its glyph name via the font's built-in
cmap.
**Evidence**: SYMBOLIC_WITHOUT_DIFFERENCES on 6 docs (12 findings).

### 4. Strip malformed /CIDSet from Type0 subsets (VERAPDF_7_21_8_1)
**What**: Detect /CIDSet streams that don't cover every used CID and
either regenerate them from the actual used-glyph set or remove the
entry (CIDSet is optional in PDF 2.0).
**Evidence**: VERAPDF_7_21_8_1 on 5 docs.

### 5. CIDToGIDMap sync for TrueType CID fonts (VERAPDF_7_21_4_2_2)
**What**: When a CIDFontType2 declares /CIDToGIDMap /Identity but the
underlying TrueType's glyph count doesn't match, emit an explicit
CIDToGIDMap stream enumerating actually-used GIDs.
**Evidence**: VERAPDF_7_21_4_2_2 on 3 docs.

---

## Category B — Matterhorn cosmetic wins (lock them down)

### 6. BDC/EMC balance verifier as a post-write gate
**What**: After the rewriter finishes, scan each content stream for
imbalanced BDC/EMC pairs and dangling marked-content operators.
Refuse to ship a document with imbalanced MC nesting — a known
silent-fail for NVDA/JAWS that PAC sometimes passes.
**Matterhorn**: 01-003, 01-004.

### 7. Guarantee `/Tabs = S` on every page with annotations
**What**: Post-write pass: for every PDPage with /Annots present, set
/Tabs = /S (structure order) on the page dictionary. This is
frequently forgotten by source producers.
**Matterhorn**: 28-008, 28-009.

### 8. Tighten `normalizeHeadingHierarchy`: no H-generic, no skipped levels
**What**: Current pass renumbers H# so first heading is H1 and no
level is skipped. Extend it to (a) refuse /H generic (promote to
numbered H1-H6), (b) log any originally-skipped level for diagnostics.
**Matterhorn**: 14-002, 14-003, 14-006.

### 9. Wrap markup annotations in `/Annot` struct elements
**What**: For every annotation subtype that is NOT Link/Widget/Popup
(Stamp, FreeText, StrikeOut, Highlight, etc.), emit an `/Annot`
structure element wrapping an OBJR reference and carrying
`/Contents` for the accessible name.
**Matterhorn**: 28-004.

### 10. Widget `/TU` backfill from labels or field name
**What**: For every widget annotation without /TU, synthesize one
from (in priority order): the visible-text label from semantic
extraction, the AcroForm field's /T (partial name), or a generic
"Input field".
**Matterhorn**: 28-005.

---

## Category C — Screen reader reality (bridge PAC-pass → reader-works)

### 11. Struct-attribute `/Lang` on mixed-language spans
**What**: When the semantic extractor detects non-default-language
runs (RFC 3066 tag differs from Catalog /Lang), emit /Span struct
elements carrying /Lang via the `/A /O /NSO` attribute chain — NOT
via marked-content properties (which NVDA/JAWS miss).
**Evidence**: Multiple research sources confirm marked-content
/Lang is ignored by all major readers; struct-element /Lang is
respected.

### 12. `/OBJR` inside `/Form` wrappers for every widget
**What**: For every widget annotation that participates in
AcroForm, emit an OBJR reference inside a /Form struct element so
that JAWS/NVDA announce fields in document reading order, not tab
order.
**Evidence**: Research flags this as the primary tagged-form vs
unlinked-AcroForm gap.

### 13. `/ActualText` fallback on spans for CID-font gibberish
**What**: When a CID Identity-H font lacks a ToUnicode CMap AND the
semantic extractor has recovered readable Unicode for the glyph
run, wrap the run in `/Span` with `/ActualText` set. This is the
NVDA/JAWS fix for the "gibberish CID font" case; VoiceOver still
needs the real ToUnicode (#2 above).

### 14. Content-stream order == tag-tree leaf order
**What**: Add a post-rewrite verifier that walks the structure tree
in reading-order and confirms that for each page, the MCIDs
referenced by struct leaves appear in the same sequence as the
page's content stream emits them. If they diverge, emit a warning
(future: re-emit the content stream in struct order).
**Evidence**: Research: "every reader has some mode that falls
back to content-stream; losing alignment produces the most common
passes-PAC/garbled-in-NVDA bug."

### 15. Decorative `/Figure` with empty `/Alt` → `/Artifact` promotion
**What**: Detect `/Figure` elements with empty or whitespace-only
/Alt (plus no meaningful child content) and rewrite them as
/Artifact marked-content. Empty /Alt is NOT announced as silence
by VoiceOver and Narrator — they announce "image" anyway. Only
/Artifact is reliably silenced.

---

## Category D — Structural tagging quality (deeper trees)

### 16. Section promotion for flat-P-under-Document trees
**What**: When the document has H# elements under /Document with no
intervening /Sect, insert /Sect wrappers between consecutive
headings (Sect = one H# + following content up to next H# of equal
or greater level).
**Evidence**: ext-thai-constitution-en produces depth=2 with 1020
flat P elements across 115 pages; promoting to Sect-per-section
takes it to depth≥4 and enables NVDA/JAWS section navigation.

### 17. List construction from geometric cues
**What**: The semantic extractor detects bullet/number-prefixed
paragraph clusters; emit them as `/L > (/LI > /Lbl + /LBody)+` with
/ListNumbering attribute set appropriately (Decimal, Disc, Circle,
Square, Roman). Matterhorn §16 is human-only for list
*semantics*, but producing structurally-valid L is machine-doable
and improves reader UX (JAWS/NVDA announce "list of N items" with
navigation hotkeys).

### 18. Multi-column /Sect or /Art wrappers
**What**: For academic/multi-column layouts (arxiv, scientific
papers), wrap each column's content in a `/Sect` or `/Art`
struct element so readers that fall back to visual order don't
cross-read columns. The semantic extractor already does column
detection; pipe column IDs through to the tag builder.

---

## Category E — PDF/UA-2 readiness

### 19. PDF/UA-2 emit mode (opt-in)
**What**: Add a writer profile that emits PDF 2.0 + namespaced
structure (Document root in PDF 2.0 namespace, /Namespaces array
declaring 1.7/2.0/MathML), renames /Note → /FENote with /Ref
back-links and /NoteType, replaces /H with numbered /H1../H6,
replaces page-index /Dest with structure destinations /SD, removes
any XFA content, sets `pdfuaid:part = 2` + `pdfuaid:rev = "2024"`
in XMP.
**Validation target**: VeraPDF `ua2` profile, WTPDF 1.0.

### 20. Associated-File (AF) slot for MathML on /Formula
**What**: When `/Formula` elements are detected, allow attaching a
MathML XML payload as an AF (Associated File) with
`/AFRelationship /Supplement`, so PDF/UA-2-aware consumers can read
the equation. Keep `/Alt` plaintext fallback for UA-1 readers and
screen readers that don't yet parse PDF MathML.

---

## Prioritization

| Priority | Points | Reason |
|---|---|---|
| P0 (immediate) | 4, 6, 7, 9, 10, 14, 15 | Low effort, high-confidence wins on Matterhorn + reader behavior |
| P1 (next) | 2, 3, 5, 8, 11, 12, 13 | Medium effort, touches 5+ corpus docs each |
| P2 (longer) | 1, 16, 17, 18 | High effort, requires new geometric / content-stream rewriting logic |
| P3 (strategic) | 19, 20 | UA-2 — emit mode + MathML AF slot, validates against VeraPDF `ua2` |

## What we will NOT claim to solve

Per Matterhorn 1.1 category of 47 human-only checkpoints:
- Reading-order *semantics* (09-001) — only order *consistency* (#14)
- Heading *presence* (14-001) — only structural *regularity* (#8, #16)
- Table-header *detection* (15-001/002) — only /Scope emission on TH we already classified
- All list *semantics* (16-001/002/003) — only structural *shape* (#17)
- Formula *detection* (17-001) — only tagging of already-detected formulas (#20)
- Running-header/footer *classification* (18-001/002) — only downstream /Artifact marking
- Alt-text *appropriateness* (13-004) — only its presence

These remain human-review requirements and our output should say so
explicitly.

## How we'll measure progress

The existing `pipeline-output-regression.test.js` pins the 16 finding
codes as an allowlist with the corpus as baseline. Each plan point,
when implemented, should shrink that allowlist. Pin reductions
corpus-wide, not per-doc, to avoid whack-a-mole.

---

# Addendum — Tag-Vocabulary Gaps (from Report.md analysis)

Today we emit ~15 structure types (Document, Sect, P, L, LI, Lbl, LBody,
Table, TR, TH, TD, Figure, Link, H1-H6). PDF 1.7 defines ~30 standard
tags and PDF 2.0 adds ~15 more. The 20-point plan above focuses on
correctness of what we emit; this addendum catalogs the tags we don't
emit at all, ranked by expected impact on screen-reader UX.

## High-impact inline semantics (not currently emitted)

### A1. `Em` / `Strong` from bold/italic runs
NVDA and JAWS both announce emphasis when a run is tagged `Em` /
`Strong`. Today we flatten formatting into the parent P. Triggers:
italic-style runs → `Em`; bold-weight runs → `Strong`. Requires passing
style metadata from the layout extractor through the tag builder.

### A2. `Code` for monospaced runs
Technical docs (arxiv, NIST SP) contain inline code. Heuristic:
font-family is Courier / NotoSansMono / Consolas / similar. Wrap as
`Code` spans. Medium effort — layout extractor already exposes font
family.

### A3. `/E` attribute for abbreviations
Tag all-caps 2-6-letter tokens (W3C, USA, URL, XML) with `/E` expansion
from a small dictionary. Screen readers prefer spelled-out expansion
when `/E` is present. Low effort, noticeable UX improvement.

### A4. `BlockQuote` for indented paragraph blocks
Detect contiguous paragraphs with deeper-than-baseline left margin +
no enclosing list → `BlockQuote`. Common in legal, academic, and
journalistic PDFs. Medium effort (needs indent-threshold heuristic).

## High-impact block/grouping semantics

### A5. `Title` as distinct from first `H1`
WTPDF + PDF 2.0 prefer `Title` for document title (separate from PDF
`/Info /Title` metadata). Heuristic: largest-font-size text on page 1,
above any headings. Today this becomes `H1` which is semantically
wrong for "the title of the document" vs "the first section header."

### A6. `Caption` for "Figure N:" / "Table N:" text
Today this stays in the surrounding P. Caption must be first or last
child of its semantic parent (Figure/Table). Detectable via pattern
match on leading tokens. Medium effort (requires associating the
caption paragraph with the target Figure/Table node in the tree).

### A7. `TOC` / `TOCI` for table-of-contents pages
Heuristic: a page whose content is dominated by entries matching
`<heading-text> ... <page-number>` pattern (dot leaders optional).
Each entry becomes `TOCI`, the whole page becomes `TOC`. Adds
navigation affordance for readers. Medium effort.

### A8. `Reference` for intra-document cross-refs
Distinct from `Link`. Pattern: "see Section 3.2" / "Figure 5" /
"[Smith 2024]" inline references that don't have a target URI but
point to tagged content. Pairs with `Ref` attribute. Medium effort.

### A9. `BibEntry` for bibliography entries
Detect "References" / "Bibliography" heading, then mark each following
paragraph as `BibEntry` until the next heading or end of section.
Common in academic PDFs (arxiv, NIST). Low effort — pattern + state
machine.

## PDF 2.0 vocabulary (future-facing, pairs with Plan #19 UA-2 mode)

### A10. `FENote` with `NoteType` + bidirectional `Ref`
Footnote/endnote detection: small-font text at page bottom with
leading superscript-like marker. Pair with `Ref` back to the
superscript marker in the body text. Replaces `Note` in PDF 2.0.

### A11. `Aside` for sidebar boxes / pull quotes
Boxed content outside main flow. Detection: isolated content block
with distinct background or border geometry.

### A12. `Sub` for semantic subdivisions
Line-numbered legal text, verse numbers, etc. When each line is
numbered, wrap each numbered line in `Sub`.

### A13. `Formula` + MathML namespace (pairs with Plan #20)
Detection today: none. Academic PDFs (arxiv) contain formulas that
get flattened into P. Even lacking MathML extraction, wrapping a
detected formula region in `Formula` with `/Alt` plaintext is a
strict improvement.

## Attribute owners we don't use

### A14. `Layout` attribute owner for positional info
Applies to any block element. Keys like `Placement` (Block/Inline/
Before/Start/End), `WritingMode`, `BBox`, text decoration. Useful
for complex layouts where a reader could use placement hints.

### A15. `Table` attribute owner for cell relationships
Beyond `/Scope`: `/ColSpan`, `/RowSpan`, `/Headers`, `/Summary`.
The research flagged this as the NVDA/JAWS-reliable path for
complex tables — superset of `/Scope`.

### A16. `PrintField` attribute owner for widgets
Pairs with Plan #12 (OBJR in Form). Carries `/Role` (PB/RB/CB/TV)
and the visible label (`/Desc`). Screen readers use this to
announce widget type accurately.

## What Report.md confirms is NOT machine-solvable

Matches the Matterhorn 47-human-only list: reading order *semantics*
(but not order *consistency*, which we do verify), heading *presence*
(but not level *regularity*, which we normalize), table-header
*detection* (we only emit `/Scope` on TH the classifier produced),
`/Alt` appropriateness (we only emit it, not judge quality), decorative
vs. informative graphics (see Plan #15).

## Revised priority after Report.md

| Priority | Adds | Rationale |
|---|---|---|
| P1+ | A1-A4 (Em/Strong/Code/E, BlockQuote) | Cheap, broad reader-UX win |
| P1+ | A5 (Title vs H1), A6 (Caption) | Structural correctness, WTPDF compliance |
| P2 | A9 (BibEntry), A7 (TOC/TOCI) | Academic/formal PDFs — helps a specific class |
| P2 | A14-A16 (attribute owners) | Pairs with existing plan items |
| P3 | A10-A13, A8 | PDF/UA-2 vocabulary — pairs with Plan #19 |

Total combined: ~36 actionable items (20 original + 16 from addendum).
Most original P0 items plus A1-A6 are achievable in the next few
sessions; the rest is PDF/UA-2 scope.
