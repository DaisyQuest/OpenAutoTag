# A50: hash-bound candidate completion

Completed 2026-10-23 from engine baseline 9d205db. This closes the 50 planned engineering improvements; it does not certify fully accessible PDFs or erase known corpus failures.

## Delivered behavior

Production checking now requires a candidate-completion report in addition to preservation and raw validation. The checker freshly inspects both PDFs, regenerates the complete saved-semantics comparison, independently reruns veraPDF and the font audit, recomputes preservation checks, and counts source text/image ownership. A shortened saved report or raw report cannot pass by adjusting its summary. Native ownership, reviewed OCR status, widget navigation and inspection integrity must agree. Unassigned meaningful source content cannot qualify merely because the writer wrapped it as a new Artifact.

Native rebuilds additionally require independent protected-object and rendering evidence. The checker compares field inventories, values, defaults, actions, appearances, complete AcroForm resources, navigation, page geometry, annotations and exact current VIEW/PRINT pixels at 120 DPI. Supported embedded TrueType fonts compare all character-to-glyph mappings while permitting bounded invalid Unicode-map cleanup; programs, widths and other protected data remain exact. Other font resources retain exact comparison. This does not authorize unrelated resource changes.

The completion report binds source, candidate, tagging intent, source ownership, writer manifest, saved comparison, preservation report and validation report to exact bytes. Download policy checks the required inventory against this job's paths and hashes, including the bytes actually served. Missing, stale, failed or partial evidence blocks retrieval. Explicit candidate=1 remains necessary. A failed/retried production stage invalidates old completion evidence; unfinished or failed jobs cannot release candidates. Original input retrieval remains available.

Successful output is always review_required with humanReviewRequired=true. It never becomes accepted automatically. This follows the distinction between machine-verifiable PDF/UA checks and human checkpoints described by [veraPDF](https://docs.verapdf.org/validation/) and structure/navigation requirements in [ISO 32000-1](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf).

## Verification

The serial production baseline passes **1155 tests**, the final affected suite passes **38**, and job-contract tests pass **6**, all with zero failures, skips or cancellations. Suites overlap. The baseline began before final retry invalidation and artifact-schema additions; the final affected/job-contract runs cover those changes. Two validator helpers plus download policy have **100% line, 97.01% branch and 95% function coverage**. Java and repository coverage were not measured.

Complete native and preserved pipelines both release review candidates. An intentional omission leaves both paragraphs visibly intact but drops 35 meaningful source glyphs from semantic ownership; raw validation and pixels still pass, while completion rejects. Truncated raw/saved reports, stale supporting files, malformed completion records, wrong job paths and failed retries reject. Native preservation tests catch changed values/defaults/actions/export options, Unicode and CID maps, paint and geometry. Several inactive-property corruptions keep identical pixels and still reject. Optional-content/XFA/oversized rendering cases remain incomplete.

Independent pypdf extraction and **three Poppler page pairs** confirm unchanged visible text and pixels for the native, preserved and omitted-content examples; the final native page was visually inspected. The two-page form fixture additionally passes all ten completion checks and **103 preservation checks**, with **239/239 source glyphs**, 12 fields/14 widgets, 11 eligible controls and three explicit exclusions. Its existing raw result is replayed successfully: **1,522 checks**, zero font errors. No fixture or real input PDFs were modified by checking.

TEST-FORM remains **unqualified**, despite its unchanged **15,112 raw passes** and 5,676 saved passes. Five widget placements remain unresolved. Coverage finds 3,935 source glyphs: 3,575 tagged, 311 authored artifacts and 49 unassigned whitespace glyphs, with no omitted meaningful text; **four source images lack ownership**. The protected form-resource difference is the existing Type1 ToUnicode change in AcroForm/DR/Font/ZaDb. Restoring only that map on a disposable diagnostic copy makes native preservation verified. The strict production comparison remains; the delivered candidate was not altered. All four current screen/print page comparisons match, and 32 fields/33 widgets/173 options remain present.

The final historical audit confirms **392 recorded file/hash pairs** across A01–A49 with no missing or changed evidence. The [requirement-by-requirement audit](accessibility-50-completion-audit.md) records all 50 deliveries and their acceptance evidence.

## Scope and operation

Production checks remain opt-in. Existing advisory CLI reports keep their contracts; gated retrieval now needs fresh completion evidence. Preserved mode requires unchanged reference structure/content and the source byte prefix. Other reviewed transformations need their existing specialized qualification and are not automatically waived here. Native checks decline unsupported dynamic states, signed/encrypted documents, XFA or resource/render limits. Limits include 500 pages, 16 million pixels per page, 200 million aggregate source/candidate page pixels before the two rendering destinations, bounded graph/stream/font traversal and a two-minute native helper timeout. Validation replay has a five-minute bound.

Coverage describes inspected source occurrences. It cannot determine whether a vector diagram is meaningful, whether an authored Artifact is correct, or whether OCR/images and descriptions convey the intended meaning. Human semantic, visual, keyboard and assistive-technology review remains mandatory. Existing NASA/NIST and TEST-FORM limitations remain documented; no general accuracy percentage or full-accessibility claim is made.

Run the new CLI with --source-pdf, --candidate-pdf, --quality-report, --validation-report, --saved-semantics and --manifest. Native mode additionally requires --tags and --ownership. --output optionally saves the report. Both modes report unqualified evidence without treating it as a successful candidate. Reproduce regression coverage with npm run test:production-baseline; retain the focused pipeline fixture using COMPLETION_EVIDENCE_DIR.

Evidence: [machine-readable record](evidence/accessibility-50-batch33-20261023.json). **A01–A50 complete within their documented scope.**
