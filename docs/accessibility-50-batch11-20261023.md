# A26: preserve OCR coordinate transforms

Completed 2026-10-23 against `5cf9fb1`. **26 improvements are complete; 24 remain pending.** See [structured evidence](evidence/accessibility-50-batch11-20261023.json).

## Problem and change

OCR coordinates previously used page-size/bitmap-size ratios, which stretched coordinates at fractional raster edges. Rendering also omitted UserUnit from physical DPI. More significantly, the recognizer enabled automatic deskew but discarded the reported rotation when interpreting its boxes.

The PDFBox renderer now includes UserUnit once, applies page crop/rotation, and emits the exact pixel-to-display scale. OCR normalization inverses the recognizer's deskew about the integer image center, then maps all four box corners. It retains a quadrilateral, source pixel box, image size, transform, recognition angle and clipping flag in the additive layout `ocrGeometry` contract. Font height uses the unrotated height rather than an enlarged enclosing rectangle. Invalid frames and boxes fail explicitly. Tiny float drift at an exact canvas edge does not create a clipping finding.

This follows [PDFBox's rendering implementation](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/rendering/PDFRenderer.java), which scales raw user units and rounds bitmap dimensions, and the [pinned Tesseract.js-core implementation](https://raw.githubusercontent.com/Balearica/tesseract/2a9c1c49c360462733c386d2a44fcd22c4e21411/src/ccmain/thresholder.cpp), which rotates without canvas expansion. The integer-center inverse is grounded in [Leptonica's rotation implementation](https://raw.githubusercontent.com/DanBloomberg/leptonica/master/src/rotateam.c). No dependency was added.

Rendering is bounded to 36–1200 DPI, 40 million pixels and 32,768 pixels per side. Oversized renders fail instead of silently changing resolution. Variant names and duplicates are checked. The Java helper has a two-minute timeout and runs without a visible console window.

## Verification

- **48 raster geometry cases:** four page rotations, two crop origins including negative coordinates, two UserUnit values and three resolutions (96, 173 and 300 DPI). An independent image mask measures the actual rendered text bounds. Maximum coordinate/size error is **0.292 points**, within the pixel tolerance. Physical image dimensions and the unchanged source hash are checked.
- **Six live Tesseract deskew cases:** two skewed PNGs with three known text lines each. Location-center error falls from **4.84–9.41 points** to **0.26–0.45 points**. Recognition boxes remain envelopes, not tight ink bounds: residual slant produces up to 4.40 points of envelope difference. The test deliberately distinguishes those quantities. The negative-skew image was visually inspected.
- **377 baseline cases verified:** the full serial baseline passed 376 cases. The subsequent float-edge correction and its new regression passed all 14 focused cases, rechecking the affected geometry suite. All 14 additional parser compatibility tests passed. There are 11 new tests/subtests; three existing OCR-pipeline tests also joined the baseline. No skips or remaining failures. The geometry helper has **100% line, branch and function coverage**; this is not repository or Java coverage.
- The existing 28-page native geometry, rendering, saved-text and form-preservation regression remains in the baseline. The three prior real candidate PDFs retain their exact hashes, preserving their prior appearance and interaction evidence. This batch does not create a new tagged candidate or claim new form-interaction testing.

Live OCR was also replayed on two pages of the [NASA STEREO lithograph](https://stereo-ssc.nascom.nasa.gov/img/litho.pdf) and pages 15 and 38 of the [NASA STEREO booklet](https://stereo-ssc.nascom.nasa.gov/img/STEREObooklet.pdf). All **225 selected OCR blocks** carry geometry evidence with no execution failures. These examples had zero detected deskew; the separate skewed-image tests exercise the rotation correction. The booklet diagram title was checked against its rendered page. Both source hashes remain unchanged.

The lithograph still produces recognition noise around illustrated borders. Geometry success does not mean the text is correct, approved or attached to saved tags. Booklet attachment/text failures from batch 10 remain unresolved. No new raw veraPDF pass is claimed.

## Remaining scope

The qualified geometry path uses PDFBox-generated PNGs and Tesseract.js/core 7.0.0. Arbitrary custom renderer transforms, EXIF-oriented images, semantic interpretation, word uncertainty and saved text-layer geometry need separate qualification. Layout retains the detailed geometry; downstream text-layer/correction integration is still pending. A27–A30 address tagged OCR layers, native/OCR overlap, font coverage and corrections. A27–A50 remain open overall.

Reproduce the deterministic tests with `node --test --test-concurrency=1 modules/parser/test/ocr-geometry.test.js modules/parser/test/ocr-pipeline.test.js test/integration/ocr-geometry.test.js`. Set `OCR_GEOMETRY_EVIDENCE_DIR` to retain the synthetic source, oracles and rendered images. Live recognition evidence uses the existing cached English model; it is separate from mandatory tests, which require no model download. Local artifacts are under `output/accessibility-50-batch11-20261023/`.
