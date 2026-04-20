# Production Calibration Report — Native PDF Tagging Pipeline

This report summarizes calibration results for the native PDF tagging
matcher across a 34-PDF external corpus spanning 11 distinct producers,
5 PDF versions (1.2 through 1.7), 4 non-Latin scripts, rotated pages,
AcroForm fillables, dense tabular data, scanned-equivalent Word output,
and multi-column academic layouts.

**Corpus timestamp:** 2026-04-18
**Pipeline version:** post-C0-normalization / spaceless-containment
fallback / bidirectional textSimilarity containment.

## Summary

- **Parser (NativeContentStreamParser):** 34/34 PDFs parsed cleanly,
  zero errors, zero exceptions. Handles PDF 1.2–1.7, pages up to 492,
  operator counts up to 145 K, multilingual text (Arabic, Chinese,
  Russian, French, Spanish), and rotated pages.
- **Hierarchical StructTreeRoot (`NativeContentStreamRewriter`):**
  previously the rewriter flattened the tag-builder's hierarchical
  output into `Document > [all leaves]`, losing Sect → H1 / Table →
  TR → TD nesting. Now accepts `--tags <tagging.json>` and emits a
  depth-5+ structure tree matching the semantic hierarchy. Uses
  `PDMarkedContentReference` with /Pg so multi-page elements
  (paragraphs that wrap across page breaks) are represented
  correctly with per-ref page pointers. Verified on
  irs-p1040-tax-tables: maxDepth 5, 3380 elements, `Table>TR>TD`
  parent-child chain present, pinned by the new
  `hierarchy-regression.test.js`.
- **Profile auto-detection (`modules/profile-detector`):** new
  heuristic classifier wired into the CLI (`--profile auto`) and
  exposed as the `detect_profile` MCP tool. Classifies 62/62
  corpus PDFs with every decision explained, 15 regression tests
  pinning the behavior (12 corpus + 3 synthetic), and end-to-end
  A/B proof that the chosen profile produces measurably different
  pipeline output (scientific profile on `nist-fips-140-3`
  promoted 1 subsection that default missed).
- **Matcher (NativeTagMatcher):** zero-bogus across 12 pinned
  external fixtures; aggregate match rate ≥98% across ~90 K
  operators. Three systemic issues were **fixed during this
  calibration pass**:
  1. **Rotation transform.** Previously `/Rotate 90|180|270` pages
     matched at 10–30% (matcher lacked a coordinate-frame
     transform). Added `unrotateOpToPortrait` in the matcher —
     usgs-of2024-1001 went from 66% to 100%, and Prince-produced
     ca-state-budget (56 `/Rotate 270` pages) from unusable to 100%.
  2. **RTL reverse-containment fallback.** PDFBox emits Arabic/
     Hebrew glyphs in visual (rendering) order while the layout
     extractor emits them in Unicode logical order — so RTL op
     strings are reversed relative to tag strings. Added a length-
     gated reverse-containment check to the matcher. The
     `containsRtl` predicate covers both Arabic (U+0600–06FF) and
     Hebrew (U+0590–05FF) via the same Unicode range check.
     Empirically verified on un-sc-arabic (95% → 97%+); Hebrew
     coverage is by code-range argument (no independent Hebrew
     corpus fixture was successfully sourced during calibration).
  3. **Profile configuration plumbing.** Every profile JSON
     (`legal`, `scientific`, `cjk`, `forms-heavy`, `scanned-low-
     quality`) advertised layout threshold overrides — column-gap
     percentages, heading-score ratios, row tolerance, table row
     min items — but `modules/layout-analyzer/index.js` had those
     constants **hardcoded**. A/B pipeline comparisons produced
     byte-identical output for default vs specialized profiles,
     confirming all profiles were silently equivalent to default.
     Refactored layout-analyzer to read eight env vars (column
     gap %, column gap min px, heading score, heading bold score,
     heading H1, heading H2, row tolerance, table row min items);
     wired `tag-builder` to read two more (heading level clamp min/
     max); wired `reading-order` to read three more (line group
     epsilon, column band threshold %, column band min px); and
     routed `profileEnv` through the reading-order stage in
     `accessibility-stage-plan.js`. Extended `profile-runtime.js`
     to propagate all thirteen. Added a module-level regression
     test pinning the behavior. Profiles now actually calibrate.

