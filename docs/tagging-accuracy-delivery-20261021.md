# Tagging accuracy delivery, 2026-10-21

This implements bounded engineering slices across A01–A10 of the [accuracy roadmap](tagging-accuracy-roadmap.md). Multilingual expansion is deferred in favor of saved-output correctness, forms, sequence boundaries and measurement. Existing language behavior remains available. The roadmap's numerical accuracy targets and human qualification requirements remain open.

## Delivered scope

| Area | Implemented behavior | Qualification boundary |
| --- | --- | --- |
| A01: real PDF corpus | Twelve hash-pinned existing PDFs, conservative source-family splits, typed annotation/adjudication metadata and a CLI running extraction, layout, semantics, paragraph merging, reading order and tag building. Nine primary documents exercised; three multilingual documents are secondary. | References are pending independent review; the holdout is an unreviewed candidate partition, not a qualified frozen holdout. Corpus diagnostics are not precision measurements. No new PDF downloads or dependencies. |
| A02: saved semantics | Reopened structure inspection records stable emitted IDs, parents, children, direct content ownership/order, table attributes (including ClassMap), list numbering, ActualText and Alt. Comparison checks intent or an identity-preserving reference. Rebuilt production candidates fail when intent is lost. | Reference mode requires original bytes as an unchanged prefix. Intent comparison establishes structure/ownership integrity and attached content, not that a consistently misassigned operator belongs to the intended source text. Content-stream completeness and actual reader behavior require separate checks. Preserved repairs retain their existing exact replay verifier. |
| A03: forms | Exact tooltip matching tolerates trailing closing-parenthesis differences and checkbox hanging indents. A unique short colon prompt directly above one widget can be associated. Widgets distinguish authored accessible names from unresolved visual associations. Parser carries authored radio/export/button metadata. | TEST-FORM's unresolved visual associations fall from 12 to 8. Shared prompts, date components and button appearance text remain explicit review cases. No automatic tooltip, field identity, grouping or tab-order mutation. |
| A04: headings | Document outline with parent/level evidence and gap/conflict tasks. Unnumbered existing headings can adopt rank from a unanimous numbered style observed on at least two pages. Wrapped headings retain source and raw-text provenance. | Membership is not inferred from typography alone by this new pass. No general hierarchy accuracy percentage or observed heading-list result is claimed. |
| A05: reading order | Page/column/spanning/footnote regions with node membership and band precedence. Unique supplied reference markers can anchor notes; ambiguity remains reviewable. | General sidebar/composite-region segmentation and automatic superscript discovery are unfinished. Existing graph cycle rejection stays mandatory. |
| A06: tables | Bounded occupancy checks identify overlapping, missing and unresolved grid positions. Cross-page joins require repeated header text, all matching column anchors and page-boundary context. Fragment continuation evidence is recorded separately. | Empty cells are not invented; ambiguous topology is not automatically repaired. Full row-group reconstruction and held-out header-edge accuracy remain unqualified. |
| A07: figures | Parser records transformed image-operator bounds. A mutually unique nearby numbered caption becomes Caption; shared caption candidates and missing descriptions generate review tasks. | Geometry is approximate for clipping; arbitrary vector composites, charts and decorative classification are unfinished. No generated description or new automatic suppression is introduced. The existing native graphics-artifact behavior still needs meaningful-figure review. |
| A08: text/OCR | Separate raw assembled extraction, comparison text and provenance. Sparse-page OCR retains native text and adds nonoverlapping regions, reporting overlaps/conflicts. Suspect source-OCR replacement retains its original blocks and a review task. | Raw assembled text is not original PDF byte content. No automatic ligature/hyphen rewriting or new multilingual/RTL qualification. OCR alignment limits abstain instead of replacing native text. |
| A09: paragraphs/lists | Tight same-page unfinished sentences can continue; numeric restarts retain following items in the new list. Both merger strategies respect semantic/region/form/table/column boundaries and remap merged identities throughout relationships and review artifacts. | Native list marker splitting is limited to one Tj operand with an exact decoded glyph boundary. Unsupported multi-operator/TJ/ambiguous labels remain detectable saved-output failures. No guessed glyph split. |
| A10: calibration/review | Rule-level precision, recall, coverage and abstention reporting accepts only adjudicated holdout decisions. Duplicate decisions and lineage leakage are rejected. Review actions now identify the affected semantic family. Existing reader records remain bound to exact candidate bytes. | No calibration data are claimed for the unreviewed pilot. A conservative Wilson bound on wholly correct source families is reported separately from decision precision; it is not the roadmap's proposed document-cluster precision interval. No automatic release promotion or fabricated reader observation. |

