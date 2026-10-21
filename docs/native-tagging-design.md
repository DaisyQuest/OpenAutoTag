# Native tagging and preservation: current design

Updated 2026-10-21 with the [accuracy delivery](tagging-accuracy-delivery-20261021.md). This replaces the original proposal, which described native tagging as future work and assumed per-page fallback. See [claims and evidence](tagging-quality-claims.md) for measured results and [the next accuracy plan](tagging-accuracy-roadmap.md) for proposed extensions.

## Pipeline and evidence flow

```text
PDF -> parser -> layout analyzer -> semantic engine -> paragraph merger -> reading order -> tag builder
 |                                                                      |
 +---------------------------> writer <---------------------------------+
                                  |
                           saved candidate PDF
                                  |
             validator + independent font audit + preservation and saved-semantic inspection
                                  |
                        review candidate and reports
```

The font-embedder emits an inventory and remediation proposals alongside this flow. Proposed inventory actions are not all executed by the main writer. Explicit qualified repair CLIs apply supported font, link and structure changes and produce saved-object proofs.

Modules exchange JSON through versioned contracts and separate processes. A semantic relationship is an inference result until a writer or qualified repair materializes it in the PDF. The preserved-input path retains authored semantics except for bounded repairs; newly inferred relationships do not silently replace the existing tree.

## Writer dispatch

`modules/pdf-writer/index.js` accepts `--mode auto|native|raster`; default is `auto`. Inspect the report's effective `writerMode`, fallback reason and applied-tagging fields for every job.

| Path | Behavior | Important limit |
| --- | --- | --- |
| `auto` | Probes native content. Qualifying already-tagged input uses preservation before the native match-rate decision. Otherwise selects native or raster at document level. | It is not a guaranteed per-page or per-region hybrid writer. |
| `native` | Parses operators, matches them to semantic/tag nodes, and writes native marked content and the structure tree. | Matching measures content assignment, not correctness of inferred roles or reading order. |
| `passthrough` (selected path) | Copies the input, then applies incremental metadata and enabled bounded repairs to qualifying authored tags. | Existing semantic mistakes remain unless a repair qualifies. Output bytes may change. |
| `raster` | Reconstructs pages from rendered images and overlays tagged text using an embedded font. | Editable forms, native vectors and original font/text behavior are not guaranteed. |
| `sidecar-manifest` (fallback) | Copies the PDF and emits a manifest when necessary semantic context is unavailable. | The copied PDF has not acquired the inferred tags. |

The auto native-match threshold defaults to 0.8; the existing-marked-content threshold defaults to 0.5, together with source structure checks. These are routing heuristics, not accuracy promises. `--already-tagged-policy passthrough` is the default; explicit `bailout-to-raster` remains available for callers whose workflow requires reconstruction.

## Native writing

Java helpers use vendored PDFBox 3.0.8:

- `NativeContentStreamParser.java` extracts operator text, geometry and existing marked-content context.
- `NativeTagMatcher.java` associates operators with semantic content/tag identities and emits a native tag plan.
- `NativeContentStreamRewriter.java` creates native structure, marked-content references and associated PDF objects.

Conceptually, a matched text operation receives marked-content boundaries:

```text
Before: BT /F1 12 Tf 72 700 Td (Hello) Tj ET
After:  BT /F1 12 Tf 72 700 Td /P <</MCID 0>> BDC (Hello) Tj EMC ET
```

This is an illustration, not the native-plan JSON contract. PDFBox serialization may change stream bytes or compression. Semantic and appearance preservation require inspecting the saved PDF; a matching score alone is insufficient.

Both native and raster writers serialize table `Headers`, `Scope`, cell spans, structure IDs and list numbering. `StructureIdentifiers.java` creates IDTree entries and rejects duplicate/dangling IDs, non-TH targets, cross-table references and excessive nesting. Tests reopen both writer outputs to check these relationships.

## Qualified incremental repairs

The repair entry points are `font-repair.js`, `link-repair.js` and `structure-repair.js` under `modules/pdf-writer/`. They refuse to overwrite inputs or existing outputs. Each has bounded eligibility conditions, emits an audit and verifies saved objects against a fresh replay from its source. Signed/encrypted inputs are outside these repair paths.

| Family | Qualified behavior | Cases left for review |
| --- | --- | --- |
| Fonts | Pinned canonical standard-font programs, observed whitespace-only use, qualified CIDSet completion, checked WinAnsi TrueType ToUnicode, unused Helvetica defaults using a matching authored Arial program. | Custom encoding/metrics, ambiguous donors, incomplete usage scans, arbitrary substitution. |
| Links | Descriptions from unchanged simple URI actions and uniquely evidenced ownership repairs, with reciprocal ParentTree/OBJR checks. | Compound actions, ambiguous text/geometry, unsupported rotations, inconsistent ownership. |
| Structure | Qualified list-form containers, wrapped headings, unrelated terminal-field Form splitting, consistent rank compaction, source-bound reviewed role decisions. | Ambiguous ownership, unsupported semantic attributes, stale decisions, unreviewed role changes. |

`SavedObjectVerifier.java` compares the saved graph against a fresh permitted replay. This proves the allowed mutation boundary; it does not prove that a human's semantic interpretation is correct. Source-hash-bound decisions and semantic/reader review remain necessary.

## Validation and publication state

The default external validator is veraPDF 1.30.3 Greenfield with `ua1`. Raw results are retained without the discontinued backend's suppressions. PDFBox supplies independent structural diagnostics and the font audit; a required checker failure cannot be interpreted as a pass.

`scripts/check-pdf-preservation.js` binds validation to candidate bytes and compares source/candidate content, fields, widgets, resources and supported structure identities. Font and structure changes require independent replay proofs when enabled. Full rewrites do not automatically satisfy an incremental-identity gate.

`--production-checks true` enables preservation checking and candidate download gating in the accessibility pipeline. A passing candidate may be downloaded explicitly for review only when its bytes match the inspected hash. It remains `review_required`; the current code does not implement a complete accepted-output promotion process. Ungated legacy jobs do not acquire this policy automatically.

## Qualification and open work

Run `npm run test:production-baseline` for portable regression suites and `npm run benchmark:semantic` for the 16-case synthetic semantic benchmark. The benchmark covers layout-to-tagging JSON; separate writer tests verify saved structure. Tests include failed preconditions, mutated saved objects, repeat runs and interaction probes.

The latest TEST-FORM result passes machine checks while preserving tested form objects, appearance and interactions. Broader real-document accuracy, inferred-to-saved semantic comparison, human reader/keyboard observations, full portable/servlet deployment and unsupported PDF feature families remain open. Choosing native mode alone establishes no fixed file-size reduction, universal font embedding or general conformance guarantee.