## Auto-profile detection (production-ready)

`modules/profile-detector/index.js` classifies a PDF via
lightweight signals (producer string, AcroForm presence, script
distribution via text sampling, legal citation density) and
recommends one of the six shipped profiles. The detector is wired
into the CLI as `--profile auto` and exposed as the
`detect_profile` MCP tool via `mcp-corpus-eval`.

**Distribution across the 62-PDF calibration corpus:**

| Profile               | Count | Example docs                                      |
|-----------------------|-------|---------------------------------------------------|
| default               |   37  | IRS publications, NIST SPs, UN docs, Prince CSS   |
| scientific            |   18  | All pdfTeX/dvips/Ghostscript arXiv + luahbtex NIST |
| forms-heavy           |    9  | All Designer 6.5 IRS fillable forms               |
| cjk                   |    1  | un-ga-chinese                                     |
| legal                 |    0  | *(in 62-doc downloads; the pinned `scotus-24-656.pdf` correctly routes to legal with citation density 0.82/1k chars)* |
| scanned-low-quality   |    0  | *(no pinned scanned fixture)*                     |

**Decision order** (specificity-first):
1. Zero-text-ops → scanned-low-quality
2. Populated AcroForm + (known forms producer OR ≤ 200 ops/page) → forms-heavy
3. Dominant CJK script (≥ 30% of non-whitespace) → cjk
4. Legal citation density ≥ 0.5/1k chars + dominantly Latin → legal
5. Producer matches TeX/Ghostscript chain → scientific
6. Else → default

Every detection returns `{profileId, signals, reasoning, confidence, alternates}` — operators can audit why auto-mode picked what it picked. 15 tests pin the decision boundaries (12 corpus + 3 synthetic).

**End-to-end A/B proof of profile plumbing** (nist-fips-140-3
via scientific profile):

| Run         | Headings | Sections | Paragraphs |
|-------------|----------|----------|------------|
| default     |    0     |    0     |    87      |
| scientific  |    1     |    1     |    90      |

The scientific profile's relaxed 1.4× heading threshold (vs
default 1.55×) caught a subsection title the default missed,
promoted it to H1, and wrapped it in a Sect element.

## Aggregate across pipeline subset

Three pipeline waves were run — a first wave of 10 novel-category
docs that surfaced the rotation and bidi bugs, a second stress-
confirmation wave of 5 larger / novel-producer docs (post-fixes),
and a third gap-target wave of 6 docs exercising new scripts and
producers (Thai, Mac Quartz, Prince CSS-to-PDF, PDFium, modern
pdfTeX with struct markings — note the UN doc originally labeled
"un-ga-hebrew" was discovered during the second pass to be English
content from the same UN resolution series; Hebrew RTL coverage
is therefore by code-range argument only, not empirical).
Combined across all three waves — ~200 K operators through the
pipeline:

- **99.83% aggregate match rate** (second + third wave, post-fix)
- **3 bogus across 81 K operators** in wave 3 — 0.004% rate, all
  data-level year-number collisions on California budget tax
  tables (adjacent rows like "New Prison Construction (1986)" and
  "(1988)" that share all non-digit text)
- No additional systemic bugs surfaced in waves 2 or 3
- **/Rotate 270 confirmed working** via ca-state-budget (56 rotated
  pages in a 261-page Prince-produced doc)
- **Hebrew RTL** covered by the matcher's `containsRtl` predicate
  (same range check used for Arabic), but no independent Hebrew
  fixture was successfully sourced during calibration — the
  generalization claim is by code-range argument, not empirical.
  Several attempted Hebrew UN documents turned out to be English
  translations shared across the UN document series.

