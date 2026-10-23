# Exact font program recovery - 2026-10-23

This delivery completes A33: explicit, source-bound recovery of missing programs for qualifying simple TrueType fonts. Six positive fixtures now embed the exact donor while retaining their glyphs, text, page appearance and editable controls. **33 of 50 improvements are complete; 17 remain pending.**

## Qualification

The new optional `--donors <manifest.json>` argument accepts `contracts/font-donors.schema.json`: the source SHA-256, each target font's indirect reference, a program path and its SHA-256. Relative program paths resolve beside the manifest. The manifest is limited to 256 KiB and 32 targets; programs are limited to 64 MiB each and 128 MiB combined. Duplicate targets, stale hashes and unreachable references reject before saving. Input hashes are checked again after execution, and the repair report records the exact manifest hash.

For each requested font, the donor must have the same PostScript identity and exactly the same bytes as the full program PDFBox currently resolves for that source. Every observed code must retain its glyph ID, Unicode, advance, displacement, outline and effective glyph scaling. Complete usage scanning includes nested Forms, patterns, clipping text and annotation appearances. Existing programs and editable default resources remain unchanged. A shared descriptor is isolated so an unrequested font cannot inherit the new program.

The full donor program is embedded without subsetting or editing its permissions. Supported donors declare installable or editable outline embedding in OS/2; restricted, preview-only, bitmap-only, variable and unsupported programs remain for review. These checks use the [OpenType OS/2 specification](https://learn.microsoft.com/en-us/typography/opentype/spec/os2). No new dependency, host-font harvesting or proprietary font distribution was added.

This proves equality to the program used by the tested PDFBox environment, **not the historical author's missing font version or every reader's substitution**. Font names alone never qualify recovery. The rule does not generalize to arbitrary Type0, Type1, symbolic or editable-default fonts.

## Why the booklet stays unchanged

The six remaining NASA STEREO booklet fonts resolve to available matching programs, but their PDF widths are rounded differently from those programs. [PDFBox 3.0.8 PageDrawer](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/rendering/PageDrawer.java) scales nonembedded glyphs to explicit PDF widths; embedding can remove that scaling even when program bytes match. The new check detects this before saving. For example, Verdana-Bold code 38 has PDF width 862 versus program width 862.3047.

All six requests therefore remain for review. The saved booklet is **byte-identical** to the batch 16 candidate, so its existing hash-bound validation/render evidence still applies: six raw font-embedding failures, 196 saved semantic failures and 158 pending OCR segments. Those checks were reused, not rerun or newly resolved. TEST-FORM also retains its previous exact candidate hash and evidence.

## Verification

- All **500 production baseline tests pass**, with zero failures, cancellations or skips. A final rerun of the 31 donor tests also passes; these overlap the baseline.
- Six positive cases cover ordinary page text, shared descriptors, nested Forms, patterns, appearances and clipping. Negative cases cover changed programs, different families, permissions, malformed data, missing glyphs, width/scaling mismatches, incomplete usage, editable defaults, existing entries and stale evidence.
- Independent pypdf comparison preserves the source prefix and all 12 original streams' encoded/decoded bytes. Only the requested FontFile2 additions and the qualified shared-descriptor isolation differ; existing object references, values and aliasing are checked.
- All six Poppler page pairs at 150 DPI and seven PDFBox page pairs match, including fill/save/reopen with `José café 987`. The rendered positive page was visually inspected.
- The separate validator font audit confirms that the positive fixture's target changes from unembedded to embedded and removes its `FONT_NOT_EMBEDDED` finding. Other findings persist; this is not a claim of full fixture conformance.
- Saved-program tampering fails independent source replay. Preservation qualification requires the same donor manifest through `--font-donors`; omitting it cannot waive font-resource changes. Report output cannot overwrite donor inputs.

Reproduce the focused suite with `node --test --test-concurrency=1 modules/pdf-writer/test/font-donor-repair.test.js`. To retain fixtures, set `FONT_DONOR_EVIDENCE_DIR` to a new output directory. Existing CLI calls without donors retain their behavior. Repair with `node modules/pdf-writer/font-repair.js --pdf source.pdf --output candidate.pdf --donors font-donors.json`; verify with `--verify candidate.pdf` instead of `--output`. The output must not already exist.

Exact hashes, artifact paths and the six declined booklet reasons are in [the evidence report](evidence/accessibility-50-batch17-20261023.json). Human review and broader reader qualification remain required. A34 invalid-ToUnicode diagnostics and repair is next.
