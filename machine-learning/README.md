# Machine Learning Planning Track

This directory is a planning workspace for adding classifier-assisted tagging to OpenAutoTag. It intentionally contains no generator, training, or runtime integration code yet. The current repository contract says deterministic rules come before machine learning, so this track treats ML as an evidence-producing assistant behind the existing CLI and JSON boundaries.

## Scope

The first objective is to design a reproducible synthetic and semi-synthetic PDF corpus of at least 100,000 meaningful test documents. The second objective is to define verification and reporting strong enough that humans can audit the corpus, labels, model behavior, and release gates with mathematical confidence.

The plan is split across these files:

- [research-notes.md](research-notes.md): academic guidance and how it maps to this engine.
- [ml-plan-critique.md](ml-plan-critique.md): research-backed critique of the current corpus, wave-2, and ML integration plan.
- [ontology-and-label-policy.md](ontology-and-label-policy.md): frozen task-head, role, confidence-tier, note, and ambiguity policy for the first training wave.
- [leakage-control-plan.md](leakage-control-plan.md): split units, holdouts, fingerprints, scanner requirements, and model-selection logging.
- [real-anchor-corpus-plan.md](real-anchor-corpus-plan.md): plan for real public PDF anchors and synthetic-to-real divergence checks.
- [real-pdf-ingestion-mechanism.md](real-pdf-ingestion-mechanism.md): staged mechanism for feeding real PDFs to calibrated ML through profiling, shadow mode, audit, and promotion.
- [real-derived-corpus-plan.md](real-derived-corpus-plan.md): plan for using real PDFs as seed documents and mathematically transforming them into the primary stronger testcase body.
- [dataset-datasheet-template.md](dataset-datasheet-template.md): required dataset documentation template.
- [model-card-template.md](model-card-template.md): required trained-model documentation template.
- [release-gates.md](release-gates.md): hard gates for training, shadow mode, assistive mode, and ongoing release health.
- [corpus-generation-plan.md](corpus-generation-plan.md): factor space, quotas, labels, splits, and deterministic generation design.
- [wave-2-transformation-plan.md](wave-2-transformation-plan.md): lineage-based plan for transforming the original corpus into finer-grained derivative testcases.
- [verification-and-reporting-plan.md](verification-and-reporting-plan.md): proof strategy, VIVID evidence blocks, and report suite.
- [development-roadmap.md](development-roadmap.md): staged implementation plan, acceptance gates, and risks.
- [contracts-draft/](contracts-draft/): draft ML ground-truth and prediction schemas. These are proposals only, not live engine contracts.

## Engine Fit

The ML layer should not replace the current parser, layout analyzer, semantic engine, reading-order engine, tag builder, PDF writer, or validator. It should produce candidate evidence that the deterministic modules can consume or compare against through explicit contracts.

Current useful contract vocabulary:

- `layout.schema.json`: text blocks, bounding boxes, font size, block type hints, heading levels, column hints.
- `semantic.schema.json`: roles for `Document`, `H1`, `H2`, `H3`, `P`, `L`, `LI`, `Table`, `TH`, `TD`, and `Artifact`.
- `tagging.schema.json`: richer tag tree types including headings, lists, labels, bodies, captions, figures, asides, forms, and table sections.
- `table-structure.schema.json`: table geometry, rows, columns, cells, spans, assigned block IDs, merge signals, and vector summaries.

The current semantic contract is narrower than the tag-builder contract. If ML is expected to classify captions, figures, footnotes, endnotes, form fields, or asides before tag building, that is a contract gap. The right next step is an additive shared contract proposal, not a private model output shape.

Draft proposals now live under `machine-learning/contracts-draft/`:

- `ml-ground-truth.schema.json`: corpus truth with label confidence, lineage, leakage fingerprints, contract projection, and audit state.
- `ml-predictions.schema.json`: classifier evidence with task heads, OOD score, abstention, calibrated confidence, contract projection, and shadow-mode decision logs.
- `real-pdf-intake.schema.json`: real-PDF batch intake with provenance, privacy review, profile routing, shadow inference, audit state, and promotion target.

## Design Principles

1. Reproducibility first: every generated PDF must have a stable case ID, seed, generator version, source factor vector, PDF hash, rendered image hash, and ground-truth manifest.
2. Meaningful variation over random chaos: randomization should be stratified and measured, not merely noisy.
3. Labels by construction, labels by verification: the generator creates the truth manifest, then independent probes confirm that the PDF actually expresses that truth.
4. Synthetic plus real anchors: synthetic documents provide scale and full truth; real PDFs provide distribution checks and domain drift warnings.
5. Calibration matters: model confidence should mean something. A classifier that is accurate but overconfident should not be allowed to silently steer tagging.
6. Human auditability is a product requirement: every corpus and model report should include visual overlays, concrete invariants, reproducible commands, and failure slices.
7. Leakage control is a release blocker: train, validation, test, and locked audit sets must be separated by lineage, template, text source, producer, assets, and parent clusters.
8. Abstention is expected behavior: low-confidence, OOD, ambiguous, and contract-gap predictions should fall back to deterministic output.

## Proposed ML Tasks

The initial classifier work should be split into explicit tasks rather than one vague "tagging model":

- Region role classification: heading, paragraph, list label, list body, table, table header cell, table data cell, artifact, caption, figure, form, footnote, endnote.
- Table structure support: borderless table membership, header row detection, sparse numeric table detection, row and column span candidates.
- Note linking: footnote reference to footnote body, endnote reference to endnote body, and negative controls for superscripts that are not notes.
- Artifact suppression: stamps, watermarks, running headers, page numbers, seals, and decorative noise.
- Reading-order support: local pairwise ordering decisions for multi-column, table-adjacent, marginalia, and note-heavy pages.

Each task should emit evidence and confidence, not direct final tags, until integration gates prove that it improves the deterministic engine.
