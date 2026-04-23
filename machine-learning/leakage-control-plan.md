# Leakage Control Plan

## Purpose

Leakage control prevents overoptimistic ML results. The machine-learning track must treat leakage as a release blocker, not a report footnote.

## Split Units

Splits are assigned by selection unit, not by individual PDF:

- Wave 1 synthetic: template family plus seed group.
- Wave 2 derivative: parent case ID.
- Real-anchor: source collection plus document family plus producer cluster.
- Text-derived cases: source text family.
- Table-derived cases: table schema hash.
- Asset-derived cases: stamp, watermark, background, and font asset cluster.

All descendants inherit the parent split.

## Holdout Types

Every dataset version should include these holdouts:

- Template holdout: entire document templates unseen during training.
- Transform holdout: selected wave 2 transform families unseen during training.
- Producer holdout: PDF producer profiles unseen during training.
- Text-source holdout: text generation or source-text families unseen during training.
- Real-anchor holdout: real public PDFs unseen during model selection.
- Locked audit holdout: hidden from all model selection and threshold tuning.

## Required Fingerprints

Each truth manifest must record:

- Template hash.
- Seed group.
- Transform ID and transform version.
- Parent case ID for wave 2.
- Source text hash.
- Table schema hash.
- Asset hashes for stamps, watermarks, figures, backgrounds, and fonts.
- Producer profile hash.
- Render perceptual hash per page.
- OCR/noise profile hash when applicable.

## Leakage Scanner Requirements

Before training, a scanner must fail the dataset build when:

- Any parent lineage crosses splits.
- Any exact template hash crosses disallowed splits.
- Any source text hash crosses disallowed splits.
- Any exact table schema hash crosses disallowed splits unless explicitly allowed for a controlled holdout experiment.
- Any asset hash crosses locked audit and training.
- Any render perceptual hash is above near-duplicate similarity threshold across train and evaluation splits.
- Any preprocessing statistics are fitted using validation, test, or locked audit data.
- Any model selection record references locked audit metrics.

## Model-Selection Logging

Every model-selection run should record:

- Dataset version.
- Split access.
- Metrics read.
- Hyperparameters changed.
- Thresholds changed.
- Person or process that initiated the run.
- Whether test or locked-audit metrics were visible.

Locked audit metrics should be generated only for release-candidate runs and should not feed threshold tuning.

## Reports

The leakage report should include:

- Split sizes by selection unit and by PDF.
- Near-duplicate clusters.
- Fingerprint collisions.
- Parent-child split inheritance checks.
- Holdout coverage.
- Preprocessing fit scope.
- Model-selection access log summary.
- Hard failures and waivers.

Waivers require an explicit reason and must be visible in release reports.
