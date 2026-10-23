# Verified OCR font fallback - 2026-10-23

This delivery completes A29: generated OCR can use more than one embedded font within a single tagged line. Noto Sans remains first choice; the already bundled Noto Sans Symbols and Noto Sans Symbols 2 supply supported arrows, checkboxes and stars. No dependencies or downloaded fonts were added. Native source fonts and editable form fonts retain their existing path. **29 of 50 improvements are complete; 21 remain pending.**

## Implementation and verification

Coverage is cached per code point. Adjacent characters using the same font share a text run; all runs in a line retain one MCID, one tag owner and a continuous text matrix. The sum of their font advances fits the declared line envelope. Unsupported characters fail before saving, rather than becoming replacement boxes. Typed font encoding continues to avoid GSUB substitutions in invisible text.

Saved inspection independently verifies embedding and glyph availability for each run, in addition to exact decoded Unicode, invisible rendering and geometry. Multiple runs combine only when they are contiguous and belong exclusively to the same marked-content sequence, declared exactly once. A visible, unembedded or missing-glyph run cannot be hidden by adjacent valid text. A corrupted CIDToGIDMap pointing to missing glyphs and a removed fallback font program both fail saved qualification.

The deterministic fixture declares `office first Effects Café € Ω – → ☐ ★`, then verifies the exact saved text, three embedded font programs, one tag owner and unchanged page rendering. An unsupported supplementary character still rejects before a candidate exists. This exercises font emission, not OCR recognition accuracy. Existing rotation, crop, scale, native-text, field editing and mutation cases remain covered.

| Saved candidate | Saved semantic checks | Raw veraPDF UA1 |
| --- | --- | --- |
| NASA STEREO lithograph | 1,407 pass, 0 fail | 5,460 pass, 0 fail |
| NASA STEREO booklet | 50,986 pass, 248 fail | 192,138 pass, 31 fail |
| Mixed-font Unicode fixture | 430 pass, 0 fail | 1,417 pass, 0 fail |

The two official candidates reuse the exact tagging intent from batch 12. Their 223 OCR segments pass the additional font-program checks; the booklet's existing 248 semantic and 31 raw failures remain unchanged. All 63 official pages and 16 Unicode-fixture pages are pixel-identical in Poppler, and original image streams match. The synthetic mixed-page field also retains its value, appearance and fill/save/reopen behavior.

All **400 production baseline tests pass**, with zero failures, cancellations or skips. The 24 focused cases also pass and overlap the baseline. Three new cases and strengthened existing Unicode checks cover this delivery. Font hashes, candidate hashes and report hashes are recorded in [the evidence](evidence/accessibility-50-batch13-20261023.json). No repository-wide coverage claim is made. Local artifacts are under `output/accessibility-50-batch13-20261023/`; raw PDFs and logs are not committed.

## Boundaries

This is bounded coverage from three bundled font programs. Unsupported scripts, emoji and mathematical symbols may still require another verified font; they fail explicitly. Glyph presence and correct Unicode do not prove arbitrary font-outline equivalence or complex shaping. The NASA poster still has substantial recognition noise, and the booklet still needs diagram and reading-order review. Word-level uncertainty and hash-bound transcription corrections remain A30; no new human reader qualification is claimed.

The implementation uses PDFBox's [Type 0 font API](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/font/PDType0Font.java) and [content-stream font/subset handling](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/PDAbstractContentStream.java). These implementation sources support the encoding approach, not a general accessibility certification.
