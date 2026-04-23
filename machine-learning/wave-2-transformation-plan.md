# Wave 2 Transformation Plan

## Purpose

Wave 1 creates or curates a truth-bearing corpus. Wave 2 mathematically transforms that original corpus into a larger, finer-grained suite of derivative testcases.

The important shift is lineage. A wave 2 testcase is not just another random PDF. It is a controlled child of an original parent case, with a known transform, known parameters, known truth mapping, and a known oracle.

## Academic Basis

Wave 2 is guided by four testing ideas:

- Metamorphic testing: when a perfect oracle is hard, define relations between original and transformed inputs and outputs. Reference: https://arxiv.org/abs/1804.11121
- Combinatorial testing: use covering arrays so multi-factor interactions are tested without exhaustive enumeration. Reference: https://www.nist.gov/publications/practical-combinatorial-testing-beyond-pairwise
- Property-based testing: generate many cases from formal properties, then shrink failures toward minimal counterexamples. Reference: https://research.chalmers.se/en/publication/177264
- ML system testing: robustness requires test generation, test adequacy, and explicit evaluation of data, model, and workflow behavior. Reference: https://www.emergentmind.com/papers/1906.10742

For OpenAutoTag, this means each transform must carry its own expected property and failure explanation.

## Formal Model

Represent each original corpus case as:

```text
c = (pdf, render, truth_graph, factor_vector, split, hashes)
```

Represent a transform as:

```text
t = (
  transform_id,
  precondition,
  parameter_space,
  pdf_operation,
  truth_morphism,
  invariants,
  oracle_relation
)
```

Applying transform `t` with parameter vector `a` produces:

```text
c_prime = t_a(c)
truth_prime = truth_morphism(truth_graph, a)
```

Every derived testcase must store:

- Parent case ID.
- Parent corpus version.
- Transform ID and version.
- Parameter vector.
- Truth morphism summary.
- New PDF hash.
- New render hash.
- New truth hash.
- Oracle type.
- Oracle confidence.
- Verification status.

Oracle confidence uses the same tier names as label confidence: `constructed`, `render-verified`, `extraction-verified`, `human-verified`, `ambiguous`, and `contract-gap`.

## Oracle Types

### Preserving Oracle

The transform changes appearance or encoding but should preserve logical truth.

Example:

```text
Move a table 12 points down.
Expected: same table role, same cells, same header cells, same reading order inside the table.
Changed: bounding boxes are translated by +12 points on y.
```

### Monotonic Oracle

The transform sweeps one difficulty parameter and expected quality should degrade smoothly or stay stable until a known tolerance boundary.

Example:

```text
Increase scan blur from 0.0 to 2.0.
Expected: role predictions should be stable through the accepted blur band.
Observed metric: recall should not drop before the threshold.
```

### Threshold Oracle

The transform moves a case around a known boundary where classification should change or become uncertain.

Example:

```text
Reduce heading font-size delta from +6 points to +0 points.
Expected: H2 confidence decreases; role flips to paragraph only after the intended boundary.
```

### Counterfactual Oracle

The transform makes a minimal semantic edit that should flip one target label while preserving nearby labels.

Example:

```text
Convert aligned prose into a true borderless table by adding a header row and repeated column semantics.
Expected: target region changes from P nodes to Table/TH/TD nodes.
```

### Extraction Oracle

The transform isolates a component into a smaller PDF while preserving the intended local truth.

Example:

```text
Extract only the footnote marker and footnote body region onto a single-page microcase.
Expected: note marker, note body, and link relation remain present.
```

## Wave 2 Corpus Size

Start from the 100,000-PDF wave 1 corpus and derive a 1,000,000-PDF wave 2 suite.

| Derivative family | Count | Purpose |
| --- | ---: | --- |
| Atomic microcases | 200,000 | Isolate one table, note, list, stamp, paragraph, form field, or caption |
| Metamorphic preserving variants | 200,000 | Preserve labels under geometry, typography, and encoding changes |
| Threshold sweeps | 150,000 | Probe exact boundaries for font size, spacing, indentation, noise, and alignment |
| Counterfactual pairs | 150,000 | Create near-identical cases where one target label intentionally changes |
| Context ablations and additions | 100,000 | Remove or add neighboring evidence and distractors |
| Noise robustness variants | 100,000 | Render/reassemble, skew, blur, dropout, compression, and OCR layer variants |
| PDF producer, font, and operator variants | 60,000 | Stress extraction without changing visual truth |
| Failure-neighborhood variants | 40,000 | Expand around known engine/model failures |
| Total | 1,000,000 | Larger fine-grained suite derived from the original corpus |