## What the matcher handles well

| Category               | Representative doc         | Match | Bogus | Unique |
|------------------------|----------------------------|-------|-------|--------|
| CJK (Chinese)          | un-ga-chinese              | 100%  | 0     | 99.8%  |
| RTL (Arabic, verified) | un-sc-arabic (Word)        | 97%   | 0     | 91.4%  |
| RTL (Hebrew, code-range) | (no pinned Hebrew fixture)  | —    | —     | —      |
| AcroForm (Designer)    | irs-fw4                    | 100%  | 0     | 87.0%  |
| NIST Adobe Library     | nist-fips-140-3            | 100%  | 0     | 99.4%  |
| arXiv Word-produced    | arxiv-cs-ml-2501.17600     | 99%   | 0     | 99.9%  |
| arXiv pdfTeX           | arxiv-hep-2501.17800       | 95%   | 0     | 76.5%  |
| arXiv dvips+Ghostscript| arxiv-older-0704.0001      | 97%   | 0     | 83.7%  |
| Heavy-math arXiv       | arxiv-math-2501.17900      | 93%   | 0     | 79.9%  |
| Antenna House + iText  | irs-p502                   | 97%   | 0     | 92.9%  |
| luahbtex               | nist-sp-800-63-4           | 100%  | 0     | 99.8%  |
| GPL Ghostscript        | arxiv-chem-2501.18050      | 98%   | 0     | 82.4%  |
| Prince 14.4 + /Rotate 270 | ca-state-budget         | 100%  | 3*    | 85.9%  |
| Hebrew RTL (range only)| (no verified Hebrew fixture) | —   | —     | —      |
| Thai + Mac Quartz      | thai-constitution-en       | 100%  | 0     | 98.2%  |
| PDFium producer        | india-economic-survey      | 100%  | 0     | 99.7%  |

*ca-state-budget's 3 bogus are year-number collisions in repeated
tax-table rows, not a matcher bug. 0.005% bogus rate.

Pinned regression corpus (all enforced in
`modules/pdf-writer/test/external-corpus.test.js`):

| Doc                      | Match  | Bogus | Coverage                          |
|--------------------------|--------|-------|-----------------------------------|
| arxiv-2501.18462         |  99%   | 0     | pdfTeX academic                   |
| gpo-fr-notice            | 100%   | 0     | GPO XyVision Federal Register     |
| irs-p1040-tax-tables     | 100%   | 0     | Antenna House tabular data        |
| irs-w9                   | 100%   | 0     | Designer 6.5 AcroForm             |
| nist-sp-1271             | 100%   | 0     | Adobe PDF Library publication     |
| scotus-24-656            | 100%   | 0     | Word → Distiller legal opinion    |
| un-ecosoc-multilingual   | 100%   | 0     | Distiller 5.0.5 PDF 1.2 (ASCII)   |
| un-ga-chinese            | 100%   | 0     | CJK script (Chinese)              |
| un-sc-arabic             |  97%   | 0     | RTL script (Arabic), 13K ops      |
| usgs-of2024-1001         | ≥99%   | 0     | /Rotate 90 (24 landscape pages)   |
| un-ga-hebrew             | 100%   | 0     | Short UN resolution (English content despite URL slot naming) |
| thai-constitution-en     | 100%   | 0     | Thai script + Mac Quartz PDF 1.3  |

## Known limitations

### 1. Legacy Distiller fonts without ToUnicode — non-ASCII text only

**Observed:** An Acrobat Distiller 5.0.5 / PDF 1.2 document in
Spanish (UN ECOSOC series `g0316903`) matched only 49% of operators
with 44 bogus assignments. The parser emits correct Unicode
(`ESPAÑOL`, `COMISIÓN`, `período`) via PDFBox's glyph pipeline, but
the semantic extractor produces Mac-OS-Roman-like garbled text
(`ESPA—OL`, `COMISI”N`, `perÌodo`). An identically-produced English
document from the same UN series (`g0316900`, pinned as
`un-ecosoc-multilingual`) matches 100% — confirmed by a side-by-side
producer check: both are "Acrobat Distiller 5.0.5 (Windows)" on PDF
1.2.

