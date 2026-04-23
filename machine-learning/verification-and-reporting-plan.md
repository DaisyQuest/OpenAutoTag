# Verification And Reporting Plan

## Purpose

The generated corpus should be trusted only after independent verification proves that the PDF contains the structures the manifest claims. The reports must support two audiences:

- Engineers need deterministic pass/fail gates and regression deltas.
- Human reviewers need vivid, inspectable proof that labels are correct and failures are explainable.

## Verification Layers

### 1. Construction Verification

The generator records every authored object before PDF emission:

- Logical object ID.
- Intended role.
- Text content.
- Page number.
- Bounding box.
- Parent/child relationship.
- Reading-order index.
- Table, list, note, form, figure, or artifact relationship.

This proves intent, not rendered reality.

### 2. PDF Structural Verification

Low-level PDF probes should confirm:

- Page count and page boxes.
- Text operators and glyph counts.
- Vector line counts for ruled table cases.
- Image and XObject counts.
- Font resources and ToUnicode state when relevant.
- Rotation, opacity, and artifact drawing operators when relevant.
- Expected producer profile.

This catches generator or PDF-library bugs.

### 3. Render Verification

Every page is rendered to PNG and checked for:

- Nonblank page image.
- Expected page dimensions.
- Text and shape occupancy within expected bands.
- No clipped required content.
- Stamp, watermark, or occlusion visible when requested.
- Borderless table cases have low vector-line evidence but clear text alignment.
- Ruled table cases have expected horizontal and vertical stroke evidence.

Rendered overlays are the main human audit artifact.

### 4. Extraction Verification

Parser-facing extraction should confirm:

- Expected text coverage for born-digital PDFs.
- Expected OCR/text-layer behavior for scanned PDFs.
- Block bounding boxes overlap construction truth above threshold.
- Known artifacts are present but suppressible.
- Superscripts, note markers, list labels, and table cells survive extraction.

### 5. Engine Verification

Run the current pipeline:

```text
parser -> layout-analyzer -> semantic-engine -> reading-order -> tag-builder -> pdf-writer -> validator
```

Compare outputs against truth projections:

- Block role precision, recall, and F1.
- Table detection mAP and cell assignment accuracy.
- Header-cell and data-cell F1.
- Note marker detection F1.
- Note link accuracy.
- Artifact suppression precision and recall.
- Reading-order pairwise accuracy and inversion count.
- Tag-tree structural match.
- Validator findings by severity.

## VIVID Evidence Blocks

VIVID means Visual, Invariant, Verifiable, Inspectable, Diagnostic.

Every important claim in a report should have a VIVID evidence block:

```json
{
  "caseId": "mlpdf:borderless-table:test:g042:000713:8df31a",
  "claim": "Page 2 contains a borderless table with two header rows, four body rows, and no visible column rules.",
  "visual": {
    "page": 2,
    "renderPng": "render/page-002.png",
    "overlayPng": "render/page-002.overlay.png",
    "thumbnailPng": "render/page-002.thumb.png"
  },
  "invariant": [
    {
      "name": "table_cell_count",
      "expected": 24,
      "observed": 24,
      "status": "pass"
    },
    {
      "name": "vertical_rule_count",
      "expectedMax": 0,
      "observed": 0,
      "status": "pass"
    },
    {
      "name": "column_alignment_rms_points",
      "expectedMax": 2.5,
      "observed": 1.3,
      "status": "pass"
    }
  ],
  "verifiable": {
    "seed": 832901441,
    "generatorVersion": "0.1.0-planned",
    "pdfSha256": "example",
    "truthSha256": "example",
    "commands": [
      "node machine-learning/bin/verify-case.js <case-dir>"
    ]
  },
  "inspectable": {
    "truthObjectIds": ["tbl-2", "tbl-2-r0-c0", "tbl-2-r1-c3"],
    "expectedTags": ["Table", "THead", "TR", "TH", "TBody", "TD"]
  },
  "diagnostic": {
    "status": "pass",
    "notes": "Borderless table evidence comes from text alignment, not vector rules."
  }
}
```

Every VIVID block that supports a training label must also record the label confidence tier and whether the label projects into a current contract or remains a contract gap.

## Report Suite

### Per-Case Report

One report per generated PDF:

- Case metadata.
- Factor vector.
- Page thumbnails.
- Overlay images.
- VIVID evidence blocks for declared structures.
- Probe results.
- Pipeline comparison.
- Failure notes and triage labels.

### Shard Report

One report per shard, recommended size 1,000 PDFs:

- Coverage summary.
- Failed generation count.
- Failed verification count.
- Structure distribution.
- Difficulty distribution.
- Top failing factors.
- Representative pass examples.
- Representative fail examples.

### Corpus Atlas

Whole-corpus report:

- Total PDFs, pages, objects, blocks, table cells, notes, artifacts.
- Coverage matrix for all factors.
- Pairwise and high-risk triple coverage.
- Split integrity checks.
- Leakage scanner summary.
- Effective sample size by parent cluster, template family, transform family, text source, producer profile, and visual signature.
- Deduplication and leakage checks.
- Role balance and rare-class counts.
- Synthetic-vs-real anchor comparison.
- Human audit sample list.

### Training Report

For each model run:

- Dataset version and hashes.
- Model architecture and feature inputs.
- Training configuration.
- Precision, recall, F1 by role.
- Confusion matrix.
- Slice metrics by factor.
- Calibration metrics: expected calibration error, Brier score, reliability plots.
- Abstention behavior at confidence thresholds.
- OOD behavior by document profile.
- Parent-clustered metrics and worst-parent metrics for wave 2.
- Regression comparison against previous model.
- Examples where ML helps deterministic rules.
- Examples where ML hurts deterministic rules.

### Release Report

Before an ML-assisted classifier can affect engine output:

- Locked audit score.
- Real-PDF anchor score.
- Validator impact.
- Performance impact.
- Memory and runtime impact.
- Calibration and abstention gates.
- OOD and unknown-profile behavior.
- Shadow-mode deterministic-vs-ML decision logs.
- Rollback plan.
- Contract compatibility proof.

## Metrics

Classification metrics:

- Accuracy only as a secondary metric.
- Macro F1 to avoid hiding rare-role failures.
- Per-class precision and recall.
- Area under precision-recall curve for rare roles.
- Confusion matrix normalized by truth class and prediction class.

Detection metrics:

- mAP across IoU thresholds for region/table detection.
- IoU distribution by role.
- Cell assignment accuracy.
- Table structure exact match and relaxed match.

Relationship metrics:

- Note reference link accuracy.
- Table caption link accuracy.
- Figure caption link accuracy.
- Parent-child tag relationship F1.

Reading-order metrics:

- Pairwise order accuracy.
- Kendall tau.
- Inversion count per page.
- Table row-major order accuracy.

Calibration metrics:

- Expected calibration error.
- Maximum calibration error.
- Brier score.
- Reliability curve.
- Coverage versus accuracy under abstention.

## Human Audit Design

Human review should not require reading raw JSON first. Each audit packet should show:

- A page thumbnail with overlay.
- The local truth snippet.
- The model prediction snippet.
- A short explanation of why the case exists.
- The exact invariants that passed or failed.
- A checkbox outcome: correct, label bug, generator bug, engine bug, ambiguous, contract gap.

Audit sampling should be stratified:

- Random sample from every family.
- Oversample rare classes.
- Oversample high-difficulty cases.
- Oversample recent failures.
- Include all new generator templates until stable.
