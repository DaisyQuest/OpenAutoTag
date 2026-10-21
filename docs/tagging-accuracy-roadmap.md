# Next tagging accuracy plan

Proposed 2026-10-21, following implementation commit `1b24d87`. Bounded slices across A01–A10 are now implemented; see the [delivery and qualification limits](tagging-accuracy-delivery-20261021.md). Numerical targets, independent review, richer reconstruction and release qualification remain open. Multilingual expansion is lower priority. See [current claims and evidence](tagging-quality-claims.md).

The strongest immediate opportunities are to measure real errors, resolve form context, and verify that correct semantic decisions survive writing. The present benchmark has 16 synthetic cases, the latest form inference leaves eight visual widget associations unresolved (down from 12; all eight have authored tooltips), and the preserved-PDF path intentionally retains authored structure except for qualified repairs. Increasing inference sophistication alone will not improve every saved PDF.

## Sequencing and shared acceptance rules

Start with A01's 12-document pilot, then A02's saved-output comparison, A03's form relationships and A04's heading model. Use the resulting failure inventory to order A05-A09. A10 consumes evidence from each slice. Extend existing contracts and tools; the delivered additive schemas are listed in the delivery record; further schema extensions remain proposals. Keep module boundaries and existing CLIs compatible.

Use one small vertical slice at a time: reference examples, failing test, bounded rule, saved-output check, then qualification. Add public or redistribution-permitted fixtures only; keep private documents in a locally bound manifest. Do not add a model service or new PDF engine to implement the initial phases.

Every writer change must retain field identities, values, flags, actions, appearances, links and original page content unless that exact mutation is part of an explicit reviewed decision. Require exact saved-object proof on incremental repairs, repeat-run stability, text equality, two-renderer comparisons and fill/save/reopen for applicable fixtures. A full rewrite needs its own identity mapping; bypassing the incremental gate is not evidence of preservation. Structural failures, lost content, duplicate ownership and changed interactions block promotion.

Targets below are proposed gates for the named feature families, not general accuracy claims. Report counts, abstentions and document-cluster uncertainty as well as point estimates. Insufficient independent examples means “not yet qualified,” even if every observed case passes.

## A01. Review a real-document corpus and measure errors by type

**Gap:** synthetic layout inputs do not exercise extraction, real typography or writer fidelity.

**Slice:** annotate 12 documents first: two each of forms, reports, multiple-column papers, complex tables, scans/mixed OCR and mixed-language documents. Have a second reviewer independently annotate headings, logical sequences, labels/groups, table cells/headers, list boundaries and artifacts; retain disagreements for adjudication. Expand to 60 independently sourced documents, with 40 for development and 20 held out by publisher/template lineage. Split before tuning; keep variants and scans of the same source in the same partition.

**Owners/contracts:** benchmark script and fixtures; additive corpus provenance, source hash, split and annotation agreement metadata. Retain the current layout-only benchmark as a fast unit-level gate. Add an end-to-end runner for parser through saved PDF separately.

**Exit:** baseline per-document/per-feature precision, recall, sequence error and abstention counts; no unlabeled feature counted as correct. Compare builds on the same pinned tools and holdout. This is measurement work, not an automatic pass from reaching 60 documents.

## A02. Compare intended semantics with reopened PDF semantics

**Gap:** JSON relationships can be correct while the saved PDF omits them; inferred changes are not generally applied to preserved authored trees.

**Slice:** extend the existing preservation inspector with a normalized read-only semantic view. Bind identities to source hash, page, content-stream/XObject path plus MCID or annotation reference, rather than text alone. Compare role, ordered content ownership, list membership, field ownership and table header edges against the intended output. Report unmatched and many-to-one mappings explicitly. Add reviewed, source-hash-bound patches only for one proven role/relationship family at a time using the existing repair ledger and verifier.

**Owners/contracts:** inspector, validator, writer; additive inspection and repair-audit fields. Reuse `StructureIdentifiers.java` for saved IDs. Do not introduce a second structure writer.

**Exit:** mutation tests catch dropped Headers, wrong heading roles, duplicate MCIDs, wrong-page OBJRs and swapped reading order. Every applied decision maps to exactly the intended saved objects; every unresolved mapping remains a review item. This comparison must catch errors that veraPDF does not diagnose.

## A03. Resolve form labels, groups and navigation with explicit context

**Gap:** nearby text plus tooltip matching leaves shared prompts, radio options and repeated widgets unresolved.

