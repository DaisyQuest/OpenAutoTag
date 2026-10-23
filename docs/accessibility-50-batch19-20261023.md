# A35: sampled editable font qualification

The writer now offers an opt-in proof for proposed text in existing fields. It accepts a source-hash-bound sample manifest and creates separate QA PDFs. It never changes the source or substitutes fonts. This extends the earlier default-font repairs: a font used successfully by the current value is no longer treated as evidence that different input will work.

## Why this needs an actual edit test

[PDFBox's text-field setter](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/interactive/form/PDTextField.java) stores the value before generating its appearance. Consequently, a value can exist without a correct appearance. The [appearance generator](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/interactive/form/AppearanceGeneratorHelper.java) also resolves widget defaults, handles automatic sizing and clips text. These are implementation facts, not proof that a particular form supports new text.

For each requested Unicode scalar, qualification checks the effective embedded TrueType font's encoder, glyph ID, Unicode round trip, independent embedded Unicode cmap and advance. Supported fonts include simple TrueType and horizontal Type0/CIDFontType2 fonts. The generated `/Tx` appearance must paint exactly the requested text with the same font program, glyphs and advances; non-space glyphs need outlines, nondegenerate transforms and containment within the appearance clipping path. The test then saves and reopens the copy, checks values, widget geometry/flags, other field values/appearances and target appearance bytes, and compares affected pages rendered by PDFBox at 72 DPI.

Rendering itself can synthesize missing annotation appearances in memory. QA copies are saved before rendering, so these unrelated renderer changes are not written into them. A regression fixture and independent TEST-FORM object checks cover this behavior. JSON is emitted explicitly as UTF-8 to preserve characters outside the Windows console code page.

Unsupported characters are identified by code point. Missing or ambiguous resources, conflicting glyph evidence, subsets without sufficient evidence, clipping, hidden controls, field/widget actions, calculation order, XFA, signatures, encryption, read-only/password/rich-text/file-select behavior and non-text controls require review. Printable single-line sample strings can exercise multiline and comb fields; line breaks, control and formatting characters require separate layout review. MaxLen is checked conservatively using UTF-16 length. Document-level scripting and reader behavior are outside this font proof.

## Verification

The serial production baseline passed **616 cases**; the final affected run passed **56 cases**, including the renderer-side-effect guard and two additional signed/encrypted cases. The configured baseline is now 618 cases, covered across these overlapping runs. No single final 618-case run or repository/Java coverage percentage is claimed. Positive fixtures cover non-ASCII text beyond WinAnsi, simple fonts, inherited defaults, multiple widgets, multiline/comb fields with single-line samples and automatic sizing. Negative cases cover unsupported code points, wrong glyph/Unicode maps, clipping, ambiguous resources, actions, document restrictions, stale requests, invalid Unicode, duplicate samples and cyclic field trees.

Independent pypdf inspection verifies **19 positive samples**, with unrelated values, appearances, geometry, flags, annotation actions and page contents retained. All **26 Poppler page pairs at 120 DPI** match after independent save/reopen. All 26 also match the source outside the edited widget rectangles, with a two-pixel mask margin for antialiasing. Representative Unicode and real-form pages were visually inspected.

TEST-FORM retains **32 fields and 33 widgets**. Five sample values pass, including accented/euro text and the two-widget index field. The year field remains for behavior review because it has actions; a separate unsupported-character request remains unresolved. Original TEST-FORM and production booklet bytes retain their previous hashes. This batch does not change the booklet's six raw failures, 196 saved semantic failures or 158 pending OCR segments. The extra legacy table header-ID assertion remains recorded for the pending table work.

## Use

Create a manifest satisfying `contracts/editable-font-samples.schema.json`:

```json
{
  "schemaVersion": "1.0.0",
  "sourceHash": "<exact lowercase SHA-256 of the candidate PDF>",
  "samples": [{ "fieldRef": "98 0 R", "value": "José café € 123" }]
}
```

The field reference identifies the field object in that exact PDF, not a name search. Run:

```text
node modules/pdf-writer/editable-font-proof.js --pdf candidate.pdf --samples samples.json --output-dir fresh-probe-directory
```

The public JS entry point is `qualifyEditableFonts({sourcePdf, samplesPath, outputDir})`. The output directory must not exist; its parent must exist. The CLI prints `editable-font-proof.schema.json` JSON and saves `proof.json` alongside successful `sample-N.pdf` copies. Exit zero means every requested sample was verified; exit one with a report means at least one sample requires review. Input/runtime errors use stderr and a nonzero exit. Mixed requests retain successful evidence and identify the unresolved sample. Do not distribute QA copies as the remediated document: they deliberately contain the supplied test values.

Limits are 16 samples, 256 Unicode scalars per value, 8 KiB combined UTF-8 text, a 64 MiB source, 64 KiB manifest and 128 MiB projected source copies. A field may have at most eight widgets. Raw field traversal, parent depth, default-appearance parsing, decoded streams, nested appearances, operators, glyphs, page count, rendering pixels, process memory and elapsed time are bounded. These limits cause an error or explicit review result; they do not silently truncate evidence.

## Qualification boundary

`verified` applies to the exact sample and PDFBox 3.0.8, with source, request, font-program and QA-copy hashes. It does not establish support for arbitrary lengths, all characters in a font, all readers, contrast, overlays, complex shaping, scripts, assistive-technology usability or full PDF accessibility. It is a separate opt-in qualification tool; it does not automatically waive the production quality gate or any raw conformance failure. Human semantic and reader review remains required.

Run `node --test --test-concurrency=1 modules/pdf-writer/test/editable-font-proof.test.js`. Set `EDITABLE_FONT_EVIDENCE_DIR` to a fresh directory to retain generated fixtures, QA copies and reports. The focused suite is included in both production-baseline and production-fonts commands. No dependencies were added. Final run counts, exact artifacts, independent preservation checks and real-form outcomes are recorded in [the evidence report](evidence/accessibility-50-batch19-20261023.json).
