# A16: label/value paragraph boundaries

Completed 2026-10-23 against `e14ddc3`. The 50-item ledger now has **16 completed items and 34 pending**. Evidence: [machine-readable results](evidence/accessibility-50-batch7-20261023.json).

## Problem and implementation

The NASA STEREO booklet's definitions were being mistaken for indented quotations. Paragraph merging could then join a definition to the next acronym. Fractional baseline differences also reversed fragments such as `IM` and `U`, and unconditional spaces broke words such as `Heliospheric`.

The semantic engine now identifies aligned native label/value rows before quotation inference. A clear colon label qualifies directly; acronym rows require independent alignment evidence. Mixed-case abbreviations require nearby established anchors. The pass excludes tables, form-linked nodes, explicit paragraph groups, semantic roles, OCR and unsupported writing directions. Processing is bounded at 10,000 nodes per page, with an explicit review task above the limit.

The public semantic contract carries `labelValuePairId` and `labelValuePart` together. Each part has its own paragraph identity; precedence relations order label, wrapped definition and subsequent row. Both merger strategies respect these boundaries, retain existing paragraph identities and rebind references. Qualified native fragments use anchored baselines and touching text boxes to reconstruct split words while preserving explicit source whitespace. Other pages retain their previous sorting policy, including OCR pages.

## Verification

- **298 production-baseline tests pass**, with no failures or skips. The final focused semantic/merger suites pass **144 tests**, overlapping the baseline. Ten new tests cover positive cases, protected boundaries, ambiguity, mixed-case anchors, row drift, bounded inference, repeated merging, schema rejection and the semantic-to-tag-tree pipeline.
- Rebuilt semantic inference, paragraph merging, reading order and saved output from the same frozen layout inputs. This isolates the change from extraction/OCR variability. Native writing was used for the booklet and Hinode; TEST-FORM uses the existing preservation path.
- An independent pypdf structure-tree walk verifies **101 adjacent saved P label/value pairs**: 8 on booklet page 2, 35 on page 56, 32 on page 57 and 26 on page 58. All have saved content references. Sixteen pairs were also checked against text transcribed from rendered source pages.
- The formerly ambiguous page-57 operation 4 and page-58 operation 21 now have exact label/definition ownership. Independent content-stream traversal verifies **209 fragments from 104 compound operations**, with every one of the source's **53,667 text bytes and 615 TJ spacing adjustments unchanged**.
- All **64 pages** match their sources pixel for pixel in Poppler: 61 booklet pages at 96 DPI and three control pages at 150 DPI. PDF.js additionally verifies control rendering and sampled form interaction. TEST-FORM retains **32 fields and 33 widgets**, and text/checkbox fill-save-reopen and filled appearance comparisons pass.

| Document | Saved checks passed / failed | Raw veraPDF checks passed / failed | Disposition |
| --- | ---: | ---: | --- |
| NASA STEREO booklet | 15,401 / 154 | 186,894 / 31 | rejected |
| NASA Hinode | 489 / 0 | 5,246 / 0 | review_required |
| TEST-FORM preserved control | 1,828 / 0 | 9,874 / 0 | review_required |

The booklet loses one previous saved attachment failure (`n-58-57`, the split UNH label), with no new failed targets. The two corrected compound operations were not individually reported as saved failures before; validator counts alone would miss that improvement. Retaining paragraph identities changes some tag grouping and check totals in the rebuilt controls; counts are not an accuracy percentage.

## Remaining limits

The booklet still has 154 saved attachment failures, including the prior 137 OCR findings, and 31 raw font failures. Existing table misclassification on the launch-details page and upstream combined blocks such as the PLASTIC row are not reclassified or split by this pass. Heading membership, broader running-text inference, OCR attachment and human usability qualification remain open. All outputs require human review; the booklet remains rejected.

Local replay artifacts and proof scripts are in `output/accessibility-50-batch7-20261023/`. Regression commands are the package's `test:production-baseline` plus the semantic-engine and paragraph-merger test files. On this host, Java tests ran serially with `JAVA_TOOL_OPTIONS=-XX:TieredStopAtLevel=1 -XX:+UseSerialGC -Xms32m -Xmx512m`; production JVM defaults are unchanged.