**Slice:** review all 12 unresolved TEST-FORM widgets, classifying shared group prompt, option label, field instruction, missing text or ambiguous association. Use section boundaries, authored field hierarchy, alignment and unique text evidence to distinguish group prompts from widget labels. Add radio export-state and repeated-widget fixtures. Reuse `formRelationships`, `relations` and `formNavigation`; represent new evidence additively. Keep field `/T` identity distinct from the user-facing accessible name.

**Owners/contracts:** parser and semantic engine; reviewed PDF edits follow A02. Offer proposed tooltip/group/tab-order changes for review before adding any automatic rule.

**Exit:** every current unresolved widget has an adjudicated expected outcome, including legitimate abstention. On the reviewed holdout, target at least 99% precision for automatically selected label relations, with recall and coverage reported independently. Require adequate independent documents and at least 200 relevant decisions before qualifying that threshold; do not meet it by forcing ambiguous matches. Human tests must confirm spoken labels, group context and tab order on saved PDFs.

## A04. Infer heading hierarchy across the document

**Gap:** local typography and numbered-heading depth cannot fully distinguish titles, section headings, field labels and repeated running headings.

**Slice:** group comparable styles using font family/weight, size, spacing, alignment and repetition; combine with section numbering and nearby content. Separate heading membership from rank assignment. Produce a consistent candidate outline plus conflict evidence. Preserve the existing wrapped-title rules and short-widget-label safeguards. Include same-size title/subheading, numbered prose, appendices, repeated page headers and bilingual headings as negative cases.

**Owners/contracts:** semantic engine; additive outline evidence and competing interpretations. The preserved writer changes only reviewed or separately qualified roles using A02.

**Exit:** target 99% heading-membership precision and 98% exact parent/level agreement on the qualified holdout family, reporting recall and uncertainty. No false heading removal in protected form/paragraph fixtures, and no rank correction that hides a membership error. Verify the actual screen-reader heading list on selected output documents.

## A05. Build reading order from page regions and anchors

**Gap:** spanning headings and supplied anchors work, but general region segmentation and anchor discovery remain weak.

**Slice:** represent nested page regions before ordering blocks: full-width material, columns, sidebars, footnotes and captions. Derive candidate anchors from superscript markers, caption numbering and local geometry. Keep tables and form groups together. Reuse the existing precedence graph and cycle rejection; conflicting anchors produce localized review tasks. Add varying column counts, a full-width heading mid-page, floating figures and notes crossing page boundaries.

**Owners/contracts:** layout analyzer, semantic engine and reading-order module; proposed region IDs/parent IDs and anchor evidence in layout/semantic contracts.

**Exit:** no lost/duplicate content; target at most 0.5% errors on annotated critical precedence pairs, plus complete per-document sequence review. Pairwise scores must be accompanied by checks for catastrophic column interleaving. Validate mixed-layout output with observed reader navigation.

## A06. Reconstruct complex table topology before assigning headers

**Gap:** saved header associations are now checked, but a wrong table boundary or cell grid can still produce valid-looking tags.

**Slice:** combine ruling evidence, whitespace and text alignment into a grid with explicit uncertainty. Distinguish form grids and aligned prose from data tables. Handle empty cells, spanning cells, row-group headers and repeated headers; join multi-page fragments only with matching column boundaries and contextual evidence. Keep repeated visual occurrences distinct while associating the correct preceding headers.

**Owners/contracts:** layout analyzer, tag builder and saved-output inspector; propose explicit table-fragment/continuation evidence rather than overloading row indices.

**Exit:** exact cell coverage and span consistency; target 99% header-edge precision on the qualified family, with recall reported. Zero references to future, cross-table or missing headers. Adversarial aligned-prose/forms cases stay out of Table. Human tests check the announced row/column context, not just the presence of TH tags.

## A07. Separate meaningful figures, captions and decorative artifacts

**Gap:** repeated-margin review and local image repairs do not classify arbitrary logos, charts, seals or composite figures.

**Slice:** use image/vector grouping, caption text, repetition and page region evidence to propose Figure/Caption/Artifact roles. Build negatives for repeated meaningful warnings and logos, signature lines and decorative rules. Require review before suppressing uncertain content. Carry caption relationships using the existing anchors; descriptions must come from supplied or reviewed content, with provenance.

**Owners/contracts:** parser/layout evidence, semantic engine and qualified writer; proposed figure group IDs and description provenance.

**Exit:** zero suppressed meaningful content in the adjudicated negative set; exact unique ownership of composite content and caption. Correctly localized review tasks for charts requiring descriptions. Do not treat a filename, image dimensions or a generic generated sentence as adequate alternate text.

