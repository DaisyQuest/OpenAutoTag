# Display geometry: crop origins, page scale and rotation

A13–A15 are complete: **15 of 50 improvements verified, 35 pending**. New extraction and matching use physical points from the displayed CropBox top-left, after rotation and UserUnit. Native tagging retains the original page geometry, content and controls.

## What changed

The previous parser treated CropBox upper-right coordinates as page dimensions, left text/widgets in raw coordinates, and transformed images separately. The matcher also assumed unrotated semantic boxes. These conventions disagreed on shifted, rotated or scaled pages.

The additive `source.coordinateSpace: "crop-display-points"` contract now follows text, images, widgets, semantic inference and reading order. Source-text diagnostics, ruled-table detection, OCR render dimensions, raster overlays and both redaction paths use the same declared frame. PDFBox native positions already include crop translation and page rotation, so matching applies only UserUnit. Missing geometry and incompatible frames reject. Older plans without the marker retain their previous interpretation.

## Verification

- **288 production-baseline, 29 writer compatibility and 49 consumer tests pass**, with zero failures or skips. Six geometry tests overlap the baseline and consumer suites; these totals are not distinct coverage counts. Runs use serial Java execution with the documented host options.
- A 28-page fixture exercises zero, positive and negative crop origins; rotations 0/90/180/270; and UserUnit 0.5/1/2. Text/font, image, widget and table coordinates match their physical expectations. An independent saved-tree walk checks 24 column sequences and identical labels belonging to their own columns.
- Original glyphs and page geometry remain exact. PDFBox pixels match at 96 physical DPI. Four fields preserve values and rectangles, and accented fill/save/reopen pixels match. The candidate passes **3,865 saved checks and 29,152 raw veraPDF checks**, with zero failures.
- Raster checks cover 24 geometries, image placement, invisible text and redaction rectangles. The standalone redactor preserves the exact intended bitmap and transformed image corners. Fractional-DPI rerender interpolation is not claimed pixel-identical; raster form preservation is not claimed.
- Poppler verifies **93 candidate-page comparisons**: 64 existing control pages, 28 geometry pages and one fresh Hinode pipeline output. Representative geometry/form pages and Hinode were visually inspected. TEST-FORM retains its unchanged source-byte prefix, 32 fields and 33 widgets; sampled text and checkbox interactions and filled-page PDF.js pixels match.

| Existing control | Saved passed / failed | Raw veraPDF passed / failed | Disposition |
| --- | ---: | ---: | --- |
| NASA STEREO booklet | 14,727 / 155 | 185,539 / 31 | rejected |
| NASA Hinode | 531 / 0 | 5,295 / 0 | review_required |
| TEST-FORM | 1,828 / 0 | 9,874 / 0 | review_required |

## Remaining problems

A full preparation and forced-native Hinode run passes the same checks. The official [USGS report](https://pubs.usgs.gov/of/2024/1001/ofr20241001.pdf) correctly exposes its 24 rotated pages as 792 × 612 points. Matching assigns 4,448 of 4,454 text operators on those pages, but forced rebuilding rejects an authored replacement scope with unassigned paint on page 5. No candidate is saved. This is an unresolved ownership case for the source-coverage work, not a qualified USGS result or an accessibility accuracy percentage.

A26's complete OCR transform/recognition qualification remains pending. The booklet's 155 saved attachment and 31 raw font failures persist. Human review and screen-reader qualification remain required. A16 label/value paragraph boundaries is the next planned implementation.

[Hash-bound evidence](evidence/accessibility-50-batch6-20261023.json) includes implementation hashes, exact candidate hashes and test logs. Local proofs live under `output/accessibility-50-batch6-20261023/`; logs are `tmp/accessibility-50-batch6-*.log`. PDFs and local artifacts are not committed.

Coordinate behavior was checked against the pinned [PDF.js PageViewport implementation](https://github.com/mozilla/pdf.js/blob/v4.10.38/src/display/display_utils.js) and [PDFBox TextPosition implementation](https://github.com/apache/pdfbox/blob/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/text/TextPosition.java). `SPEC.txt` and the public schemas document the compatibility rules.
