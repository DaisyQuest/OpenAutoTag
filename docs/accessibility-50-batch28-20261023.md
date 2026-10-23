# A45: caption relationships backed by saved content

The previous caption pass could ignore an unresolved explicit target, attach the caption to another table, and move it across unrelated prose. It also nested Figure captions inside Figure tags. The [PDF Association guide](https://pdfa.org/download-area/publications/Tagged-PDF-Best-Practice-Guide.pdf), version 1.0.1, pages 13–14 and 47, places table captions at the first/last child boundary and figure captions immediately beside the figure under a shared parent. A Figure must own its actual graphical content.

## Changes

Caption association resolves explicit node/table/figure identities and relation records without falling back when a supplied target is missing or conflicting. Same-page geometry, horizontal overlap, a maximum 36-point gap and logical adjacency are required. A caption cannot cross prose or attach to the wrong content kind. A continued table uses its first/last logical page boundary. Inference remains optional; explicit relationships are handled without the inference flag. The legacy lookback option remains accepted but cannot authorize crossing paragraphs. Failed associations stay visible as review records and saved-verification failures.

Table captions become first/last children without changing text order. Captioned images become real Figure siblings, with no fabricated description. Native binding freshly identifies one image XObject invocation from its display bounds, then uses its native stream origin and lexical operator index. PDF.js indices are never reused as native indices. Nested and repeated Form invocations retain separate ownership. Ambiguous or unsupported paint and protected source scopes reject before the output is saved. Raster mode refuses native-image ownership requests explicitly.

Independent saved inspection checks source image payload, presentation resources (including color/decode/mask data), full transforms, invocation order, MCID ownership and caption placement. Source/intent hashes bind the ownership evidence. Altered image ownership, changed payload/presentation, mirrored paint, stale geometry, duplicate claims, source artifacts and missing evidence reject. Existing image bytes, page paint and controls are retained. Distinct explicit caption targets also protect paragraph-merge boundaries.

## Verification

The serial baseline passed 916 cases. It began before the final image-presentation/matrix checks and continued-table caption guards. The final 82-case affected run covers those changes; no single run of the final revision is claimed.

Focused coverage is 100% lines/functions for both new JavaScript helpers, with 91.43% branches for caption association and 95.24% for image ownership validation. This is not repository-wide or Java coverage.

The four-page native fixture saves **six caption relationships**, including table captions before/after tables and figure captions before/after images. It covers all four page rotations, shifted crop boxes, UserUnit scaling and nested/reused Forms. It passes **656 saved checks and 2,064 raw veraPDF checks**, with zero failures in those two reports. Three separate default-font audit errors remain explicit; raw conformance is not an overall accessibility qualification.

Independent pypdf checks preserve all six source image occurrences, their resources, original text operands/spacing, fields, annotations, appearance bytes and page geometry. All **eight Poppler pairs at 120 DPI** match, before and after field fill/save/reopen with accented text. Representative original and rotated pages were visually inspected. The final evidence hashes bind the tested files.

The NASA booklet and both NIST candidates were reinspected unchanged; fresh tag-builder replays of their retained semantic inputs produce identical tagging intent. Their complete failure objects remain identical: **192 booklet, 15 NIST-1299 and 28 NIST-1300 saved failures**. This is a regression check, not a fresh recognition run or a claimed accuracy increase on those documents. TEST-FORM and the older booklet control retain their prior hashes.

## Limits

This delivery qualifies caption mechanics for supported native image XObjects and declared table relationships. It does not solve vector/composite figure descriptions, inline-image ownership, every caption convention, all legacy coordinate plans or human reading-order judgments. Captions do not substitute for reviewed image descriptions. Missing descriptions stay explicit; a supplied description is not authenticated human approval. Raster form editing and unsupported image paths remain unqualified.

Evidence: [machine-readable record](evidence/accessibility-50-batch28-20261023.json). **A01–A45 complete; A46–A50 remain.**