This target can be generated physically or lazily. For expensive transforms, store the manifest and generate PDFs on demand, but all selected release and audit cases must have materialized PDFs and rendered evidence.

## Lineage And Split Discipline

All descendants inherit the parent split.

Rules:

- A train parent can produce only train children.
- A validation parent can produce only validation children.
- A test parent can produce only test children.
- A locked audit parent can produce only locked audit children.
- No child of a validation, test, or locked audit parent can be used for training.
- Metrics must be reported both by child case and by parent lineage cluster.

This prevents a model from seeing a near-duplicate of an evaluation case during training.

## Finer-Grained Testcase Levels

Wave 2 creates cases at several granularities:

| Level | Unit | Example |
| --- | --- | --- |
| Document | Whole transformed PDF | Same report with added watermark |
| Page | One page from a multi-page parent | Page containing the difficult table |
| Region | Cropped and rebased region | Only the table plus caption |
| Block | One semantic block with neighbors | Paragraph beside stamp |
| Token | Marker, label, or cell text | Superscript marker vs exponent |
| Relationship | Linked objects | Footnote reference and body |
| Operator | PDF drawing behavior | Same text visually, fragmented into many text operators |

The region, block, token, and relationship levels are what make the suite finer-grained. They let a failure be explained without requiring a human to inspect a full source document.

## Transform Families

### 1. Atomization Transforms

Extract a smaller case from a parent:

- Single page extraction.
- Region crop onto blank page.
- Table-only page.
- Row-band and column-band table page.
- Footnote-only page.
- Footnote-reference plus body page.
- List-only page.
- Stamp-over-content page.
- Caption plus figure page.
- Form-field group page.

Truth morphism:

- Preserved nodes are copied.
- Deleted context nodes are marked as removed.
- Coordinates are rebased to the new page.
- Relationships are retained only when both endpoints survive.

Acceptance:

- Rendered region contains all preserved nodes.
- No preserved node is clipped.
- All deleted nodes are absent from the extracted PDF.

### 2. Geometric Transforms

Apply affine or layout-level geometry changes:

- Translate region.
- Scale page content.
- Rotate by small angles.
- Skew scan-like content.
- Change margins.
- Move table closer to paragraph.
- Move footnote closer to or farther from body text.
- Add column gutter variation.

Truth morphism:

```text
bbox_prime = affine_matrix * bbox
reading_order_prime = reading_order unless the transform intentionally changes layout order
```

Acceptance:

- Bounding-box IoU after inverse mapping is above threshold.
- Role labels are unchanged for preserving transforms.
- Reading-order relation remains expected.

### 3. Typographic Transforms

Change typography while controlling semantics:

- Font family swap.
- Font weight change.
- Font size sweep.
- Leading and line-gap sweep.
- Kerning and character spacing variation.
- Italic or small caps.
- Low-contrast text.
- Superscript offset sweep.

Important threshold sweeps:

- Heading font-size delta.
- List-label indent.
- Footnote font-size ratio.
- Caption proximity to figure or table.
- Table header boldness.

Acceptance:

- Text remains extractable unless the case explicitly tests OCR or encoding degradation.
- The intended role flips only in counterfactual transforms.
- Sensitivity curves are generated for threshold sweeps.

### 4. Table Transforms

Transform tables into targeted families:

- Remove vertical rules.
- Remove all rules to create borderless tables.
- Add broken grid lines.
- Jitter column alignment.
- Add or remove header emphasis.
- Convert first row between header and body.
- Split one cell text into multiple text operators.
- Merge cells.
- Split merged cells.
- Move table notes above or below the table.
- Add paragraph traps aligned with columns.

Truth morphism:

- Cell IDs remain stable when structure is preserved.
- New cells receive derived IDs.
- Deleted cells are recorded.
- Header scope changes are explicit.
- Table role changes are explicit for counterfactuals.

Acceptance:

- Expected row and column counts are verified.
- Header and body sections are independently checked.
- Borderless cases have low vector-line evidence and high alignment evidence.

### 5. Note Transforms

Transform footnotes and endnotes:

- Numeric marker to symbolic marker.
- Superscript to bracketed marker.
- Page footnote to column footnote.
- Page footnote to endnote.
- Single marker to repeated marker.
- Many references to one note.
- Note body continuation.
- False note marker from exponent, ordinal, citation, or list label.

