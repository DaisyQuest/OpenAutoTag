# A48: radio group and choice semantics

Completed 2026-10-23 from engine baseline 1035b13.

## Delivered behavior

The parser records the native field object, group name, widget index, radio appearance/export states, and choice export/display pairs. Selection inconsistencies, malformed groups and ambiguous duplicate exports remain explicit review findings. Field object identity prevents unrelated controls with the same name from merging.

Radio labels now use each widget's visible choice text while retaining the authored group name. An opt-in review binds the exact source PDF and semantic bytes, every widget in the selected group, complete visible labels and all authored choice options. Tag building rejects changed reviewed intent or missing structural anchors. Independent PDFBox inspection verifies the declared metadata against both source and saved objects. Native TU, Opt, V, DV, AS, flags, actions and appearance streams are preserved.

The [PDF Association guide, pages 50–53](https://pdfa.org/download-area/publications/Tagged-PDF-Best-Practice-Guide.pdf) describes Form/widget relationships and group context. [ISO 32000-1](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf), section 12.7, distinguishes radio export values from choice display/export pairs. [PDF 2.0 annotation errata](https://pdf-issues.pdfa.org/32000-2-2020/clause12.html) clarifies state and index interpretation. These inform implementation without establishing PDF/UA-2 support.

## Verification

The serial production baseline passes **1,070 tests**. The final affected run passes **85 tests**, including ten additional negative review-proof tests and the final label-normalization and interaction-helper changes. Suites overlap; these are not additive counts. The three new JavaScript helpers have 100% line, 94.74% branch and 98.39% function coverage. Java and repository-wide coverage were not measured.

The two-page fixture exposes three reviewed groups and four choice widgets, retains seven fields/nine widgets, and passes all saved checks plus **1,033 raw veraPDF checks**, with zero font errors. Eight radio, dropdown and multiselect operations survive save/reopen. Negative tests reject stale source/intent, incomplete groups, invalid states, altered options, missing proof, blank labels and changed saved native values. All six embedded contract copies match their canonical schemas.

TEST-FORM retains **32 fields/33 widgets**, all **173 authored options**, and passes **5,600 saved checks and 15,112 raw checks**, with zero font errors. A regression oracle accepts the existing County of label and its 63 options. Four dropdown selection/save/reopen probes pass. The Index #: label again matches the authored Index number tooltip through a narrowly scoped terminal-number-symbol normalization. The existing **eight unresolved placements remain**; neither the oracle nor the test counts establish human acceptance.

Independent pypdf inspection verifies field/widget properties, exports, selections, appearance streams, text operands and geometry. Widget font maps receive a separate audit: the existing font pass retains all glyph indices, replaces NUL/BOM mappings with U+FFFD and adds missing control-code mappings as U+FFFD; other widget resources match. The earlier TEST-FORM source needs pypdf's non-strict recovery for a pre-existing incremental cross-reference warning; candidates and all edited probes load strictly. All **28 Poppler page pairs at 120 DPI** match exactly, and representative edited fixture and real pages were visually inspected. PDFBox separately confirms tested edited-page equality.

The authoritative real replay starts from the qualified batch-23 control. Rebuilding the batch-29 candidate still declines an authored-text scope containing an OBJR; that existing guard remains intact. An official [OPM SF181](https://www.opm.gov/forms/pdf_fill/sf181.pdf) intake was also inspected; it contains checkboxes, so it supplies no radio/choice coverage claim.

## Use and limits

~~~text
node modules/semantic-engine/choice-review.js --pdf source.pdf --semantic intent.json --review accepted-choices.json --output reviewed-intent.json
~~~

Use contracts/form-choice-review.schema.json. Reviews change logical label associations, preserving native names and export values. Review after merging and ordering semantic content, then use the exact reviewed intent for tag building. Output is exclusive; stale inputs reject. Supplied reviewer attribution is not authenticated identity. Unsupported state encodings and malformed or inconsistent options require review. Actual screen-reader announcement, keyboard navigation and final human acceptance remain separate qualifications.

Evidence: [machine-readable record](evidence/accessibility-50-batch31-20261023.json). **A01–A48 complete; A49–A50 remain.**
