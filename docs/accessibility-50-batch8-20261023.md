# A17–A20: running content and heading hierarchy

Completed 2026-10-23 against `cd8b221`. The ledger now has **20 completed improvements and 30 pending**. See [structured evidence](evidence/accessibility-50-batch8-20261023.json).

## Requirements and implementation

[W3C PDF14](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF14) distinguishes running page information from document content and describes pagination artifacts. [W3C PDF9](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF9) describes heading elements and a logical progression of heading levels. These techniques guide the changes; passing our checks does not establish complete WCAG or PDF/UA qualification.

- **A17 — running content:** Document-wide inference recognizes Arabic/Roman pagination and repeated, detached margin text. It requires three distinct pages, consistent typography and sequence evidence. A blank separator can inherit a sequence established by pages containing body text; number-only cards remain real content. Headings, body repetitions, tables, explicit semantic groups, OCR, form-linked text, nearby unresolved widget prompts and link-like strings are protected. Crowded pages get a bounded-inference review task. Every inferred artifact retains its source identity, text, geometry and evidence, plus a review task.
- **A18 — numeric heading false positives:** One shared numeric-prefix parser serves rank refinement and document style anchors. Date, measurement and version prefixes cannot become section-depth anchors. Body-sized dates/measurements become paragraphs, while large numeric headings keep their heading role. Explicit list membership remains a list. Ordinary numbered sections still establish hierarchy. Ambiguous numeric language is not an unconditional heading classifier.
- **A19 — wrapped heading styles:** A supported continuation can cross bold font families or bold/italic variants. Uppercase connector lines join a preceding title. Existing size, alignment, page, column, role and intervening-content guards remain. A change to a regular face, a different rank or a smaller subtitle remains a boundary; independent article-led subtitles do not merge.
- **A20 — section hierarchy:** Final semantic roles determine heading membership and rank. Stale `headingLevel` metadata can no longer resurrect a demoted paragraph or undo a correction. Reading order synchronizes that metadata and rebuilds outline parents in final reading order, replacing stale gap findings. The tag builder's existing reported normalization/clamp policy remains; the outline still requires review.

## Verification

All **312 production-baseline tests pass**. The final focused semantic, paragraph, reading-order and tag-builder suites pass **206 tests**, with overlap. Final targeted tests cover the later blank-page, subtitle and widget-proximity guards; deterministic regeneration confirms those guards leave all three replayed semantic documents byte-identical to their saved inputs. No failures or skips remain in these runs.

The new four-page PDF fixture uses independently created, embedded Sans and Serif fonts. It verifies eight saved running text occurrences through PDF.js marked-content extraction, four retained body passages, four mixed-font headings, numeric/list boundaries and four exact section ancestry trees through the saved PDF. Deliberately stale rank metadata is included before writing. It passes **497 saved-semantic and 3,142 raw veraPDF checks**, with zero failures. All four pages match in both PDFBox and Poppler at 150 DPI.

The NASA booklet replay verifies **47 saved pagination artifacts**, including the Roman numeral on the blank separator page. PDF.js decodes each number inside artifact content. Six sampled meaningful section titles retain non-artifact ownership; their text is reconstructed by following the saved structure references, since the source interleaves some heading fragments with body operators. All **101 label/value pairs** from A16 still pass, including 16 source-page text oracles.

Independent pypdf traversal again verifies 209 pieces from 104 compound operations, all **53,667 source text bytes**, and all **615 TJ adjustments**. All **68 compared pages** are pixel-identical in Poppler: 61 booklet pages, three control pages and four fixture pages. TEST-FORM retains 32 fields and 33 widgets, and sampled text/checkbox fill-save-reopen and filled appearance checks pass.

| Document | Saved checks passed / failed | Raw veraPDF checks passed / failed | Disposition |
| --- | ---: | ---: | --- |
| NASA STEREO booklet | 14,834 / 154 | 186,049 / 31 | rejected |
| NASA Hinode | 489 / 0 | 5,246 / 0 | review_required |
| TEST-FORM preserved control | 1,828 / 0 | 9,874 / 0 | review_required |

The booklet's failure targets are unchanged from batch 7. Passing-check totals change because evidenced pagination leaves the logical structure; this is not a reduction in the unresolved failures or a percentage of accessibility accuracy.

## Remaining limits

All inferred running content and headings require human review. Ambiguous margins, numeric labels and uncertain typography remain conservative; the work does not infer every header or every language's numeric syntax. The booklet's 154 saved attachment failures, including the earlier OCR findings, and 31 raw font failures remain. Broader source coverage, OCR attachment, tables, navigation and forms continue under A21–A50. Machine conformance and pixel preservation do not replace reader testing.

Local evidence is in `output/accessibility-50-batch8-20261023/`, including the replay, independent ownership proof, PDF.js running-content proof and render comparisons. Java tests ran serially with the established host-specific options; production JVM defaults are unchanged.
