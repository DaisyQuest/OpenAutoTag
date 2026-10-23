# A21, A22 and A24: inspect saved content and reciprocal ownership

Completed 2026-10-23 against `422b27e`. **23 improvements are complete; 27 remain pending.** A23 (exclusive source-paint ownership) and A25 (complete source-text coverage) remain open. See [structured evidence](evidence/accessibility-50-batch9-20261023.json).

## Problem and changes

Previously, a structure element could pass `CONTENT_ATTACHED` merely because it contained an MCR dictionary. Removing its real marked-content wrapper or leaving only whitespace could still pass. ParentTree checks verified forward references and reachable targets, but did not establish the reverse relationship for every live index entry.

[ISO 32000 document-interchange errata](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html#14754-finding-structure-elements-from-content-items) describes the relationship between structural parents, content identifiers and page/object scopes. The implementation follows those relationships without claiming PDF/UA-2 support.

- **A21:** A new bounded scanner reads actual saved page streams and invoked Form streams independently of the writer and structure tree. It resolves named property resources, page content arrays, nested Forms and font state. Each MCR must resolve to exactly one lexical sequence in its page/stream scope. Missing, duplicate, malformed and unbalanced sequences reject. Repeating a Form invocation does not invent a second lexical declaration.
- **A22:** Nonempty intended text requires owned, decoded non-whitespace glyphs. Empty wrappers, spaces, unknown glyphs, Artifact-only paint, graphics-only paint and replacement text without real content cannot satisfy that check. Figure/Form attachment and intentionally blank table cells retain their appropriate rules. The public inspection contract gains an additive `markedContent` inventory; old snapshots remain readable but cannot receive a saved-semantic pass without this evidence.
- **A24:** ParentTree validation now checks the reverse relationship, scope-key uniqueness, integer key types and incompatible key forms. Extra live slots, orphan keys, missing keys and mismatched page/Form/annotation owners reject. The same MCID number remains valid in separate scopes.

The scanner caps decoded bytes, operations, glyphs, operands, sequence count, graphics-state depth, marked-content depth and Form recursion. Cycles and exhausted bounds fail explicitly. There are no new dependencies or writer changes.

## Verification

All **348 production-baseline tests pass**, with no failures or skips. This includes 36 new tests: four validator tests and 32 saved-PDF integration tests/subtests. The independent two-page fixture contains eight sequences, two tagged Form streams, a parent-owned untagged Form, a figure, a widget and a link. Its valid structure passes 70 saved checks. All **27 deliberate corruptions** and both excessive-depth/cyclic-invocation cases are rejected. Positive cases cover content arrays, Tj/TJ/quote operators, graphics-state fonts, inherited Form resources and repeated Form invocation.

Four mutations alter structural references or marked-content metadata while preserving visible paint. Poppler at 150 DPI confirms **all eight compared pages are pixel-identical**, and saved validation still rejects each corruption. The valid fixture's first page was visually inspected.

The real-document check reads the exact candidates from batch 8. SHA-256 checks before and after inspection verify unchanged bytes, so the prior 64-page appearance comparisons, TEST-FORM's 32 fields/33 widgets and sampled interaction proof remain applicable. Those preservation checks were reused by exact hash rather than rerendered or represented as fresh interaction testing.

| Document | Saved checks passed / failed | Executed marked sequences | Existing raw veraPDF passed / failed |
| --- | ---: | ---: | ---: |
| NASA STEREO booklet | 18,969 / 154 | 4,134 | 186,049 / 31 |
| NASA Hinode | 542 / 0 | 52 | 5,246 / 0 |
| TEST-FORM preserved control | 2,008 / 0 | 89 | 9,874 / 0 |

The raw reports apply to those identical candidate hashes and were not rerun. All existing booklet failure targets are unchanged. More passing checks reflect deeper validation, not improved accessibility percentages or resolved attachment failures. The booklet remains rejected; the controls still require human review.

## Remaining work

This batch establishes that referenced sequences exist and contain meaningful decoded content. It does not yet establish that every glyph belongs to the intended source node or that all intended text survived. A23 and A25 will address those gaps; nested/foreign ownership and partial text must not be accepted merely because nonempty content exists. Visibility, clipping, annotation appearance text, OCR completeness, arbitrary stream scopes and reader behavior require separate qualification.

Reproduction: `npm run test:production-baseline` (serial Node tests with the documented host-specific JVM settings on this machine). Focused tests: `node --test --test-concurrency=1 modules/validator/test/saved-semantics.test.js test/integration/saved-content-validation.test.js`. Local replay, render and mutation evidence is under `output/accessibility-50-batch9-20261023/`.
