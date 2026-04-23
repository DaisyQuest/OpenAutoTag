# Model Card Template

Use this template for every trained model before it can be evaluated for release.

## Model Identity

- Model name:
- Model version:
- Model artifact hash:
- Training code version:
- Inference code version:
- Training dataset version:
- Validation dataset version:
- Test dataset version:
- Locked audit dataset version:
- Owner:
- Contact:

## Intended Use

- Intended engine stage:
- Intended task heads:
- Intended document profiles:
- Intended operating mode:
- Fallback behavior:
- Explicitly unsupported use cases:

## Architecture

- Model family:
- Inputs:
- Outputs:
- Feature extraction:
- Calibration method:
- OOD method:
- Abstention policy:
- Runtime dependencies:

## Training

- Training start/end:
- Hardware:
- Hyperparameters:
- Random seeds:
- Checkpoint selection rule:
- Preprocessing fit scope:
- Data augmentation:
- Class balancing:
- Label confidence tiers used:
- Excluded labels:

## Evaluation Summary

- Macro F1:
- Per-role precision/recall/F1:
- Object detection mAP:
- Table structure metrics:
- Relationship metrics:
- Reading-order metrics:
- Tag-tree metrics:
- Real-anchor metrics:
- Locked audit metrics:
- Parent-clustered wave 2 metrics:
- Worst-child/worst-parent metrics:

## Calibration And Abstention

- Global expected calibration error:
- Per-role expected calibration error:
- Per-slice expected calibration error:
- Brier score:
- Reliability plot paths:
- Coverage versus accuracy:
- Abstention thresholds:
- Low-confidence fallback rate:
- OOD fallback rate:

## Slice Analysis

Report each critical slice:

- Borderless tables:
- Sparse numeric tables:
- Footnotes:
- Endnotes:
- Stamps/watermarks:
- Multi-column reading order:
- Forms:
- Captions and figures:
- Multilingual and bidi:
- Scanned/OCR-heavy:
- Producer holdouts:
- Template holdouts:
- Transform holdouts:
- Text-source holdouts:

## Known Limitations

- Known failure modes:
- Known ambiguous cases:
- Known contract gaps:
- Known OOD profiles:
- Known runtime limits:
- Known label-quality limits:

## Safety And Rollback

- Default mode:
- Emergency disable flag:
- Version pinning strategy:
- Rollback procedure:
- Shadow-mode report path:
- Release gate report path:
