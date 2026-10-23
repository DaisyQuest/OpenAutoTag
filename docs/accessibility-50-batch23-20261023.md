# A39–A40: reviewed bookmarks and saved navigation preservation

An opt-in writer now appends hierarchical bookmarks from an explicitly accepted, source-hash-bound outline. Existing authored bookmarks, destinations and logical page labels are independently inventoried and checked after saving. A missing navigation inspection cannot pass preservation qualification.

The implementation follows [ISO 32000-1 sections 12.3.3 and 12.4.2](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf), the [PDF Association page-label clarifications](https://pdf-issues.pdfa.org/32000-2-2020/clause12.html), and [PDFBox 3.0.8 outline behavior](https://raw.githubusercontent.com/apache/pdfbox/3.0.8/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/interactive/documentnavigation/outline/PDOutlineNode.java). Alphabetic labels use repeated letters: after Z come AA and BB. An omitted label style means a prefix-only label.

## Supported operation

`contracts/reviewed-outline.schema.json` requires an accepted decision, reviewer, evidence, exact source SHA-256 and a hierarchy of unique IDs, Unicode titles, physical one-based page numbers, open/closed states and children. New bookmarks use explicit Fit destinations. At most 4,096 nodes and 33 tree levels are accepted; text, manifest size and execution time are bounded. Existing richer actions, named destinations, styling and hierarchy remain intact. Encrypted/signed documents, inconsistent existing outlines and stale or invalid review inputs are refused.

The writer appends incrementally to a separate output. Before releasing it, a fresh source replay compares the entire reachable catalog and document-information graph with the saved candidate. Verification mode performs that comparison without writing a PDF. The root preservation command invokes this verifier itself; only its exact source/candidate-bound proof permits the requested outline difference. Page-label and named-destination changes remain disallowed. The review record carries supplied acceptance evidence; it does not authenticate a human review.

Independent inspection handles modern byte-string and legacy name destinations, explicit destination operands, outline graph relationships, number-tree ranges, Roman/decimal/alphabetic labels and prefix-only labels. Stable graph fingerprints preserve alias relationships without relying on renumbered PDF object IDs. Traversal, decoded-stream and fingerprint limits bound the work. Generic saved-semantic comparisons also require unchanged, well-formed navigation when a source/reference inspection is provided.

```text
node modules/pdf-writer/reviewed-outline.js --pdf tagged.pdf --output bookmarked.pdf --review accepted-outline.json
node scripts/check-pdf-preservation.js --source-pdf tagged.pdf --candidate-pdf bookmarked.pdf --validation-report validation.json --outline-review accepted-outline.json --output quality.json
node --test --test-concurrency=1 modules/pdf-writer/test/reviewed-outline.test.js
```

The validation report must be freshly generated for the saved candidate. Set `NAVIGATION_EVIDENCE_DIR` to a fresh directory to retain regression artifacts. No dependency was added; the main tagging pipeline does not automatically accept or publish a proposed outline.

## Verification

The final focused run passed all **53 tests**, including 35 reviewed-outline cases. The full production baseline passed all **760 tests**, with no failures or skips. These runs overlap; no coverage percentage is claimed.

The six-page tagged fixture retains four authored bookmarks, including local, named and remote destinations, and appends six reviewed Unicode bookmarks across three levels. Independent checks cover open/closed branches, Roman/decimal/alphabetic ranges, absent and empty outline roots, prefix-only labels and source byte preservation. Seventeen saved corruption probes reject altered titles, targets, graph links/counts, labels and field values. Seven invalid review inputs and three invalid existing trees are refused. Saved native checks pass 120/120.

Raw veraPDF passes 553 source and 559 candidate checks. The fixture's separate font audit reports the same three pre-existing findings on both: unembedded Helvetica, unembedded ZapfDingbats and its missing symbolic Differences mapping. Focused preservation tests use an explicitly named validation stub to isolate that gate; the fixture is not claimed fully qualified. Real-PDF checks below use actual raw validation and font-audit reports.

Independent pypdf checks confirm all **268 original stream payloads**, annotation properties, widget appearance resources, field values, text bytes/TJ adjustments and page geometry are unchanged across five comparisons. Raw number-tree decoding verifies label inheritance across leaf boundaries, avoiding pypdf's observed page-label fallback there. All **40 Poppler page pairs at 120 DPI** match exactly, including 18 pairs after editing fields to `José café 987`, saving and reopening. PDFBox also verifies the three synthetic source/candidate pairs before and after editing. Representative filled fixture, TEST-FORM and NASA pages were visually inspected.

Separate copies of TEST-FORM and the previously tagged official [NASA STEREO lithograph](https://stereo-ssc.nascom.nasa.gov/img/litho.pdf) each receive two synthetic accepted-outline test entries. No actual human approval is claimed. TEST-FORM retains 32 fields/33 widgets and passes 9,876 raw checks; STEREO passes 5,462. Both font audits have zero findings and all preservation checks pass. Their existing structure, text ownership and source content remain identical. STEREO's 65 pending OCR reviews remain pending. A passing preservation report still says `review_required`.

## Newly exposed source defect and remaining work

The original official [NASA Hinode PDF](https://science.nasa.gov/wp-content/uploads/2023/09/hinode-one-pager.pdf) contains ten existing outline-graph defects: five parent links, four previous-sibling links and one last-child link. Independent raw-object inspection confirms them. Appending bookmarks is refused before creating an output, and the source remains byte-identical. Earlier green reports predate this navigation coverage; they do not establish current navigation qualification.

The booklet candidate remains byte-identical with its prior six raw failures, 196 saved semantic failures and 158 pending OCR segments; it was not rerun here. NIST table failures and the legacy table-header assertion remain for A41–A45. Forms and final eligibility integration remain A46–A50. Bookmark usefulness, OCR accuracy, reading order and keyboard/screen-reader behavior still need human review.

Exact artifact, source, report and log hashes are recorded in [the evidence report](evidence/accessibility-50-batch23-20261023.json).
