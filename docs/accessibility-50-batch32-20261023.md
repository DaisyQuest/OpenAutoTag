# A49: saved widget navigation order

Completed 2026-10-23 from engine baseline 51ac7d5.

## Delivered behavior

Native widget navigation now carries raw annotation/field flags, rectangle-area evidence and optional-content presence. The tag builder records the exact logical widget inventory and sequence. Hidden, NoView and empty-rectangle widgets retain their Form/OBJR ownership and receive explicit exclusions. Read-only fields remain in the reading sequence. The Invisible annotation flag alone does not exclude a standard Widget. Conditional visibility remains review work.

Separate label contexts retain the established logical tree order, including columns. Controls sharing a label follow physical rows, with a fixed row anchor to tolerate small baseline offsets without a non-transitive sorting comparator. Complete multiline labels spanning consecutive sibling paragraphs place their widget after the final fragment; unrelated intervening text, different parents and cross-page fragments do not qualify.

The independent saved inspector reads native visibility data and each page's Tabs setting. Validation compares the source inventory, intent inventory, exclusions, unresolved controls and actual OBJR traversal order. Every eligible widget must appear once, in the declared order, with Tabs S. Changing flags, swapping controls or selecting row tab order rejects qualification. Missing legacy evidence cannot gain a new qualification. A truthful unresolved placement remains review_required; a complete structural result is structure_verified, with readerStatus always required.

These rules follow [W3C PDF3](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF3) and [ISO 32000-1](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf), Table 165 and page-level navigation. Structural verification is distinct from observed keyboard and screen-reader behavior.

## Verification

The serial baseline passes **1,123 tests**, with zero failures, skips or cancellations. The final affected run passes **70 tests**, and the final fixture run passes **four tests** after a fixture-only layout adjustment and multiline editing probe. Suites overlap. The baseline started before the final row-order and lookup refinements; the final affected run covers those production changes. Three new JavaScript helpers have **100% line/function and 93.80% branch coverage**. Java and repository-wide coverage were not measured. All five embedded navigation contracts match their canonical schemas.

The fixture deliberately reverses field and annotation arrays and offsets inline date controls by 0.13 points. It retains **12 fields/14 widgets**: all **11 eligible widgets** appear in the expected sequence, with three explicit exclusions. Repeated fields, a multiline label, a read-only field, noninteractive prose and shared date labels are exercised. Text, checkbox, radio, dropdown and multiline edits survive save/reopen. Saved row-order, swapped-control and changed-visibility corruptions reject. Raw validation passes **1,522 checks**, with zero font errors.

TEST-FORM retains **32 fields/33 widgets and all 173 options**. AffirmationDay, AffirmationMonth and AffirmationYear gain label-context placement and occur in day–month–year order despite fractional baseline differences. Unresolved placements decrease **from eight to five**. The candidate passes **5,676 saved checks and 15,112 raw veraPDF checks**, with zero font errors. Four dropdown selection/save/reopen probes pass. Navigation remains review_required for the five unresolved controls: ResetForm, LocalCourt, two long service-checkbox labels and PrintForm.

Independent pypdf traversal confirms every widget OBJR occurs once, the fixture's explicit expected sequence, the three exclusions and the real date sequence. Field/widget properties, appearances, text and geometry remain preserved with the individually audited existing font-map changes documented in A48. All **14 Poppler page pairs at 120 DPI** match, including edited PDFs; representative final pages were visually inspected. The earlier TEST-FORM source needs non-strict pypdf cross-reference recovery; candidates and edited probes load strictly. Original PDFs remain unchanged.

## Scope

The report verifies the widget subsequence in logical structure. It does not establish actual reader focus behavior, radio arrow-key handling, link/widget interleaving, arbitrary dynamic visibility or human semantic acceptance. The fixture's label associations and the real County label use known regression oracles, not human approval. The real replay uses the qualified batch-23 control; the existing refusal to rebuild an authored replacement scope containing an OBJR remains intact.

Evidence: [machine-readable record](evidence/accessibility-50-batch32-20261023.json). **A01–A49 complete; A50 remains.**
