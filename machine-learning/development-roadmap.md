# Development Roadmap

## Phase 0: Governance And Contract Proposal

Deliverables:

- Confirm that `machine-learning/` owns planning and future ML tooling.
- Draft a proposed `ml-ground-truth.schema.json`.
- Draft a proposed `ml-predictions.schema.json`.
- Decide how footnotes and endnotes should be represented in semantic and tagging outputs.
- Decide whether captions, figures, forms, and asides should be promoted into `semantic.schema.json` as additive roles.
- Draft a dataset datasheet template and model card template.
- Define label confidence tiers, oracle confidence tiers, and leakage scanner requirements.
- Draft the first task ontology and role projection table.
- Draft the release gates for training, shadow mode, assistive mode, and ongoing release health.

Acceptance gates:

- No module consumes private ML JSON.
- Proposed contracts map cleanly to existing layout, semantic, table, and tagging schemas.
- Contract gaps are documented before implementation.
- Training does not start until task ontology, leakage controls, label confidence, and real-anchor evaluation are specified.
- Draft ML schemas remain isolated under `machine-learning/contracts-draft/` until promoted.

## Phase 1: Corpus DSL And Truth Model

Deliverables:

- A deterministic document construction DSL.
- A truth graph model for pages, blocks, glyph runs, tables, lists, notes, forms, figures, artifacts, and relationships.
- A factor-vector registry with valid ranges and invalid combinations.
- Seeded sampling utilities.
- A coverage ledger.

Acceptance gates:

- Same seed and generator version produce byte-stable truth manifests.
- Coverage ledger can prove planned factor counts before PDF emission.
- Truth graph can project into current engine contracts where representable.

## Phase 2: PDF Generation Backends

Deliverables:

- Born-digital PDF backend.
- Render/reassemble scan backend.
- PDF producer profile layer.
- Font and encoding stress layer.
- Artifact/stamp/watermark layer.
- Table generator layer.
- Note and reference generator layer.

Acceptance gates:

- 1,000-PDF pilot generation completes deterministically.
- Rendered pages are nonblank and visually aligned.
- Probe reports pass for at least 98 percent of pilot cases.
- Failed cases are automatically quarantined with VIVID evidence.

## Phase 3: Verification And Reporting

Deliverables:

- Case verifier.
- Shard verifier.
- Corpus atlas generator.
- Overlay renderer.
- VIVID evidence block emitter.
- Human audit packet generator.

Acceptance gates:

- Every accepted case has visual, invariant, verifiable, inspectable, and diagnostic evidence.
- Shard report catches intentionally corrupted labels.
- Human reviewers can audit a case without running a debugger.

## Phase 4: 10,000-PDF Calibration Corpus

Deliverables:

- Generate a 10,000-PDF pilot corpus.
- Run the full engine on every accepted case.
- Produce baseline deterministic metrics.
- Identify classes where deterministic rules are strong enough and classes where ML may help.
- Complete a dataset datasheet for the calibration corpus.
- Run leakage scanner and report effective sample size.

Acceptance gates:

- At least 9,800 verified cases accepted.
- Every family has at least 500 accepted PDFs.
- Coverage ledger has no missing required factor values.
- All reports are generated from reproducible commands.
- No unapproved leakage failures.
- High-impact labels meet required confidence tiers.

## Phase 4A: Real-Anchor Corpus

Deliverables:

- Build a 250-PDF smoke real-anchor corpus.
- Expand to a 1,000-PDF training-readiness real-anchor corpus.
- Define the 5,000 to 10,000 PDF release-anchor target.
- Record source provenance, license, producer profile, language/script profile, and born-digital/scanned/hybrid status.
- Run deterministic baseline metrics and synthetic-to-real divergence reports.
- Define real-PDF intake batches, routing states, and shadow-mode promotion rules.
- Select real-derived transform seeds from audited real PDFs.

Acceptance gates:

- Real-anchor smoke corpus passes pipeline and reporting checks.
- Training-readiness anchor has human audit sampling.
- Release-anchor plan covers government, legal, tax/form, academic, standards-like, financial, multilingual, old scan, and accessibility-tool-generated sources.
- Real-anchor performance is a hard gate for ML-assisted release.
- Real-PDF intake manifests validate and route unknown or sensitive PDFs conservatively.

## Phase 4B: Real-Derived Primary Corpus

Deliverables:

- Select 2,500 to 5,000 real seed PDFs.
- Generate preserving, threshold, counterfactual, ablation, scan/OCR, artifact, table-region, note-region, and operator variants.
- Build the primary 100,000-PDF body with at least 60 percent real-derived cases.
- Produce real-derived lineage, transform coverage, threshold response, and invariance reports.

Acceptance gates:

- Every real-derived case has a seed intake record, transform ID, truth morphism, label confidence, oracle confidence, and render verification.
- Release-anchor seeds and derivatives never enter training.
- Human audit samples every real-derived transform family.
- Synthetic cases fill only the structures that real-derived seeds cannot cover safely or confidently.

## Phase 5: 100,000-PDF Corpus

Deliverables:

- Generate the full 100,000-PDF corpus in shards.
- Produce shard reports and whole-corpus atlas.
- Freeze dataset version with hashes.
- Create train, validation, test, and locked audit splits.
- Include template, transform, producer, text-source, real-anchor, and locked-audit holdouts.

Acceptance gates:

- At least 100,000 verified PDFs accepted.
- No seed, template instance, rendered background, or exact table schema crosses splits.
- Pairwise and high-risk triple coverage targets are met.
- Locked audit split remains untouched by model selection.
- Dataset datasheet is complete.
- Leakage scanner passes.

## Phase 5A: Wave 2 Transformation Corpus

Deliverables:

- Define a lineage-preserving transform manifest.
- Derive atomic microcases, preserving variants, threshold sweeps, counterfactual pairs, context ablations, noise variants, operator variants, and failure-neighborhood cases from the wave 1 corpus.
- Produce transform atlas, lineage reports, sensitivity curves, counterfactual pair reports, and shrink reports.
- Expand the original corpus into a planned 1,000,000-PDF derivative suite without crossing train, validation, test, or locked-audit split boundaries.

Acceptance gates:

- Every child case records parent ID, transform ID, parameter vector, truth morphism, oracle type, and verification status.
- At least 99 percent of materialized child PDFs pass structural and render verification.
- Parent-clustered metrics and worst-child metrics are reported.
- All locked-audit descendants remain excluded from training and model selection.

## Phase 6: Baseline Models

Deliverables:

- Non-neural baseline using existing block features.
- Calibrated linear or tree-based role classifier.
- Table-specific classifier for header/cell/artifact decisions.
- Note detector and linker baseline.
- Evaluation harness against deterministic engine output.
- Model card template filled for every trained baseline.

Acceptance gates:

- Baselines beat simple majority and deterministic fallback on targeted weak slices.
- Baselines do not regress strong deterministic slices.
- Calibration report is generated for every model.
- Inference is deterministic for a fixed model and input.
- OOD and abstention behavior are measured before any release claim.

## Phase 7: Multimodal Models

Deliverables:

- Token-plus-layout model input pipeline.
- Optional page-image feature pipeline.
- Region/object detection experiment for tables, figures, stamps, and notes.
- Feature ablation reports.

Acceptance gates:

- Multimodal model improves locked audit slices where visual context is required.
- Runtime and memory are measured.
- Abstention thresholds are selected on validation only.
- Model cards and report artifacts are stored with hashes.

## Phase 7A: Real-PDF Shadow Feed

Deliverables:

- Register real-PDF intake batches.
- Run profile detection, deterministic baseline, and calibrated ML shadow inference.
- Produce deterministic-vs-ML disagreement reports.
- Produce OOD and abstention reports.
- Generate human audit packets and active-learning queue entries.

Acceptance gates:

- Deterministic output remains final.
- Every real PDF has provenance, privacy status, routing state, and OOD decision.
- Unknown or OOD PDFs abstain or quarantine.
- Only audited and leakage-safe PDFs can become training candidates.
- Release-gate PDFs never enter training.

## Phase 8: Engine Integration

Deliverables:

- Additive ML prediction contract.
- CLI for classifier inference.
- Orchestrator integration behind a disabled-by-default flag.
- Deterministic fallback when ML is unavailable, low confidence, or out of distribution.
- Delta report comparing deterministic-only versus ML-assisted output.
- Shadow-mode decision logs for deterministic evidence, ML evidence, final decision, and fallback reason.

Acceptance gates:

- Existing CLI contracts remain valid.
- Default behavior is unchanged until explicitly enabled.
- ML-assisted mode improves agreed metrics on weak slices.
- PDF/UA validator impact is non-negative on locked audit and real anchor corpora.
- Emergency disable flag and rollback path are tested.

## Phase 9: Continuous Evaluation

Deliverables:

- Nightly corpus shard sampling.
- CI smoke subset.
- Weekly larger corpus run.
- Drift report for real PDF anchor suite.
- Failure clustering and active-learning queue.

Acceptance gates:

- CI subset catches seeded regressions quickly.
- Large corpus reports remain reproducible.
- Human audit queue is prioritized by uncertainty, novelty, and severity.
- Any production model change has a release report and rollback path.

## Key Risks

- Synthetic bias: the model learns generator style instead of document structure.
- Label leakage: train and test share templates, text, seeds, or rendered backgrounds.
- Label truth mismatch: the PDF does not visually contain what the manifest says.
- Class imbalance: rare roles look good in aggregate metrics but fail in practice.
- Calibration failure: confidence scores are not meaningful.
- Contract gap: ML predicts roles that cannot be represented downstream.
- Runtime cost: model inference slows the engine beyond acceptable limits.
- Silent harm: ML improves one slice while damaging validator output elsewhere.

## Immediate Next Decisions

1. Approve the proposed planning scope for `machine-learning/`.
2. Decide whether footnotes and endnotes are semantic roles, tag-builder-only structures, or relationship metadata.
3. Decide whether the first implementation should start with corpus generation or with schema proposals.
4. Choose the pilot target: 1,000 PDFs for generator proof, then 10,000 PDFs for calibration, then 100,000 PDFs for training.