## A08. Improve text fidelity, OCR alignment and mixed-language semantics

**Gap:** document language and explicit RTL hints do not establish correct language switches, OCR text, ligatures or bidirectional runs.

**Slice:** retain raw extracted text separately from normalized comparison text. Detect language/direction at a sufficiently supported span or paragraph boundary; abstain on short ambiguous strings. Align OCR regions with native text to prevent duplicates. Handle discretionary hyphens and ligatures with constrained `ActualText` only when exact replacement is evidenced. Preserve visible glyphs and original editable-font programs.

**Owners/contracts:** parser/OCR, semantic engine and writer; proposed span language/direction, raw-text provenance and reviewed replacement fields. Start with English/Spanish switches; qualify mixed RTL separately.

**Exit:** annotated character/word errors and duplicate-text counts improve on held-out scans; native text never regresses on exact-string fixtures. Verify saved text extraction, search/copy and reader voice switching. Unicode changes require glyph-level tests and existing font-proof safeguards. No general multilingual claim from a document-level `/Lang` value.

## A09. Model paragraph and list boundaries as sequences

**Gap:** existing continuation rules are deliberately local and cannot reliably handle interrupted lists, bullet restarts or inconsistent typography.

**Slice:** score bounded candidate boundaries with indentation, marker progression, sentence completion, typography and section transitions. Preserve authorial paragraph breaks, list-item bodies and nested list levels. Add interleaved footnotes, page headers, multiple paragraphs per item, quoted material and same-marker restarts. Keep the existing deterministic rules as the baseline; only change a boundary with sufficient evidence.

**Owners/contracts:** semantic engine, paragraph merger and tag builder; extend the existing continuation IDs/evidence rather than introducing a parallel representation.

**Exit:** every source identity appears once, list numbering survives save/reopen, and no merge crosses forms, unrelated columns or tables. Target 99% precision for automatically changed boundaries, report recall/abstention, and compare full list navigation in saved output.

## A10. Calibrate automation and close the human qualification loop

**Gap:** heuristic scores are not measured probabilities, and complete evidence records are not themselves observations of assistive technology.

**Slice:** group error rates by rule, feature family and source lineage using A01/A02. Show rule evidence, competing candidates and the exact proposed change in review output. For each automatic rule, measure precision versus the fraction handled; enable broader automation only when the reviewed holdout supports it. Corrections become adjudicated development fixtures; do not tune repeatedly on a frozen holdout.

**Owners/contracts:** benchmark/reporting, validator/review-plan and reader-qualification workflow. Reuse the existing hash-bound reader record; add fields only for demonstrated reporting gaps.

**Exit:** actual reader/keyboard sessions on at least 12 representative candidate PDFs, using two declared reader/viewer combinations available to the reviewers. Cover reading order, headings, lists, tables, links, labels, tab order and fill/save/reopen; justify non-applicable checks. Record exact platform/tool versions and candidate hashes. Require no unresolved critical preservation/interaction defect. For automatic semantic decisions, initially target 99% precision and a document-cluster lower 95% confidence bound of 97%; insufficient data stays review-only. These thresholds are proposed engineering gates, not conformance guarantees.

## Delivery order and stopping rules

| Phase | Deliverable | Advance only when |
| --- | --- | --- |
| 1 | A01 pilot + A02 read-only saved comparison | Reviewed references expose reproducible failures; output/source identities are trustworthy. |
| 2 | A03 forms + A04 headings | Each targeted error has a passing saved-output test; unrelated cases do not regress. |
| 3 | A05 order + A06 tables | The pilot shows enough relevant failures to justify each slice; ambiguity is represented. |
| 4 | A07 figures + A08 text/language + A09 boundaries | A01 evidence ranks these above other remaining defects; extend only qualified families. |
| 5 | A10 qualification and release evidence | Holdout and actual reader observations support each stated capability. |

Measure elapsed time and peak memory on the same machine and corpus for every phase. Investigate regressions over 20% before enabling a rule by default. Stop broadening a rule when precision deteriorates; increase review coverage or gather discriminating evidence. Do not spend engineering effort on an unmeasured universal “perfect tagging” score.

## External guidance used for the plan

The plan's metrics and thresholds are project proposals. W3C's examples support testing [logical reading and tab order](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF3), [table relationships](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6), and [form name/role/value](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF12). [veraPDF's documented validation scope](https://docs.verapdf.org/validation/) explains why machine-check success remains separate from semantic and reader qualification.
