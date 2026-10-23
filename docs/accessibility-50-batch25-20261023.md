# A42: mixed row and column header relationships

The old header lookup collected every preceding header in a covered row or column. It could carry an older band into a newer one, order broad headings before specific headings, and promote a data cell solely because it was inside THead. The builder now resolves directional relationships on the validated grid and preserves each declared TH/TD role.

The [PDF Association table clarification, clause 14.8.4.8.3](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html) permits mixed header/data rows and describes directional header search with scope filtering and specific-to-general order. [W3C PDF6](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6) describes structural cells, spanning relationships and manual verification of complex tables. These inform this implementation; this delivery does not claim PDF/UA-2 certification.

## Implementation

`modules/tag-builder/table-headers.js` uses the validated rectangular grid. Explicit Row, Column and Both scope takes precedence. Existing section-based defaults remain available and are identified as `thead` or `body-default` in typed `tableHeaderEvidence`. An unwrapped header-only section retains its column scope. Evidence records the separate ordered column and row target lists.

Searches cover every row/column occupied by a spanning cell. Opposite-axis headers neither contribute nor stop that direction. A data cell after a matching header ends the search; a header's own parent search also stops at data, preventing a new band from inheriting an earlier band. Each axis is ordered nearest first, with stable logical order for ties. The emitted Headers array contains column targets followed by row targets, without duplicate IDs. Identical labels are not used to merge distinct header identities. Neighboring tables and nested cell content cannot supply targets.

The resolver works on original unassociated cells before emitting the complete Headers lists. Generated relationships are not recursively reused, which avoids importing labels from the other axis. This is a bounded inference policy for new tagging plans, not a processor for arbitrary authored Headers hierarchies. Five million search visits is the limit, in addition to A41 grid limits. Exhaustion rejects before any header mutation. New evidence is additive; dependencies and CLI arguments are unchanged.

THead placement no longer promotes TD to TH. A section can legitimately contain data cells, including a corner value or empty corner. Upstream role recognition still needs review. The legacy `tableStructureRepairs` counter remains present with zero for this removed heuristic. Saved validation now checks exact Headers order and scope absence as well as explicit scope values.

## Verification

The serial production baseline passed **816 tests** before the final future-header guard. The final **52-case affected run** passes with zero failures or skips and covers the changed paths, including the added regression. Together these overlapping runs cover the current 817 configured cases; a single final 817-case run is not claimed.

The new 13-case header unit suite has 100% line, branch and function coverage for `table-headers.js`. A separately specified four-page fixture defines all 44 cells' intended relationships, including a corner data cell, Both scope, multirow/multicolumn groups, intervening data, opposite-axis headers and spanning data. Additional unit probes cover distinct repeated labels and exclude declared future headers even when section normalization has moved them. Expected identities are specified independently of the implementation. These fixtures are engineering oracles, not authenticated human accessibility reviews.

Both native and raster saved PDFs retain all 44 exact expected relationships. The native result passes 1,344 saved semantic and 2,210 raw veraPDF checks; raster passes 1,066 saved and 2,163 raw checks. Four saved corruptions reject: reordered Headers, an unrelated target, changed header scope and unexpected data-cell scope. Native PDFBox rendering and accented field fill/save/reopen remain intact. The native fixture retains three separate default-font audit findings; raster's font audit is clean. Raster form editing is not qualified by this test.

Independent pypdf checks verify the native fixture's saved roles, ordered Headers and scope against the fixture oracle, original text bytes/TJ spacing, fields, annotation properties, widget appearance bytes and page geometry. All 25 Poppler page pairs at 120 DPI are identical: four native fixture pages, four after editing/reopening and all 17 NIST pages. Representative fixture pages were visually inspected.

## Real replay and limits

Historical pilot semantic inputs for official [NIST SP 1299](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1299.pdf) and [NIST SP 1300](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1300.pdf) were rebuilt. Relationships or order changed on 38 and 36 cells, respectively. This establishes exercised behavior and preservation, not reviewed correctness of their inferred table recognition. All saved table checks pass, and all previously reported saved failures remain explicit and unchanged: 15 complete-text failures in SP 1299; 24 complete-text and four attachment failures in SP 1300. One merged SP 1300 Span still contains a detected extra W. Each candidate retains one raw optional-content failure, three font-audit findings and 15/33 link reviews.

Six booklet grids remain ambiguous and block a new candidate. The previous booklet and TEST-FORM controls retain their exact hashes. A two-page probe confirms that section normalization can move a repeated header before earlier body rows; A42 excludes the future target, while correcting the order and continued-table references remains A43. Diagram/table discrimination, captions and broader human reader qualification remain unfinished. This delivery improves a verified supported case and does not turn the remaining corpus failures into passes.

```text
node --test --test-concurrency=1 modules/tag-builder/test/table-headers.test.js modules/pdf-writer/test/mixed-table-headers.test.js
```

Set `MIXED_HEADERS_EVIDENCE_DIR` to a fresh directory to retain the PDFs and reports. Exact hashes, checks and remaining findings are in [the evidence report](evidence/accessibility-50-batch25-20261023.json).
