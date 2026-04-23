# Corpus Generation Plan

## Goal

Generate at least 100,000 meaningful PDF testcase documents with complete construction truth or confidence-tiered real-derived truth, rendered evidence, and contract-aligned labels for classifier training and engine regression. Meaningful means each document is built from an explicit structural intent or from a verified real seed PDF with a documented mathematical transform, not from random text boxes scattered on a page.

The primary 100,000-PDF body should be real-derived first and synthetic-supported. The planned average length is 3 to 5 pages, which yields roughly 300,000 to 500,000 pages while keeping small single-page diagnostic cases in the mix.

## Corpus Artifact Set

Every generated case should produce:

- `source.pdf`: the document under test.
- `truth.json`: construction graph, factor vector, expected roles, relationships, table grids, note links, artifacts, reading order, label confidence tiers, leakage fingerprints, and contract projections.
- `layout.expected.json`: optional expected layout contract projection.
- `semantic.expected.json`: optional expected semantic contract projection.
- `tagging.expected.json`: optional expected tag-tree projection when the current contracts can represent the truth.
- `render/page-*.png`: deterministic raster renders.
- `render/page-*.overlay.png`: bounding boxes, labels, reading order, and table grids.
- `probe-report.json`: independent verification checks.
- `case-report.md`: human-readable VIVID evidence block summary.

The truth manifest should be a proposed shared contract later. Until then, it stays as a planning artifact under the machine-learning track.

The current draft truth proposal is [contracts-draft/ml-ground-truth.schema.json](contracts-draft/ml-ground-truth.schema.json). Engine modules must not consume that draft until it is promoted through shared contract review.

## Case Identity

Case IDs should be deterministic and informative:

`mlpdf:<family>:<split>:<seed-group>:<case-index>:<short-hash>`

Each case stores:

- `seed`: 64-bit integer seed.
- `generatorVersion`: semantic version of the generator.
- `realSeedDocumentId`: stable parent ID when the case is derived from a real PDF.
- `realTransformId`: transform ID when the case is mathematically adjusted from a real PDF.
- `factorVectorHash`: stable hash of the sampled factors.
- `pdfSha256`: hash of the emitted PDF bytes.
- `renderSha256`: hash per rendered page image.
- `truthSha256`: hash of the truth manifest.
- `selectionUnitId`: split unit used to prevent near-duplicate leakage.
- `leakageFingerprints`: hashes for template, text source, table schemas, assets, producer profile, and rendered page perceptual signatures.

## Label Confidence Policy

Every label carries one confidence tier:

- `constructed`: generator intent only.
- `render-verified`: rendered output confirms the label exists.
- `extraction-verified`: parser-facing extraction confirms the label survived.
- `engine-projected`: current pipeline can project the label into an expected contract.
- `human-verified`: human audit accepted the label.
- `ambiguous`: label is intentionally excluded from supervised loss.
- `contract-gap`: concept is valid but not currently representable downstream.

High-impact labels cannot rely on `constructed` alone. High-impact labels include table structure, note links, artifact suppression, reading order, and any label that changes final tag-tree structure.

## Factor Space

Each generated PDF is sampled from a factor vector:

```text
x = {
  document_family,
  page_count,
  page_size,
  producer_profile,
  text_density,
  font_family,
  font_size_distribution,
  script_or_language,
  reading_direction,
  column_count,
  heading_depth,
  paragraph_shape,
  list_pattern,
  table_pattern,
  note_pattern,
  artifact_pattern,
  form_pattern,
  figure_pattern,
  scan_noise_pattern,
  compression_pattern,
  occlusion_pattern,
  rotation_skew_pattern,
  negative_control_pattern
}
```

Continuous factors are sampled with stratified Latin hypercube sampling. Categorical factors are covered with pairwise and selected three-way covering arrays. Rare combinations are then intentionally oversampled when they are known engine risks, such as borderless tables plus footnotes plus stamps.

## Mathematical Coverage Rules

The corpus should be generated from a coverage ledger, not a loose random loop.

Required coverage:

- Every single categorical factor value appears at least 500 times corpus-wide unless explicitly marked rare.
- Every pair of categorical factor values appears at least 25 times corpus-wide when the pair is valid.
- Every high-risk triple appears at least 40 times:
  - borderless table + multi-column page + footnotes
  - stamp/watermark + heading-like text + table nearby
  - sparse numeric table + missing headers + paragraph trap
  - endnotes + references + superscript math
  - scanned noise + rotated page + list indentation
  - RTL or CJK text + table + caption
- Boundary values appear in at least 5 percent of documents for each relevant continuous factor.
- Negative controls represent at least 8 percent of documents.
- At least 60 percent of the primary 100,000-PDF body should be real-derived unless licensing, privacy, or audit constraints make that unsafe.
- Every real-derived transform family appears in at least 1,000 cases before it is used for model claims.
- Every real-derived transform family has seed-level and transform-level VIVID evidence examples.

Difficulty score:

```text
D(case) =
  0.15 * layout_entropy +
  0.15 * role_overlap_risk +
  0.15 * table_complexity +
  0.10 * note_link_complexity +
  0.10 * artifact_interference +
  0.10 * reading_order_ambiguity +
  0.10 * visual_degradation +
  0.05 * multilingual_complexity +
  0.05 * font_encoding_complexity +
  0.05 * producer_quirk_complexity
```

The corpus should be bucketed into easy, medium, hard, and adversarial bands. Training, validation, and test splits must preserve these bands without sharing seeds or near-duplicate templates.

## Primary 100,000-PDF Allocation

