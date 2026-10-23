# Native stream and empty table-cell fixes — 2026-10-22

Follow-up: [content ownership and exact overprint fixes](content-ownership-fixes-20261022.md) reduce the booklet to 31 raw veraPDF and 267 saved semantic failures while retaining appearance. The measurements below describe the preceding build.

Three bounded fixes remove the STEREO booklet's writer blocker and preserve its appearance. All 61 pages now match the frozen NASA source in Poppler. The booklet still fails saved semantic checks and remains rejected; successful writing and identical pixels do not establish accessible reading order or complete tagged content.

This follows the [official-source pilot fixes](public-pdf-pilot-fixes-20261022.md). The [evidence record](evidence/native-stream-and-table-fixes-20261022.json) binds results to source/candidate hashes, code hashes and local reports. No dependency was added, and validation or preservation guards were not weakened.

## Changes and reasons

1. **Keep empty table positions as data cells.** The missing `tag:table:table:2:1:H_r1c0_2` header was an empty synthetic placeholder, not lost header text. Tag building promoted the gap to TH, while native writing pruned it. Blank repair placeholders now stay TD even within THead, do not acquire header identities, and survive native writing and shared cleanup when directly inside TR. Unmatched intended text and orphan cells still fail saved comparisons. The W3C's [PDF6 technique](https://w3c.github.io/wcag/techniques/pdf/PDF6) discusses empty TD cells for maintaining table structure.
2. **Use PDFBox's existing content-stream serializer.** The handwritten writer emitted tiny numbers in exponential notation, narrowed large integers, failed to escape names, mishandled booleans and dropped inline-image payloads. PDF exponential notation is invalid under section 7.3.3 of [ISO 32000-1](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf). The native writer now uses the bundled PDFBox 3.0.8 [ContentStreamWriter](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdfwriter/ContentStreamWriter.java), replacing about 90 lines of custom serialization code.
3. **Retain source font families during native tagging.** Automatic substitutions such as Arial Narrow → Liberation Sans and Times New Roman → Noto Serif altered six booklet pages. Native rewriting now disables that substitution step. Existing Unicode/metadata handling remains; this is not a promise that every font dictionary is byte-identical. Missing-font findings remain visible for separately qualified repair. The shared method's existing four-argument behavior is preserved for other callers.

## Verified results

| Document | Pages checked | Appearance | Saved semantic checks | Raw veraPDF failed checks | Outcome |
| --- | ---: | --- | --- | ---: | --- |
| NASA STEREO booklet | 61 | All match at 96 DPI in Poppler | 15,809 passed; 389 failed | 859 across 6 rules | Rejected by saved-semantics checker |
| NASA Hinode | 1 | Matches at 150 DPI in Poppler and PDF.js | 531 passed; 0 failed | 0 | Review required |
| TEST-FORM control | 2 | Both match at 150 DPI in Poppler; first page also matches in PDF.js | 1,828 passed; 0 failed | 0 | Review required |

An independent pypdf traversal of the booklet verifies all **42 empty TD cells** remain directly inside TR, have no painted content or replacement text, and are never header targets. All **213 Headers references** resolve to TH elements in the same table, with no duplicate structure IDs. This verifies serialization; table recognition and inferred relationships still need semantic review.

The booklet's intermediate candidates make the appearance regressions concrete: after the table fix alone, 0/61 pages matched; after serialization repair, 55/61 matched; after disabling font-family substitution, 61/61 matched. The six remaining differences before the font fix were pages 14, 18, 21, 25, 46 and 52. Final page 14 and TEST-FORM page 1 were visually inspected; booklet page 2 was inspected after serialization repair. Intermediate candidates are diagnostic artifacts, not deliverables.

Retaining the source fonts increases raw failed checks from 854 to **859**, with **6 font-audit errors and 1 warning** instead of 1 error and 1 warning. That is an explicit unresolved conformance problem, not an accessibility improvement claimed from the count. Appearance equality is bounded to the named renderer, machine and resolution. Booklet PDF.js comparisons are excluded because unresolved unembedded fonts made its rendering unreliable.

TEST-FORM retains **32 fields / 33 widgets**, its source byte prefix and zero raw veraPDF/font findings. One editable text field and one checkbox were filled, saved and reopened in both source and candidate; the edited first pages match in PDF.js. These are bounded interaction probes, not every field/action or keyboard/screen-reader qualification. The control source is the previously qualified `output/TEST-FORM-verified-20261021/06-candidate.pdf`, not the original download.

