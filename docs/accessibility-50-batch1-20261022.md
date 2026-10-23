# Accessibility improvements: native identities and list operands

Four of the [50 selected improvements](accessibility-50-improvements.md) are implemented and verified: A01, A02, A06 and A07. The other 46 remain open. This delivery starts from `eff2da8`; its [evidence record](evidence/accessibility-50-batch1-20261022.json) binds results to candidate and source-code hashes.

## Changes

- **A01 — lexical indices.** PDFBox's synthetic String-overload dispatch executes without creating another source-operator record or advancing its lexical index. The stream-tokenizer overload still records actual operations. TD's internal operations no longer shift later identities.
- **A02 — quoted text.** Single- and double-quote operators retain the complete decoded Unicode text in one record. Double-quote names are escaped correctly in JSON. Their following text operations attach to the intended saved structure elements.
- **A06 — standalone markers.** A marker-only operand transfers its MCID to `Lbl`. Following body operations retain their own `LBody` references; no empty body reference is manufactured for the marker.
- **A07 — array markers.** Qualified `TJ` markers split across strings while preserving source bytes and every numeric adjustment in order. Splitting occurs only in the first operator of the original group. Marker-only arrays retain trailing adjustments and empty strings.

The bounded prefix splitter also has real Type0-font tests for multibyte codes, ligatures and combining sequences, including rejection of boundaries inside a Unicode mapping, unknown mappings, malformed operands and excessive input. This is groundwork for A09; a general mapping usable by compound-node partitioning remains open and is not counted complete. No dependencies were added or validation gates relaxed.

## Verification

The production baseline passes **244 tests**, with no failures or skips. The final focused suite passes all three tests after adding an accented double-quote operand. Counts overlap. Tests use Java 21 with `-XX:TieredStopAtLevel=1 -Xms32m -Xmx512m` and Node test concurrency 2. No new coverage percentage is claimed.

The two-page operator fixture compares every identity with an independent lexical `PDFStreamParser` walk, verifies expected positions, reopens the candidate, resolves each text operation through the ParentTree to its intended ID, checks saved semantics and compares 150-DPI pixels. List fixtures cover separate marker/body operands, markers spanning multiple TJ strings, a boundary between strings, numeric adjustments, empty strings and later body text resembling a marker. Saved glyph positions and 150-DPI pixels remain unchanged.

Three real-document runs replay output stages with unchanged upstream semantic/tagging intent. These are development examples, not an accuracy sample.

| Candidate | Saved checks: passed / failed | Raw veraPDF failed checks | Preservation |
| --- | --- | --- | --- |
| NASA STEREO booklet, 61 pages | 14,624 / 258; previously 14,603 / 267 | 31, unchanged | All 61 pages pixel-identical in Poppler at 96 DPI |
| NASA Hinode, one page | 531 / 0 | 0 | Poppler and PDF.js pixel-identical at 150 DPI |
| TEST-FORM control, two pages | 1,828 / 0 against preserved source structure | 0 | Both Poppler pages identical; PDF.js normal/filled first page identical; text/checkbox fill-save-reopen succeeds with 32 fields and 33 widgets |

Seven booklet list labels on page 40 now have nonempty painted content, removing nine saved checks (five attachment, two missing-node and two child-order failures). An independent pypdf audit verifies their content references and finds no nested, duplicate or unbalanced page MCIDs or unmarked text. The remaining 258 saved failures are still reported. The page-40 rendering was also visually inspected.

The independent lexical comparison improves from 30 mismatching pages / 1,135 mismatching indices to one page / 23 indices. Page 1 includes a nested Form XObject; child text still shares the page stream identity. A03–A05 must address that separately. These counts compare top-level source tokens and are not semantic-accuracy scores.

The booklet remains **rejected**, with unresolved native/OCR attachment and font issues. Hinode and TEST-FORM remain **review_required**. No human screen-reader or keyboard qualification was performed. Booklet PDF.js rendering remains excluded because the source's font behavior is not qualified.

## Reproduction and artifacts

From the engine repository root:

```powershell
$env:JAVA_TOOL_OPTIONS='-XX:TieredStopAtLevel=1 -Xms32m -Xmx512m'
node --test --test-concurrency=2 modules/pdf-writer/test/native-operator-identity.test.js modules/pdf-writer/test/native-list-operands.test.js
```

New tests are included in `test:production-baseline`. The bounded full-run log is `tmp/accessibility-50-batch1-tests.log`; focused results are in `tmp/accessibility-50-batch1-focused.log`. Local replay, rendering, interaction and independent-audit scripts and outputs live under `output/accessibility-50-batch1-20261022/`, with candidates in `booklet-final`, `hinode-final` and `control-final`. These ignored PDFs and screenshots are not distributed by the evidence commit.
