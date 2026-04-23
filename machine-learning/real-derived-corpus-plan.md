# Real-Derived Corpus Plan

## Purpose

The primary test body should include real PDFs that are programmatically and mathematically adjusted into stronger test cases. This gives the corpus real producer quirks, real typography, real content-stream behavior, real OCR oddities, and real document conventions, while still letting us probe controlled factors.

Synthetic PDFs remain necessary for perfect construction truth and rare structures. But the main calibration corpus should not be purely synthetic. It should be a real-derived corpus supported by synthetic cases.

## Core Rule

A real-derived testcase is created from a real seed PDF only after the seed PDF has an intake record, deterministic baseline artifacts, profile fingerprints, and enough label evidence for the structures being transformed.

Real-derived truth is not "truth by construction." It is:

```text
real seed PDF
  -> intake and provenance
  -> deterministic pipeline baseline
  -> rendered overlays
  -> optional human audit
  -> seed truth graph with confidence tiers
  -> mathematical transform
  -> transformed truth graph through a truth morphism
  -> verification and VIVID evidence
```

## Primary 100,000-PDF Body

Revise the original 100,000-PDF plan so the primary body is real-derived first:

| Corpus component | Count | Purpose |
| --- | ---: | --- |
| Real-derived preserving transforms | 25,000 | Same logical document under controlled geometry, raster, OCR, artifact, and producer-style changes |
| Real-derived threshold sweeps | 15,000 | Measure where real layouts break: skew, blur, alignment, contrast, note proximity, table-rule visibility |
| Real-derived counterfactual and ablation cases | 10,000 | Minimal real-context edits that add, remove, or confuse target structures |
| Real-derived scan, OCR, and operator variants | 10,000 | Stress parser and extractor behavior while preserving rendered intent |
| Synthetic fully controlled rare-structure cases | 25,000 | Perfect-truth cases for rare notes, nested tables, forms, multilingual layouts, and adversarial traps |
| Unaltered real-anchor PDFs | 10,000 | Distribution check, release gate, and synthetic-to-real divergence measurement |
| Human-audited ambiguous and adversarial mixed cases | 5,000 | Ambiguity taxonomy, OOD, abstention, and contract-gap tests |
| Total | 100,000 | Primary calibration and evaluation body |

The unaltered real-anchor portion is not a training pool by default. It is primarily an evaluation and release-gating pool. Any real PDF used for training must be promoted through audit and leakage checks.

## Seed Selection

Start with 2,500 to 5,000 real seed PDFs from the real-anchor intake mechanism.

Each seed should have:

- Public or approved provenance.
- Privacy status of `public` or `redacted`.
- PDF hash.
- Producer profile.
- Page count and page size.
- Language/script profile.
- Born-digital, scanned, or hybrid profile.
- Deterministic pipeline artifacts.
- Rendered page images.
- Overlay report.
- Baseline label confidence summary.

Seeds should be stratified by source family:

- Government notices and regulations.
- Court opinions and legal documents.
- Tax forms and tabular schedules.
- Academic and technical reports.
- Financial and annual reports.
- Standards-like manuals.
- Multilingual documents.
- Scanned and OCR-heavy documents.
- Accessibility-tool-generated PDFs.

## Transform Classes

### 1. Appearance-Preserving Affine Transforms

Apply controlled transformations that should preserve document semantics:

- Page translation.
- Page scaling.
- Small rotation.
- Scan-like skew.
- Margin expansion with content recentering.
- Region crop with coordinate rebasing.

Truth morphism:

```text
bbox_prime = A * bbox
role_prime = role
relationship_prime = relationship
```

These are high-value because they test whether the engine relies too heavily on exact coordinates.

### 2. Raster/Reassembly Transforms

Render the real PDF, mathematically degrade it, and rebuild a PDF:

- DPI sweep.
- Blur sweep.
- Contrast sweep.
- Compression sweep.
- Salt-and-pepper dropout.
- Background texture.
- OCR text layer added.
- OCR text layer removed.

Truth morphism:

- Semantic labels are preserved only for labels with sufficient seed confidence.
- Observed text-layer truth is recorded separately from visual truth.
- OCR failures are expected outcomes, not automatic label failures.

### 3. Artifact Injection

Inject controlled artifacts into real contexts:

- Date stamps.
- Approval stamps.
- Diagonal watermarks.
- Page headers and footers.
- Page numbers.
- Low-opacity background text.
- Vector seals.
- Table-overlapping or heading-overlapping stamps.

Truth morphism:

- Existing labels are preserved if still visible.
- New artifact labels are added.
- Occluded objects record occlusion metadata.