**Root cause:** Not the producer or PDF version — the discriminator
is whether the font carries a ToUnicode CMap for non-ASCII glyphs.
PDF.js's legacy-build text extractor falls back to a non-Unicode
encoding interpretation when the font's encoding dictionary is
pre-PDF-1.4 and ToUnicode is absent for the affected code points.
PDFBox correctly post-processes via font metrics and AFM tables, so
the operator-level parser gets correct Unicode.

**Impact:** PDFs produced on the Distiller 5.x / pre-Unicode pipeline
that contain **non-ASCII text** (accented Latin, CJK, Cyrillic)
**without ToUnicode CMaps** match poorly because the matcher compares
correct Unicode ops against garbled semantic text. Pure-ASCII
documents from the same pipeline match correctly.

**Status:** Known limitation in the layout extractor
(`modules/parser`), not the matcher. Fix would require hooking into
PDF.js's font-decoder fallback or switching the text-extraction layer
to PDFBox. Modern production PDFs (2005+ with ToUnicode for non-ASCII
glyphs) are unaffected.

### 2. Scanned / OCR'd documents — coverage gap, not a bug

**Status:** No scanned PDF is currently in the pinned corpus, so the
`scanned-low-quality` profile's calibration rests on the profile
definition (force OCR, 4 retry attempts, 25% acceptance threshold,
multiple DPI/colorMode render variants) rather than empirical
evidence from a representative doc. This isn't a bug — scanned docs
force OCR and bypass native-parsing — but expanding the pinned corpus
to include a degraded-scan PDF would let us measure the OCR-plus-
layout pipeline end-to-end.

**Impact:** None on the native-parsing matcher behavior (the code
paths this calibration exercises). Scanned docs route through the
OCR preparation stages, which are separately tested.

**Status:** Known coverage gap; not blocking for native-tagging
production readiness.

### 3. Profile fields without underlying implementation

**Resolved during this calibration pass:**
- `tagBuilder.headingLevelClampMin/Max` — wired through
  `TAG_BUILDER_HEADING_LEVEL_CLAMP_MIN/MAX`. Scientific profile's
  `headingLevelClampMax: 4` now permits H4 tags.
