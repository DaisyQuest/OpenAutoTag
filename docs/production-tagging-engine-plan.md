# OpenAutoTag production engine plan

Implementation plan and delivery history, 20-21 October 2026. Scope: the engine in `C:/Users/tabur/PDFIsAbsurd/OpenAutoTag`. Sections 16-22 record successive bounded deliveries; section 22 is the latest result. Earlier counts, suppression behavior and open issues describe their historical build, not the current state. Use the [claims register](tagging-quality-claims.md) for current evidence and the [next accuracy plan](tagging-accuracy-roadmap.md) for additional proposed work. Production qualification remains incomplete.

Build a production engine that preserves document content and interaction, produces defensible semantic structure, and gives a precise outcome when automation cannot finish the job. The eight workstreams below extend the existing pipeline. Delivery begins with trustworthy measurements and a complete form-processing slice, then expands through independently gated capabilities.

Production acceptance has four separate dimensions: content preservation, structural integrity, machine validation, and semantic review. A high operator-match rate or successful process exit cannot substitute for any of them. veraPDF explicitly limits PDF/UA validation to machine-verifiable checks; meaningful reading order and control behavior also need appropriate accessibility testing. [veraPDF validation scope](https://docs.verapdf.org/validation/), [W3C reading and tab order](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF3).

## 1 Production scope and output promises

### Initial release envelope

Start with born-digital PDF 1.x documents, existing tags or untagged content, ordinary AcroForms, English and Spanish text, headings, paragraphs, lists, links, and simple ruled or borderless tables. Each claimed combination must have qualifying fixtures; including a feature in this list does not automatically qualify every producer or combination.

| Input class | Initial behavior | Expansion requirement |
| --- | --- | --- |
| Tagged documents with clear local defects | Preserve valid structure and apply qualified local repairs | Each repair has preconditions, tests, and independent postconditions |
| Untagged born-digital documents | Construct native tags using existing parser, matcher, and writer | Complete content/reference checks and calibrated semantic decisions |
| Ordinary AcroForms | Preserve all fields and widgets; repair supported relationships | Tests cover fill, toggle, select, save, reopen, and keyboard navigation |
| Scans and mixed native/OCR pages | Retain selective OCR; unresolved recognition or alignment becomes review work | Region-level OCR/text alignment and interaction preservation meet the same release gates |
| Complex tables, figures requiring descriptions, formulas, uncertain language or reading direction | Preserve content and identify the unresolved requirement | Reviewed examples and qualified representations for each capability |
| Dynamic XFA, signed/certified files, unsupported encryption, portfolios, complex interactive actions, PDF 2.0 structures outside tested support | Inspect where possible and return an explicit support outcome before mutation | Dedicated compatibility work and fixtures; no silent conversion to a different feature set |

PDF/UA-1 is the first validation target. PDF/UA-2 requires its own profile, namespace and role rules, fixtures, and reader validation. Keep target-profile selection in the contracts so this expansion does not require another pipeline.

### Separate execution from acceptance

Keep the existing job lifecycle (`queued`, `running`, `completed`, `failed`) compatible. Add a quality report and additive job summary; a completed job may produce a review candidate rather than an accepted output.

| Proposed quality disposition | Meaning | Artifact behavior |
| --- | --- | --- |
| `accepted` | Required automated checks completed, policy gates passed, and no unresolved required review remains | Publish the accepted PDF and reports together |
| `review_required` | A usable candidate exists, but semantic uncertainty, known unresolved defects, or a required review remains | Expose a clearly labeled candidate and localized review tasks |
| `rejected` | A candidate violates preservation or structural requirements | Retain diagnostics; do not expose it as an accepted result |
| `unsupported` | The input falls outside the enabled feature or resource envelope | Preserve the input and explain the unsupported feature |
| `error` | A required inspection, writer, or validator could not complete | Preserve failure evidence; do not infer a pass |

`accepted` means acceptance under the named policy, not a blanket WCAG or PDF/UA certification. Report raw machine conformance, independently adjudicated findings, and human review coverage separately. Required human checks remain pending unless there is recorded evidence of completion.

## 2 Verified starting point (before these deliveries)

| Existing implementation or evidence | Consequence for this plan |
| --- | --- |
| `modules/pdf-writer/index.js` now prefers preservation for sufficiently tagged sources; `PASSTHROUGH_MINIMAL` defaults to preservation | Keep this behavior and introduce qualified repairs incrementally |
| Wrapped-heading grouping and repair exist in `modules/semantic-engine/heading-continuation.js` and `PassthroughMetadataCli.java` | Extend their evidence and fixtures; do not implement a second heading merger |
| `PassthroughMetadataCli.java` already includes link/widget wrapping, heading normalization, font remediation, Unicode helpers, and structural probes | Characterize and adapt selected routines instead of enabling the entire legacy repair pass |
| `wrapWidgetAnnotations` currently appends newly created Form elements beneath the document container | Preserving existing fields is solved more thoroughly than placing new field tags beside their labels |
| `scripts/build-tag-delta-report.js` compares counts and page metrics | Extend the existing inspection/delta path to compare actual content ownership and relationships |
| `modules/native-verify/lib/metrics.js` measures operator-count preservation and role-sequence similarity | Keep these as diagnostics; they are insufficient acceptance measures |
| `readingOrderInversionCount` in `modules/mcp-corpus-eval/lib/scorers.js` uses node array order | Fix it before using it to evaluate reading-order changes |
| `scripts/run-ci-tests.js` skips goldmasters unless `GOLDMASTER_STRICT=1`; font corpus coverage depends on corpus availability | Establish mandatory portable release fixtures and make missing required suites fail release CI |
| `modules/pdf-writer/test/pipeline-output-regression.test.js` permits a corpus-wide set of finding codes | Replace that gate with per-document, per-location baselines that detect new occurrences of known codes |
| `contracts/semantic.schema.json` allows roles H1–H3 while its heading level permits 1–6 and the tag contract supports H1–H6 | Resolve this contract mismatch before broader hierarchy work |
| `orchestrator/accessibility-stage-plan.js` has paragraph/reading-order fallbacks and emits the PDF before final validation | Carry fallback evidence into acceptance and publish an accepted artifact only after the gate |
| `modules/validator/index.js` records raw and adjusted summaries; failed font audits are recorded separately | Preserve raw evidence and make missing required audit results an explicit acceptance failure |
| The current normal tagging stage plan does not explicitly invoke the font-embedder stage described in SPEC | Trace writer-internal behavior and select one font-plan producer; prevent duplicate or missing remediation |

The reading-order defect was reproduced with two nodes: a reversed `orderedNodeIds` returned zero inversions; a reversed storage array with correct `orderedNodeIds` returned one. This is a measurement defect, independent of whether a particular PDF's generated order is correct.

The pre-implementation TEST-FORM baseline is `output/TEST-FORM-heading-20261013/`. Its verification records one complete title, 32 fields, preserved widget placement and text, and identical 72-DPI renders. Its adjusted veraPDF summary has nine failed rules and 89 failed checks:

| Failure family | Failed checks | Planned owner |
| --- | ---: | --- |
| Font embedding, widths, and CIDSet | 45 | Workstream 7 |
| Link structure and annotation/link descriptions | 27 | Workstreams 2 and 3 |
| List item children | 12 | Workstreams 2 and 4 |
| Custom-role mapping | 3 | Workstream 2 |
| Heading hierarchy | 2 | Workstream 4 |

These are check counts, not counts of distinct defective objects. The report also contains font-audit findings. Preserve both sources in the baseline. These historical results are a starting point, not a fresh benchmark of the complete repository.

## 3 Architecture and contract decisions

### Reuse the existing module boundaries

Keep the CLI-based pipeline, Node, PDFBox, PDF.js, AJV, and current OCR infrastructure. No new rendering engine, model service, queue, or generic workflow framework is required for the first release.

1. Snapshot and fingerprint the input; inspect its features, existing structure, fields, resources, and restrictions once.
2. Run the existing preparation stages. Propagate stable source references and evidence through layout, semantics, reading order, and tags.
3. Write a private candidate using a declared mode and bounded repair plan. Inspect and validate the resulting PDF independently of the writer's claimed success.
4. Compare source, intended changes, and actual output. Produce the quality decision, then publish the accepted artifact atomically or return a labeled review candidate.

Keep the PDF inspector behind its existing CLI in `scripts/inspect-pdf-low-level.js` and `scripts/java/LowLevelPdfInspectorCli.java`. Add a proposed quality CLI under `modules/validator/` that consumes inspection and report files; it must not import another engine module's implementation. The orchestrator owns process sequencing and artifact publication.

Source inspection may be reused by content hash, inspector version, and configuration. Candidate inspection is always tied to the candidate's hash. Avoid reparsing the whole PDF independently for every rule.

### Engineering limits

Start each slice with one failing example, one counterexample that must remain unchanged, and the expected saved-PDF result. Extend an existing component unless that boundary demonstrably prevents the change. New contracts are small typed records; the repair registry is a fixed set of operations, not a general rule language. The relation vocabulary does not require a graph database or a replacement document model.

Land only the contract fields needed by the next consumer. Expand inspection coverage incrementally, marking uninspected features unknown until qualified. Reuse current fixture generators, reports, queue controls, and UI surfaces. Keep ML in observation mode until it improves held-out semantic outcomes and passes the same gates; model training is not on the critical path for these repairs.

For an uncertain PDFBox or viewer behavior, produce a minimized fixture and a decision about the supported approach before broad implementation. Dependency upgrades are separate changes with their own corpus comparison. Stop an approach that cannot preserve meaning or interaction and retain a review outcome instead of accumulating special cases without evidence.

### Proposed contract changes

Implement contracts and contract tests before dependent consumers. These are proposals for the contract owner; this plan does not modify the shared schemas. Prefer additive fields and separate new schemas. If a legacy enum or consumer cannot safely accept an extension, provide a versioned boundary instead of silently changing its meaning.

| Contract | Minimum addition | Required invariant |
| --- | --- | --- |
| New `pdf-inspection.schema.json` | Source hash, inspector version, feature inventory, scoped content references, structure relationships, fields/widgets, resource inventory, inspection coverage/errors | Missing or failed inspection is distinct from an empty successful result |
| `layout.schema.json` | Typed source references, page transforms, separate field/widget identities, source of native/OCR text, optional region and language evidence | Preserve existing IDs; every new reference resolves to the inspected input |
| `semantic.schema.json` | Resolve H4–H6 support; optional `relations` and `decisionEvidence`; typed stable provenance | Existing `sourceBlockId`, `sourceBlockIds`, `formFieldIds`, `orderedNodeIds`, and confidence remain compatible |
| `tagging.schema.json` | Explicit widget placement/association and approved header/relationship fields where absent | Referenced semantic nodes and source objects exist; no duplicate widget ownership |
| New `repair-plan.schema.json` | Rule ID/version, target references, preconditions, intended change, evidence, risk class, expected postconditions | Hash-bound targets; no arbitrary executable code or unrestricted object-edit language |
| New `quality-report.schema.json` | Disposition, policy version, input/output hashes, dimension results, findings, repair results, review tasks, timings | All required dimensions have explicit pass/fail/unknown/not-applicable states |
| Existing validation and normalized compliance contracts | Preserve raw/adjudicated machine outcomes; add human-review status and adjudication evidence | A PDF/UA machine result must not be converted into a general WCAG AA assertion |
| `pipeline-job.schema.json` and profile contract | Quality artifact/summary, candidate versus accepted artifact references, rule policy, target conformance profile, resource policy | Preserve lifecycle and CLI compatibility; incomplete candidates are never mislabeled accepted |

Use a small relation vocabulary initially: `labels`, `describes`, `belongsToGroup`, `continues`, `precedes`, `captionFor`, and `headerFor`. Each relation carries source/target IDs, evidence, and decision status. Reuse existing table/list fields where they already express the relationship; do not duplicate the same fact in competing representations.

A decision record contains `ruleId`, `ruleVersion`, applicable source references, evidence signals, `decision` (`apply`, `preserve`, `review`, or `reject`), and reason codes. Existing heuristic confidence is a score, not a calibrated probability. Store calibration identity only when measured calibration exists.

Start with an explicit production profile so existing clients can migrate before default behavior changes. Update server, desktop, and report consumers to distinguish accepted and candidate artifacts and handle completed jobs without an accepted PDF. Compatibility tests must cover those consumers, not just schema validation.

### Identity and reference rules

- Identify marked content by document hash and owning content scope plus MCID. Page number plus MCID alone is insufficient for nested or reused Form XObjects.
- Preserve the distinction between a field and its widgets: one field may have multiple widgets on multiple pages. Track indirect object number and generation within a file, plus an output mapping when a rewrite changes them.
- Track XObject invocation paths and coordinate transforms for placement. Reused content resources must not be mistaken for duplicated logical text.
- Keep source operator references and block lineage through merges and splits. Node IDs based on array indices are not durable correction anchors.
- Resolve inherited page, language, and field attributes. Detect cycles and limit traversal depth before recursive inspection or repair.
- Compare the actual saved PDF, including nested content and annotations, with the intended result. A JSON sidecar is not evidence that its relationships were written correctly.

## 4 Workstream 1 Quality decisions and independent verification

**Owner:** validator and corpus-evaluation modules, inspection scripts, orchestrator. **Dependencies:** contract decisions and baseline fixtures.

Implement the reading-order metric fix first: resolve explicit `orderedNodeIds`, verify they are a complete unique permutation, otherwise use valid explicit reading-order values. Do not silently invent an order when supplied IDs are missing or duplicated. Use language/region direction when a horizontal-order check applies. Add relationship-based evaluation beyond the existing horizontal inversion heuristic.

Extend source/output inspection to check text and non-text content ownership, headings and lists, fields and widgets, link targets, page dimensions, annotations, structure references, marked-content balance, ParentTree/IDTree consistency, and referenced resource resolution. Compare expected mutations from the repair plan so that a valid two-heading-to-one-heading repair is not falsely rejected as a lost heading.

Keep independent gates for preservation, structure, machine validation, semantic uncertainty, and required review. A high score in one dimension cannot compensate for a failed dimension. Mandatory checker crashes or timeouts produce `error`; optional unavailable diagnostics remain explicitly unavailable. Existing fallbacks propagate into the decision rather than disappearing in a completed stage.

Make review tasks actionable: task ID, rule/reason, page and region, exact content references, current decision, alternatives, and the evidence needed to resolve the issue. Review responses carry reviewer identity, task ID, input/candidate hashes, decision, and explanation. Reuse the existing inspector/report surfaces for this first workflow. Accepted corrections become a bounded repair plan and rerun affected checks; stale responses cannot approve a changed document. Keep review history as versioned evidence rather than editing the original report in place.

**Acceptance:** injected text loss, a dropped field, an orphan reference, a duplicate widget tag, an invalid order permutation, and a required-checker crash each prevent acceptance. A justified heading merge passes. A pre-existing defect remains visible even when it was not introduced by the engine. Both reproduced order-metric cases return the correct result.

**Boundary cases:** malformed source tags, valid repeated content, ligatures and combining characters, multiple content streams, nested/reused XObjects, rotated/cropped pages, invisible but meaningful text, and annotations without page text.

## 5 Workstream 2 Qualified repair of existing structure

**Owner:** PDF writer, with independent validator checks. **Dependencies:** Workstream 1 and repair-plan contract.

Introduce a small writer-local registry around existing repair routines. Each rule exposes detection, preconditions, bounded mutation, and postconditions. Classify it as structure-only, metadata-only, annotation-related, or content/resource-changing. Extract helpers from `PassthroughMetadataCli.java` only as a rule needs isolation; avoid a wholesale rewrite of that class.

Start with four operations: confirmed heading continuation; wrapping existing list-item content into valid label/body containers; completing a demonstrably known role mapping; and connecting an existing link annotation to its actual text and location. Reuse valid IDs, classes, attributes, page references, destinations, and object references. Unknown custom roles or descriptions become review tasks; generic replacement text is not proof of a correct description.

Run detection against an immutable input snapshot, reject stale preconditions, apply the planned batch to a candidate, save once, reopen, and verify. A failed batch discards that candidate. A bounded retry may rebuild from the original with the failing rule disabled; never keep repairing a partially mutated document or run an unbounded repair loop.

Replace the all-or-nothing broad legacy repair switch over time with individually qualified policy entries. Retain legacy CLI behavior through compatibility mapping; never turn on all existing passes as a shortcut to fewer validator findings.

**Acceptance:** each enabled rule has positive, negative, idempotence, and failure-injection fixtures. Unaffected content and relationships remain equivalent. A second run makes no additional logical repairs; timestamps and serialization differences are excluded from this idempotence comparison. Source bytes remain unchanged.

**Boundary cases:** direct and indirect children, MCR/OBJR mixtures, inherited `/Pg`, nested list bodies, RoleMap chains/cycles, missing ParentTree entries, shared resources, and malformed input. Content that is undecodable must not be deleted or marked decorative merely to reduce failures.

## 6 Workstream 3 Form relationships and interaction

**Owner:** parser, semantics, tag builder, writer. **Dependencies:** typed widget identity, relationships, Workstreams 1 and 2.

Promote the existing widget bounds and field IDs into a complete form inventory: parent/child field relationships, fully qualified names, widget references, types/flags, accessible names, values/defaults/export states, appearance states, choice options, actions, and page locations. Preserve sensitive values in protected job artifacts only.

Associate labels using existing authored structure and names first, then compatible geometry, reading region, and wording. Distinguish a group prompt from an individual option label. Handle labels above, below, or beside a field and labels split across lines. Ambiguous candidates remain unassociated with a localized review task.

Emit Form/OBJR relationships at the semantic field location for native tagging and targeted repairs. Place checkboxes within the appropriate option/list body. Derive keyboard order from the same relationships used for reading order, while preserving field identity and behavior. Writing an accessible name must not rename the programmatic field or change its export value.

W3C's form technique explicitly tests name, role, value/state, and interaction. The release fixtures must exercise those properties, not just count surviving field dictionaries. [W3C PDF form controls](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF12).

**Acceptance:** 100% of expected fields and widgets survive; each applicable visible widget has one correct structural owner and resolvable object reference. Labels and option/group associations match reviewed truth. Fill, toggle, select, reset where supported, save, reopen, and keyboard navigation succeed. TEST-FORM retains its 32 fields and the baseline widget inventory.

**Boundary cases:** radio groups with multiple widgets, repeated field names, inherited attributes, multiline text, choice fields, checked/unchecked states, hidden/read-only/required controls, signature fields, rotated widgets, and cross-page groups. Signature-bearing and dynamic forms use the support policy before any mutation.

## 7 Workstream 4 Document hierarchy and text grouping

**Owner:** layout analyzer, semantic engine, paragraph merger, tag builder; writer for preserved tags. **Dependencies:** provenance and hierarchy contract correction.

Build a document-level style inventory from real font identity, size, weight, spacing, indentation, numbering, repeated position, and surrounding text. Use it to infer title and section relationships before assigning heading levels. Keep institutional branding, running headers, field labels, and body emphasis distinct from section headings.

Extend the existing wrapped-heading rule with an evidence-backed grouping decision, including mixed font runs and punctuation where fixtures support them. Keep the same cases and expected decisions in shared test data for semantic generation and preserved-PDF repair so the Java and JavaScript paths cannot silently diverge.

Retain paragraph boundary guards and the conservative Forms default. Add explicitly supported paragraph/list continuation cases rather than broadly re-enabling merging for forms. Recover wrapped list bodies, nested numbering, checkbox options, and cross-page continuations without swallowing intervening instructions or headings.

Apply hierarchy normalization only after the section relationships are known. Renumbering tags to satisfy a validator alone cannot establish that the title or section levels are correct. Preserve existing hierarchy when contradictory evidence is insufficient.

**Acceptance:** the complete Supplemental Affirmation title remains one heading; branding and subtitles have reviewed roles; headings H1–H6 traverse every contract and writer path. Nested and continued lists match expected membership, labels, and bodies. Negative examples of bold prose, field labels, and adjacent independent headings remain separate.

**Boundary cases:** all-capital headings, same-size heading/body text, mixed-script text, numbered legal paragraphs, centered titles, short labels, small caps, footnotes, repeated headers, and page breaks inside items.

## 8 Workstream 5 Tables and header associations

**Owner:** layout analyzer, semantics, tag builder, writer. **Dependencies:** quality gate and reviewed table fixtures.

Extend existing ruled-table extraction, borderless/text-grid detectors, spanning-cell support, and header association code. Generate candidate regions, then compare evidence for a data table against competing explanations: prose columns, form blanks, equations, addresses, and aligned lists. Widget presence is evidence, not an absolute prohibition on tables containing controls.

Require a consistent row/column model and meaningful cell relationships before table promotion. Treat the first row as a header only when supported. Resolve multi-level row/column headers through the existing header IDs, scope, spans, and header-reference machinery. Keep repeated page headers connected to continued tables without treating them as new data rows.

Validate the cell occupancy model: no unsupported overlaps, spans inside table bounds, correct header references, preserved empty cells, and no invented content to complete a grid. Separate tables on the same page must remain independent.

**Acceptance:** reviewed form/prose traps produce no false tables; genuine tables retain expected cells, spans, sections, and header relationships in the saved PDF. Complex ambiguous tables route to review. Measure false promotion and missed-table rates separately.

**Boundary cases:** broken borders, borderless rows, multiline cells, sparse numeric content, merged headers, row headers, nested content, multiple tables per page, rotated tables, and continuation across pages.

## 9 Workstream 6 Logical reading order

**Owner:** reading-order module, semantics, tag builder, corpus evaluator. **Dependencies:** region evidence, relationships, corrected metrics.

Retain the existing page units for lists, tables, and column bands. Add explicit precedence constraints for document regions and relationships: heading before section, prompt before options, label with control, and caption with the associated object. Establish a documented policy for footnotes and sidebars using reviewed truth rather than simply sorting all objects by vertical position.

Use a deterministic topological order within the applicable scope, with geometry only as the tie-breaker. Detect conflicting constraints; remove only a clearly lower-evidence inferred edge or request review. Source-authored, valid relationships have distinct provenance and cannot be silently overridden by a weak geometric guess.

Represent valid ordering as required relationships where several reading sequences are acceptable. Preserve the distinction between logical tag order, content order within a tag, and keyboard focus order. Numerical MCID order need not equal logical reading order; a difference is diagnostic evidence, not automatically a defect.

**Acceptance:** all required precedence relationships hold on golden fixtures, order IDs form a complete unique permutation, and label/control sequences agree with keyboard behavior. Add negative tests for cross-reading columns and repeated/skipped content. Verify both tag order and resolved text within merged tags.

**Boundary cases:** full-width headings above columns, interleaved source paint order, sidebars, footnotes, figures between paragraphs, right-to-left text, rotated text, cross-page lists/tables, and link/field navigation.

## 10 Workstream 7 Fonts and Unicode with preserved appearance

**Owner:** font embedder, writer, validator. **Dependencies:** complete resource inventory, rendering/text checks, candidate isolation.

First trace the actual font-plan path through the current orchestrator and writer. Choose one producer and one consumer for each plan; reuse `font-inventory.schema.json`. Inventory fonts in pages, nested XObjects, annotation appearances, AcroForm default resources, and inherited resources using bounded traversal and shared-resource identity.

Separate operations that add missing metadata/mappings from operations that substitute fonts or rewrite encoded text. For mappings, require evidence from actual encoding, glyph identity, font programs, or reviewed source truth. A nonempty mapping, private-use character, replacement glyph, or generic ActualText value is not proof of semantic correctness.

For font substitution, update character encoding, glyph mapping, widths, text positioning, and affected appearances coherently. Test current field values and future typed text. Clone shared resources when a local repair must not affect another usage. Check every rewritten stream and final saved font program; prefer supported metadata fixes over re-embedding an already correct font.

**Acceptance:** targeted font findings are resolved at their actual object locations without new findings, changed text meaning, clipping, missing symbols, or broken field appearances. Font-resource and appearance tests include checked and unchecked options and reopened filled forms. Unresolvable mappings become review work.

**Boundary cases:** Standard 14, symbol/dingbat fonts, subset prefixes, Type0/CID, Type1/CFF, Type3, ligatures, combining marks, CJK/RTL, invisible OCR layers, shared/nested resources, and incremental saves. Unsupported combinations remain outside automatic repair until qualified.

## 11 Workstream 8 Corpus and reader verification

**Owner:** module tests, integration/goldmaster tests, CI scripts, corpus evaluator. **Dependencies:** begins immediately and accompanies every workstream.

Use the existing fixture builders, goldmasters, font fixtures, and corpus tools. Add a versioned manifest with source checksum, provenance/redistribution status, producer, feature categories, reviewed expectations, target profile, expected findings at stable locations, and reviewer status. Keep TEST-FORM as a local regression anchor unless its distribution rights are established; create redistributable synthetic fixtures for the underlying failures.

Bootstrap a required portable set of at least 40 compact fixtures: 12 form cases, 8 hierarchy/list cases, 8 table/order cases, 6 font/OCR cases, and 6 rejection/recovery cases. Multiple features may appear in each file, but count each file once. Add a reviewed real-document set of at least 30 documents from at least five producer families before general production promotion. Counts are coverage floors, not a proof of quality.

Count existing qualifying fixtures toward these floors. Add a new fixture only for an uncovered behavior or a minimized regression. Reuse the current synthetic generators and corpus inventory before acquiring or generating another dataset.

Keep development, calibration, and locked evaluation sets separate by template/document family and producer lineage. Reuse `machine-learning/leakage-control-plan.md`; variants of the same form must not appear on both sides of an evaluation split. Review ambiguous truth with a second reviewer and preserve disagreement as uncertainty.

Replace global finding-code allowlists with per-fixture expected findings keyed by rule, stable content/object anchor, and bounded count. A known rule appearing on a new object is a regression. Legitimate fixes update the fixture truth through review; a bulk goldmaster refresh cannot approve itself.

Run full reader checks on at least six representative documents: native form, preserved form, multi-column report, table, mixed-language document, and OCR sample. Use pinned viewer/screen-reader combinations, initially Acrobat Reader with NVDA on Windows and a second independently chosen supported combination. Record versions, expected actions, heading/list/table navigation, label announcements, fill/save/reopen, reading sequence, and failures. An accessible-tree snapshot supports these checks but cannot replace all reader behavior.

**Acceptance:** every claimed feature has positive, adversarial, and rejection fixtures; release CI executes all required suites and fails when required fixtures/tools are absent. Raw validator artifacts and reader evidence accompany the release. Existing development commands retain their documented behavior while a new strict release command becomes authoritative.

## 12 Release gates and measurements

The following are proposed release criteria. Benchmark them against the frozen baseline and refine the support envelope when a target is missed; do not loosen a threshold merely to pass the current implementation.

| Dimension | Release gate | Measurement details |
| --- | --- | --- |
| Source preservation | Zero source mutations | Snapshot hashes before/after; exercise cancellation, crashes, retries, and concurrent jobs |
| Native content | Zero unexplained loss, duplication, or semantic substitution | Compare scoped content lineage and extracted text; preserve punctuation, numbers, case, and meaningful whitespace; qualify normalization by content type |
| Interactive behavior | Zero lost fields/widgets/options/actions or unintended value changes | Compare identities, relationships, flags, states, appearances, destinations, and permitted behavior; actual interaction tests supplement inventory checks |
| Structure | Zero introduced defects and zero unresolved critical structural defects in an accepted output | Inspect the saved output recursively for dangling references, cycles, invalid ownership and malformed marked content, including ParentTree, IDTree, MCR/OBJR, and XObjects; distinguish source defects from introduced defects |
| Visual fidelity | Exact pinned-renderer equality for structure/metadata-only repair fixtures | For content/font repair use calibrated local image differences plus glyph/geometry checks; any unexplained changed region blocks acceptance; no aggregate score can hide a missing character |
| Machine validation | Zero unresolved failures for an output claimed machine-conformant | Preserve raw reports and target/profile versions; adjudications require exact evidence and remain visible; mandatory missing checks are errors |
| Semantic correctness | All reviewed expected relationships pass in the required fixture set | Test meaning and relationships, not only tag counts or tree depth |
| Automatic decisions | Initial target at least 99.5% precision and 97% recall per eligible feature class on held-out truth | Precision is correct applied decisions divided by all applied decisions; recall is correctly recovered ground-truth relationships divided by all eligible ground-truth relationships, with abstentions counted as misses; publish counts, document-level success, intervals, and review rate |
| Calibration evidence | At least 1,000 reviewed decisions per promoted inferential rule family across at least 30 documents and three producers | Document/template clustering matters; report uncertainty by family; deterministic repairs may instead qualify through complete precondition coverage and exhaustive small fixtures |
| Reading order | 100% required precedence edges on mandatory fixtures | Score the declared order, with correct language direction and within-tag text order; report critical crossings separately |
| Repeatability | No further logical edits on a second run; stable decisions across repeated identical runs | Ignore documented volatile metadata; bind results to dependency and policy versions |
| Critical code coverage | At least 90% line coverage for new/changed engine code, all critical guard and recovery branches exercised | Report Java and Node coverage separately; line coverage does not replace semantic or interaction tests |

Do not count unknown/unsupported inputs as successful automation. Report eligible-document count, automatically accepted count, review-required count, rejection/error rates, and whole-document correctness alongside feature-level metrics. A system that abstains on everything cannot meet the recall and automation objectives.

Freeze eligible feature classes before evaluation. Keep confidence intervals and document/template clustering visible; the corpus floors alone cannot establish a universal accuracy claim. One critical content-loss or interaction defect blocks promotion even when an aggregate precision target passes.

For qualification renders, compare every fixture page at 150 DPI and inspect affected text/appearance regions at 300 DPI. Use fixed renderer versions and settings for equality checks. Add cross-library checks using the existing PDF.js and PDFBox paths, with Poppler as an independent QA renderer where available. Production checks may share a parser library but must recompute facts from saved bytes rather than trust mutation counters. Thresholds for permissible rendering differences must be calibrated on benign changes and deliberately removed/altered glyphs; every seeded loss must still be detected.

### Test matrix

| Area | Required variants |
| --- | --- |
| Existing structure | Valid, absent, partly tagged, malformed, custom roles, cyclic references, direct/indirect children, nested/reused XObjects |
| Geometry | CropBox offsets, page rotation, transformed text, multiple columns, full-width regions, shared XObject placements |
| Forms | Text/checkbox/radio/choice/button/signature; inherited flags; repeated widgets; labels and groups; all relevant appearance states |
| Hierarchy | H1–H6; branding/title/subtitle; mixed fonts; wrapped headings; nested/continued lists; paragraph boundary traps |
| Tables | Ruled/borderless/broken grids; headers and spans; repeated headers; empty cells; form/prose/equation traps |
| Text and language | English/Spanish baseline; punctuation and legal numbering; ligatures and combining marks; mixed-language and unsupported-direction routing |
| OCR | Scan-only and mixed pages; duplicate hidden layers; recognition disagreement; low-confidence text; missing language data |
| Figures and formulas | Existing valid descriptions retained; meaningful images without descriptions flagged; equations not silently converted into tables or artifacts |
| Integrity | Links/destinations, annotations, outlines, metadata/language, attachments, actions, signatures/encryption detection |
| Failure and load | Disk full, permission error, invalid JSON, subprocess crash, validator timeout, canceled job, stale repair plan, duplicate completion, oversized/deeply nested input |

### Further content qualification

| Capability | Reuse and next implementation boundary | Qualification requirement |
| --- | --- | --- |
| OCR and mixed pages | Extend parser selection and region alignment; keep native and recognized text provenance distinct | No duplicate invisible text or invented form values; digit/punctuation errors, missing language data, and low-confidence regions generate review tasks |
| Images, charts, and artifacts | Extend existing Figure/Caption handling and review tasks | Retain correct authored descriptions; meaningful content cannot become decorative merely because extraction or description generation failed; review descriptive adequacy |
| Formulas and scientific notation | Preserve content and use a qualified formula representation through an explicit contract extension | Mathematical meaning and reader behavior verified on reviewed examples; no fabricated text equivalent or forced table classification |
| Language and direction | Extend current language detection with scoped language/direction evidence and inherited attributes | Mixed-language voice changes and direction-sensitive reading order verified in target readers; unknown language stays unknown |
| PDF 2.0 and advanced forms | Separate target profiles and compatibility fixtures | Namespace/role, encryption, signature, and interactive-feature requirements qualified before automatic mutation |

These capabilities use the same inspection, evidence, repair, and acceptance contracts. Their expansion must not introduce a second pipeline or weaken the initial release gates.

## 13 Operational requirements

### Candidate isolation and publication

Use an immutable input snapshot. Existing hard-link staging requires special attention: changes to either link can affect the same bytes. A production snapshot must be isolated or verified under a clearly enforced read-only contract; test external input modification during a job.

Write candidates to unique job/attempt paths. Publish a versioned artifact directory and commit its accepted pointer only when the PDF, manifest, reports, and checksums are complete. Verify crash behavior on Windows and Linux; do not assume remove-then-rename gives atomic replacement. Retried jobs must not overwrite an already accepted result with a stale candidate.

Keep source-preservation and redaction workloads distinct. Accessibility repair may use incremental saving; redaction output must not retain recoverable removed content in previous revisions, source text maps, reports, or the tag tree. Give redaction its own content-removal invariants and retained-artifact policy. Never apply the accessibility preservation gate unchanged to a redaction job.

### Resources and execution

Reuse existing stage attempts, heartbeats, runtime paths, and worker machinery. Add bounded subprocess duration, process-tree cancellation, memory/output/decompression limits, recursion/object-count limits, and temporary-storage quotas. Retry only transient infrastructure failures; deterministic semantic failures go directly to review or rejection.

Benchmark native, preserved, and OCR jobs separately on documented Windows and Linux reference workers. Record cold/warm startup, p50/p95/p99 duration, peak memory across child processes, temporary disk use, and throughput at one and two concurrent jobs. Before release, bind supported file/page limits and timeouts to measured ceilings in the profile rather than scattering constants through modules.

Proposed efficiency targets: core non-rendering inspection/gating adds no more than 25% p95 time to the same baseline workload; required rendering and full validation have separately reported budgets. Stage failures or cancellation must terminate descendants and return a final status within ten seconds of the configured termination deadline. Memory and disk reservations must keep two worst-case admitted jobs inside the published worker limits. These are qualification targets, not current performance claims.

### Deployment and traceability

Pin runtime, PDFBox, PDF.js, OCR data, fonts, and validator/profile versions; verify packaged checksums and record them in every job report. Include policy/rule versions, input/output hashes, enabled fallbacks, repair counts, review reasons, and stage timings. Keep raw field values and document text out of routine telemetry.

Treat uploaded PDFs as untrusted input: do not execute embedded actions or fetch referenced network resources during inspection. For hosted deployments, verify authentication and job/artifact authorization, path containment, upload/output limits, workspace isolation, and retention/cleanup behavior. Package required OCR languages for offline processing or make an allowed download policy explicit. Include dependency/license inventory and update qualification in the release process.

Keep an operational rollback to the last qualified rule set. Disable a misbehaving repair by versioned policy while retaining diagnostics. Policy changes and renderer/validator upgrades run the same corpus gates as code changes.

## 14 Implementation sequence

Each change should be independently reviewable and testable. The following slices are scope boundaries rather than calendar estimates. Module owners coordinate through contracts; a slice touching shared contracts begins with the contract owner.

| Slice | Deliverable | Depends on | Exit evidence |
| --- | --- | --- | --- |
| P01 | Freeze source/config/dependency fingerprints and portable baseline manifest; record existing failures | None | Reproducible baseline report and fixture coverage map |
| P02 | Correct reading-order evaluation and permutation validation | P01 | Both reproduced defects and malformed-order fixtures pass |
| P03 | Land the minimum inspection/quality contracts, then stage relationship, repair, and hierarchy additions with their consumers | P01 | Old fixtures still validate; new valid/invalid contract fixtures pass |
| P04 | Extend existing inspector with scoped content, structure, and widget ownership | P03 | Nested/reused-resource and malformed-input fixtures pass |
| P05 | Implement quality decision CLI, review-task exchange, and raw/adjudicated/review separation | P02–P04 | Mutation tests prove each critical defect blocks acceptance; stale review responses are rejected |
| P06 | Stage candidates and gate artifact publication through the orchestrator and existing client surfaces | P05 | Crash, retry, stale completion, cancellation, and client compatibility tests preserve source/accepted output |
| P07 | Add writer-local repair registry; adapt the current heading repair | P03–P06 | Same supported heading results, explicit ledger, idempotence, rule disablement |
| P08 | Qualify local list-container and role-map repairs | P07 | Positive/negative/reference-preservation fixtures and actual output checks |
| P09 | Qualify link structure and evidence-backed annotation descriptions | P07 | Correct destinations, descriptions, ownership, and source appearance |
| P10 | Complete form inventory and label/group relationships | P03–P05 | Reviewed relationship truth plus ambiguous-case review tasks |
| P11 | Write native/repair Form tags at their semantic locations and align navigation | P07, P10 | Fill/save/reopen and reader/keyboard checks on native and preserved forms |
| P12 | Build document style/section evidence and extend heading grouping | P03–P05, P07 | H1–H6 and title/branding/heading trap fixtures pass in both paths |
| P13 | Extend paragraph/list continuation within proven boundaries | P12 | Nested/cross-page lists correct; form labels and options remain distinct |
| P14 | Strengthen table-vs-form/prose decision and complex header verification | P03–P05 | Reviewed true/false table corpus and saved-PDF cell/header checks |
| P15 | Add reading precedence relationships and deterministic conflict handling | P02, P10, P12–P14 | Required edges, within-tag sequence, and direction-sensitive tests pass |
| P16 | Unify font-plan production/consumption and qualify metadata/mapping fixes | P04–P07 | One plan per font, scoped resources, exact evidence, no guessed Unicode |
| P17 | Qualify font/appearance rewrites for supported resource types | P11, P16 | Image/text/interaction gates and all font finding locations verified |
| P18 | Mandatory strict corpus CI, held-out evaluation, reader qualification | Starts P01; expands through P17 | All required suites execute, metrics and review evidence meet release gates |
| P19 | Resource limits, isolation, cancellation, packaging, telemetry, and load qualification | Starts P06; completes after P18 | Published envelope, fault-injection results, operational runbook |
| P20 | Shadow deployment, limited opt-in promotion, then supported-profile default | P18–P19 | Acceptance/review/error rates and semantic samples remain within gates; rollback exercised |

The first functional milestone is P01–P11 with the necessary P18/P19 checks: safe source inspection, honest acceptance, targeted repairs, and complete form relationships. TEST-FORM should become either a demonstrably improved accepted output or a candidate with precise remaining tasks. Do not promise zero failures by enabling unqualified font or hierarchy routines.

The first three reviewable deliveries are deliberately smaller than that milestone: (1) the two reading-order metric regressions plus a required baseline fixture; (2) source/candidate comparison that catches a dropped field, a lost heading, and a required-checker failure; (3) an opt-in list-container repair with correct widget placement retained. For the third delivery, pin the existing 12 TEST-FORM list-child failures and require that the targeted violations disappear without any new content, field, or structural regression. Ambiguous list semantics must remain review tasks. This delivers a measurable form improvement before the broader hierarchy, table, and font work.

The second milestone adds document hierarchy, tables, and reading-order work. The third qualifies font rewrites and the broader support envelope. Corpus work and runtime hardening begin early; they are not deferred until all detection changes are finished.

## 15 Rollout and completion rules

Move each rule through `disabled`, `observe`, `candidate-only`, and `qualified` policy states. Observation records proposed decisions without changing accepted output. Candidate-only enables inspection and review. Qualified activation requires the rule's fixtures, semantic metrics, interaction checks where applicable, and runtime budget to pass.

A completed slice includes contract compatibility, implementation, positive and adversarial tests, critical branch coverage, actual output verification, updated documentation, and reproducible evidence. A changed rule includes its disable path and idempotence checks. A corpus expectation change includes the reason and reviewed truth.

Before general production promotion, require all of the following:

- The support matrix is explicit, versioned, and enforced before risky processing.
- Mandatory inspectors, font audit, validators, and release suites cannot silently disappear or count as passes.
- No critical preservation, structural, interaction, or publication regression remains in the required corpus.
- Machine validation and review status are distinct throughout reports, API summaries, and downloads.
- Reader and keyboard checks pass for every advertised primary workflow.
- Font and content rewrites have local visual and semantic evidence, including newly entered form values.
- Failures, retries, crashes, cancellation, and resource exhaustion preserve the source and previously accepted artifacts.
- The packaged deployment reproduces the qualification run with pinned dependencies and offline resources as configured.
- Operators can identify a failed rule, disable it, retain diagnostics, and return to the prior qualified policy.

The engine should resolve cases it can prove and make the remaining work specific. That is the production standard against which every proposed improvement is evaluated.

## 16 Implementation record - 20 October 2026

The first three reviewable deliveries in section 14 are complete as an opt-in candidate workflow. They do not complete the wider P01-P20 roadmap or qualify a general production release.

| Delivery | Implemented behavior | Evidence |
| --- | --- | --- |
| Reading-order measurement and required baseline | Explicit `orderedNodeIds` wins over storage order; numeric order is used only when no ID sequence is supplied. Invalid permutations, geometry, or explicit numeric order return unavailable. Horizontal scoring respects explicit direction, rotation, columns, artifacts and pages; legacy array order remains compatible when no order metadata exists. | Both original measurement defects, malformed inputs and direction/boundary fixtures pass in `modules/mcp-corpus-eval/test/reading-order-contract.test.js`. This remains a horizontal heuristic, not complete reading-order evaluation. |
| Saved-PDF preservation checks | Typed inspection and quality contracts; decoded content/resource and annotation fingerprints; raw field hierarchy/properties; widget appearance, page and Form/LI ownership; standard H1-H6 content coverage; observed parent/shared-object defects. Source and candidate object comparisons require the source byte prefix. Validator reports now include `pdfSha256`, and the gate requires it to match the candidate. | Snapshot mutation tests plus actual incremental PDF mutations catch dropped fields, changed values, lost headings and page changes. Missing/failed font audits, malformed inputs and stale validation hashes produce `error`. Rewrites require an identity mapping and remain review candidates. |
| List-form container repair | Default-off `PASSTHROUGH_REPAIR_LIST_FORMS=1`; direct Form children move into the same LI's existing MCID-only LBody. Single or multiple OBJRs are supported only for unique widgets on that page. Existing objects, IDs, content and tree targets are retained. | Positive scalar/array-body and multi-widget fixtures, 11 ambiguous/malformed negative shapes, disabled behavior, repeat-run idempotence, and fill/save/reopen checks pass. The actual form loses all 12 targeted list-child failures. |

The first contracts deliberately expose only `review_required`, `rejected`, and `error`. A clean bounded comparison never produces `accepted`. `--preservation-check` adds a final accessibility pipeline stage; a regression or checker failure fails that stage and retains its diagnostic report. Existing clients and publication behavior have not been reworked: `06-tagged.pdf` remains a candidate on disk even when checking fails. No accepted-artifact publication guarantee is claimed.

The six portable suites in `npm run test:production-baseline` are required by `scripts/run-ci-tests.js`; missing files cannot silently disappear from default CI. They generate their PDFs locally with existing dependencies. The private/user-supplied TEST-FORM is additional qualification evidence and is not required for portable CI.

Validation completed for this delivery:

- Production baseline: **25 tests passed**, no skips.
- Existing validator, corpus scorer and pipeline compatibility: **32 tests passed**, no skips.
- Existing schema and font-audit checks: **11 tests passed**, no skips.
- `quality-cli.js` measured coverage: **99.16% lines, 98.84% branches**. This is module-specific JavaScript coverage; it does not claim Java or repository-wide coverage.
- Actual TEST-FORM: **12 list items repaired**, moving **17 widgets** into their existing list bodies. All **32 fields and 33 widgets** remain, with field properties, widget appearances, Form/LI identity, page text/resources/geometry, ParentTree and IDTree targets preserved. The complete two-line heading remains one heading with its original content references, IDs and styles.
- Both final pages were visually inspected and are **pixel-identical at 150 DPI**. A separate test copy passed text-field and checkbox fill/save/reopen. This is programmatic interaction testing; reader and keyboard qualification is still pending.
- Adjusted veraPDF results improved from **9 failed rules / 89 failed checks** to **8 / 77**. `VERAPDF_7_2_20` has zero failures. All other veraPDF rule counts and font-audit finding counts are unchanged. The result remains **review_required**.

Saved evidence is in `output/TEST-FORM-production-20261020/`: the candidate PDF, writer and validation reports, `08-quality-report.json` with source/candidate sidecars, `09-production-verification.json`, the reproducible `verify_production.py` comparison, `10-interaction-probe.json`, and `11-run-fingerprints.json`. Fingerprints record Node, validator, profile/config, source code and dependency artifacts; they do not replace immutable staging or deployment qualification. Run logs are in `tmp/test-production-baseline.log`, `tmp/test-production-compatibility.log`, `tmp/test-production-contract-font.log`, and `tmp/test-quality-coverage.log`.

Roadmap status: P02's measurement correction is implemented. P01/P03/P04/P05/P08/P18 have the bounded baseline/contracts/inspection/gate/list-rule/CI portions above, while their broader exit criteria remain open. P06 publication, P07 repair registry and ledger, role-map and link repairs, complete form relationships, hierarchy/table/reading-precedence improvements, font remediation, reader testing and operational qualification remain outstanding. The rule stays opt-in until those applicable qualification requirements are satisfied.

## 17. Engine improvements delivered 2026-10-21

This delivery implements conservative improvements in all ten selected areas. It does **not** complete every production exit criterion in the earlier roadmap. In particular, font rewriting, ambiguous semantic reconstruction, complete content-stream coverage and human reader qualification remain open. The earlier section records the October 20 state; the following table describes the current implementation.

| Area | Implemented and tested | Remaining boundary |
| --- | --- | --- |
| Structure and RoleMap verification | Bounded RoleMap chain resolution, cycle/unmapped-role findings, ParentTree MCID/OBJR ownership checks, duplicate ownership detection, IDTree consistency and unreachable target checks. Mapped H1–H6 participate in heading preservation. | No guessed mapping for unknown roles; complete stream coverage, PDF 2.0 namespaces, and rebuilding damaged ownership trees are not qualified. TEST-FORM's three `Artifact` structure roles require review. |
| Contextual links | Opt-in same-page, same-URI, overlapping annotation binding to one existing authored Link; ParentTree slots retained; blank Contents filled from the unchanged URI. Existing link actions, destinations and owners are independently protected. | Different destinations, multiple candidate owners, and stale StructParent entries are left for review. Four overlapping TEST-FORM annotations have different destinations and are deliberately not rebound. |
| Form relationships | Parser records field/widget identities, control type and required/read-only flags. Semantic output groups shared-field widgets and emits label relations with tooltip/proximity evidence; ambiguous labels become review tasks. | Relations are analysis metadata. General widget relocation, radio-option semantics, label rewrites and keyboard tab-order changes are not automatically applied. Existing fields and interactions remain protected. |
| Heading hierarchy | H1–H6 throughout the semantic contract and default builder profile; explicit numbered heading depth retained; conflicting same-style levels surfaced for review; wrapped-heading repair retained. | This does not infer a perfect document outline from typography or renumber ambiguous authored headings. Explicit profile caps still apply. |
| Lists | Explicit nested levels produce L beneath the preceding LBody, resume parent lists correctly and reject skipped levels. Conservatively joins aligned, consecutively numbered lists at adjacent page boundaries, excluding field-linked items. | Unmarked continuation paragraphs, arbitrary indentation inference and ambiguous restarts remain open. |
| Reading order | Anchored line groups eliminate non-transitive epsilon sorting. Explicit RTL extraction/direction is retained, homogeneous RTL regions are ordered accordingly, and a stable rank-heap topological sort applies precedence/continuation relations. Missing, duplicate, self-referential or cyclic identities fail. Orchestration cannot discard explicit constraints through fallback. | Mixed bidirectional text, floats, captions, footnotes and complex region reconstruction need further qualification. |
| Tables | Header IDs include table identity; a spanning TD receives all covered column/row header IDs; explicit Scope is retained; rowspan alone no longer implies Both; nested tables are isolated during header decoration. | Complex header inference, irregular/cross-page tables and layout-versus-data table classification remain separate work. |
| Font/Unicode safety | Candidate-bound font audits feed a per-font review plan with original-program, encoding/glyph mapping, rendering and new-form-value proof requirements. The preservation path retains original resources and rejects resource changes. | No new automatic font rewrite is claimed. Exact original font programs and mapping evidence are needed before qualifying those repairs. The 45 TEST-FORM font-related validation failures remain. |
| Explainable repairs and delivery gating | Versioned per-object records for wrapped-heading, list-form and link repairs; source/candidate hashes in the writer audit; stable review-task IDs with localized validation contexts. Source staging copies bytes instead of hard-linking. Production mode exposes `candidatePdf`; HTTP artifact downloads require valid quality results, explicit `candidate=1`, and a hash of the exact bytes served. | The ledger covers these qualified rules, not all legacy nonminimal edits. Gating is opt-in for the accessibility pipeline and its job artifact route; unrelated diff/export workflows are not promoted to qualified production delivery. No automatic accepted state is emitted. |
| Corpus and reader qualification | Fourteen required portable suites now include saved-PDF malformed structures, positive/negative link repair, hierarchy, lists, tables, directions, gating, source isolation and reader evidence binding. A typed human-reader record and checker reject incomplete, failed or stale evidence. | The generated fixtures and TEST-FORM are not a representative production corpus. Real reader/keyboard sessions and operational qualification have not been performed. A structurally valid evidence record is not certification. |

Run the reviewed candidate workflow with:

```powershell
node orchestrator/pipeline-runner.js --pdf C:/path/input.pdf --output-dir output/review --profile forms-heavy --production-checks
```

This enables the mandatory preservation stage, minimal passthrough, qualified list/link rules and table header attributes. The final artifact is `06-candidate.pdf`, with `06-writer-report.json`, its `.tags.json` repair audit, the validation report, and `08-quality-report.json` containing review tasks and font plans. It does not overwrite the supplied input. API callers can set `options.productionChecks: true`; retrieval uses `/jobs/<jobId>/artifacts/candidatePdf?candidate=1`. Rejected, incomplete, stale or malformed quality results cannot pass that route. Existing callers without preservation or production checks retain their previous workflow; calls using `--preservation-check` also require explicit candidate retrieval once a quality report is present.

Human evidence must follow `contracts/reader-qualification.schema.json`, identify the exact candidate hash and reader/version/platform, and record reading order, headings, lists, tables, links, labels, tab order, and fill/save/reopen observations. A not-applicable entry needs an explanation. Check a supplied record with:

```powershell
node scripts/check-reader-qualification.js --pdf output/review/06-candidate.pdf --evidence reader-evidence.json
```

Validation and saved evidence:

- Required production baseline: **43 tests passed**, no skips. The last full run is `tmp/engine-next-baseline-final.log`.
- Module compatibility run: **183 tests passed**, no skips, in `tmp/engine-next-compatibility.log`. Subsequent parser/reading-order, HTTP server, pipeline and gate checks: **49 tests passed**, no skips, in `tmp/engine-next-routing.log`; the new HTTP gating and quality tests also pass in `tmp/engine-next-final-gate.log`. These counts overlap and are not a repository-wide coverage claim.
- TEST-FORM: 32 fields, 33 widgets, original field values/options/tooltips/flags, page text/resources and the consolidated heading preserved. All 12 prior list-container repairs remain, covering 17 widget placements. Five existing Link descriptions are filled; all nine actions/destinations and authored ownership remain unchanged.
- veraPDF: **8 failing rules / 67 failed checks**, down from **8 / 77**. Ten link-description-related checks disappear with no new rule/count regressions. Three RoleMap, seventeen link/annotation, forty-five font and two heading checks remain. Status remains **review_required**.
- Both final pages were visually inspected and are pixel-identical to the source at 150 DPI. Poppler reports the same missing display-font warnings for Symbol and ArialUnicode in source and candidate; rendering equality does not qualify their fonts. A separate programmatic text/checkbox fill/save/reopen copy retains all 32 fields.
- Reproducible verification, saved PDFs and reports are in `output/TEST-FORM-engine-20261021/`, including `verify_candidate.py`, `09-candidate-verification.json`, `interaction-probe.mjs` and `10-interaction-probe.json`. These are local qualification artifacts, not source fixtures containing the user's form.

## 18. Qualified font repairs delivered 2026-10-21

The new explicit post-processing pass removes all **45 font-related veraPDF failed checks** from the 67-check TEST-FORM baseline. Engine-adjusted results are now **5 failed rules / 22 failed checks**. Raw veraPDF results change from **12 rules / 133 checks to 9 / 88**; the existing validator adjustments are unchanged. Every nonfont rule count is unchanged. This is a completed bounded font delivery, not completion of the remaining structural work or production certification.

| Rule | Qualification and behavior |
| --- | --- |
| `standard-dingbats-embed` v1 | Only canonical unembedded Type1 ZapfDingbats dictionaries without custom metrics/encoding/descriptors. Embeds PDF.js's pinned FoxitDingbats CFF as FontFile3/Type1C, with its actual font name, explicit original code-to-glyph encoding, matching advances for every defined code and a ToUnicode map. Retains existing ToUnicode when supplied. Shared resources are processed once; all existing appearance commands, states and values survive. |
| `space-only-times-embed` v1 | Only canonical Times-Roman with complete observed use of code 32, outside form default resources. Scans page content, nested Form XObjects and all annotation appearance states, including inactive states. Patterns, Type3 fonts, incomplete scans, editable use and any visible text prevent qualification. The pinned Serif CFF has an empty space outline and identical advance; unobserved glyph substitution is not qualified for editable or visible use. |
| `identity-cidset-complete` v1 | Only an existing CIDSet, an embedded TrueType program and explicit Identity CIDToGIDMap with no conflicting shared descriptor mapping. Reads the actual glyph count, marks every GID including empty slots and zeroes padding. Does not change the font program or mapping. Writes the bitmap uncompressed because the bundled veraPDF PDFBox adapter sizes a decoded read using encoded /Length. No validation rule is suppressed. |

The programs come from the existing `pdfjs-dist/standard_fonts` dependency and retain its `LICENSE_FOXIT` notice; no dependency, font download or system-font dependency was added. Their hashes are pinned in `QualifiedFontRepairs.java`; changed programs fail qualification. The `.pfb` files are raw CFF despite their suffix. Encrypted and signed inputs fail without producing a candidate. Malformed TrueType data, missing/unqualified replacement programs and resource limits also fail before publication. No-op passes copy identical bytes; output overwrite is refused.

`font-repair-report.schema.json` reuses the existing per-object audit contract and adds saved-object verification. Before publishing the incremental result, the pass reloads the source, reapplies the qualified rules, and compares the entire reachable Catalog and Info graph against the saved candidate. It checks existing indirect identities, aliasing, dictionary/array values and decoded stream bytes. Stream serialization filters/length and incremental trailer bookkeeping are outside that logical comparison. The preservation gate still requires the source byte prefix and exact candidate-bound validation. `--font-repairs true` invokes this verifier afresh; a writer ledger alone cannot permit changed resource/field/appearance fingerprints. Invalid or stale proofs fail closed.

Run after the existing preservation workflow, using its candidate as this pass's source:

```powershell
node modules/pdf-writer/font-repair.js --pdf output/review/06-candidate.pdf --output output/fonts/06-candidate.pdf > output/fonts/06-font-repair.json
node modules/validator/index.js --pdf output/fonts/06-candidate.pdf --manifest output/review/06-candidate.pdf.tags.json > output/fonts/07-validation-report.json
node scripts/check-pdf-preservation.js --source-pdf output/review/06-candidate.pdf --candidate-pdf output/fonts/06-candidate.pdf --validation-report output/fonts/07-validation-report.json --output output/fonts/08-quality-report.json --font-repairs true
```

Create `output/fonts` before redirecting stdout into it. The pass is available as `npm run repair:fonts -- ...`; it is not silently added to all existing pipeline runs. Keep the preceding structure-repair report and this font report together so the chain from the original source remains auditable. The short Java process uses tier-1 compilation to avoid an observed Windows JDK 21.0.6 C2 compiler crash in FontBox's Type2CharString implementation.

Validation and evidence:

- Required production baseline: **65 tests passed**, no skips (`tmp/font-production-baseline.log`). The new suite generates portable fixtures using the already installed PDF.js fonts. It covers canonical/shared resources, preserved programs and CIDSet padding, byte-identical repeat runs, visible and hidden-state text, editable fonts, custom encoding/metrics, patterns, nonidentity mappings, malformed programs, signatures, hash pins, overwritten-output protection, saved-object mutations and the integrated gate. No Java/repository-wide coverage claim is made.
- Negative saved-output probes alter values, appearances, page commands, geometry, font programs, Unicode maps, structure and Info metadata; all are rejected. A candidate without fresh qualified-font proof remains rejected by the original strict preservation checks.
- TEST-FORM: 21 Dingbats dictionaries, three whitespace-only Times dictionaries and three CIDSets repaired. **32 fields and 33 widgets retained**, along with all prior heading/list/link repairs. The object-level proof and preservation checks pass. Text and checkbox fill/save/reopen succeeds in both a generated fixture and the actual form.
- Both normal pages are pixel-identical at **150 DPI** in Poppler and PDF.js. All **20 checked boxes** are pixel-identical to the source in PDF.js at 150 DPI. Poppler previously omitted the source's unembedded checkmark glyphs; embedding makes those checked-state glyphs visible. Normal pages and checked-state output were visually inspected. Pixel equality in PDF.js does not qualify every viewer or reader.
- Evidence: `output/TEST-FORM-fonts-20261021/06-candidate.pdf`, `06-font-repair.json`, `07-validation-report.json`, `08-quality-report.json` plus its `.fonts.json` proof and source/candidate inventories, `09-font-verification.json`, `verify-fonts.py`, and the rendering/interaction probes. Candidate SHA-256: `a3e40909c8c3bd970e7e1ff995a4c58569d1021fccbdab38751b5ed6594ed43b`.

Remaining engine-adjusted failures: **17 link/annotation, 3 structure-role, 2 heading-order checks**. Separately, the font inventory audit still flags four pre-existing form-default issues: unembedded Helvetica and missing ToUnicode for Arial, Arial,Bold and Helvetica. Those defaults were deliberately not substituted; safe future editable text requires separate qualification. The candidate remains **review_required**. Human reader/keyboard testing and broader corpus qualification remain open.

## 19. Qualified link and annotation repairs delivered 2026-10-21

This delivery resolves the **17 remaining engine-adjusted link/annotation findings**, reducing TEST-FORM from **22 to 5 failed checks**. Four existing, unowned annotations overlapped authored links but carried different URI actions: two email addresses without the authored subject parameters and two URLs with different host/path strings. Each action is retained exactly. No destination equivalence, redirect or network lookup is assumed.

The PDF Association's [Tagged PDF Best Practice Guide, section 4.2.11](https://pdfa.org/wp-content/uploads/2019/06/TaggedPDFBestPracticeGuideSyntax.pdf#page=42) permits a Link element without page content and recommends that annotations sharing a Link element have the same action. Accordingly, each differently targeted annotation gets its own Link with an OBJR and an Alt description containing its original URI. That Link is inserted beside the uniquely matching authored Link in the same parent, preserving the original content ownership. No MCID is duplicated or moved.

Implemented qualification boundaries:

- `link-description` v2 fills blank Contents from the unchanged simple URI action, independently of whether binding qualifies. Authored descriptions, URI strings, destinations, flags, borders, rectangles, appearance streams and annotation order remain unchanged. Compound or additional actions are left for review.
- `link-context-binding` v2 retains the existing same-URI overlap rule, now requiring a reciprocal ParentTree anchor and simple actions.
- `link-literal-adjacent-binding` v1 requires exact extracted destination text, the same text in one existing authored link's region, at least 85% intersection relative to the smaller annotation rectangle, and a supported parent role (including RoleMap resolution). It creates a separate Link for the action. Page rotation, nondefault UserUnit, QuadPoints, hidden/invisible/no-view annotations, stale StructParent entries, missing/mismatched text, ambiguous anchors and unsupported parent roles do not qualify. Text extraction is evidence for this bounded rule, not a universal proof of rendered visibility.
- Existing ParentTree targets are retained; fresh slots are allocated beyond existing keys and ParentTreeNextKey. Cyclic/malformed structures and number trees fail preflight. No-op passes retain identical bytes. Signed/encrypted input and output overwrite are rejected.
- `SavedObjectVerifier.java` now supplies the same bounded exact Catalog/Info comparison to both the font and link CLIs. The link pass reloads the original, replays only its rules, and checks the saved candidate before publishing it. `--verify` repeats that comparison and emits the existing repair-audit contract only on success. No new contract or preservation-gate waiver was needed.
- The validator's independent Link probe now requires a unique reachable OBJR, correct parent chain, reciprocal ParentTree entry, correct page and nonshared annotation slot. RoleMap chains and number-tree traversal are bounded; malformed or cyclic inputs cannot qualify for the existing validator correction. Negative fixtures catch missing/wrong/duplicate OBJRs, unreachable owners, bad parents, wrong pages, missing/wrong/shared slots, duplicate keys and cycles.

The engine's pre-existing correction for veraPDF 1.28.2's PDFBox `structParentStandardType` stub now applies because all nine links pass the strengthened independent check. Raw veraPDF failures decrease **88 to 80** by fixing the eight missing-description checks. Nine remaining raw link-structure false positives are corrected only after the complete ownership proof; the adjusted count decreases **22 to 5**. No new suppression category was added. The residual three role and two heading counts, and all four separate form-default font audit findings, are unchanged.

Use the explicit pass after the font-repaired candidate:

```powershell
New-Item -ItemType Directory -Force output/links | Out-Null
node modules/pdf-writer/link-repair.js --pdf output/fonts/06-candidate.pdf --output output/links/06-candidate.pdf > output/links/06-link-repair.json
node modules/validator/index.js --pdf output/links/06-candidate.pdf --manifest output/review/06-candidate.pdf.tags.json > output/links/07-validation-report.json
node scripts/check-pdf-preservation.js --source-pdf output/fonts/06-candidate.pdf --candidate-pdf output/links/06-candidate.pdf --validation-report output/links/07-validation-report.json --output output/links/08-quality-report.json
```

`npm run repair:links -- ...` exposes the same CLI. The improved rules also participate in the existing `PASSTHROUGH_REPAIR_LINKS=1` path, including production checks. The explicit pass retains metadata and prior font repairs without rerunning other transformations.

Validation and saved evidence:

- **100 tests passed**, no skips, in `npm run test:production-baseline` (`tmp/link-production-baseline.log`). The expanded writer suite has 18 tests and the new independent validator-probe suite has 18; both are required in default CI. Coverage includes positive URL/email/RoleMap/scalar-child cases, authored descriptions, negative qualification cases, repeat-run byte identity, input/output protection, field mutation rejection and strict preservation integration. The shared verifier's existing font tests also pass.
- TEST-FORM retains **32 fields, 33 widgets and all 9 annotation destinations**. Existing link owners, font programs/resources, page content, field properties, widget appearances, headings and prior list repairs are unchanged. Four new Link elements use ParentTree slots **78-81**, with all earlier targets preserved. The fresh saved-object verification and all preservation comparisons pass without a font-repair waiver.
- Both pages are pixel-identical at **150 DPI** in Poppler and PDF.js, and all 20 checked boxes match the prior candidate in PDF.js. Both final normal pages were visually inspected. Page text is identical; a separate text/checkbox fill-save-reopen copy passes. Human reader/keyboard qualification remains pending.
- Artifacts are in `output/TEST-FORM-links-20261021/`: `06-candidate.pdf`, `06-link-repair.json`, `06-link-verification.json`, the validator and quality reports, `09-link-verification.json`, `verify-links.py`, and rendering/interaction probes. The candidate's SHA-256 is `9128996e023a65959015ba41550d954a3b4a31c0511dabd88133b04722f1c293`. Both the original download and preceding font candidate remain unchanged.

The candidate remains **review_required**. The three `Artifact` structure-role failures, two heading-order failures, separate default-font audit findings, and broader production/reader qualification are still open. The duplicate visual hit areas remain as authored; no user action was removed or redirected.


## 20. Qualified structure-role and heading remediation (2026-10-21)

Completed the five outstanding structure checks on TEST-FORM without altering its appearance or form objects. The explicit writer pass is `modules/pdf-writer/structure-repair.js` (`npm run repair:structure -- ...`), using the existing repair-audit contract and exact saved-object verifier. No validator rule or correction was added for this work.

The title already contained both lines under one heading; its /S changes H2 to H1. All five existing H4 peers become H2 through one document-wide monotone rank mapping. The pass preserves peer relationships, reading order, content references and the previously merged title. If compaction cannot make the whole sequence valid, or generic/unsupported headings are mixed in, it records review and leaves heading levels intact. Valid custom role mappings are resolved; cycles, standard-role overrides and malformed parent relationships fail closed.

The three unmapped Artifact leaves are actual footer image XObjects, already enclosed by Figure marked content: object 518 is the accessibility icon, 540 contains spoken/sign-language interpreter symbols, and 622 is the CourtHelp logo inside its existing Link. After visual review they receive Figure roles and the descriptions `Accessibility accommodations`, `Spoken and sign language interpretation`, and `CourtHelp`. This follows the distinction between meaningful graphics with an accessible description and decorative artifacts in the [PDF Association guidance](https://pdfa.org/wp-content/uploads/2023/07/Tagged-PDF-Best-Practice-Guide.pdf). No blanket Artifact role mapping or guessed description is used.

Image decisions are explicit CLI options tied to the exact source SHA-256. Preflight requires a reachable, undescribed, unmapped Artifact leaf, one page MCID, unique ownership, a reciprocal ParentTree slot, and exactly one image invocation with no text or conflicting semantic content. Bare Clip/ClipSpan wrappers are supported because these source images use them. Unsupported nested marked content, inline images, Form XObjects, prior Alt/ActualText, reused MCIDs and stale source hashes are rejected. The graph verifier replays the permitted changes from a fresh load and compares the entire saved Catalog/Info graph, including streams and indirect identities, before releasing output.

Reproduce this reviewed document pass:

```powershell
node modules/pdf-writer/structure-repair.js --pdf output/TEST-FORM-links-20261021/06-candidate.pdf --output output/TEST-FORM-structure-20261021/06-candidate.pdf --source-sha256 9128996e023a65959015ba41550d954a3b4a31c0511dabd88133b04722f1c293 --figure '518 0 R' 'Accessibility accommodations' --figure '540 0 R' 'Spoken and sign language interpretation' --figure '622 0 R' 'CourtHelp'
```

Use an unused output path when reproducing; overwrite is refused. Replace `--output` with `--verify` to verify an existing candidate against the same source and reviewed decisions. To run only heading compaction, omit the figure arguments and source hash. Unreviewed Artifact roles remain unchanged and receive review ledger entries. These CLI options stay within the writer module; output continues to use the existing repair-audit contract.

Validation and saved evidence:

- **129 tests passed, no skips**, in the required production baseline (`tmp/structure-production-baseline.log`). The new portable structure suite contributes 29 tests and is required in default CI. It exercises custom roles, consistent peer mapping, ambiguous/mixed headings, clipping wrappers, repeated byte-identical output, stale/missing decisions, malformed/cyclic structure and RoleMap, standard-role overrides, PDF 2.x, conflicting marked-content semantics, ambiguous ownership, authored descriptions, unsupported image content, strict preservation integration, and rejection of field/description mutations during saved-object verification.
- Engine-adjusted veraPDF checks: **5 to 0 failures**, with 106 passed rules and 2,642 passed checks. Raw backend checks: **80 to 75 failures** (five rules remain affected by the existing independently checked backend limitations documented in earlier sections). No new suppression was introduced. The separate four AcroForm default-font audit findings are unchanged, so overall validation still fails and the candidate remains `review_required`.
- All **32 fields, 33 widgets and 9 links** survive, including values, properties, appearance streams, link actions and ownership. Page content/resources, extracted page text, ParentTree slots, IDTree and original indirect identities are preserved. Every preservation comparison and fresh exact replay passes.
- Both saved pages are pixel-identical to the prior candidate at **150 DPI in Poppler and PDF.js**. All 20 checked boxes also match in PDF.js. Both final pages were visually inspected. A separate text/checkbox fill-save-reopen probe passes. The original input and prior candidate hashes are unchanged.
- Evidence is in `output/TEST-FORM-structure-20261021/`: candidate and manifest, repair/replay audits, validation/preservation reports, `09-structure-verification.json`, `verify-structure.py`, rendered images and interaction probes. Final SHA-256: `c05f052327950487a45a666554f8b86d9f711e8d46b4358fcee33f903598e872`.

This pass fixes heading levels while preserving existing heading membership; it does not prove that every authored heading is semantically correct. In particular, the source's `Index #:` field label remains a heading and should be reviewed for possible paragraph reclassification in a separately qualified semantic pass. Human screen-reader/keyboard qualification and the four default-font audit findings remain open. Zero adjusted structure checks is not a production-readiness or full PDF/UA certification claim.


### Follow-up validation assessment (2026-10-21; planning only)

A direct rerun of the unchanged candidate with the bundled PDFBox CLI reports 75 failures: 5-1 (1), 7.1-9 (1), 7.18.4-1 (33), 7.18.4-2 (31), and 7.18.5-1 (9). Raw diagnostic output is `tmp/structure-remaining-verapdf-cli-raw.json`.

Correction to the earlier blanket characterization of these as backend limitations: two of the 31 Form elements have two OBJR children and no Role attribute. Form 440 groups the unrelated IndexNumber and Plaintiff/Petitioner widgets (346 and 344); Form 449 groups two separate checkbox fields (widgets 361 and 363). The existing widget probe only proves that each widget's ParentTree target has Form role. It does not prove rule 7.18.4-2's one-child-or-Role condition, and currently suppresses that entire rule. The zero adjusted count therefore cannot establish that all remaining raw findings are false positives. No PDF or engine implementation was changed during this assessment.

Planned order: preserve the raw baseline; compare against a pinned supported Greenfield veraPDF release (currently 1.30.3, with PDFBox support ended in 1.30); make widget checks rule-specific and retain complete raw findings; split the two unrelated widget groupings with reciprocal ParentTree updates and exact saved-object proof; resolve only metadata/link defects reproduced by the supported backend; then run preservation, rendering, interaction and regression checks. Update installer, portable/bootstrap packaging and helper classpaths together, keeping PDFBox-backed inspection separate from the veraPDF executable. Do not carry blanket legacy corrections into the new backend. Keep the four separate default-font audit findings and human semantic/reader qualification visible as separate remaining work.

Upstream references: https://github.com/veraPDF/veraPDF-library/releases/tag/v1.30.1 and https://github.com/veraPDF/veraPDF-library/releases/tag/v1.30.3 . Implementation and qualification of this plan remain pending.

## 21. Supported validation backend and bounded Form repair (2026-10-21)

The preceding plan is now implemented. PDFBox has been upgraded from 3.0.7 to **3.0.8**, the latest stable version listed on the [Apache download page](https://pdfbox.apache.org/download.html) when checked for this delivery. Writer, parser, inspection, rendering, font auditing, test and IDE classpaths use the new jars. Both vendored copies were checked against Apache's SHA-512: `768847238f683568507bf73570a2b6fedcbe58b25c7b4f97fba536ba110b290fe96ba065aed58629d41fb94857d76bc1978c2f31d294b553c69f287f71ee9600`.

Validation now uses **veraPDF 1.30.3 Greenfield**. Upstream [ended the PDFBox backend in 1.30](https://github.com/veraPDF/veraPDF-library/releases/tag/v1.30.1); the [1.30.3 release](https://github.com/veraPDF/veraPDF-library/releases/tag/v1.30.3) is pinned by the installer and portable/bootstrap scripts. The official HTTPS installer archive is pinned to SHA-256 `b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59`. Installation verifies archive bytes, extracts afresh, stages and version-checks the CLI, and retains the previous installed app. Metadata and annotation diagnostics use the independent PDFBox 3.0.8 helper and a bounded JDK XML parser, removing their dependency on the legacy validator's jars. A fresh CLI installation succeeded; a full portable-distribution build was not run.

All blanket legacy suppressions have been removed. The report retains complete `rawFindings`; `summary` and `rawSummary` are identical. Diagnostics cannot change a failed check to a pass. Widget ownership and the Form child-or-Role rule are checked independently with bounded graph traversal, reciprocal ParentTree checks and unique reachable OBJRs. Execution failures remain explicit errors, including failures of the separate font audit.

The unchanged structure candidate produces **two raw failures** under Greenfield, both for multi-child Form tags without a Role attribute. The opt-in `--split-forms true` repair separates the unrelated terminal fields under Form objects 440 and 449. The original element/ID keeps its first widget; new consecutive siblings own widgets 344 and 363, using their existing ParentTree slots 46 and 56. No widget, field, annotation action or appearance dictionary changes. Authored semantic attributes, mixed content, duplicate references, shared terminal fields and incorrect ownership remain for review. Exact saved-object replay verifies the full permitted change before publication. The preservation gate accepts these owner changes only after an independent replay using `--structure-repairs true`; a ledger alone is insufficient.

Reproduce into a new output folder (existing PDF output is never overwritten):

```powershell
node scripts/install-verapdf.js
New-Item -ItemType Directory -Force output/modern-review | Out-Null
node modules/pdf-writer/structure-repair.js --pdf output/TEST-FORM-structure-20261021/06-candidate.pdf --output output/modern-review/06-candidate.pdf --split-forms true > output/modern-review/06-form-repair.json
node modules/validator/index.js --pdf output/modern-review/06-candidate.pdf --manifest output/TEST-FORM-structure-20261021/06-candidate.pdf.tags.json > output/modern-review/07-validation-report.json
node scripts/check-pdf-preservation.js --source-pdf output/TEST-FORM-structure-20261021/06-candidate.pdf --candidate-pdf output/modern-review/06-candidate.pdf --validation-report output/modern-review/07-validation-report.json --output output/modern-review/08-quality-report.json --structure-repairs true
```

Evidence and qualification:

- Required production baseline: **148 tests passed, zero skipped**, including new bounded Form splitting and independent Widget/Form diagnostics (`tmp/modern-production-baseline.log`). The selected parser/OCR/form, corruption-repair, profile, redactor and native-parser dependency checks pass all **44 tests** after correcting an outdated native-parser test compilation helper (`tmp/dependency-regressions.log`, `tmp/native-parser-modern.log`). Related standalone writer tests now resolve Java helper dependencies through their source path; the already-tagged, matcher and hierarchy suites add **8 passed tests** (`tmp/writer-modern-regressions.log`). Final validator/probe rerun: **28 passed**; these overlap the baseline. No repository-wide coverage claim is made.
- Final candidate: `output/TEST-FORM-modern-20261021/06-candidate.pdf`, SHA-256 `c085a61f96637c087136f95f2ba747923c3705afaaa6f4ec0ccb31501031ccfb`. veraPDF reports **106 passed rules, 9,876 passed checks, zero failed rules/checks**, with no suppressed results. The old 75-failure count came from a different backend; only two failures reproduced under the supported backend, and both are repaired.
- All **32 fields, 33 widgets and 9 link destinations** are retained. Saved-object verification and all preservation comparisons pass. Both normal pages are pixel-identical to the preceding candidate at **150 DPI in Poppler and PDF.js**; all **20 checked boxes** also match in PDF.js. Both final pages were visually inspected; text equality and separate text/checkbox fill-save-reopen checks pass. The original input and preceding candidate remain unchanged.
- The same folder holds the repair audit, candidate manifest, validation/preservation reports, independent structure proof, `09-modern-verification.json`, reproducible `verify-modern.py`, and rendering/interaction probes.

The overall candidate remains **review_required** because the separate default-font audit still reports unembedded Helvetica and missing ToUnicode for Arial, Arial,Bold and Helvetica. Those editable defaults require their own qualified repair; a passing veraPDF result does not clear them. The authored `Index #:` heading semantics, human screen-reader/keyboard testing and broader corpus/operational qualification also remain open.

## 22. Semantic quality improvements 1–6 and benchmark delivery (2026-10-21)

Implemented the seven selected areas as extensions of the existing pipeline:

1. **Heading membership:** short colon/hash labels associated with widgets become paragraphs during semantic inference; numbered headings remain protected. Sentence-like and repeated marginal headings receive explicit review tasks. Existing wrapped-title grouping is retained. For preserved PDFs, source-hash-bound `--paragraph` decisions change only a qualified heading's role to P, retaining its unique page MCID, layout attributes/classes and existing Form children. The saved-object verifier and independent preservation gate replay these decisions.
2. **Form context:** authored tooltips can match a unique adjacent group of up to four label fragments, including a fragment just outside the parser's closest-widget association. Matching is constrained by page, column, alignment, distance and normalized label text. Normalization removes checkbox symbols, terminal punctuation/blanks and separate parenthesized explanation prompts; it preserves the authored tooltip in full. Conflicting authored tooltips remain reviewable. Labels and field-associated instructions are recorded separately per widget, retaining field identity, read-only/required state and repeated-widget grouping. A deterministic geometric navigation proposal and unresolved-widget list support reader testing; no inferred relationship silently changes field names, tooltips, values or tab settings.
3. **Editable fonts:** missing ToUnicode is added to embedded nonsymbolic TrueType WinAnsi defaults only after checking all defined codes against the embedded program's Unicode cmap and glyph IDs. An unused bare Helvetica default may reuse the document's sole authored Arial default program after complete page/appearance usage scanning and matching every defined glyph and advance. Its original encoding and all 256 advances remain intact. No external font is substituted. Unknown mappings, used defaults, competing donors and custom metrics remain review cases. Exact saved-object replay protects existing programs, fields and appearances.
4. **Reading order:** headings spanning identified columns create boundaries for content above and below the heading. Explicit caption, footnote and aside anchors produce precedence relationships; unresolved anchors receive review tasks and cycles still fail. Layout block references are translated to semantic identities before use. These bounded relationships do not reconstruct arbitrary ambiguous layouts.
5. **Tables:** header associations include preceding group headers on TH cells and all covered headers on spanning TD cells, exclude future occurrences and prefer the latest equivalent repeated header. IDs remain table-scoped. Header decoration is enabled by default with an explicit opt-out; legacy snapshots exercise that opt-out separately. Native and raster writers now carry IDs, Scope and Headers through to the saved PDF and build IDTree entries. Missing IDs, duplicate IDs, non-TH or cross-table references, and excessive nesting are rejected before saving. Existing form/layout-table safeguards remain in place.
6. **Lists and paragraphs:** aligned consecutive decimal, lettered and Roman items can continue across a page boundary. Typography and unfinished-sentence evidence can join a split paragraph or retain a following paragraph inside the same LBody. Content identities stay distinct, with each emitted once. Forms, tables, footnotes, mismatched typography/direction, punctuation boundaries and unrelated columns prevent qualification. Native and raster output retain the correct list numbering; ambiguous bullet-list restarts are not guessed.
10. **Semantic benchmark and reader qualification:** `semantic-benchmark.schema.json` defines a corpus of 16 authored synthetic cases. `scripts/semantic-quality-benchmark.js` executes the real semantic, reading-order and tag-builder CLIs, scoring heading roles, labels/instructions, order pairs, list groups/numbering, paragraph continuity, table headers, ambiguity handling and unique content ownership. The references retain provenance and an explicit pending expert-review state. Reader evidence remains bound to exact PDF bytes; release qualification additionally records the PDF viewer/version and requires an observed reading-order result. An absent human record or incomplete expert review produces `review_required` and exit code 2.

Run the automated checks with `npm run test:production-baseline` and `npm run benchmark:semantic`. For qualification, use:

```powershell
npm run qualify:semantic -- --pdf output/TEST-FORM-quality-20261021/06-candidate.pdf --reader-evidence path/to/actual-reader-record.json --output path/to/qualification.json
```

The reader record follows `contracts/reader-qualification.schema.json`: name the reviewer, test date, reader/version, platform and PDF viewer/version, then record evidence for reading order, headings, lists, tables, links, labels, tab order and fill/save/reopen. A non-applicable result needs a reason. References may be marked reviewed only after an actual review, recording reviewer and date. Synthetic cases and automated observations are not human-reader evidence.

Validation and saved evidence:

- Required baseline: **171 passed, zero skipped**, including generated editable-font fixtures, negative repair proofs, 16 semantic reference cases and saved native/raster table/list checks (`tmp/quality-production-final.log`). Final semantic/benchmark checks pass **44 tests**; writer/tag-builder/reader compatibility checks pass **55**. Contract, ruled-table and full pipeline checks pass **11**, after updating an obsolete integration expectation for the discontinued validator backend. These overlap the baseline; no repository-wide or Java coverage percentage is claimed. The 16-case benchmark passes all **74 checks**.
- TEST-FORM at `output/TEST-FORM-quality-20261021/06-candidate.pdf` now passes veraPDF **106 rules / 9,874 checks**, with no raw failures, suppressions or independent font-audit findings. The four default-font audit findings are resolved. Reviewed object 576 (`Index #:`) is P, retaining both existing Form children; the full Supplemental Affirmation heading stays together.
- **32 fields, 33 widgets and all nine link destinations** remain. Both incremental repair steps pass fresh saved-object replay and every preservation check. Normal pages match the preceding candidate pixel-for-pixel at 150 DPI in Poppler and PDF.js; all 20 checked boxes also match in PDF.js. Both final pages were visually inspected, page text is identical, and ordinary plus accented/Euro text and checkbox fill/save/reopen probes pass. The accented probe exercises both the existing Arial and the newly embedded default.
- The folder contains the two repair audits, reviewed decisions, candidate provenance manifest, validation/preservation reports, `09-quality-verification.json`, reproducible `verify-quality.py`, visual and interaction probes, and `11-semantic-benchmark.json`. Candidate SHA-256: `e9fc4c318c7d0b75048c9c3dbe035acb1f376be0f80fb1559b101540b3e3b858`.

The saved candidate remains **review_required** for semantic and reader qualification. The implementation of item 10 is delivered; independent expert review of the reference corpus and actual screen-reader/keyboard sessions have not been performed. The fresh inference diagnostic artifacts in the same folder expose unresolved form-label relationships; these are not silently written over authored form metadata. Broader corpus, operational and viewer qualification remain open.


## 23. Accuracy roadmap engineering delivery, 2026-10-21

Bounded A01–A10 implementations, new contracts, real-PDF diagnostics, saved-output list fixes, paragraph identity repair, form association results and remaining qualification work are recorded in [the accuracy delivery](tagging-accuracy-delivery-20261021.md). Multilingual expansion is deprioritized. The new candidate retains zero raw veraPDF failures, 32 terminal fields, 33 widgets, nine links, five saved headings and identical two-renderer pixels. Independent reference adjudication and actual reader/keyboard observations remain pending; production qualification is not claimed.

## 24. Remaining form-label associations, 2026-10-21

The [form-label delivery](form-label-associations-20261021.md) resolves seven of the eight remaining TEST-FORM cases through widget appearance evidence, expanded prompts, section instructions and compound date context. The court selector's authored tooltip remains intact, but its missing printed label remains flagged. Baseline: 213 tests pass; final focused checks: 26 pass. All fields, appearances, saved structure and tested interactions are preserved; zero raw veraPDF failures. This is inference/review evidence, not a generic field-metadata or tab-order rewrite.

## 25. Verified table, saved-text and button-name improvements, 2026-10-21

The [verified follow-up](verified-tagging-improvements-20261021.md) moves new table replacement text to content Spans, detects unintended saved ActualText/Alt, and recognizes authored push-button captions with conflict review. Native/raster saved-output and mutation tests cover the table changes; TEST-FORM retains its original appearance, fields, saved structure and zero raw validator failures. Complete glyph mapping and human reader qualification remain pending.
