# A43: continued tables and retained header occurrences

A continued table could lose its page order because section normalization moved every header row into the initial THead. Reused local row numbers could also merge cells from different pages. Repeated-header signatures accumulated each occurrence, preventing reliable recognition on a third page. These defects are now corrected for the supported declared and inferred continuations.

The [PDF Association syntax guide](https://pdfa.org/download-area/publications/Tagged-PDF-Best-Practice-Guide.pdf) describes one logical table across pages and recommends artifacting purely visual repeated headers. Its [complex-table technical poster](https://pdfa.org/download-area/posters/PDFDaysEurope2025-TechnicalPoster-axaio.pdf) explains the single-THead constraint. This delivery preserves supplied semantic TH occurrences and records their repetition for review. It does not silently classify declared semantic headers as layout-only artifacts. Existing Artifact nodes remain outside the structure and no longer interrupt a continued table.

## Implementation

`table-continuation.js` tracks rows by page and original row index. When numbering restarts, it assigns subsequent logical row indices and records `tableRowOrigin` on rows and cells. Already-global indices remain intact. Reversed pages, unsafe coordinates, new rows arriving out of sequence in a continuation, and more than 4,096 rows reject. Single-page row identities remain compatible.

Section normalization retains the original row sequence. Only a leading header band becomes THead and a trailing footer band becomes TFoot. Later occurrences remain in TBody; `tableSectionOrigin` preserves their header/footer intent. Continued column headers keep Column scope, with `continued-head` evidence, unless an explicit scope overrides it.

A complete repeated band must match cell roles, columns, spans, labels and scope. Its rows cannot straddle known page boundaries. Matching THs receive `repeatedHeaderOf` links to the original cells but retain distinct saved IDs and every content Span. Directional header resolution prefers the nearest occurrence of each proven equivalent header and excludes a header's own earlier equivalent from its parent list. Different tables, interrupted semantic groups and mismatched bands remain separate. Matching has a five-million-visit bound and applies no partial result on exhaustion.

The semantic engine retains the first page's header signature instead of appending repeats. Inferred continuation still requires matching columns, the complete header signature and page-boundary evidence; it now compares spans, column indices and scope as well as text. An explicit different table ID wins. Disabling inference still leaves matching anonymous page tables separate. Inference retains the existing 20-header-cell evidence limit; larger or ambiguous inputs need explicit grouping and review.

No dependency or CLI option was added. New tagging evidence is additive. Header-only and mixed-header behavior from A41/A42 remains tested.

## Verification

The full 843-case run started before the final running-artifact fix. The final 42-case affected run passes and covers the changed paths, including the added regression; current 844 configured cases are covered across overlapping runs. A single final 844-case run is not claimed.

The final focused run passes 42 tests, covering semantic inference, legacy section behavior, saved output and the final running-artifact fix. The 25-case coverage run gives `table-continuation.js` 100% line/function and 97.70% branch coverage, and the changed `table-headers.js` 100% line/branch/function coverage. These are module-specific measurements.

The four-page fixture has one three-page table followed by an independent table with identical headings. Its 40 cells include multirow/multicolumn headers, mixed row/column scope, restarted and already-global row numbers, and eight retained repeated TH occurrences. Both writer paths preserve the independently specified cell order and exact Headers relationships. The native result passes 1,192 saved semantic and 2,174 raw veraPDF checks; raster passes 938 saved and 2,127 raw checks. Saved row-order and previous-page-header corruptions reject.

A second native fixture paints running footers between continued pages. It retains the same logical table structure and passes 1,202 saved and 2,308 raw checks. Both native variants preserve accented field fill/save/reopen and PDFBox-rendered appearance. Each retains three separate default-font audit findings; raster's font audit is clean. Raster form editing is not qualified here.

Independent pypdf checks verify the oracle's roles, ordered Headers, scope and exact source-page ownership for every fixture cell, including every retained header occurrence. They also check original glyph bytes/TJ spacing, annotation and field properties, widget appearance bytes and page geometry. All 33 Poppler page pairs at 120 DPI match: both native variants before and after field editing, plus all 17 NIST pages. Representative continued-table and edited-footer pages were visually inspected.

## Corpus regression and remaining work

Official [NIST SP 1299](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1299.pdf) and [NIST SP 1300](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1300.pdf) historical semantic plans were replayed. All table checks pass. Their complete failure evidence remains equal to A42: 15/28 saved failures, one raw optional-content failure each, three font findings each and 15/33 link reviews. One SP 1300 Span still has the detected extra W. These are regression/preservation checks, not proof of arbitrary real-world continuation recognition.

The booklet retains six ambiguous grids and refuses a new candidate. Its prior production candidate and TEST-FORM retain their exact hashes. Diagram discrimination, captions, remaining form improvements and the final qualification gate are A44-A50. Human review must still decide table meaning, continuation intent, layout-only repetition and actual reader usability.

```text
node --test --test-concurrency=1 modules/semantic-engine/test/table-header-occurrences.test.js modules/tag-builder/test/table-continuation.test.js modules/pdf-writer/test/continued-table.test.js
```

Set `CONTINUED_TABLE_EVIDENCE_DIR` to a fresh directory to retain PDFs and reports. Exact hashes and results are in [the evidence report](evidence/accessibility-50-batch26-20261023.json).