- `readingOrder.lineGroupEpsilon`,
  `readingOrder.columnBandThresholdPercent`,
  `readingOrder.columnBandMinPixels` — wired through three new env
  vars and `accessibility-stage-plan.js` now passes `profileEnv` to
  the reading-order stage (previously didn't).
- `semanticEngine.tableContinuationDistanceX/Y`,
  `semanticEngine.listGapThreshold` — removed from `default.json`.
  These had no implementation in `modules/semantic-engine` and
  carried no code path from `profile-runtime.js` that anything
  consumed. Schema (`contracts/profile.schema.json`) still permits
  them as optional so user profiles that hallucinated them don't
  fail validation, but the default-profile reference no longer
  advertises them.

**Impact:** These profile fields are documented-but-decorative.
A user who sets `readingOrder.lineGroupEpsilon: 4` expecting tighter
line clustering in the legal profile will see the same reading order
as default. The layout-analyzer threshold fields are now functional
(above), which is the majority of the visible calibration knobs.

**Status:** Known gap. Resolving either means implementing the
missing code paths or removing the orphan fields from profile
schemas. Not blocking for the rotation/bidi/layout-threshold
production readiness milestone the rest of this report covers.

### 4. Heavy-math arXiv preprints

**Observed:** arXiv papers with dense inline math (`arxiv-math`,
`arxiv-hep`) match at 93–95%. Unmatched operators are math-glyph
fragments: single-character-plus-punctuation like `,Q`, `,W`, `)=(`,
`+2`, `,λ`. Zero bogus.

**Root cause:** LaTeX math rendering breaks equations into many
tiny text-showing operators, each a 1–3 character glyph fragment from
a math font. The semantic engine correctly collapses these into
equation-level nodes, but the matcher's minimum-length text-similarity
gate (5 chars for spaceless-containment fallback) declines to assign
sub-5-char fragments, preventing false positives at the cost of 5–7%
unmatched.

**Status:** Accepted trade-off. Math equations are correctly assigned
at the word/node level; only intra-equation glyph fragments are
unmatched, and they land as `/Artifact` content in the tagged output.

## Producer coverage established

| Producer                                       | Docs exercised | PDF versions |
|-----------------------------------------------|----------------|--------------|
| Adobe PDF Library (10.0 – 24.2)               | 11             | 1.5–1.7      |
| pdfTeX (1.40.4 – 1.40.25)                     | 4              | 1.4–1.5      |
| pikepdf (8.15.1, arXiv rewrap layer)          | 3              | 1.5, 1.7     |
| GPL Ghostscript (9.22 – 10.01.2)              | 5              | 1.4          |
| dvips + GPL Ghostscript (9.08, 9.22)          | 3              | 1.4          |
| Microsoft Word (Microsoft 365 / 2013)         | 9              | 1.5, 1.7     |
| Designer 6.5 (Adobe LiveCycle, AcroForm)      | 9              | 1.7          |
| Antenna House + iText (IRS pipeline)          | 5              | 1.7          |
| luahbtex (1.17.0)                             | 1              | 1.7          |
| Acrobat Distiller 5.0.5 (legacy)              | 2              | 1.2          |
| GPO XyVision (Federal Register — pinned)      | 1              | 1.4          |
| Prince 14.4 (CSS-to-PDF, /Rotate 270 corpus)  | 1              | 1.7          |
| Mac OS X Quartz PDFContext                    | 1              | 1.3          |
| PDFium (Chromium PDF engine)                  | 1              | 1.7          |
| Pdf.Capture (legacy NASA pipeline)            | 1              | 1.4          |

## Operational guidance

**Production profile defaults** (see `orchestrator/profiles/default.json`):
- `mode: "auto"` — the auto-detector uses `sourceHasStructTree AND
  sourceMarkInfoMarked AND markedContentFraction ≥ threshold` to route
  to passthrough where source is already accessibility-tagged.
- `nativeMatchThreshold: 0.85` — conservative floor covering CJK, RTL,
  AcroForm, and multi-column academic layouts. Below this, the writer
  falls back to rasterization per profile policy.
- `alreadyTaggedThreshold: 0.30` — marked-content fraction required
  for passthrough eligibility.

**Producer-specific expectations:**
- Legacy Distiller 5.x fonts without ToUnicode on non-ASCII text
  (e.g. pre-2005 UN Spanish/Russian archives): match rate may drop
  to 40–60%; expect rasterization fallback per profile policy.
  Pure-ASCII documents from the same pipeline match at 100%.
- `/Rotate 90 | 180 | 270` pages: matcher applies inverse rotation
  to align operator coords with unrotated semantic bboxes
  (`unrotateOpToPortrait` in `NativeTagMatcher.java`). Verified on
  usgs-of2024-1001.pdf (36 rotated pages across two documents) —
  100% match after fix.

## Provenance

All corpus PDFs are public-domain or openly-licensed from trusted
government, academic, and international-organization sources.
Pipeline artifacts (for docs in the pipeline subset) are under
`tmp/calibration-corpus/pipeline-artifacts/<base>/` and are gitignored.
Source PDFs themselves live under
`tmp/calibration-corpus/downloads/` and are gitignored.

Pinned regression fixtures (checked in, with SHA-256 provenance) live
under `test/fixtures/external/` — see that directory's `PROVENANCE.md`
for URLs and hashes.
