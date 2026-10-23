# Accessibility improvements: PDF layers and artifact properties

A10 and A12 are implemented and verified on 2026-10-23, bringing the [50-item ledger](accessibility-50-improvements.md) to **11 complete / 39 open**. This batch started on 2026-10-22 from `d70c875`. [Evidence](evidence/accessibility-50-batch4-20261022.json) binds the candidate files, tests, audits and source changes.

## Implementation and specification basis

The native writer now retains source `/OC` marked-content scopes and resolves named properties in the current page or Form resources. Layer conditions remain independent of generated semantic MCIDs. Generated artifact wrappers close at source-scope boundaries, so neither crossing scopes nor stale source MCIDs change visibility or ownership. Nested layers, optional-content membership dictionaries and source markers spanning a page's physical content streams are supported. This resolves **A10**.

Source artifact dictionaries are copied onto content that remains unassigned by the intended semantic plan, preserving type, subtype, bounding box and attachment properties while removing obsolete MCIDs. Shared source dictionaries are not mutated. Explicitly assigned text is outside artifact wrappers, including meaningful body text with the same typography as a header and a Form invocation previously surrounded by a source artifact. A wholly decorative Form retains its artifact properties in the invoking coordinate space; its cloned content drops stale ownership without adding nested artifact wrappers. This resolves **A12**.

These decisions follow the distinction between optional-content visibility in [ISO 32000-2 clause 8.11](https://pdf-issues.pdfa.org/32000-2-2020/clause08.html#811-optional-content) and artifact/structure relationships in [clause 14](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html). Source property names, membership policies and optional-content configuration remain intact. [Adobe PDF Reference 4.10.2](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.6.pdf#page=362) requires named resources for optional-content properties because group identity depends on indirect objects. Inline OCG/OCMD dictionaries reject; an ordinary application tag named OC without a visibility dictionary remains an ordinary source scope. Malformed/unresolved properties, unbalanced/unclosed scopes and more than 256 nested source scopes also reject before saving. No dependencies or external CLI contracts changed.

## Verification

**269 production-baseline tests and 29 compatibility tests pass**, with zero failures or skips. The new seven-test marked-properties fixture is part of the final baseline, which was rerun after correcting the test-state setup and adding the named-resource qualification check.

The fixture exercises two layers, nested visibility conditions, an AllOn membership dictionary, page/Form property-name collisions, a marked-content pair crossing two physical page streams, stale source MCIDs, named header properties, inline footer/background/watermark properties, decorative and semantic Form invocations, and identical header/body typography. Independent traversal checks every painted item, disjoint semantic ownership and preserved property values. Raw veraPDF and saved-semantic comparison have zero failures. Source dictionaries retain their original MCIDs in unused resource properties, proving that copying the effective artifact dictionary did not mutate shared resources.

Both PDFBox and Poppler produce identical source/candidate pixels at 150 DPI in the default state and all four combinations of the two layer switches. The comparison checks that the four alternate states actually produce four distinct images. During qualification, Poppler exposed contradictory ON/OFF lists in the initial test harness after repeated PDFBox toggles on a reloaded file. The harness now explicitly replaces both lists with disjoint arrays before each state comparison; the focused tests and both renderer proofs pass. No product findings were suppressed. The all-on and all-off fixture renders were visually inspected.

## Real-document replay

The NASA booklet contains nine optional-content scopes on eight pages, all controlled by its `HeaderFooter` group. The preceding candidate had stripped all nine scopes: turning that layer off produced visible differences from the source on pages **11, 12, 14, 15, 16, 52 and 53**. The new candidate preserves all nine scopes and matches the source on **all eight affected pages** with the layer off, including page 42. This reveals a preservation defect that default-state rendering alone did not detect.

Five emitted pagination artifact scopes now retain exactly matching source Type/BBox/Attached values; the previous candidate retained none. Source artifact membership does not override an explicit intended semantic assignment. The fixture separately verifies Header/Footer/Watermark subtype preservation and meaningful text outside artifacts.

All **64 default-state pages** remain pixel-identical in Poppler, with the booklet at 96 DPI and Hinode/TEST-FORM at 150 DPI. The eight additional layer-off comparisons use 96 DPI. Booklet page 11 with the layer off was visually inspected. The form retains 32 fields, 33 widgets, its source-byte prefix and sampled text/checkbox fill-save-reopen behavior; PDF.js comparisons for Hinode, the form and its filled page remain identical.

| Candidate | Saved checks: passed / failed | Raw veraPDF failed checks | Disposition |
| --- | --- | --- | --- |
| NASA STEREO booklet | 14,727 / 155 | 31 | rejected |
| NASA Hinode | 531 / 0 | 0 | review_required |
| TEST-FORM control | 1,828 / 0 | 0 | review_required |

Independent pypdf audits still verify all 5,017 source text-operation identities, 4,158 painted MCRs with reciprocal ownership, and exact ownership of 175 fragments from 87 compound operations. All 53,667 text bytes and 615 TJ adjustments are unchanged. The ownership audit now distinguishes non-owning OC visibility scopes from semantic/artifact ownership and checks inherited artifact context in Forms; it still rejects overlapping semantic/artifact owners.

A11 remains open. Preserving authored ActualText and abbreviation expansion requires coordinated matching and structure-tree handling: merely nesting source replacement properties around generated wrappers can allow generated structure ActualText to override them. This batch does not claim that preservation, fix OCR attachment, or establish full semantic correctness or human usability.

Focused reproduction: `node --test --test-concurrency=2 modules/pdf-writer/test/native-marked-properties.test.js modules/pdf-writer/test/native-form-streams.test.js`. Logs use the `tmp/accessibility-50-batch4-` prefix. Ignored PDFs, layer-state variants, renders and audit scripts are under `output/accessibility-50-batch4-20261022/`; the evidence commit does not distribute local source PDFs.
