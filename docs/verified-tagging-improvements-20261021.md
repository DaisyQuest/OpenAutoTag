# Verified tagging improvements, 2026-10-21

This delivery addresses three reproducible gaps from the tagging research. It extends the form-label delivery at `9d7637e`; it does not claim completion of all ten research proposals. No dependencies or CLI options were added.

## Changes and evidence

1. **Preserve table semantics when supplying replacement text.** New TH/TD tags place `ActualText` and their content source identity on an inner Span. Header IDs, Scope, Headers, row/column spans and coordinates remain on the cell. Existing synthetic merged-cell repairs use the same representation. Both writer paths retain these attributes after save/reopen, with 155 intent checks passing for each generated table/list fixture. Native glyph positions and 150-DPI pixels remain unchanged. Four table snapshots were updated only for the reviewed content-Span representation; the benchmark now finds the enclosing cell from its unique content owner and rejects misplaced attributes or duplicate owners.
2. **Reject unexpected replacement and alternate text.** Saved-semantic comparison now checks absence as well as presence of `ActualText` and `Alt`. A value added to a cell can mask its valid descendants even if the original requested text still exists. Saved-PDF mutation tests reject unexpected cell replacement text, unexpected alternate text and removal of required Span replacement text, alongside the existing role/header/order/ownership corruptions.
3. **Recognize authored push-button names.** A read-only metadata pass, invoked once only for documents containing push buttons, reads `/MK /CA` using the existing pdf-lib dependency. Captions are joined by exact object/generation reference to PDF.js-confirmed push buttons. Checkboxes, editable values and shared field names cannot supply this evidence. Authored tooltips retain precedence; a valid caption can supply a name when no tooltip exists. Caption/appearance disagreement creates `FORM_BUTTON_CAPTION_MISMATCH`, and a caption without matching visual evidence leaves the visual association reviewable. Neither metadata nor appearance is rewritten.

The caption reader handles literal/hex and indirect strings, nonzero reference generations, empty/invalid/oversized captions and secondary-parser failure. The new helper has 100% measured line, branch and function coverage; this is not repository-wide coverage. Unsupported evidence remains absent, with metadata-read errors exposed in layout output. The layout and semantic contracts add typed caption provenance fields.

The PDF Association guide recommends moving replacement text into a Span to avoid losing table-cell semantics in accessibility interfaces ([Tagged PDF Best Practice Guide, §5.5.3](https://pdfa.org/download-area/publications/Tagged-PDF-Best-Practice-Guide.pdf)). W3C identifies push-button captions and tooltips as sources of form names ([PDF12](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF12)). These sources motivate the changes; the automated tests verify emitted structure and preservation, not observed screen-reader behavior.

## TEST-FORM preservation

Candidate: `output/TEST-FORM-verified-20261021/06-candidate.pdf`.
SHA-256: `efe6450b8b060c5536d9f0a655af243b75029b65e752e8a2691fcc7e499a1f45`.

- veraPDF 1.30.3 Greenfield, `ua1`: 106 passed rules, 9,874 passed checks, zero raw failures and zero suppressions. Independent font audit: zero findings.
- All nine preservation comparisons and 1,828 saved-reference comparisons pass. Retains 32 terminal fields, 35 field-tree objects, 33 widgets, nine links and five saved headings, including the complete Supplemental Affirmation title.
- Both pages are pixel-identical to the preceding candidate at 150 DPI in Poppler and PDF.js. Both pages and both generated table outputs were visually inspected. Text/checkbox and accented/Euro fill-save-reopen probes pass.
- Reset and Print now carry explicit authored-caption evidence as well as their matching painted captions. Their existing tooltips still supply their names. The unresolved visual association remains `LocalCourt` (`340R`), whose authored tooltip has no printed label. Original and preceding PDF hashes are unchanged.

TEST-FORM follows the existing-tag preservation path; this run does not rewrite its saved table cells or field names. The generated native/raster fixtures separately exercise the new table representation. The [hash-bound evidence summary](evidence/verified-tagging-improvements-20261021.json) records artifacts and test results; raw PDFs, probes and logs remain local under `output/` and `tmp/`.

## Reproduction and boundaries

```powershell
npm run test:production-baseline
node --test modules/tag-builder/test/*.test.js modules/parser/test/parser.test.js
node --test --experimental-test-coverage --test-coverage-include=modules/parser/authored-widget-captions.js modules/parser/test/form-parser.test.js
node orchestrator/pipeline-runner.js --pdf output/TEST-FORM-labels-20261021/06-candidate.pdf --output-dir output/TEST-FORM-verified-20261021 --production-checks true
node scripts/check-saved-semantics.js --pdf output/TEST-FORM-verified-20261021/06-candidate.pdf --reference output/TEST-FORM-labels-20261021/06-candidate.pdf --output output/TEST-FORM-verified-20261021/09-saved-semantics.json
```

Use a fresh output directory when repeating the pipeline. The production suite includes caption extraction/association, saved-table mutation and benchmark checks. It reports 220 passed tests with zero failures/skips. The compatibility suite reports 60 passed after the final synthetic-cell guard. Coverage of the caption helper is measured separately; suites overlap.

The candidate remains `review_required`. Human reader/keyboard observations, independent corpus adjudication, complete intended-glyph ownership, nested XObject provenance and general semantic accuracy are still open. Synthetic cell splitting has not acquired a complete source-glyph mapping through this change. List replacement-text placement is unchanged; extending it requires separate marker/body qualification. This delivery makes specific behavior safer and testable, without claiming general production qualification.
