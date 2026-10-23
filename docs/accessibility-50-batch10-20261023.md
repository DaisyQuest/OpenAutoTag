# A23 and A25: verify source ownership and complete text

Completed 2026-10-23 against `dced612`. **25 improvements are complete; 25 remain pending.** See [structured evidence](evidence/accessibility-50-batch10-20261023.json). This delivery strengthens validation; it does not claim that all newly detected document defects are repaired.

## Changes

- **A23:** The native writer emits a public source-ownership sidecar containing original invocation/operator identities, glyph ranges and proposed tag owners. Source and tagging-file hashes bind that intent. An independent saved-content reader checks the complete source character-code sequence, font names, rendering matrices and displacement, then verifies each glyph occurrence's saved owner. Swapping identical words between tags fails even when text and structure IDs remain unchanged. Nested or duplicate owners, overlapping source ranges and moved glyphs also fail. Anonymous authored Spans resolve through their intended ancestor.
- **A25:** Saved structure order now determines complete owned-text comparison. Partial substrings cannot pass; generated ActualText cannot cover missing glyphs. Empty structure ActualText is distinguished from absence. Bounded exceptions require unchanged authored replacement text over an exact continuous source range, or exact overprinted glyphs with identical font, character and position, verified source ownership and matching intended saved ActualText. Mixed MCR/child `/K` order is retained when collecting text.

`source-ownership.schema.json` defines the additive contract. The checker accepts `--source-pdf` and `--ownership` with `--tags`; production native validation requires them. Reports carry candidate, source, intent and ownership hashes. `ownershipStatus: verified` qualifies the proposed paint ownership only; a report with text failures still rejects the document.

The [PDF specification's document-interchange rules](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html) inform ownership and replacement scope handling. Positions come from PDFBox's raw glyph callback, avoiding [legacy TextPosition heuristics](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/text/LegacyPDFStreamEngine.java) and [replacement-text substitution](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/text/PDFTextStripper.java). No dependency was added.

## Verification

All **363 production-baseline tests pass** across the serial baseline and corrected rerun. The baseline passed 344 tests; three test files initially had duplicate local variable names introduced while wiring the stronger checks. After those names were corrected, their 19 tests passed. Production code was unchanged between these runs. No tests were skipped. There are 15 new tests/subtests; existing quote, compound-text, Form, authored-text, optional-content and 28-page geometry tests now exercise the source proof.

Mutation coverage includes identical-text owner swaps, moved identical text, partial text, fabricated inline replacement text, nested ownership, overlapping source ranges, stale intent hashes, altered authored replacements and partial authored ranges. Exact overprints require source evidence; font or position differences cannot authorize collapse.

All **64 real-document pages are pixel-identical** in fresh Poppler comparisons: 61 booklet pages at 96 DPI and Hinode plus the two-page control at 150 DPI. The booklet's independently parsed 53,667 source text bytes and 615 TJ adjustments remain unchanged. All 209 pieces of 104 compound operators retain their exact byte ownership. A rendered booklet page was visually inspected.

TEST-FORM uses the exact prior candidate hash. Its 32 fields, 33 widgets and sampled text/checkbox fill-save-reopen evidence are reused from batch 8 by hash; they were not presented as new interaction tests. The fresh reference check also compares saved text runs and replacement-property presence.

| Document | Saved checks passed / failed | Source occurrence proof | Raw veraPDF checks passed / failed |
| --- | ---: | --- | ---: |
| NASA STEREO booklet | 50,491 / 529 | 61 pages; 5,122 owned/unowned text runs verified | 186,049 / 31 |
| NASA Hinode | 939 / 0 | 1 page; 52 text runs verified | 5,246 / 0 |
| TEST-FORM preserved control | 2,175 / 0 | Preserved-reference comparison | 9,874 / 0 |

The NASA raw reports are fresh; the control's raw report is reused by its unchanged hash. The booklet's independent font audit still reports six errors and one warning.

The booklet has **154 existing attachment failures and 375 text-completeness failures**. Those are overlapping checks: 154 text failures are the same empty attachments, leaving 221 nonempty mismatches. Of these, 79 intended strings contain C1 control characters; the rest require investigation of order, duplicated diagram labels and other source/intent discrepancies. A further 120 exact-overprint replacements are proven equivalent. Rechecking the prior batch-8 candidate with the current checker produces **identical failure targets and values**, confirming these findings predate this writer run. The booklet remains rejected.

## Limits and reproduction

The sidecar records writer-proposed source association; it cannot independently certify the semantic classifier's choice of source nodes. Font-name/code/position equality does not prove font-program equivalence. NFKC and whitespace normalization do not establish word boundaries. Visibility, clipping, annotation appearance text, OCR, general replacement semantics and reader usability require separate qualification. Unqualified legacy/tag-only checks cannot claim source ownership. A26–A50 remain pending; the USGS authored-text rebuild rejection remains unresolved.

Run `npm run test:production-baseline`; on this host use serial Node tests and the documented JVM compatibility settings. Focused new tests are `modules/validator/test/source-ownership.test.js`, `modules/validator/test/saved-semantics.test.js` and `test/integration/source-glyph-proof.test.js`. Frozen replay, raw validation, source-byte and rendering artifacts are under `output/accessibility-50-batch10-20261023/`.