| Family | Count | Purpose |
| --- | ---: | --- |
| Real-derived preserving transforms | 25,000 | Preserve real document semantics under controlled geometry, raster, OCR, artifact, and producer-style changes |
| Real-derived threshold sweeps | 15,000 | Measure breakpoints for skew, blur, alignment, contrast, note proximity, and table-rule visibility |
| Real-derived counterfactual and ablation cases | 10,000 | Minimal real-context edits that add, remove, isolate, or confuse target structures |
| Real-derived scan, OCR, and operator variants | 10,000 | Stress parser and extractor behavior while preserving rendered intent |
| Synthetic fully controlled rare-structure cases | 25,000 | Perfect-truth cases for rare notes, nested tables, forms, multilingual layouts, and adversarial traps |
| Unaltered real-anchor PDFs | 10,000 | Distribution check, release gate, and synthetic-to-real divergence measurement |
| Human-audited ambiguous and adversarial mixed cases | 5,000 | Ambiguity taxonomy, OOD, abstention, and contract-gap tests |
| Total | 100,000 | Minimum planned corpus size |

The detailed real-derived strategy is in [real-derived-corpus-plan.md](real-derived-corpus-plan.md). Synthetic PDFs remain necessary, but they no longer dominate the primary test body.

## Real-Derived Seed And Transform Model

Real-derived cases start with a seed PDF from the real-PDF intake mechanism:

```text
real PDF
  -> provenance and privacy review
  -> deterministic baseline
  -> profile fingerprints
  -> seed labels with confidence tiers
  -> mathematical transform
  -> truth morphism
  -> transformed PDF
  -> render, extraction, and engine verification
```

Allowed real-derived transform classes:

- Appearance-preserving affine transforms.
- Raster/reassembly transforms.
- Artifact injection.
- Table-region transforms.
- Note and citation transforms.
- Context ablation.
- Counterfactual real-context edits.
- PDF operator transforms.

Real-derived transforms are allowed only when the seed labels required by the transform meet the required confidence tier and the transform has a defined truth morphism.

## Structure Families

### Paragraphs With Odd Shapes

Generate paragraphs whose line boxes form non-rectangular geometry:

- Text wraps around figures or stamps.
- First-line and hanging indents vary.
- Paragraphs are interrupted by inline equations.
- Callouts cut into the left or right margin.
- Drop caps create large first-glyph boxes.
- Ragged columns cause uneven line lengths.

Truth must include paragraph membership, line order, and intended tag role.

### Tables

Table factors:

- Rules: full grid, horizontal-only, vertical-only, broken grid, no visible rules.
- Headers: none, one row, multiple rows, side headers, hierarchical headers.
- Cells: empty, numeric, text, wrapped, rotated text, merged cells, spanning headers.
- Structure: regular grid, ragged row, grouped columns, stub column, subtotal rows.
- Proximity: notes below table, caption above or below, paragraph adjacent, stamp overlap.
- Negative controls: aligned prose, definition lists, symbol glossaries, signature blocks.

Truth must include table ID, row count, column count, cell bbox, text ownership, row and column spans, header scope, caption link, footnote links, and expected reading order.

### Footnotes And Endnotes

Note factors:

- Marker style: numeric superscript, bracketed number, asterisk, dagger-like ASCII fallback, letters, roman numerals.
- Placement: page foot, column foot, table foot, section end, document end.
- Link pattern: one-to-one, many references to one note, continued note, missing note as negative control.
- Traps: exponents, ordinals, citation numbers, legal section numbers, list labels.

Truth must include marker object, note body object, link relation, note scope, and expected tag treatment. Because the current semantic contract lacks explicit footnote and endnote roles, this is a contract proposal area.

### Stamps, Watermarks, And Artifacts

Artifact factors:

- Text stamp, image stamp, vector seal, diagonal watermark, page number, running header/footer.
- Rotation, opacity, color, z-order, clipping, overlap with body text or table.
- Heading-like stamp text and table-like stamp alignment.

Truth must identify these as artifacts unless the document intentionally uses them as content.

### Noise

Noise is sampled as a transformation pipeline:

```text
born_digital_pdf
  -> optional render at DPI
  -> optional affine skew
  -> optional blur/dropout/compression
  -> optional scanner background/noise
  -> optional OCR text layer injection
  -> final test PDF
```

The manifest records both intended semantic truth and observed OCR/text-layer truth so parser behavior can be evaluated separately from model behavior.

## Split Strategy

Use seed groups to prevent leakage:

- Train: 70 percent
- Validation: 15 percent
- Test: 10 percent
- Locked audit: 5 percent

No template instance, seed group, generated paragraph content, rendered background, or exact table schema may appear in more than one split. The locked audit split is never used for model selection.

Additional holdouts are mandatory:

- Template holdout.
- Transform holdout.
- Producer holdout.
- Text-source holdout.
- Real-anchor holdout.
- Locked audit holdout.

Wave 2 children and real-derived children inherit the parent split. Real-anchor documents are split by source collection, document family, and producer cluster, not by individual file. Release-anchor seeds and their derivatives never enter training.

## Data Quality Gates Before Training

A generated case is training-eligible only when:

- The PDF opens with the selected parser and independent low-level inspector.
- Rendered pages match expected page count and dimensions.
- The truth manifest validates against the proposed truth schema.
- Required visual structures are confirmed by independent probes.
- Text coverage is within the expected band for born-digital cases.
- OCR/text-layer coverage is within the expected band for scanned cases.
- Overlay images are produced for human audit.
- No unknown generator warning remains unresolved.
- Required label confidence tiers are present.
- Leakage scanner passes for the case and its split.
- Contract-gap labels are excluded from production training targets unless explicitly scoped.
- Real-derived cases have a valid real seed intake record, transform ID, truth morphism, and render verification.