## Writer and integration defects found and fixed

Saved comparison exposed two list defects. Raster instructions used the full source sentence for LBody, repeating its marker, and Lbl had no page content. Raster writing now uses the intended text, emits a content-bearing label and avoids duplicate text on containers. Native writing discarded empty labels. For a single Tj operand, it now decodes the marker with the active font and splits only at an exact glyph boundary. Prefix and suffix retain every original character byte and text advance. An embedded-font fixture verifies identical glyph positions and exact 150-DPI pixels. Unmatched markers are rejected by the saved comparison. IDTree is rebuilt after cleanup so removed elements cannot leave stale targets.

The full form pipeline also exposed references to paragraph nodes that had been merged away. Both merger strategies now preserve original block identities and raw text, rebind label/context/region/order/review references, and internalize continuation edges whose endpoints become one node. Standalone page counters and URLs stay separate. Protected boundaries prevent merging through unrelated forms, columns, regions, tables, headings or semantic groups.

## Measured evidence

The [committed evidence summary](evidence/tagging-accuracy-20261021.json) binds results to local artifacts. PDF content and full diagnostic reports remain outside Git.

- Nine primary corpus documents completed with 37,643 final semantic nodes, no lost source-block identities and no missing/duplicate tag ownership. All annotations remain pending; no automatic accuracy rate was calculated. Runtime is diagnostic only: runs overlapped test processes, and no controlled previous-build or peak-memory comparison was performed.
- TEST-FORM candidate: `output/TEST-FORM-accuracy-20261021/06-candidate.pdf`, SHA-256 `ede89479e33638a1adffbda2761d1e323732caeecea6bd0f08350bbe2ced2383`.
- veraPDF 1.30.3 Greenfield: 106 passed rules, 9,874 passed checks, zero raw failures/suppressions; independent font audit: zero findings.
- Preserved 32 terminal fields (35 field-tree objects), 33 widgets, nine links, five saved headings and the full Supplemental Affirmation heading. All page, field, widget, link, heading and saved structure inventories match the preceding candidate. The saved-reference comparison passes 1,828 checks.
- Both normal pages are pixel-identical at 150 DPI in Poppler and PDF.js. Extracted page text is identical. Text/checkbox and accented/Euro fill-save-reopen probes pass. Both rendered pages were visually inspected.
- Eight unresolved widgets all have authored tooltips. Reset/Print buttons need appearance-text association; court/county and explanations need contextual adjudication; day/month/year share sentence prompts. These are not eight missing accessible names.
- Human reader/keyboard observations remain unperformed. Candidate disposition remains `review_required`.

## Commands and contracts

```powershell
npm run test:production-baseline
npm run test:accuracy
npm run benchmark:accuracy -- --output-dir output/accuracy-pilot
npm run check:saved-semantics -- --pdf <rebuilt.pdf> --tags <05-tagging.json> --output <comparison.json>
npm run check:saved-semantics -- --pdf <preserved.pdf> --reference <prior.pdf> --output <comparison.json>
```

The real-PDF benchmark disables OCR for repeatable native extraction diagnostics. Select documents with `--documents id1,id2`; include secondary language fixtures with `--include-secondary true`. It does not write candidate PDFs. Run the production pipeline and saved/preservation checks separately for saved-output qualification. Direct comparison exits nonzero on a semantic mismatch; orchestration uses `--report-only true` to persist findings into the quality gate.

New contracts: `accuracy-corpus.schema.json`, `saved-semantics.schema.json`. Existing layout, semantic and preservation inspection contracts have typed additive evidence fields. Reader evidence continues to use `reader-qualification.schema.json`. Marking a corpus frozen requires adjudicated holdout references; metadata completeness does not independently verify the reviewers' observations.

## Remaining release work

Gather independently adjudicated real-document expectations and actual reader/viewer sessions before calibrating any general accuracy claim. Expand saved content mapping to prove the intended operator ownership, support additional list operand forms with preservation evidence, and implement reviewed figure descriptions and richer table/region reconstruction. Establish controlled runtime/peak-memory comparisons. Broader language detection, mixed-script qualification, operational packaging and automatic accepted-output publication remain lower priority or separate qualification work.
