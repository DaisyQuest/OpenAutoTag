# Accessibility improvements: nested Form content ownership

A03, A04 and A05 are implemented and verified, bringing the [50-item ledger](accessibility-50-improvements.md) to **7 complete / 43 open**. This batch starts from `777db8f`. [Candidate hashes, code hashes and results](evidence/accessibility-50-batch2-20261022.json) identify the exact evidence.

## Implementation and specification basis

The parser records each Form invocation as a path of lexical `Do` indices, such as `page/8/7`. Local operator indices restart inside each Form and resume correctly afterward. Reusing the same Form resource produces different invocation identities. The matcher carries those identities through to the writer. This resolves **A03**.

The native writer creates a private Form stream for each invocation, retaining its drawing operations, matrix, bounding box, transparency group and effective resources. Only private XObject resource dictionaries receive new aliases; shared source Forms are not overwritten. Nested resources and inherited fonts continue to resolve. The writer closes an outer artifact wrapper before invoking a Form whose internal content now owns its tags. This resolves **A04**.

Each page or tagged Form receives its own ParentTree slot and compact MCID numbering. Form MCR dictionaries carry `/Stm` and `/Pg`, and each stream's `/StructParents` entry resolves back to its structure element. Equal MCIDs in different streams therefore have distinct owners. Both the hierarchical writer and the legacy flat-tree CLI emit these relationships. This resolves **A05**.

These relationships follow [Adobe's PDF Reference, section 10.6.3 and Table 10.11](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.6.pdf#page=814): an MCR identifies a non-page content stream through `Stm`; a Form may contain its own structured marked content. Our design uses independent invocation streams so different occurrences can belong to different semantic nodes. This is implementation evidence for the existing PDF/UA-1 path, not a new PDF/UA-2 qualification claim.

Duplicate scoped addresses, assignments without a source text operation, cyclic Forms, depth above 32 and more than 10,000 Form invocations per page fail before saving the candidate. Older page-only plans without scoped identities retain sequence-based matching. No dependencies were added.

## Verification

**250 production-baseline tests and 29 compatibility tests pass**, with zero failures or skips. The six-test Form fixture is included in the baseline. Compatibility tests cover native matcher/hierarchy regressions, writer modes and existing writer behavior. Runs use Java 21 with bounded heap/Tier 1 compilation and test concurrency 2 (baseline) or 1 (compatibility). No new coverage percentage is claimed.

The new two-page fixture has 15 text operations in ten content scopes: two pages and eight Form invocations. It includes nested and repeated Forms, reuse across pages, differing transforms, Form matrices, transparency groups and inherited resources. An independent lexical traversal verifies parser addresses. After saving, another walk verifies every painted operation's intended owner and reciprocal ParentTree entry, including MCID zero reused in all ten scopes. Glyph positions and 150-DPI pixels are unchanged, saved-semantic comparison passes, and raw veraPDF has zero failures. Deliberately wrong `Stm`, duplicate addresses, stale indices and recursion exercise failure paths. The flat-tree CLI is also verified.

The first flat-tree test attempt hit the test runner's 1 MiB stderr cap on PDFBox font diagnostics. The final test uses the same bounded 50 MiB cap as the production subprocess wrapper; it passes. No product validation findings were suppressed.

## Real-document replay

The same three development documents were replayed through output and verification stages with unchanged upstream extraction and inference. All **64 pages** remain pixel-identical in Poppler (booklet at 96 DPI; Hinode and control at 150 DPI). Booklet page 1 and Hinode were visually inspected. Hinode and the form also retain matching PDF.js checks. The form retains 32 fields and 33 widgets, its original source-byte prefix, and successful text/checkbox fill-save-reopen checks.

The booklet's independent pypdf audit now agrees with **all 5,017 source text operations**, including its nested text operation. The prior page-1 identity mismatch is gone. Across 100 invoked content scopes, all **3,994 emitted MCRs** point to painted content with reciprocal ParentTree ownership; no duplicate, nested or unbalanced ownership or unmarked paint is found. Previously the matcher reported 3,994 matched operations but only 3,993 marked-content runs were emitted.

| Candidate | Saved checks: passed / failed | Raw veraPDF failed checks | Disposition |
| --- | --- | --- | --- |
| NASA STEREO booklet | 14,624 / 258 | 31 | rejected |
| NASA Hinode | 531 / 0 | 0 | review_required |
| TEST-FORM control | 1,828 / 0 | 0 | review_required |

These remaining failure counts are unchanged. Better operator identity is not proof of complete intended-node attachment or semantic accuracy. Compound text partitioning, OCR, optional-content/replacement-text preservation, other ledger items and human usability qualification remain open.

Reproduce the focused fixture with `node --test modules/pdf-writer/test/native-form-streams.test.js`. Full logs are `tmp/accessibility-50-batch2-tests.log` and `tmp/accessibility-50-batch2-compatibility.log`. Ignored replay scripts, PDFs, renders, interaction records and the independent audit are under `output/accessibility-50-batch2-20261022/`; the evidence commit does not distribute those local artifacts.
