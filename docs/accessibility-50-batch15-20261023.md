# Verified missing CID mappings — 2026-10-23

This delivery completes A31. The qualified font repair CLI now makes an implicit identity mapping explicit for supported embedded TrueType CID fonts after verifying their used glyphs. NASA's booklet loses all six missing-map failures: **raw failures decrease from 31 to 25**. **31 of 50 improvements are complete; 19 remain pending.**

## Qualification boundary

The repair requires one existing FontFile2 program, supported TrueType glyph/metric tables, bounded valid glyph offsets and unitsPerEm, a known Type0 parent, and complete supported usage evidence. It parses the embedded program independently, then compares each used code's CID, GID, advance, displacement, vertical origin where applicable, decoded Unicode and glyph outline before/after the proposed Identity entry. Glyph zero and out-of-range mappings do not qualify. Existing mappings are preserved, including malformed entries left for separate review; unembedded fonts cannot acquire a guessed map.

Usage includes page text, nested and inherited-resource Forms, transparency groups, tiling patterns and inactive annotation appearances. Unresolved resources, unvisited inherited contexts, recursion and unsupported Type3 execution remain review cases. Operator and glyph scans are bounded. Every parent of a shared descendant is checked. The audit records original program hashes and digests of observed code/CID/GID/advance/Unicode/outline evidence.

Adversarial testing exposed a PDFBox constructor side effect: reading XObjects can populate Type/Subtype entries. The scanner now restores those exact authored entries for all reachable streams before repair. Tests cover patterns, missing Form Type entries, inactive appearances and no-op rejection cases. Independent object comparison rejected the preliminary candidate with those extra changes and accepts only the final candidate.

The existing interface remains opt-in:

```powershell
node modules/pdf-writer/font-repair.js --pdf preserved.pdf --output candidate.pdf
node modules/pdf-writer/font-repair.js --pdf preserved.pdf --verify candidate.pdf
```

Output preserves the complete source byte prefix. A fresh source replay verifies the entire saved catalog and information graph. It rejects unrelated changes to mappings, content, fields, appearances, programs, Unicode or structure. No font program, text operand, width array, CMap or ToUnicode value is substituted by this new rule. Other pre-existing qualified rules retain their separate checks. No dependencies were added.

## Results

The six repaired programs are Century Gothic, Century Gothic Bold, Symbol MT, Wingdings, Verdana and Arial Unicode MS. All were already embedded; they are separate from the six remaining embedding failures. Across these fonts, 69 used codes, counted separately for each font and parent retain the same glyph evidence.

| Booklet check | Before | After |
| --- | --- | --- |
| Raw veraPDF failed checks | 31 | 25 |
| Missing CIDToGIDMap failures | 6 | 0 |
| Unicode failures | 19 | 19 |
| Embedding failures | 6 | 6 |
| Saved semantic failures | 248 | 248 |
| Pending OCR transcription segments | 158 | 158 |

The final saved report has 51,144 passes and 248 failures, with source glyph ownership verified. Raw veraPDF has 192,144 passes and 25 failures. The preservation gate verifies font changes, source identity, page content, fields/widgets, heading content, links and observed structure; its disposition remains review_required because validation findings remain.

All **440 production baseline tests pass**, with no failures, cancellations or skips. Twenty-five new cases cover valid horizontal/vertical/custom CMaps, shared descendants, nested/inherited resources, patterns, inactive appearances, malformed programs/locations/units, unresolved fonts, recursion, idempotence and saved-map mutation. The earlier 50-test focused suite also passes and overlaps the baseline; the final baseline adds the unitsPerEm case. No Java or repository-wide coverage percentage is claimed.

An independent pypdf graph comparison visits 12,637 object pairs and permits exactly six added Identity entries. All **346 encoded and decoded streams are byte-identical**, and aliases/identities are preserved. All **69 Poppler page pairs** match: 61 booklet pages and eight fixtures. PDFBox also verifies 70 page pairs, including all booklet pages and fixture field fill/save/reopen with accented input. The field's original value and appearance remain unchanged before editing. [Evidence and hashes](evidence/accessibility-50-batch15-20261023.json) identify the exact final candidate and reports; artifacts are under `output/accessibility-50-batch15-20261023/`.

[ISO 32000-1 Table 117 and section 9.7.4.2](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf) describe the Identity default and the explicit mapping requirement for embedded TrueType programs. The implementation also checks [PDFBox's actual CID/GID selection](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/font/PDCIDFontType2.java) and accounts for [XObject constructor mutations](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/graphics/PDXObject.java). These sources explain the repair boundary; saved evidence establishes the measured result. Unicode semantics, missing font recovery, broad future form input and human reader qualification remain separate work.