These cases directly strengthen the tricky stamp and artifact-suppression problem.

### 4. Table-Region Transforms

Operate only on verified table regions:

- Remove or fade vertical rules.
- Remove or fade horizontal rules.
- Add broken rules.
- Jitter column alignment within tolerance.
- Increase or reduce row spacing.
- Add table-like nearby prose as a distractor.
- Crop table plus caption into a microcase.

Truth morphism:

- Table structure is preserved for preserving transforms.
- Header/body/cell labels inherit seed confidence.
- Any transform that changes the meaning of the table is marked counterfactual or ambiguous.

### 5. Note And Citation Transforms

Operate only where notes or citation-like markers are seed-verified:

- Crop marker and body into a microcase.
- Move note body closer to or farther from content.
- Add false note markers near real superscripts.
- Degrade superscript visibility.
- Convert page-level context into a note-linking microcase.

Truth morphism:

- Marker-body relations are preserved only if both endpoints survive.
- False markers are explicit negative controls.
- Ambiguous legal citations and math superscripts stay out of supervised loss until audited.

### 6. Context Ablation

Remove or isolate context:

- Page-only extraction from multi-page PDFs.
- Region-only extraction.
- Table-only extraction.
- Figure-caption extraction.
- Sidebar isolation.
- Form-field group extraction.

Truth morphism:

- Surviving labels are coordinate-rebased.
- Deleted context is recorded.
- Relationships survive only when both endpoints survive.

Context ablation produces small failure cases that humans can audit quickly.

### 7. Counterfactual Real-Context Edits

These intentionally change one target property:

- Add a stamp that should become an artifact.
- Add a caption under an existing figure.
- Add a note marker and note body to a real page.
- Add a table-like distractor near a verified table.
- Remove enough table rules to create a borderless table stress case.

Counterfactual cases require higher scrutiny. They should be training candidates only after human audit or strong verification because they partially synthesize new semantics into real pages.

### 8. PDF Operator Transforms

When technically feasible, preserve visual output but alter internals:

- Fragment text operators.
- Reorder content streams where render stays unchanged.
- Change object ordering.
- Change compression.
- Subset fonts differently.
- Remove or alter nonessential metadata.

Truth morphism:

- Visual truth is preserved.
- Parser-facing extraction changes are measured separately.

These cases are parser stress tests and should be reported separately from semantic-model failures.

## Transform Preconditions

A real-derived transform is allowed only when:

- The seed PDF has an intake manifest.
- Privacy status is public or redacted.
- License permits derivative internal testing, or the derivative remains non-redistributable.
- Seed split is assigned before transformation.
- Seed labels needed by the transform meet the required confidence tier.
- The transform can define a truth morphism.
- Render verification can prove the transformed page is not blank, clipped, or incoherent.

## Split Discipline

Every derivative inherits the seed split.

Rules:

- A train seed can create only train derivatives.
- A validation seed can create only validation derivatives.
- A test seed can create only test derivatives.
- A locked-audit seed can create only locked-audit derivatives.
- A release-anchor seed can create only evaluation derivatives, never training derivatives.
- Near-duplicate fingerprints are checked across all splits.

## Stronger Test Cases

Real-derived cases are stronger than raw real PDFs because they create measured local neighborhoods around real document behavior:

- Same real page under increasing blur.
- Same real table as ruled, partially ruled, and borderless.
- Same real note marker under varying proximity and visibility.
- Same real page with and without a stamp.
- Same real layout as full page, cropped region, and microcase.
- Same real content stream rendered normally and fragmented internally.

This lets reports show response curves, not isolated pass/fail anecdotes.

## Reports

Each real-derived shard should produce:

- Seed coverage report.
- Transform coverage report.
- Real-derived lineage report.
- Preserving-transform invariance report.
- Threshold response curves.
- Counterfactual pair report.
- Deterministic-vs-ML disagreement report.
- OOD and abstention report.
- Human audit packet list.

Primary metrics:

- Invariance violation rate.
- Robustness radius.
- First-failure threshold.
- Counterfactual success rate.
- Parent-clustered score.
- Worst-seed score.
- Parser extraction degradation curve.
- Validator impact.

## Training And Evaluation Use

Recommended use:

- Use real-derived preserving transforms for robustness evaluation and limited training only after labels are verified.
- Use real-derived threshold sweeps for calibration and abstention threshold selection.
- Use counterfactual real-context edits mainly for evaluation and audit until label confidence is high.
- Use unaltered real anchors for evaluation and release gating.
- Keep synthetic documents for perfect-truth rare structures and contract-gap exploration.

Never use locked-audit or release-gate derivatives for training.
