# A41: declared table spans and multiline cell fragments

Table normalization previously moved colliding cells into later columns. It could turn two lines assigned to one cell into separate cells and produce incorrect header references. The builder now reserves declared cell rectangles before placing cells without column positions. Ambiguous overlaps retain their original coordinates and content in a bounded review report; they are not silently shifted.

[W3C PDF6](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6) describes table rows/cells, spanning attributes and empty data cells as ways to preserve tabular relationships. The [PDF Association table structure clarification](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html) also distinguishes row/column header scope. This delivery addresses the grid and content grouping prerequisites; mixed-header inference remains A42.

## Implementation and boundaries

`modules/tag-builder/table-grid.js` performs a nonmutating placement pass. Explicit rectangles, including their future row coverage, are reserved before any unspecified column is assigned. Large valid column hints are honored. A collision, contradictory row identity, invalid span, missing row crossed by a span, or exhausted work limit produces typed `tableGridReview` evidence. Review tables bypass subsequent cell splitting, header decoration, demotion and grid normalization. Native and raster writers refuse those unresolved plans before creating a PDF; authored-tag passthrough retains its existing independent behavior. Saved semantic validation explicitly rejects pending grid reviews.

Successive horizontal native-text lines can be combined into one cell when their declared row/column, spans, role, section and scope agree. Their page must match; their boxes must overlap horizontally by at least half the narrower width, must not overlap vertically, and must have a bounded line gap. OCR, rotation, inconsistent roles/spans, distant or reversed lines and cross-page fragments are ineligible. Each original content Span and source identity remains intact and ordered. `mergedCellIds` and the source merge ledger record the original cells. No source glyphs are concatenated or repartitioned by this repair.

Limits are 4,096 rows, 1,024 columns, 10,000 cells, 65,536 completed grid slots, five million placement checks and 100 reported conflicts per table. Unsupported inputs require review. Existing valid merged grids, implicit cells, empty gap cells and trailing row spans remain supported. Synthetic continuation rows stay under their table or section, including header-only tables. No dependency or CLI argument was added.

## Verification

The full production baseline passed **795 tests** before the final header-only row-parent fix. The final **66-case affected run**, including two new regressions, passes with no failures or skips. Together these overlapping runs cover the current 797 configured cases; a single final 797-case run is not claimed. The final 30-case grid unit suite has **100% line/function and 90.48% branch coverage** for `table-grid.js` only.

The four-page native fixture covers mixed row/column spans, a two-line header, future-row reservations, a sparse six-column grid and a trailing span. All 616 saved semantic and 1,177 raw veraPDF checks pass. Its header-only variant passes 617 saved and 1,175 raw checks. Native/raster refusal cases preserve the source and create no candidate; altered saved RowSpan/ColSpan values and pending review evidence are rejected. Both variants' separate font audits retain three default-font findings, so raw conformance alone does not qualify them.

Independent pypdf checks verify content Span identity/order within every merged cell, original text bytes and TJ spacing, annotation properties, field values, widget appearance bytes and page geometry. All **33 Poppler page pairs at 120 DPI** match exactly: both four-page fixture variants before and after editing/reopening, plus all 17 NIST pages. PDFBox independently verifies fixture appearance and editing the field to `José café 987`, saving and reopening. Representative pages from both fixture variants and NIST were visually inspected.

## Reputable-source replay and remaining defects

Historical semantic inputs from the official [NIST SP 1299](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1299.pdf) and [NIST SP 1300](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1300.pdf) are rebuilt with the current builder and writer. Two and sixteen declared cell groups are combined, respectively. Both now save instead of failing on missing emitted header IDs. All table roles, spans, Headers references and child-order checks pass. Their source bytes and appearance remain unchanged.

These candidates remain unqualified. SP 1299 has 15 complete-text failures; SP 1300 has 24 complete-text and four attachment failures. One SP 1300 merged content Span (`n-4-49`) includes an extra source “W”; the independent complete-text check catches it. Each candidate also retains one raw optional-content `/AS` failure and three font-audit findings. The source audits report 73/99 raw failures and five font findings, respectively; reductions reflect the entire current tagging pipeline, not this table change alone. Link reviews remain 15/33. No evidence was weakened to produce these results.

The booklet replay merges three eligible groups but retains six table-grid reviews. Writing is refused before a candidate is created. Its previous production candidate remains byte-identical, with historical six raw/196 saved failures and 158 pending OCR segments. The TEST-FORM control likewise retains its exact hash and prior 32-field/33-widget evidence. General table recognition, mixed header interpretation, cross-page headers, caption relationships and the legacy header-ID test remain for later table work. Human semantic and reader review remains required.

```text
node --test --test-concurrency=1 modules/tag-builder/test/table-grid.test.js modules/pdf-writer/test/table-grid.test.js
```

Set `TABLE_GRID_EVIDENCE_DIR` to a fresh directory to retain PDFs and saved reports. Exact inputs, output hashes, tests and remaining findings are recorded in [the evidence report](evidence/accessibility-50-batch24-20261023.json).
