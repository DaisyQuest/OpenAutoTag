# A38: native link grouping across inline spans

A single native Link can now contain several complete, consecutive Span siblings belonging to the same source annotation. Wrapped anchors preserve their intended order, individual structure IDs, language and equivalent generated replacement text. The annotation retains one OBJR and its reciprocal ParentTree entry. Original glyph bytes, actions and appearance are preserved.

The [ISO 32000 Link structure rules](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html) permit inline children inside a Link and describe one annotation reference for a wrapped anchor whose active areas are represented by QuadPoints. This change applies those relationships to qualified existing semantic spans; it does not infer that adjacent paragraphs form one link.

## Implementation and limits

The writer requires one common inline-capable parent, consecutive leaf Spans, complete source coverage and one annotation per group. A Span with unrelated text, nested structure, OCR content, alternate text or a differing replacement is ineligible. Authored replacement scopes and ancestors that mask the Link remain review cases. Separate paragraphs, intervening siblings and separate parents are not regrouped. One parent can contain several independent qualified Links. The source tree is indexed with 128-depth/100,000-node limits; a group has at most 4,096 members.

The additive `groupedOwnerTagIds` ownership field records the original members in logical order; `ownerTagId` identifies their common parent. Source ownership stays with each original Span. The independent saved validator checks original sibling membership/order, source ranges, exact glyph membership, each saved member, one OBJR, annotation identity and reciprocal ownership. Only a fully verified group becomes transparent when comparing the original parent/child relationships. Missing or forged group evidence does not waive those checks. Logical order and physical paint order are checked separately.

No dependencies or CLI arguments were added. Existing single-owner links retain their original path.

## Verification

The affected link suites passed 104 cases. The final grouping suite passed 27 cases after the bounded tree-index refinement. The final full production baseline passed all **722 cases**, with no failures or skips. These runs overlap.

The 16-page fixture has eight bound grouped annotations and nine explicit review cases. It covers wrapped and same-line anchors, reversed paint order, nested Forms, generated replacement text, language retention and two groups in one paragraph. Saved output passes 1,793 checks and raw veraPDF passes 3,875 checks. Ten corruption probes reject child reordering, stolen neighboring content, invalid parents, missing/forged group declarations, forged range order, masking replacement text, direct extra content and invalid member roles/replacements. An unchanged PDFBox save/reopen control also passes saved checks.

Independent pypdf inspection verifies original text operand bytes/TJ adjustments, annotation properties, page geometry, field values and widget appearance bytes. PDFBox verifies all pages before and after editing the existing field to `José café 987`, saving and reopening. All 34 Poppler page pairs at 120 DPI match exactly: 16 fixture pairs, 16 edited/reopened pairs and two NASA pairs. Representative fixture and NASA output pages were visually inspected.

The official [NASA Hinode PDF](https://science.nasa.gov/wp-content/uploads/2023/09/hinode-one-pager.pdf) retains its original hash. With batch 10's corrected reading-order intent, all four links bind and 1,043 saved/5,246 raw checks pass. A second run splits one URL's intent into two consecutive Spans using its original glyph geometry. That controlled intent variation groups the two spans under one Link; all four annotations bind and 1,062 saved/5,265 raw checks pass. It is an explicitly synthetic intent variation of an unchanged reputable source, not a newly discovered natural corpus example.

Existing TEST-FORM and booklet production candidates retain their hashes and prior evidence; they were not rerun in this batch. The booklet's six raw failures, 196 saved failures and 158 pending OCR segments remain unresolved. Raw conformance passes do not resolve the fixture's intentional link review cases.

## Reproduce and remaining work

```text
node --test --test-concurrency=1 modules/pdf-writer/test/native-link-groups.test.js
```

Set `NATIVE_LINK_GROUP_EVIDENCE_DIR` to a fresh directory to retain the PDFs, source/intent proof and corruption reports. Artifact and log hashes are recorded in [the evidence report](evidence/accessibility-50-batch22-20261023.json).

This qualifies grouping for the documented inline siblings. Cross-paragraph interpretation, partial semantic-node splitting and ambiguous relationships remain review tasks. Reviewed bookmarks are next (A39); page labels, tables, forms and final eligibility integration remain A40-A50. Link purpose, overall reading order and keyboard/screen-reader usability still require human review.
