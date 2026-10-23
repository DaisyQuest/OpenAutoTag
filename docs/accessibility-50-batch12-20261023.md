# Tagged OCR on original PDF pages - 2026-10-23

This delivery completes A27 and A28: saved OCR attachment for image-only and mixed pages. It appends invisible text with real structure owners while retaining the original page content, images and editable form appearances. **28 of 50 improvements are complete; 22 remain pending.**

## Implementation

Original OCR lines now survive semantic paragraph and heading merges with their individual geometry. Native/OCR boundaries prevent a merged paragraph from acquiring misleading provenance. Tagging intent carries each line's exact text, source identity, page and quadrilateral, including separate label/body portions for lists. The existing intent hash binds these declarations.

The native matcher excludes OCR nodes. The writer appends an embedded text layer using rendering mode 3, resets the source graphics context, and gives every segment a real MCID and reciprocal structure owner. Unsupported characters and invalid geometry fail before saving. Small nonoverlapping OCR additions no longer need to exceed the whole page's native character count. Overlap conflicts retain native text, both transcriptions, geometry and correctly remapped semantic review references; conflicts also survive a retained-native decision.

Independent saved inspection records text rendering mode and font embedding. Original glyph codes, positions and owners still match the source. Generated text is verified separately as a page suffix: exact Unicode, exclusive owner, invisible rendering, embedded font and the declared line envelope with continuous glyph advances. Missing, additional, partial, visible, shifted and misowned text cannot qualify. This does not allow OCR text to replace an original source glyph.

The NASA replay exposed PDFBox 3.0.8's GSUB conversion of `fi`, `ff` and `fl` into ligature characters. Invisible OCR now uses the font encoder and PDFBox's typed token serializer, with explicit subset tracking, to retain declared Unicode. The normal visible-text path and source fonts are unchanged.

## Verification

- Synthetic image-only and mixed PDFs cover four page rotations, two crop origins and two UserUnit values. All 32 candidate pages match their sources in PDFBox at 120 DPI; original image streams match. A text field retains its original value and appearance, accepts an edit, survives save/reopen, and matches the correspondingly edited source across 16 more page comparisons.
- Saved-PDF mutations exercise visible text, shifted placement, partial Unicode, wrong MCID ownership, duplicate lines and missing lines. Invalid quadrilaterals and unsupported glyphs fail before a PDF is saved. Separate tests cover exact Latin ligature sequences, accents, Euro and Greek text, merge provenance, small OCR additions and retained overlap conflicts.
- **397 production baseline tests pass, with zero failures or skips.** There are 20 new cases, plus 14 additional parser compatibility cases. Focused suites overlap the baseline. Log hashes, real PDF hashes and named checks are recorded in [the evidence](evidence/accessibility-50-batch12-20261023.json). The mandatory tests require no OCR model download. No repository-wide coverage claim is made.

| Official source | Saved OCR result | Saved semantic checks | Raw veraPDF UA1 |
| --- | --- | --- | --- |
| [NASA STEREO lithograph](https://stereo-ssc.nascom.nasa.gov/img/litho.pdf), 2 pages | 63 recognized lines become 65 owned segments, including two list-label splits | 1,342 pass, 0 fail; ownership verified | 5,460 pass, 0 fail |
| [NASA STEREO booklet](https://stereo-ssc.nascom.nasa.gov/img/STEREObooklet.pdf), 61 pages | 158 OCR lines attach on mixed pages 15 and 38; each page retains its two native blocks | 50,828 pass, 248 fail; ownership verified | 192,138 pass, 31 fail |

Every OCR-specific saved check passes on both candidates. The booklet's remaining failures are 17 attachment and 231 text-completeness checks. The full pipeline was rebuilt from source using the hash-verified selected OCR evidence from batch 11; these totals are not a controlled comparison with the earlier cached layout. Selected recognition was reused to avoid another expensive OCR run, not manually corrected or represented as newly recognized text.

All **63 real pages** are pixel-identical in Poppler (150 DPI for the lithograph, 96 DPI for the booklet). Both raw and decoded original image bytes match independently through page/Form resources. The poster and booklet page 15 were also visually inspected. Neither official PDF has form fields; the synthetic mixed-page test supplies fresh form-interaction evidence. The existing TEST-FORM control retains its prior hash and interaction proof.

## Limits and research

The lithograph still contains substantial OCR noise around its illustrated border, and the booklet's diagrams need semantic and reading-order review. Passing attachment and raw validation does not make those words or diagrams correct. Line envelopes and proportional list-label splitting are not exact word boxes. Review/correction qualification, broader Unicode fallback, complex shaping and assistive-technology testing remain separate work. A29-A50 remain pending after this delivery.

[W3C PDF7](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF7) calls for checking converted text and its reading order. [PDFBox's rendering modes](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/graphics/state/RenderingMode.java) distinguish invisible mode 3 from clipping mode 7. Its [content-stream implementation](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/PDAbstractContentStream.java) explains the GSUB behavior detected in this replay. These sources informed the implementation; they do not certify the candidates.

Reproduce the focused tests with `node --test --test-concurrency=1 test/integration/ocr-text-layer.test.js modules/tag-builder/test/ocr-segments.test.js modules/validator/test/ocr-layer.test.js modules/pdf-writer/test/native-content-guard.test.js`. Set `OCR_LAYER_EVIDENCE_DIR` to retain fixtures, candidates and inspections. Local replay scripts, raw reports and renders are under `output/accessibility-50-batch12-20261023/`; only the compact evidence is committed.