Truth morphism:

- Marker node, note body node, and link relation are first-class objects.
- Negative controls explicitly mark that no note relation exists.

Acceptance:

- Marker and body are both visible.
- Marker and body are both extractable for born-digital cases.
- Link relation is preserved or intentionally changed.

### 6. Artifact Transforms

Inject or modify artifacts:

- Diagonal watermark.
- Approval stamp.
- Date stamp.
- Page header.
- Page footer.
- Page number.
- Vector seal.
- Low-opacity background text.
- Stamp overlapping a table or heading.

Truth morphism:

- Artifact nodes are added.
- Existing content labels are preserved.
- Overlapped nodes record occlusion metadata.

Acceptance:

- Artifact is visible in render.
- Artifact is identified in truth.
- Existing content remains visible unless the transform explicitly tests occlusion.

### 7. Noise And Scan Transforms

Render and rebuild the PDF:

- DPI sweep.
- Gaussian blur.
- Salt-and-pepper dropout.
- JPEG compression.
- Background texture.
- Deskew error.
- Rotation.
- OCR text layer injection.
- OCR text layer omission.

Truth morphism:

- Semantic truth is preserved.
- Observed text-layer truth is separately recorded.
- OCR uncertainty is recorded.

Acceptance:

- Page is nonblank.
- Noise parameters match measured image statistics.
- OCR/text-layer coverage falls in the intended band.

### 8. PDF Producer And Operator Transforms

Keep visual truth but alter PDF internals:

- Fragment text into one operator per glyph.
- Combine nearby glyph runs.
- Change content stream order while preserving visual placement.
- Use different producer metadata.
- Change compression.
- Change object ordering.
- Subset fonts differently.
- Stress ToUnicode availability when legally and technically appropriate.

Truth morphism:

- Visual and semantic truth are preserved.
- Operator-level changes are recorded for parser diagnostics.

Acceptance:

- Render comparison remains within tolerance.
- Text extraction differences are expected and recorded.
- Parser failures are attributed to operator-level changes.

### 9. Context Ablation And Distractor Transforms

Remove or add context:

- Remove caption while keeping table.
- Add caption-like paragraph near a table.
- Remove heading hierarchy above a section.
- Add sidebar near multi-column body.
- Add aligned prose near a table.
- Add math superscripts near notes.
- Remove all but one list item.

Truth morphism:

- Preserved nodes stay mapped.
- Added distractors receive explicit negative-control labels.
- Removed context is recorded.

Acceptance:

- Target label remains stable for preserving cases.
- Target label flips only for counterfactual cases.

### 10. Failure-Neighborhood Transforms

When the engine or model fails, generate a local neighborhood around that failure.

For a failing case with factor vector `x`, generate:

```text
x_i_minus = x with factor_i moved one step easier
x_i_plus = x with factor_i moved one step harder
x_pair = x with two suspected factors varied by a covering array
```

This produces a local response surface around the failure so the team can distinguish:

- A single-factor threshold failure.
- A two-factor interaction failure.
- A label issue.
- A parser extraction issue.
- A contract gap.

## Parameter Selection

Use three parameter strategies:

### Covering Arrays

For categorical transform parameters, require at least pairwise coverage and selected three-way coverage for risky interactions.

Examples:

- stamp type x opacity x rotation
- note marker style x placement x font-size ratio
- table rule style x header style x row spacing
- scan blur x skew x OCR layer state

### Latin Hypercube Sampling

For continuous parameters, use stratified samples across valid ranges:

- rotation angle
- blur radius
- font-size ratio
- line-gap ratio
- column jitter
- watermark opacity

### Boundary Sweeps

For known thresholds, sample around boundary values:

```text
values = boundary + step * [-4, -3, -2, -1, 0, 1, 2, 3, 4]
```

Boundary sweeps should be paired with sensitivity reports so a human can see exactly where the engine changes behavior.

## Derived Truth Manifest

Every wave 2 child should include a transformation manifest:

