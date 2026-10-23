# Content ownership and exact overprints — 2026-10-22

The STEREO booklet's raw veraPDF failures fell from **859 to 31**, and saved semantic failures from **389 to 267**. All 61 pages still match the frozen NASA source in Poppler. The candidate remains rejected because content attachments and fonts are unresolved.

This follows the [native preservation fixes](native-stream-and-table-fixes-20261022.md). The [evidence record](evidence/content-ownership-fixes-20261022.json) binds the measurements to source/candidate hashes, tested code and local reports. There are no new dependencies or relaxed validator thresholds.

## What changed

**Disjoint native content ownership.** The writer previously stretched one marked-content wrapper from a tag's first text operator to its last. Unrelated tags, whitespace and graphics could occur between them. Its barrier indices could also drift from the actual source stream during PDFBox's internal dispatch. The result included Artifact content nested inside tagged content, crossing tag wrappers and unmarked paint.

Each assigned text operator now receives its own MCID and balanced wrapper. One structure element may own several such references, in source order. Source markers cannot close wrappers created by this rewrite. Duplicate operator ownership rejects before saving, and inline images participate in the existing paint-marking path. The list-label splitter is restricted to the start of its original assignment group, so later body text resembling the marker cannot be reassigned to Lbl.

**Exact overprint extraction.** The booklet paints some diagram labels repeatedly at identical coordinates. Extraction previously treated these as several semantic occurrences or concatenated repeated words. The parser now collapses exact matches of text, transformation, dimensions, font resource/name and direction before grouping lines. It retains line-end evidence, does not mutate input items, and keeps nearby text and different font resources separate. The original PDF paint operations remain intact.

## Results and interpretation

| Booklet measurement | Before | After |
| --- | ---: | ---: |
| Raw veraPDF failed rules / checks | 6 / 859 | 3 / 31 |
| Artifact inside tagged content | 290 | 0 |
| Tagged content inside Artifact | 290 | 0 |
| Content neither tagged nor artifacted | 248 | 0 |
| Saved semantic failed checks | 389 | 267 |
| Missing emitted nodes | 22 | 2 |
| Child-order failures | 3 | 2 |
| Content-attachment failures | 364 | 263 |
| Native semantic nodes | 1,006 | 901 |
| OCR semantic nodes | 137 | 137 |
| Matched operators | 3,994 | 3,994 |

The semantic comparison is against a changed intent tree: redundant extraction has been removed, so **122 fewer failed checks does not mean 122 newly attached text nodes**. Layout blocks decrease from 1,940 to 1,818. Saved checks now total 14,603 passing and 267 failing. Tag granularity and inferred table topology also change; neither these counts nor the operator match rate measure general tagging accuracy.

An independent pypdf audit finds no nested or unbalanced marked content, duplicate page MCIDs, or unmarked paint among **7,289 top-level page paint operators**. It also verifies all **41 intended empty TD cells**, **143 Headers references** resolving to TH in the same table, and no duplicate structure IDs. This audit covers top-level page streams and structural relationships, not complete nested Form XObject semantics or correct table recognition.

The remaining raw failures are **6 missing font programs, 6 CIDToGIDMap findings and 19 unmapped Unicode glyphs**. The independent font audit remains at 6 errors and 1 warning. Fonts were not substituted to reduce these counts.

## Preservation and tests

- **241 production-baseline tests passed**, zero failed/skipped, using test concurrency 2 and Java `-Xms32m -Xmx512m`. An initial unbounded run overlapped OCR and hit Windows paging-file/JVM startup and process-spawn limits. The bounded rerun passed; no assertions were weakened.
- The focused new regressions pass 6 tests; a parser compatibility run passes 25. Counts overlap. Before the fixes, the ownership fixture failed on nested marked content and three overprint tests failed. No new coverage percentage is claimed.
- Tests check interleaved tags, whitespace, unmatched text, source markers, vector paint and inline images; conflicting ownership must reject without producing a PDF. List continuations, exact versus near overprints, source font identity and line boundaries are covered. Native glyph/pixel comparisons and saved semantic checks remain enabled.
- **All 64 checked pages match in Poppler**: 61 booklet pages at 96 DPI, one Hinode page and two TEST-FORM pages at 150 DPI. Final booklet pages 14 and 52 were visually inspected. PDF.js additionally matches Hinode and TEST-FORM first pages, including the filled TEST-FORM first page. Booklet PDF.js comparisons remain excluded because of unresolved source fonts.
- Hinode retains **531 passing saved checks** and zero raw veraPDF/font failures. TEST-FORM retains **32 fields / 33 widgets**, its source byte prefix, **1,828 passing saved-reference checks** and zero raw veraPDF/font failures. One text field and checkbox were filled, saved and reopened in both source and candidate. These remain bounded probes, not every field or reader/keyboard qualification.

Each document received a full pipeline replay after the main fixes. After the list-label boundary guard, final tag-builder/writer/validator/production-preservation stages reused the unchanged ordered semantics. Final tagging JSON hashes match the full runs. The production preservation stage still rejects the booklet; Hinode and TEST-FORM remain `review_required`. The control source is the previously qualified `output/TEST-FORM-verified-20261021/06-candidate.pdf`, not the original downloaded form.

| Final candidate | SHA-256 |
| --- | --- |
| Booklet | `61bb14d43fcab33fea25ee51d4e294ab4d7660700729dc69dd43a1d958eea3fe` |
| Hinode | `b1b5459e3aa64506fc5b49a30007521cbe9d44f86685974c2012482be02cca8e` |
| TEST-FORM | `25c01974b73282322707977b725590244733bce9d0509ab75df615cae10af8c6` |

## Remaining priorities

1. **Native attachment and stream identity.** The 263 attachment failures comprise 251 Span, 9 Lbl and 3 LBody nodes. Their source references include 117 native and 137 OCR nodes; the 9 labels have no source IDs. Some source text operators combine multiple intended nodes, such as a label and value. Support needs exact glyph/operand boundaries and saved ownership proof, not broader text-similarity matching. Virtual operator dispatch and nested stream identity also require qualification.
2. **OCR attachment.** All 137 OCR nodes remain unattached. Add a qualified invisible text layer with correct rotation, geometry, Unicode and ownership, preserving appearance and controls. No such layer was added here.
3. **Qualified fonts and semantic review.** Address the 31 remaining raw font failures with verified mappings and appearance checks. Meaningful diagram/figure descriptions, table recognition, reading order and human keyboard/screen-reader qualification remain separate work. Unmatched text and graphics may still be artifacts; passing content-marking rules does not establish correct semantic classification.

## Reproduction

Use Node 22, Java 21, PDFBox 3.0.8 and veraPDF 1.30.3 Greenfield. From the repository root:

```powershell
$env:JAVA_TOOL_OPTIONS = '-XX:TieredStopAtLevel=1 -Xms32m -Xmx512m'
$baselineFiles = ((Get-Content package.json -Raw | ConvertFrom-Json).scripts.'test:production-baseline' -split ' ') | Select-Object -Skip 2
node --test --test-concurrency=2 @baselineFiles
node orchestrator/pipeline-runner.js --pdf <frozen-source.pdf> --output-dir <new-directory> --production-checks true
```

Final local artifacts are under `output/content-ownership-fixes-20261022/booklet-final`, `hinode-final` and `control-final`; upstream full runs are in the same parent directory. Logs, PDFs, raw inspections and rendering/replay helpers are ignored local artifacts, not distributed with the evidence summary. This is a three-document development replay, not an unseen holdout or a repeat of the entire eight-document pilot.
