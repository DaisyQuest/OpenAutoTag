# Authored replacement text and abbreviation scopes

A11 is complete for qualified native text scopes. The ledger now records **12 of 50 improvements complete, 38 pending**. This delivery preserves the author's reading text without moving source glyphs or rebuilding form controls.

## Behavior

The native writer previously removed source marked-content properties and rebuilt the structure tree without its `ActualText` or abbreviation expansion (`E`). It now indexes those properties from named/inline marked content and from structure elements, including page and Form MCRs. Each qualified scope becomes a dedicated Span containing only its own references. Empty strings and whitespace retain their meaning.

Multi-operator replacements use one continuous marked-content sequence. This matters in practice: an intermediate implementation put the replacement on the first operator and empty replacements on the others. PDFium then read trailing glyphs twice. The final writer coalesces the ownership wrappers while retaining every source text operand and positioning operator. A regression assertion requires one continuous MCR per replacement.

An outer replacement takes precedence over replacements inside it. The fixture preserves 13 effective scopes and reports one shadowed inner scope. Abbreviation expansion remains metadata on the complete abbreviation, rather than replacing its ordinary text. Generated ActualText on affected inferred tags and their ancestors is removed so it cannot mask authored content. The report identifies those tag IDs; the saved-intent checker still reports conflicts. The deliberate conflict fixture produces exactly 13 `ACTUAL_TEXT` discrepancies, rather than silently accepting different intent.

Qualification requires mapped text belonging to one inferred tag. ActualText also requires a continuous run within one invoked content stream. Invalid properties, missing references, cycles, unassigned paint, incompatible tag boundaries, intervening unrelated content and changes of layer scope reject before saving. Graphics/object replacements and arbitrary restructuring across inferred tags remain outside this support boundary; existing-tree preservation or reviewed correction is required.

## Evidence

- **282 production-baseline tests and 29 compatibility tests pass**, with no failures or skips. The baseline includes 13 new positive/adversarial tests.
- The synthetic fixture verifies ligatures, multi-operator words, abbreviations, empty/whitespace replacements, nested precedence, reused Forms, Form MCRs and unaffected neighboring text. All 33 original text operators remain painted with unchanged glyph codes/positions; coalescing yields 27 MCRs. It passes 89 saved checks and 927 raw veraPDF checks, with zero failures.
- Pages 5 and 6 of the Census Bureau's [Income in the United States: 2024](https://www2.census.gov/library/publications/2025/demo/p60-286.pdf) supply 125 real replacement scopes. Exact page content is copied into forced-native regression fixtures; all 54 + 71 replacement values and their order survive. Independent pypdf traversal verifies non-marking operators and operands after resolving rewritten Form resource aliases to their content. PDFium extraction is identical, Poppler pixels match at 150 DPI, and raw veraPDF failures are zero on both candidates (4,918 + 7,116 passing checks).
- Those two Census page fixtures deliberately use a simple test ownership plan. They establish content/property preservation, **not** full-document heading, contents-list or accessibility quality. Source structure properties are exercised separately in the synthetic fixture.
- PDFBox and the independent logical-tree walker handle the fixture's empty replacement correctly. Installed PDFium 156.0.8076.0 ignores the empty replacement in both source and candidate. This existing reader limitation is recorded; reader qualification is not claimed.

Initial concurrent testing encountered two JVM access violations. Final suites ran serially with `-XX:TieredStopAtLevel=1 -XX:+UseSerialGC -Xms32m -Xmx512m`. No application assertion was suppressed, and the engine's production JVM configuration was not changed.

## Existing controls

The frozen upstream semantic/tagging intent is unchanged. All 64 default-state pages match the source in Poppler; the three new regression pages also match. TEST-FORM retains its source-byte prefix, 32 fields and 33 widgets. Sample text/checkbox fill-save-reopen and filled-page PDF.js comparisons pass.

| Candidate | Saved checks passed / failed | Raw veraPDF passed / failed | Disposition |
| --- | ---: | ---: | --- |
| NASA STEREO booklet | 14,727 / 155 | 185,539 / 31 | rejected |
| NASA Hinode | 531 / 0 | 5,295 / 0 | review_required |
| TEST-FORM control | 1,828 / 0 | 9,874 / 0 | review_required |

The booklet's remaining attachment, OCR and font problems are not fixed by this delivery. No human screen-reader qualification was performed.

The [hash-bound evidence](evidence/accessibility-50-batch5-20261023.json) records these candidates and checks. Local proofs, PDFs and images live under `output/accessibility-50-batch5-20261023/`; logs are `tmp/accessibility-50-batch5-*.log`. PDFs and local outputs are not committed.

Specification references: [ISO 32000-2 clause 14 corrections](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html#1494-replacement-text), [Adobe PDF Reference 1.6, sections 10.8.3–10.8.4](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.6.pdf), [PDFBox 3.0.8 text extraction](https://github.com/apache/pdfbox/blob/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/text/PDFTextStripper.java), and [PDFium text extraction](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/core/fpdftext/cpdf_textpage.cpp).
