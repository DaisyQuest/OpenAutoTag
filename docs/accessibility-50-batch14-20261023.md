# OCR uncertainty and scoped corrections — 2026-10-23

This delivery completes A30. Word evidence now survives recognition, semantic merges, list splitting and saved-output qualification. Explicit transcription decisions can correct an exact OCR segment while preserving original page paint, native text, form fields and tag roles. **30 of 50 improvements are complete; 20 remain pending.**

The parser retains normalized original text, word confidence, UTF-16 offsets and mapped word quadrilaterals. Unmatched words lose inferred offsets; unavailable or clipped geometry stays explicit. Missing word evidence in older artifacts remains unknown. A list label and body retain disjoint ranges into the same original recognition record. The generated text layer still uses line envelopes; word evidence does not claim precise selection geometry.

Saved reports expose an `ocrReview` section with exact tag/segment targets, original recognition evidence, pending status and reasons. Scores below 85 prioritize review; the threshold is an uncalibrated heuristic. **Even confidence 100 cannot close transcription review.** Production quality reports include an open task pointing to this evidence whenever segments remain pending. Structural `automated_pass` remains separate from transcription and overall reader qualification.

## Review workflow

Create decisions conforming to `contracts/ocr-review.schema.json`. Copy the source and intent hashes from the saved report, identify the exact tag ID/segment index/page/source block, and supply the expected text, explicit confirm/correct decision, final text, reviewer and evidence. Do not infer these decisions from confidence. Apply them to the original tagging artifact:

```powershell
node modules/tag-builder/ocr-review.js --pdf source.pdf --tags original-tagging.json --review decisions.json --output reviewed-tagging.json
node modules/pdf-writer/index.js --pdf source.pdf --tags reviewed-tagging.json --semantic original-semantic.json --output reviewed.pdf --mode native
node scripts/check-saved-semantics.js --pdf reviewed.pdf --tags reviewed-tagging.json --source-pdf source.pdf --ownership reviewed.pdf.ownership.json --output reviewed-saved.json
```

Then rerun raw validation, appearance/form preservation and reader checks for the new candidate hash. The review CLI refuses existing output paths. Stale source/intent hashes, duplicate or unknown targets, mismatched expected text and ambiguous replacement metadata reject. A complete revised review must be reapplied to the original intent; automatic chaining is intentionally unsupported. The original semantic file is retained because native matching excludes OCR nodes; generated OCR and its ActualText come from the final reviewed tagging file.

Corrections update only selected segment text and exactly corresponding ActualText/Alt/label metadata. Character-position mapping distinguishes repeated occurrences and preserves unaffected whitespace. Structure, roles, geometry and immutable recognition evidence remain unchanged. The audit binds the original source and tagging bytes, the canonical review object and final tagging document; the writer's ownership proof also binds the final tagging file bytes. This detects stale or changed evidence. It does not authenticate a reviewer or prove the human work occurred.

## Verification

| Candidate | Saved semantic checks | Raw veraPDF UA1 | OCR review |
| --- | --- | --- | --- |
| Fresh NASA STEREO lithograph OCR | 1,472 pass, 0 fail | 5,460 pass, 0 fail | 65 pending; 61 contain a word below 85 |
| Existing NASA STEREO booklet | 51,144 pass, 248 fail | 192,138 pass, 31 fail | 158 pending; legacy word evidence unknown |
| Corrected mixed-page fixture | 467 pass, 0 fail | 1,529 pass, 0 fail | One authored fixture decision recorded; 15 pending |

The poster's two pages were recognized again using the cached English model and the same grayscale/auto configuration. All 469 words across 63 recognized lines retain evidence; list splitting produces 65 tagged segments. No NASA text was declared reviewed or corrected. The booklet PDF and raw report retain their exact batch-13 hashes; saved checking and rendering were rerun. Existing failures remain visible.

All **415 production baseline tests pass**, with no failures, cancellations or skips. Fifteen cases were added, including stale evidence, occurrence targeting, schema consistency, uncertainty propagation and saved correction/form tests. The scoped 13-test coverage run covers four new JavaScript files at 92.64% lines and 91.30% branches; CLI subprocess integration is separate. These are not repository-wide or Java coverage figures.

All **79 Poppler page pairs** match, with original image bytes preserved. The synthetic PDFBox probes compare 96 page pairs across unmodified scans, mixed content, font fallback, corrected output and filled/reopened forms. The correction fixture deliberately injects I23 where the independent raster says 123, then verifies the exact saved correction, metadata, native glyph ownership, unchanged fields/appearance, and fill/save/reopen. The first corrected page was also visually inspected. Evidence and hashes are in [the machine-readable report](evidence/accessibility-50-batch14-20261023.json); local artifacts are under `output/accessibility-50-batch14-20261023/`.

This addresses suspect transcription handling described by [W3C PDF7](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF7), which also calls for checking complete text and reading order. It does not establish OCR accuracy, correct diagram order or completed human reader qualification. No dependencies were added.
