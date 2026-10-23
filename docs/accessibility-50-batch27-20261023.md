# A44: distinguish diagram labels from table cells

Seven inferred tables on pages 15, 51 and 52 of the official [NASA STEREO booklet](https://stereo-ssc.nascom.nasa.gov/img/STEREObooklet.pdf) were actually parts of diagrams. Their aligned labels and boxes triggered text/grid inference. Six of those inferred grids had overlapping cells and prevented a new native output. Fresh extraction and classification now keep these pages free of false tables, retaining all 243 labels and the booklet's three other detected tables.

[W3C PDF6](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6) describes tabular information in terms of logical relationships in two dimensions. Alignment alone does not establish those relationships. The [PDF Association syntax guide](https://pdfa.org/download-area/publications/Tagged-PDF-Best-Practice-Guide.pdf) distinguishes illustration structure and alternative descriptions from table structure. This implementation avoids false table semantics while keeping illustration meaning and reading order explicit review tasks.

## Changes

The vector extractor retains up to 4,096 oblique strokes separately from the existing ruled-grid geometry. Exceeding that bound reports `limit-exceeded` and supplies no partial connector evidence. The table-map contract carries these strokes in physical display coordinates. Existing horizontal/vertical table extraction is unchanged.

Diagram inference requires an illustration heading, a sufficiently large image or at least four distinct long oblique strokes, and six or more short labels within the proposed region. Duplicate strokes do not add evidence. Dense regular text/numeric grids, ambiguous headings, form controls, insufficient geometry and oversized inputs decline classification. The vocabulary currently covers English diagram, schematic, flowchart, data-flow and qualified architecture headings. It is a conservative heuristic, not a universal diagram detector.

Typed `diagramRegions` retain the title, exact block IDs, bounds, evidence and review status. These labels are excluded from every table detector and orphan-cell adoption. Reanalysis recomputes proposals rather than trusting stale region IDs. Semantic inference preserves each label as P, avoids list, heading, running-content, quotation and label/value inference for these labels, and emits `DIAGRAM_DESCRIPTION_AND_ORDER_REQUIRED`. Both paragraph-merging strategies preserve label boundaries. Tag building groups contiguous labels in Sect containers without changing their order or claiming a complete Figure description. Interrupted groups remain separate.

The saved fixture exposed an additional native comparison defect: PDFBox layout extraction expanded the presentation ligature `ﬂ` to `fl`, while the operator matcher did not. Comparison now expands U+FB00–U+FB06 through Unicode normalization. Source glyphs, content bytes and matching thresholds remain unchanged. The real `Data flow catalog` heading now attaches correctly and passes saved text/ownership checks.

No dependency or CLI option was added. Existing-tag preservation is unchanged; this classification applies to new inferred plans.

## Verification

The serial baseline passed 863 tests. It started before the final stale-evidence/label guards and the connector-limit test. The final 54-test affected run covers those paths; the current 865 configured cases are covered across overlapping runs. A single final 865-case run is not claimed.

The final affected suite passes **54 tests**, including the two pre-existing ruled-table integration cases, adversarial image/connector detection, stale-evidence removal, both paragraph strategies, native/raster saved output and the extractor's real 4,096-edge limit. Focused coverage for `diagram-regions.js` is **100% line/function and 94.94% branch**, not repository or Java coverage.

The two-page fixture keeps eight diagram labels in one text section, unrelated prose outside that section and one genuine ruled table on the next page. Native output passes **526 saved / 1,386 raw checks**; raster passes **402 saved / 1,305 raw checks**. Deliberately changing the saved diagram section to Table rejects. Native field values, appearance bytes and accented fill/save/reopen are preserved. The native fixture retains three separate default-font audit findings; raster's font audit is clean. Raster form editing is not qualified.

Independent pypdf inspection confirms the saved label roles/section ownership, original text bytes/TJ spacing, annotations, field properties, widget appearance bytes and page geometry. The booklet's two separately appended invisible OCR streams are excluded only when comparing original text operands; their page identities and invisibility are checked. All **82 Poppler page pairs at 120 DPI** match: four fixture pairs before/after editing, 61 booklet pages and 17 NIST pages. Representative fixture and booklet pages were visually inspected.

## Corpus results and boundaries

The booklet retains 146 OCR labels on page 15, 42 native labels on page 51 and 55 on page 52. The real parameter/value tables on pages 37 and 39 still detect. Six overlapping-grid review failures become zero, and a new native candidate can be written. It remains unqualified: **192 saved failures** (175 complete-text and 17 attachment checks), **six raw failures**, six font-audit errors and **158 pending OCR reviews**. Seventeen saved failures concern diagram labels, including three unattached duplicate-label occurrences. Preserving labels in the structure does not mean every source occurrence or diagram relationship is correct. No improvement percentage is inferred from changed tagging intent or historical validator counts.

Official NIST SP 1299 and SP 1300 historical semantic plans were replayed as native matcher/preservation regressions. Their complete failure records remain identical to A43: **15/28 saved failures**, one raw optional-content failure each and three font findings each. These replays do not qualify fresh table recognition on those documents. The earlier booklet and TEST-FORM control PDFs retain their exact hashes.

Image content, connector meaning, descriptions and reader navigation still need human review. General vector Figure attachment, unlabeled or predominantly orthogonal diagrams, mixed illustrations/tables in one graphic, arbitrary languages and authenticated reader observations are not qualified by this delivery. A45–A50 remain open.

```text
node --test --test-concurrency=1 modules/layout-analyzer/test/diagram-regions.test.js modules/pdf-writer/test/diagram-discrimination.test.js test/integration/table-structure-map.test.js
```

Set `DIAGRAM_EVIDENCE_DIR` to retain fixture outputs. Exact hashes and evidence are recorded in [the evidence report](evidence/accessibility-50-batch27-20261023.json).
