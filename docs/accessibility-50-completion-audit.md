# 50-improvement completion audit

All 50 planned engineering improvements are implemented and verified within the acceptance scope below. The current serial baseline passes 1155 tests; final affected and job-contract runs pass 38 and 6. Historical evidence retains all 392 inspected path/hash pairs. Test suites overlap. Current changes and limitations are detailed in [A50](accessibility-50-batch33-20261023.md); exact hashes are in the [machine-readable audit](evidence/accessibility-50-completion-audit.json).

This is not a claim that every input PDF is fully accessible. Known form placements, image ownership, font qualification, OCR, diagram and table issues remain in the documented corpus. Human review is always required. Counts of checks or completed engineering items do not measure general tagging accuracy.

| Item | Delivered improvement | Acceptance criterion and evidence |
| --- | --- | --- |
| A01 | Lexical operator indices | Mixed positioning/text fixture indices equal an independent PDFStreamParser token walk. [Evidence](evidence/accessibility-50-batch1-20261022.json) |
| A02 | Quoted text operators | Quote operators decode complete text once and subsequent native tags own the correct glyphs. [Evidence](evidence/accessibility-50-batch1-20261022.json) |
| A03 | Nested stream identity | Nested/reused Forms carry stable invocation identities; no child operator impersonates page text. [Evidence](evidence/accessibility-50-batch2-20261022.json) |
| A04 | Native Form XObject tagging | Saved text in two differently transformed invocations has correct owners and unchanged pixels. [Evidence](evidence/accessibility-50-batch2-20261022.json) |
| A05 | Stream-scoped MCR emission | Identical MCID numbers in different streams resolve to their own structure elements. [Evidence](evidence/accessibility-50-batch2-20261022.json) |
| A06 | Standalone list marker attachment | Separate marker/body operands yield nonempty saved Lbl and LBody without moving glyphs. [Evidence](evidence/accessibility-50-batch1-20261022.json) |
| A07 | Array-based list marker splitting | Mixed string/number TJ arrays preserve advances, bytes and distinct label/body ownership. [Evidence](evidence/accessibility-50-batch1-20261022.json) |
| A08 | Compound text-node attachment | Booklet label/value examples attach to exact intended nodes; spacing and geometry are unchanged. [Evidence](evidence/accessibility-50-batch3-20261022.json) |
| A09 | Glyph-to-byte mapping | Splitting never bisects a font code or Unicode mapping; ambiguous boundaries are rejected. [Evidence](evidence/accessibility-50-batch3-20261022.json) |
| A10 | Optional-content preservation | Default visibility and alternate layer states render identically; generated MCIDs remain balanced. [Evidence](evidence/accessibility-50-batch4-20261022.json) |
| A11 | Authored replacement text | Authored ligature and abbreviation replacement survives without duplicating or suppressing unrelated text. [Evidence](evidence/accessibility-50-batch5-20261023.json) |
| A12 | Artifact subtype preservation | Saved pagination/artifact metadata survives, while identically styled body text remains semantic. [Evidence](evidence/accessibility-50-batch4-20261022.json) |
| A13 | CropBox origin handling | Shifted-crop fixtures attach all intended text and retain page geometry and pixels. [Evidence](evidence/accessibility-50-batch6-20261023.json) |
| A14 | UserUnit handling | Scaled-unit fixtures preserve coordinates across text, annotations and matching without double scaling. [Evidence](evidence/accessibility-50-batch6-20261023.json) |
| A15 | Rotated-page reading order | Rotated multicolumn pages have expected saved order at 0/90/180/270 degrees. [Evidence](evidence/accessibility-50-batch6-20261023.json) |
| A16 | Label/value paragraph boundaries | Booklet launch details and acronym rows retain distinct identities and logical pair order. [Evidence](evidence/accessibility-50-batch7-20261023.json) |
| A17 | Running-text discrimination | Location-varying pagination is recognized; body repetitions and section titles are retained. [Evidence](evidence/accessibility-50-batch8-20261023.json) |
| A18 | Numbered heading false positives | Adversarial numeric examples keep their correct roles while evidenced numbered headings remain headings. [Evidence](evidence/accessibility-50-batch8-20261023.json) |
| A19 | Wrapped heading style boundaries | A heading wraps completely without swallowing a differently ranked subtitle or body line. [Evidence](evidence/accessibility-50-batch8-20261023.json) |
| A20 | Section hierarchy consistency | Saved nested sections agree with the approved outline after heading demotion and rank refinement. [Evidence](evidence/accessibility-50-batch8-20261023.json) |
| A21 | Existing MCID references | Deleting or changing a sequence makes saved comparison fail, even when its MCR dictionary remains. [Evidence](evidence/accessibility-50-batch9-20261023.json) |
| A22 | Nonempty content attachment | Empty and whitespace-only wrappers cannot satisfy intended nonempty text attachment. [Evidence](evidence/accessibility-50-batch9-20261023.json) |
| A23 | Exclusive painted ownership | Wrong-owner and multiply-owned glyph mutations fail despite unchanged structure IDs. [Evidence](evidence/accessibility-50-batch10-20261023.json) |
| A24 | Scoped reciprocal ParentTree | Cross-stream and annotation-key mutations fail; valid reused MCIDs in separate scopes pass. [Evidence](evidence/accessibility-50-batch9-20261023.json) |
| A25 | Text completeness proof | Partial substring matches cannot pass complete text; bounded replacement-text exceptions carry proof. [Evidence](evidence/accessibility-50-batch10-20261023.json) |
| A26 | OCR coordinate transforms | Known image text boxes land correctly on rotated/cropped pages at multiple render resolutions. [Evidence](evidence/accessibility-50-batch11-20261023.json) |
| A27 | Image-only tagged text layer | Official poster and synthetic scans expose saved text with complete ownership and unchanged images. [Evidence](evidence/accessibility-50-batch12-20261023.json) |
| A28 | Mixed-page OCR attachment | Booklet mixed page gains OCR attachments; overlapping native/OCR conflicts remain explicit review tasks. [Evidence](evidence/accessibility-50-batch12-20261023.json) |
| A29 | OCR Unicode font coverage | Accents, symbols and missing-glyph cases have correct extracted text or explicit failure, never replacement boxes. [Evidence](evidence/accessibility-50-batch13-20261023.json) |
| A30 | OCR uncertainty workflow | Low-confidence text cannot be silently accepted; hash-bound corrections change only intended text metadata/layer. [Evidence](evidence/accessibility-50-batch14-20261023.json) |
| A31 | Missing CIDToGIDMap repair | Booklet mapping failures reduce only with proven used-code/GID equivalence and pixel preservation. [Evidence](evidence/accessibility-50-batch15-20261023.json) |
| A32 | Symbol Unicode repair | Wingdings-like cases produce correct Unicode for observed glyphs; unsupported ambiguity stays unresolved. [Evidence](evidence/accessibility-50-batch16-20261023.json) |
| A33 | Exact font program recovery | Exact-donor fixtures embed correctly; similar-family substitutions and mismatched advances are refused. [Evidence](evidence/accessibility-50-batch17-20261023.json) |
| A34 | Invalid ToUnicode diagnostics and repair | Malformed maps are diagnosed per used code; verified replacements preserve glyph selection and extraction. [Evidence](evidence/accessibility-50-batch18-20261023.json) |
| A35 | Editable font coverage proof | Fill/save/reopen retains field values and appearance for verified repertoire; unsupported glyphs are reported. [Evidence](evidence/accessibility-50-batch19-20261023.json) |
| A36 | Native link ownership | New native output has reciprocal link ownership with unchanged action, rectangle and appearance. [Evidence](evidence/accessibility-50-batch20-20261023.json) |
| A37 | Rotated and quad-point links | QuadPoints/rotation fixtures bind the correct anchor and preserve actions; nearby text is excluded. [Evidence](evidence/accessibility-50-batch21-20261023.json) |
| A38 | Multiline link grouping | Wrapped anchors retain ordered text and one annotation reference without stealing neighboring runs. [Evidence](evidence/accessibility-50-batch22-20261023.json) |
| A39 | Reviewed outline bookmarks | Unicode titles, page targets and hierarchy round-trip correctly; existing authored bookmarks are preserved. [Evidence](evidence/accessibility-50-batch23-20261023.json) |
| A40 | Logical page-label verification | Mutated Roman/decimal labels or bookmark destinations fail preservation; unchanged labels pass. [Evidence](evidence/accessibility-50-batch23-20261023.json) |
| A41 | Overlapping span detection | Overlapping spans generate a bounded repair/review result; valid merged grids serialize unchanged. [Evidence](evidence/accessibility-50-batch24-20261023.json) |
| A42 | Mixed row and column headers | Reviewed mixed-header fixtures expose correct Headers relations with no unrelated header targets. [Evidence](evidence/accessibility-50-batch25-20261023.json) |
| A43 | Repeated cross-page headers | A continued table retains all page header occurrences and associates each body cell with the correct headers. [Evidence](evidence/accessibility-50-batch26-20261023.json) |
| A44 | Diagram versus table discrimination | Booklet diagrams and negative fixtures retain meaningful figure/text grouping; genuine aligned tables still work. [Evidence](evidence/accessibility-50-batch27-20261023.json) |
| A45 | Caption relationships | Caption association survives output and does not attach neighboring unrelated prose. [Evidence](accessibility-50-batch28-20261023.md) |
| A46 | Native widget structure ownership | Multiwidget fields have reciprocal OBJRs and unchanged names, values, actions and appearance streams. [Evidence](accessibility-50-batch29-20261023.md) |
| A47 | Reviewed accessible field names | Only reviewed missing TU names change; existing names and form behavior remain intact. [Evidence](accessibility-50-batch30-20261023.md) |
| A48 | Radio group and choice semantics | Radio groups expose reviewed names/choices and still select, save and reopen correctly. [Evidence](accessibility-50-batch31-20261023.md) |
| A49 | Widget navigation ordering | All eligible widgets occur once in expected order; hidden widgets and noninteractive labels are handled explicitly. [Evidence](accessibility-50-batch32-20261023.md) |
| A50 | Hash-bound completion gate | Stale, partial or failed evidence cannot publish a qualified result; complete machine evidence still requires human review. [Evidence](accessibility-50-batch33-20261023.md) |
