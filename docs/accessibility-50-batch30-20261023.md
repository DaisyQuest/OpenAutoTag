# A47: reviewed accessible field names

Completed 2026-10-23 from engine baseline 0898f78.

## Delivered behavior

An opt-in repair adds missing terminal-field TU names from an accepted, attributed review bound to the exact source PDF and semantic-intent bytes. The review identifies the field object, every widget and complete visible label fragments. Each widget needs an accepted label association or its own button caption. Partial, reordered, stale or unrelated labels reject. Ambiguous inference requires an explicit corrected association before acceptance.

Existing authored names are preserved. Only missing or blank TU entries can change; values, export states, flags, actions, widget appearances and field topology remain intact. The writer saves incrementally to a new file, replays the requested changes on a fresh source and compares the entire reachable Catalog/Info graph. The preservation gate independently repeats that replay and permits only the named field changes. A supplied report alone does not authorize the wrapper to skip replay.

The parser now reads a separate widget's terminal-field tooltip, with source-object provenance. It does not borrow a name from an unrelated nonterminal ancestor. This fixes missing names previously caused by consulting only widget-local metadata. Malformed metadata is omitted rather than treated as accepted naming evidence.

The distinction between TU, internal field name T, and pushbutton CA follows [W3C PDF12](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF12). Form-label placement and field identity follow the [PDF Association guide, pages 50–53](https://pdfa.org/download-area/publications/Tagged-PDF-Best-Practice-Guide.pdf). These sources guide implementation; they do not certify the output.

## Verification

The serial baseline passes **1017 tests**, and the final focused run passes **61 tests**, with zero failures, cancellations or skips. Suites overlap. Two CLI/input-boundary tests were added after the baseline loaded that test file; production code was unchanged. The three JavaScript helpers have 100% line/function and 93.10% aggregate branch coverage. Java and repository-wide coverage were not measured.

Positive tests cover repeated widgets, text, checkbox, choice and button names, blank names, absent default appearance, fresh native tagging and fill/save/reopen. Negative tests cover existing field/widget names, stale source/intent, partial widgets, invalid labels, saved value/name/action/appearance corruption, signed/encrypted/XFA sources, missing forms, aliases, existing outputs, size limits and malformed CLI arguments.

The native fixture retains six fields/eight widgets and passes **375 saved and 966 raw checks**, with zero font errors. Text, checkbox, radio and choice editing survives save/reopen.

A disposable copy of the qualified TEST-FORM control has exactly one known authored name removed: Print Name. Restoring that exact reviewed label reduces raw failures from **one to zero**, with **15,112 raw and 3,312 saved-reference checks passing** and no font errors. It retains 32 fields/33 widgets and verified accented-text editing. The original control is unchanged. The fixture review is an automated regression oracle, not a claim that a person accepted a new name or resolved the existing eight placement reviews.

Independent strict pypdf comparison checks 1,080 reachable objects and 201 streams across three repairs: one repeated text-field name, four mixed field names, and the real-document restoration. Only the six requested TU entries change; original byte prefixes remain. All **12 Poppler page pairs at 120 DPI** match, including edited forms. Representative fixture and TEST-FORM pages were visually inspected.

## Use and limits

The review format is contracts/reviewed-field-names.schema.json. It requires accepted decision, reviewer/evidence, sourceHash, intentHash and exact field/widget/label identities. Generate hashes from the actual source and semantic bytes; do not reuse a review for a regenerated file.

~~~text
node modules/pdf-writer/reviewed-field-names.js --pdf source.pdf --output named.pdf --review accepted-names.json --semantic semantic.json
node modules/pdf-writer/reviewed-field-names.js --pdf source.pdf --verify named.pdf --review accepted-names.json --semantic semantic.json
node scripts/check-pdf-preservation.js --source-pdf source.pdf --candidate-pdf named.pdf --validation-report validation.json --semantic semantic.json --field-name-review accepted-names.json --output quality.json
~~~

Repair stages are verified separately. Signed, encrypted or XFA forms and existing malformed/nonblank names decline this repair. Supplied reviewer attribution is not authenticated human identity. Source coverage, radio-choice interpretation, keyboard order and actual reader usability remain separate qualifications. Successful output remains review_required.

Evidence: [machine-readable record](evidence/accessibility-50-batch30-20261023.json). **A01–A47 complete; A48–A50 remain.**
