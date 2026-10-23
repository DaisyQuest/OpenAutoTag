# Invalid Unicode diagnostics and repair - 2026-10-23

This delivery completes A34. The engine now distinguishes absent, malformed, incomplete and contradictory ToUnicode mappings by observed character code, and repairs supported missing or invalid mappings using independent embedded glyph evidence. **34 of 50 improvements are complete; 16 remain pending.**

## What changed

The optional `--repair-unicode true` font-repair pass reads the actual ToUnicode definitions. It does not treat PDFBox fallback extraction as proof that a direct mapping exists. Its typed report records source state, used codes, effective authored values, independently established values where available, reasons and applied repairs.

The parser supports bfchar, scalar/array bfrange, valid UTF-16BE sequences and one-byte simple-font or two-byte Identity encodings. It rejects malformed counts, range overflow, inconsistent codespaces and unsupported inherited/custom operations within explicit resource limits. Later code definitions supersede earlier ones, while codespaces are checked byte by byte. These distinctions follow [ISO 32000-1, sections 9.10.2-9.10.3](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf) and [Adobe CMap specification #5014](https://adobe-type-tools.github.io/font-tech-notes/pdfs/5014.CIDFont_Spec.pdf). Overlapping mappings in the current booklet are valid overrides, not contradictions.

A replacement requires an undamaged embedded TrueType program and unambiguous glyph-to-Unicode evidence from its Unicode cmaps or the previously audited symbol fingerprint. Every observed glyph must keep its glyph ID, outline, width, displacement and vertical origin. Valid authored entries are retained, including unused multi-character and supplementary sequences. A valid effective mapping that conflicts with glyph evidence remains for review; ligature expansions and other author intent must not be guessed away.

Editable defaults, authored ActualText, incomplete usage, unknown/ambiguous glyph evidence and invalid unused mappings prevent automatic replacement. Unsupported fonts/maps remain unchanged. Apply the repair before parsing/tagging so new intent and replacement text use the corrected extraction. This supports useful bounded repairs, not arbitrary Unicode reconstruction or general CMap execution.

The independent font audit now exposes direct coverage, missing codes and qualified standard-encoding fallback codes separately. An explicit map is not mandatory in every font situation: supported simple-font fallbacks are reported as warnings rather than false mapping failures. Missing mappings without a qualified fallback remain errors even at 99.5% direct coverage. Empty/unreadable maps have a separate malformed finding. The audit's `parsed` status does not establish strict syntax, glyph identity or semantic correctness; the repair qualification and raw validator remain separate checks.

## Verification

The configured production baseline now contains **562 cases**. The full serial run passed all 557 cases then present; five additional boundary/fallback cases and the final parser/audit changes passed in a **74-case affected rerun**. These counts overlap. The new feature suite contains 57 tests/subtests, and five existing font-audit cases were added to the baseline. No Java or repository coverage percentage is claimed.

Fifteen positive fixtures cover partial maps, invalid surrogates, odd-length and empty values, null/empty/absent maps, simple fonts, vertical text, array ranges, later invalid overrides, shared maps, nested Forms, patterns and appearances. Tests also retain valid overrides and sequences, reject ambiguous or unsupported syntax, bound parser work, distinguish standard fallback, reject saved-map tampering and require the opt-in flag during preservation replay. An accented field value survives fill/save/reopen. The preservation-gate test's artificial validation input is explicitly not a conformance result.

A controlled copy of the official NASA STEREO source, after the previously verified A32 repair, was deliberately corrupted by replacing U+2756 with an unpaired surrogate. A34 repairs exactly that font map. Independent extraction restores **all 79 bullets**, with every page's complete text equal to the uncorrupted qualified source. This is a documented fault-injection experiment, not a claim that the official source naturally contained this defect.

Across the 15 positive fixtures and that 61-page booklet copy, independent pypdf comparison verifies the source prefix, all other reachable objects/references and **381 original streams with identical encoded and decoded bytes**. All **76 Poppler page pairs** and **77 PDFBox page pairs** match; the latter include field fill/save/reopen. Positive page rendering was visually inspected. Poppler uses 150 DPI for fixtures and 96 DPI for the booklet; PDFBox uses 120 DPI.

The existing production booklet remains byte-identical at its batch 16 hash, and all 15 inspected maps have valid supported syntax. Its six raw embedding failures, 196 saved semantic failures and 158 pending OCR segments remain; previous raw/render/saved evidence is reused by exact hash. A fresh font audit still reports six errors and one warning. TEST-FORM also retains its previous exact candidate and preservation evidence.

An additional legacy check, `test/integration/rich-pdfua-compliance.test.js`, fails at line 205 because it expects `H_r0c0` instead of the existing table-scoped header ID. That assertion and the tag-builder code are unchanged from the preceding commit, and the failure occurs before either modified font stage executes. It is outside the required baseline and is recorded for the remaining table qualification work; this delivery does not claim every repository test passes.

## Use and evidence

Run `node modules/pdf-writer/font-repair.js --pdf source.pdf --output candidate.pdf --repair-unicode true`. Verification uses `--verify candidate.pdf` in place of `--output`. The output must not already exist. `scripts/check-pdf-preservation.js` forwards `--repair-unicode true` together with `--font-repairs true`; omitting the repair flag cannot waive changed font resources. Calls without it retain their existing-map behavior.

Run the focused tests with `node --test --test-concurrency=1 modules/pdf-writer/test/invalid-unicode-repair.test.js`. Set `INVALID_UNICODE_EVIDENCE_DIR` to a new directory to retain generated PDFs and reports. There are no new dependencies. Exact hashes and limits are recorded in [the evidence report](evidence/accessibility-50-batch18-20261023.json), the public report schema and `SPEC.txt`. Human semantic and reader review remains required. A35 editable font coverage is next.