```json
{
  "schemaVersion": "0.1.0-planned",
  "derivedCaseId": "mlpdf2:table-borderless:test:g042:000713:3d91ac",
  "parentCaseId": "mlpdf:table:test:g042:000713:8df31a",
  "parentCorpusVersion": "wave1-0.1.0-planned",
  "transform": {
    "id": "table.remove-rules",
    "version": "0.1.0-planned",
    "oracleType": "preserving",
    "oracleConfidence": "render-verified",
    "parameters": {
      "removeHorizontalRules": false,
      "removeVerticalRules": true,
      "columnJitterPoints": 0.8
    }
  },
  "truthMorphism": {
    "preservedNodeIds": ["tbl-1", "tbl-1-r0-c0"],
    "addedNodeIds": [],
    "removedNodeIds": [],
    "roleFlips": [],
    "coordinateTransform": "identity-with-column-jitter"
  },
  "expectedRelation": {
    "roleLabels": "preserve",
    "tableStructure": "preserve",
    "readingOrder": "preserve",
    "bboxTolerancePoints": 3.0
  }
}
```

## Reports

### Lineage Report

Shows every parent and its children:

- Parent case ID.
- Transform counts by family.
- Verification pass/fail.
- Children used in train, validation, test, or audit.
- Worst child metrics.
- Representative child overlays.

### Transform Atlas

Whole-suite report:

- Counts by transform family.
- Parameter coverage.
- Pairwise and selected three-way coverage.
- Pass/fail by transform.
- Engine sensitivity by transform.
- Model sensitivity by transform.

### Sensitivity Curve Report

For threshold sweeps:

- Parameter on x-axis.
- Deterministic engine role/confidence on y-axis.
- ML role/confidence on y-axis.
- Ground-truth expected boundary.
- First failure point.
- Stability radius.

### Counterfactual Pair Report

For near-identical pairs:

- Parent render.
- Child A render and overlay.
- Child B render and overlay.
- Minimal edit description.
- Expected role difference.
- Observed deterministic difference.
- Observed ML difference.

### Shrink Report

For a failure:

- Original failing case.
- Sequence of simplifications.
- Smallest reproduced failure.
- Removed factors.
- Remaining causal factors.
- Recommended owner: parser, layout, semantic, reading order, tag builder, writer, validator, contract, or label.

## Metrics Specific To Wave 2

Wave 2 should report:

- Parent-clustered accuracy: average per parent, not only per child.
- Worst-child score per parent.
- Robustness radius: largest tolerated perturbation before failure.
- Flip distance: smallest semantic edit that changes prediction.
- Invariance violation rate: percentage of preserving transforms that changed labels unexpectedly.
- Counterfactual success rate: percentage of intended flips detected correctly.
- Sensitivity slope: how sharply confidence changes near a boundary.
- Transform validity rate: percentage of children whose PDF and truth verification passed.

These metrics prevent one parent with many easy children from dominating the report.

## Acceptance Gates

Before wave 2 can feed training:

- At least 99 percent of materialized child PDFs pass structural and render verification.
- At least 98 percent of preserving transforms pass truth-morphism verification.
- Every derivative case has parent lineage, transform ID, parameter vector, and oracle type.
- Every derivative case has oracle confidence and contract projection status.
- Every child inherits the parent split.
- Every transform family has VIVID evidence examples.
- Every transform family has a human-reviewed oracle validation sample.
- At least 50,000 children are human-audit eligible with overlays.
- All locked-audit descendants remain excluded from training and model selection.

Before wave 2 can feed release gating:

- Parent-clustered metrics are reported.
- Worst-child metrics are reported.
- Counterfactual pair reports are generated for all target roles.
- Sensitivity curves exist for known heuristic thresholds.
- Failure-neighborhood reports exist for all critical regressions.

## Implementation Order

1. Define the wave 2 transformation manifest.
2. Implement lineage and split rules.
3. Implement atomization transforms first because they produce the smallest human-auditable cases.
4. Implement preserving geometry and typography transforms.
5. Implement table and note transforms.
6. Implement artifact and noise transforms.
7. Implement counterfactual pairs.
8. Implement failure-neighborhood expansion.
9. Add transform atlas, lineage reports, sensitivity reports, and shrink reports.
10. Select a small CI subset from high-value transforms.

## First Pilot

Use 1,000 wave 1 parent PDFs and generate 20,000 wave 2 children:

- 5 children per parent from atomization.
- 5 children per parent from preserving transforms.
- 4 children per parent from table or note transforms when applicable.
- 3 children per parent from threshold sweeps.
- 2 children per parent from distractors or artifacts.
- 1 child per parent from noise or operator transforms.

Pilot acceptance:

- 19,500 verified children.
- No split inheritance violations.
- At least 100 shrinkable failures discovered or a documented explanation that the current engine passed the pilot.
- Reports generated for all transform families used in the pilot.
