# Verified symbol Unicode — 2026-10-23

This delivery completes A32. The qualified font repair pass can recover missing Unicode mappings from verified embedded glyph evidence. Fresh tagging of the NASA STEREO booklet now decodes all 79 affected bullets as U+2756 (❖), including their saved replacement text. **32 of 50 improvements are complete; 18 remain pending.**

## Why the earlier output failed

The source uses character code 153 to select a Wingdings glyph. That code is a glyph selector, not Unicode U+0099. Its subset program has no usable character map. The earlier tagged PDF consequently had 79 misdecoded replacement-text entries as well as 19 raw Unicode failures. Adding a font map after tagging would leave that replacement text wrong.

The embedded outline and advance exactly match the full Wingdings program's symbol index 118. [Unicode WG2 N4363](https://www.unicode.org/wg2/docs/n4363.pdf), Annex A, maps that index to U+2756. The retained audit records the program and outline hashes, units, advance and corroborating platform mappings. The runtime uses an audited geometric fingerprint; it does not inspect installed fonts, rely on a font name, or redistribute a Microsoft font. Renumbered glyphs and renamed fonts are covered by tests.

## Qualification and workflow

The existing opt-in font CLI adds a missing ToUnicode only for supported symbolic TrueType Type0 fonts with Identity-H/V and an explicit Identity CIDToGIDMap. Each observed glyph must resolve either to one unambiguous scalar in the embedded Unicode cmaps, or to the audited fingerprint. A PDF code is never interpreted directly as Unicode. Conflicting aliases, private-use/control mappings, unknown shapes, incomplete resource usage, damaged tables and mixed known/unknown usage remain unchanged for review. [Microsoft's cmap specification](https://learn.microsoft.com/en-us/typography/opentype/spec/cmap) distinguishes Unicode and symbol platform mappings; symbol indices alone do not prove Unicode identity.

Existing ToUnicode entries are retained, even if empty or malformed. Editable defaults and documents containing authored ActualText do not qualify for this rule. This prevents silent replacement-text conflicts; it is deliberately conservative even when unrelated replacement text might be harmless. Existing Alt descriptions are preserved and still require semantic review.

Run the repair **before parsing and tagging**. Feed its saved output to the normal pipeline so new intent and ActualText use the corrected Unicode. The booklet was reparsed and retagged from that source; previously cached OCR was reused with its original hash, leaving all 158 OCR reviews pending. No tag text was patched by an unbounded search-and-replace.

The pass preserves programs, glyph selection, widths, displacements, vertical origins and outlines. It emits an incremental PDF and verifies the full saved object graph against a fresh source replay. Existing CLI/report contracts are unchanged; no dependencies were added.

## Verification

| Booklet check | Previous candidate | New candidate |
| --- | --- | --- |
| Raw veraPDF UA1 failures | 25 | 6 |
| Unicode failures | 19 | 0 |
| Font embedding failures | 6 | 6 |
| Saved semantic failures | 248 | 196 |
| Misdecoded bullet ActualText entries | 79 | 0 |
| Pending OCR segments | 158 | 158 |

All **469 production baseline tests pass**, with no failures, cancellations or skips. The 29 new cases cover valid and conflicting Unicode evidence, supplementary characters, exact shape/metric boundaries, authored maps/replacement text, unsupported resources, field preservation, repeat no-ops and saved-map corruption. No Java or repository coverage percentage is claimed.

Independent pypdf comparison permits exactly seven source changes: six previously qualified Identity entries and the new one-code ToUnicode map. All 300 original streams retain their encoded and decoded bytes, object identities and aliasing; the original file remains the saved prefix. A separate text comparison verifies all 963 ActualText entries and all page extraction: exactly 79 bullets change, with all other text unchanged.

All **66 Poppler page pairs** and **67 PDFBox page pairs** match. These include all 61 booklet pages, five positive fixtures and PDFBox fill/save/reopen of an accented field value. Source image bytes remain identical; booklet page 7 was visually inspected. TEST-FORM retains its prior candidate hash and evidence; it was not newly edited in this batch.

The new candidate remains for review because of six embedding failures, 196 semantic failures, unresolved OCR transcription and human reader checks. These results do not establish general symbol coverage or fully accessible PDFs. Exact hashes and artifact paths are in [the evidence report](evidence/accessibility-50-batch16-20261023.json).
