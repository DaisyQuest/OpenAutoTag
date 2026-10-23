# A36: native links own their source anchors

Native rebuilding now places the source anchor text and its annotation object reference under the same `Link` structure element. Previously the native link-binding code was disabled; the metadata pass appended an annotation-only Link while leaving its text elsewhere. This follows [W3C PDF11](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF11) and the structure/content relationships described in [ISO 32000 document interchange](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html). Neither source establishes conformance or usability of our output by itself.

## Implementation

The writer discovers source glyphs inside each visible annotation rectangle and requires complete, unique coverage by one intended text owner. It splits native text operands at verified glyph/byte boundaries, retaining original string bytes and TJ spacing adjustments. The Link occupies its original inline position, owns its MCRs, and contains one OBJR. Its annotation has a reciprocal `StructParent` entry pointing directly to the Link dictionary; page and Form ParentTree entries retain their array representation. Reused Forms remain invocation-specific. A pre-existing intended Link can be reused only when all its content belongs to that annotation.

The tag builder commonly emits generated `ActualText` even when it repeats the source exactly. Such a leaf replacement would mask a new inline Link. The writer may omit it only when it is identical, character for character, to all of that owner's source glyph text. The saved validator independently verifies this exception using the source and original intent. Differing replacements, replacement ancestors and source-authored replacement/expansion scopes remain for review. Authored nonblank annotation descriptions are retained; missing descriptions can use the exact anchor text.

The existing `.ownership.json` contract has an additive `nativeLinks` array. Each source annotation receives either a `bound` declaration with exact source ranges, intended owner, emitted identifier and ParentTree key, or an explicit `review_required` reason. The tagging contract also accepts the standard `Link` role. No dependencies or CLI arguments were added. Native writer JSON uses explicit UTF-8, including accented anchor text on Windows.

Independent saved inspection checks source annotation identity, actions, local destination targets, appearance data, geometry, visibility, page geometry, exact glyph membership, completeness, uniqueness, replacement ancestry, OBJR and ParentTree reciprocity. An added Link becomes transparent to original semantic ownership only after these checks pass. A local destination's page is fingerprinted by ordinal, while document geometry and source glyph order/positions are checked separately. The existing preservation fingerprint remains unchanged for its original consumers.

Limits include 4,096 links per page, one million source glyphs per page, ten million geometry comparisons per page, 100,000 annotations per repeated-identity traversal, and ten million verification work units. Exceeding a limit fails explicitly. Successful verification reports aggregate glyph checks per annotation to avoid one report row per glyph.

## Verification

The serial production baseline passed **656 cases** with zero failures or skips. The final focused run passed **39 cases**, including one subsequently added source-authored replacement test. The configured baseline is now 657 cases, covered across these overlapping runs; no single 657-case run or coverage percentage is claimed.

Fixtures exercise an anchor inside Tj, multiple operators, TJ adjustments, simple and Type0 fonts, reused Forms, local destinations, existing Link intent, two links in one paragraph, authored descriptions, explicit appearances and redundant generated replacement text. Ambiguous overlap, absent/hidden anchors, QuadPoints, cross-node anchors, differing/ancestor/authored replacements and a Link containing unrelated text remain for review. A repeated annotation object is rejected before saving.

Seventeen saved-file/proof corruptions are rejected, including moved text, forged ranges, altered actions/destinations/rectangles, changed page rotation, missing OBJRs, wrong ParentTree types/keys, forged replacement exceptions and missing/duplicated evidence. All 20 saved fixtures pass **4,708 raw veraPDF checks** in total, including the review cases. That result illustrates why raw conformance alone cannot establish link quality.

Independent pypdf checks cover 22 fixture/real-document pairs: original text operand bytes and spacing adjustments, annotation actions/geometry/flags, existing descriptions, field values/properties and widget appearance bytes. **All 45 Poppler page pairs at 120 DPI are pixel-identical**, including fixture fields filled with `José café 987`, saved and reopened. PDFBox checks also compare fixture pages before and after editing; representative fixture and NASA pages were visually inspected. The existing metadata pass may add missing descriptions and font-map metadata; this batch does not claim every resource dictionary remains byte-identical.

The official [NASA Hinode PDF](https://science.nasa.gov/wp-content/uploads/2023/09/hinode-one-pager.pdf) is replayed from the previously downloaded, hash-verified source using batch 10's corrected reading-order intent. **All four links are bound**, all **1,043 saved checks** pass and all **5,246 raw veraPDF checks** pass. Page pixels are identical in Poppler and PDFBox. These figures supersede the preliminary replay with the older pilot intent, which is not the final artifact.

Replaying the historical pilot intents for NIST SP 1299 and SP 1300 stops at missing emitted table-header references. No candidate is saved for either. These table issues remain recorded for A41–A45; they are not counted as link successes or evidence of a new full-pipeline run.

TEST-FORM's preservation path retains **32 fields and 33 widgets**, passes **2,175 saved checks** and **9,874 raw veraPDF checks**, and matches both source pages exactly. Five source-bound edit samples pass fill/save/reopen qualification. The scripted year field and unsupported-character sample remain for review. The previous production booklet and TEST-FORM files retain their hashes; the booklet's six raw failures, 196 saved failures and 158 pending OCR segments are unchanged.

## Use and qualification boundary

Run native writing normally, then validate its saved result with the source and ownership sidecar:

```text
node scripts/check-saved-semantics.js --pdf candidate.pdf --tags tagging.json --source-pdf source.pdf --ownership candidate.pdf.ownership.json --output saved-checks.json
node --test --test-concurrency=1 modules/pdf-writer/test/native-links.test.js
```

Set `NATIVE_LINK_EVIDENCE_DIR` to an empty directory to retain the test artifacts. Exact source, candidate, report and log hashes are recorded in [the evidence report](evidence/accessibility-50-batch20-20261023.json).

A36 qualifies rectangular anchor ownership in these supported cases. Dedicated rotated/QuadPoints qualification (A37), grouping across semantic nodes or lines (A38), broader table repair and final eligibility integration (A50) remain pending. Review declarations must not be treated as fully tagged links merely because structural checks or veraPDF pass. Intent classification, descriptive link purpose, reading-order correctness and actual keyboard/screen-reader usability still require review. This is not a claim of fully accessible PDFs.