## Regression and replay scope

- **235 production-baseline tests passed**, zero failed/skipped. The focused writer/table run passed 10 tests. A separate overlapping layout/order/tag-builder run passed 76 tests after the empty-cell fix. No new repository-wide coverage claim is made.
- New tests save native and raster tables, check blank head/body cells, and ensure missing text, orphan cells and invalid header references remain failures. Native glyph positions and 150 DPI PDFBox pixels are compared.
- A new stream fixture checks small positive/negative decimals, a 64-bit integer, a large real, escaped names, booleans/null, inline-image parameters/payload and 150 DPI pixels. Embedded and deliberately unembedded font variants are exercised. The unembedded regression failed before the font fix on `ArialNarrow -> LiberationSans`.
- The final booklet replay starts at the writer and reuses unchanged ordered-semantic/tagging artifacts from the preceding full run. Writer, raw validator, preservation and saved-semantics CLIs were rerun after all code changes. Saved-semantics exits 1 with `rejected`; the standalone preservation report is `review_required`. These are separate checks, not a claimed final full-pipeline run. The existing production pipeline rejects a failed saved-semantic comparison.
- Hinode received a final full-pipeline replay with production checks. TEST-FORM's full replay followed the table/serializer fixes and was reused after the native-only font change; its passthrough path is unaffected by that change. All 64 pages were rendered again against the frozen sources. The full eight-document pilot was not rerun in this delivery.

Final candidate SHA-256 values:

| Document | SHA-256 |
| --- | --- |
| Booklet | `3c4d25c1f89e265d4f2d9904f0a4fd8c7189758fd3a41956a28b171b5e37add2` |
| Hinode | `d292db62816a4a31dabadc259b3d6cb86fdb9673adf1e86962a1987cf8c6822f` |
| TEST-FORM | `dd3df45efab42379eece23d48a84f3069ef66200eb124a932bf539e500dc5a9d` |

## Next opportunities, in priority order

1. Trace the booklet's **364 content-attachment failures**, **22 missing emitted nodes** and **3 child-order failures** through source identities, matching and saved MCIDs. These include native text as well as OCR; an OCR-only fix cannot resolve the entire set. Acceptance requires fewer genuine failures with no missing content or appearance changes, not relaxed comparisons.
2. Qualify mixed-page and image-only OCR attachment, including text geometry, Unicode, content ownership and unchanged rendering. The image-only poster remains unsupported by native tagging.
3. Add complete native source-to-candidate content identity proof. Hinode still has `IDENTITY_MAPPING_REQUIRED` despite its passing saved-intent and render checks.
4. Repair missing fonts only with verified mappings and appearance evidence; address the booklet's remaining raw structure/content findings independently. Font-family similarity alone is insufficient.
5. Expand independently reviewed table/figure/reading-order references and run human screen-reader/keyboard checks on an unseen holdout. This development sample cannot measure general tagging accuracy.

## Reproduction

Use Node 22, Java 21, PDFBox 3.0.8 and veraPDF 1.30.3 Greenfield. Validate frozen input hashes against the evidence record. From the repository root:

```powershell
$env:JAVA_TOOL_OPTIONS = '-XX:TieredStopAtLevel=1'
npm run test:production-baseline
node --test test/integration/native-stream-syntax.test.js test/integration/saved-table-semantics.test.js
node orchestrator/pipeline-runner.js --pdf <frozen-source.pdf> --output-dir <new-directory> --production-checks true
# To replay only writing against unchanged upstream artifacts:
node modules/pdf-writer/index.js --pdf <frozen-source.pdf> --tags <05-tagging.json> --semantic <04-semantic-ordered.json> --output <candidate.pdf> --mode native
node modules/validator/index.js --pdf <candidate.pdf> --manifest <candidate.pdf.tags.json>
node scripts/check-pdf-preservation.js --source-pdf <source.pdf> --candidate-pdf <candidate.pdf> --validation-report <validation.json> --semantic <04-semantic-ordered.json> --output <quality.json>
node scripts/check-saved-semantics.js --pdf <candidate.pdf> --tags <05-tagging.json> --output <saved-semantics.json>
```

Redirect validator stdout to the validation file before the preservation command. Full local artifacts are under `output/native-preservation-final-20261022/`; the reused control and upstream booklet artifacts are under `output/native-stream-fixes-20261022/`. Logs, PDFs, raw inspections and local rendering helpers are ignored and are not distributed with the committed evidence summary.
