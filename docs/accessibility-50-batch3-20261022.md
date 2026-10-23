# Accessibility improvements: compound text attachment and glyph boundaries

A08 and A09 are implemented and verified, bringing the [50-item ledger](accessibility-50-improvements.md) to **9 complete / 41 open**. This batch starts from `4eeabf7`. [Evidence](evidence/accessibility-50-batch3-20261022.json) records exact candidate and code hashes.

## Implementation

The native parser maps each original font code to its source operand part, byte interval and complete Unicode interval. It checks that PDFBox's glyph callbacks agree with those codes and Unicode sequences before exposing partition geometry. A single code remains indivisible when its ToUnicode mapping expands to a ligature, combining sequence or supplementary character. Missing, replacement or malformed Unicode and excessive operands do not qualify. This resolves **A09**.

The matcher can partition a compound text operation among several intended nodes when complete source glyphs, exact text substrings and individual node boxes support the boundaries. It removes whitespace for comparison, without discarding other characters or replacing glyph text. Unique longest matching runs prevent arbitrary shared-prefix splits. The writer verifies the source operand hash, full text, glyph count and every fragment before emitting disjoint marked content. Partitions must cover every glyph exactly once. Equal competing owners leave the compound operation unresolved. Existing whole-operation matching remains unchanged. This resolves **A08** for the supported, verified cases.

Splitting copies original string bytes and retains every TJ numeric adjustment in order, including leading and trailing adjustments and empty strings. Quote operators apply their spacing and line advance once before the fragments. The same path works in nested Form streams and rotated pages. No new dependencies were added. The internal plan additions remain inside the PDF writer module; external CLI contracts are unchanged.

The design follows text-showing and ToUnicode requirements in [ISO 32000-2 clause 9 errata](https://pdf-issues.pdfa.org/32000-2-2020/clause09.html). PDFBox's [3.0.8 TextPosition implementation](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/text/TextPosition.java) distinguishes Unicode strings from source character codes and reports rotation-adjusted positions. Geometry-based partitioning is bounded to horizontal writing with a cardinal baseline that agrees with the text matrix. Other text keeps the existing whole-operation path; this delivery does not qualify arbitrary skew, mirrored writing or vertical font encodings.

## Verification

**262 production-baseline tests and 29 compatibility tests pass**, with no failures or skips. The new compound fixture is included in the baseline: 24 source operations become 48 independently verified owned fragments across four pages, with rotations 0/90/180/270, Tj, TJ, single/double quotes, subsequent text-state checks and Form content. Glyph positions and all four 150-DPI page renders are unchanged. Saved-semantic comparison and raw veraPDF both report zero failures.

Negative cases cover overlapping/gapped/incomplete partitions, wrong hashes/text/counts, fractional ranges, inconsistent addresses, mixed whole/partial ownership and equally supported owners. Invalid plans fail before saving. The real Type0-font fixture checks all contiguous slices, ligatures, combining sequences, supplementary characters, numeric-adjustment preservation, empty strings, source immutability, missing mappings and size bounds. A saved split retains `fi.` and `é body` under separate owners; an attempted split inside the `fi` font code is withheld. No new coverage percentage is claimed.

The first booklet replay exposed overly broad ambiguity handling on whole operations. The final implementation restricts this decision to compound partition attempts, preserving existing whole-operation matching. Two real compound operations remain withheld because erroneous upstream merged boxes support competing owners: page 57, sequence 4 (`U Inertial Measurement Unit`), and page 58, sequence 21 (`SEP Solar Energetic Particle`). Correcting those upstream label/value boundaries remains A16.

## Real-document replay

Upstream extraction, semantic inference and tagging intent are unchanged. The booklet now partitions **87 source operations into 175 owned fragments** across nine pages. These include page 2's `Target Date:` / `February 2006` and `Launch Vehicle:` / `Delta-II 7925-10L`, plus page 56's acronym/definition pairs. Fragment ownership follows the current intended nodes; this does not correct earlier semantic merges such as the `Astr` / `onomical Unit` node split.

Independent pypdf traversal verifies all **53,667 text bytes and 615 TJ adjustments** are conserved across the 61 booklet pages, including their order and byte positions. Every partitioned fragment owns the exact expected byte interval under its intended structure ID. All **5,017 source text-operation identities** still agree with independent traversal. All **4,158 emitted MCRs** refer to painted content with reciprocal ParentTree ownership across 100 invoked scopes, with no audit errors.

| Candidate | Saved checks: passed / failed | Raw veraPDF failed checks | Disposition |
| --- | --- | --- | --- |
| NASA STEREO booklet | 14,727 / 155 | 31 | rejected |
| NASA Hinode | 531 / 0 | 0 | review_required |
| TEST-FORM control | 1,828 / 0 | 0 | review_required |

Booklet saved attachment failures decrease from **258 to 155**. Of the remaining failures, 137 concern OCR nodes. Its 31 raw font findings are unchanged. Saved-check reductions are not a semantic-accuracy percentage or human usability qualification.

All **64 pages** are pixel-identical in Poppler: booklet at 96 DPI, Hinode and the form at 150 DPI. Booklet pages 2 and 56 were visually inspected. Hinode and the form also match the bounded PDF.js checks. TEST-FORM retains 32 fields, 33 widgets, the original source-byte prefix and successful sampled text/checkbox fill-save-reopen behavior, with identical filled-page pixels.

Focused reproduction: `node --test --test-concurrency=2 modules/pdf-writer/test/native-compound-text.test.js modules/pdf-writer/test/native-list-operands.test.js`. Full logs are `tmp/accessibility-50-batch3-tests.log` and `tmp/accessibility-50-batch3-compatibility.log`. Replays, audits and rendered evidence are under ignored `output/accessibility-50-batch3-20261022/`; local PDFs are not distributed by the evidence commit. Optional content, authored replacement text, OCR attachment, stronger saved-content qualification, remaining semantic inference and human review remain open ledger work.
