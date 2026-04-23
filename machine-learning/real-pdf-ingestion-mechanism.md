# Real PDF Ingestion Mechanism

## Purpose

After the ML system is calibrated against mathematically generated documents, wave 2 derivatives, and controlled synthetic reports, real PDFs should enter through a staged intake mechanism. Real PDFs should not be dumped directly into training or production inference. They should be profiled, verified, routed, run in shadow mode first, audited when needed, and promoted only when evidence supports promotion.

The primary corpus plan now uses some real PDFs as seed documents for mathematically adjusted real-derived testcases. Those real-derived cases still pass through this intake mechanism first.

## Current Project Baseline

The current engine is already working remarkably well as a deterministic accessibility-tagging baseline. The project has parser, layout analysis, semantic mapping, reading order, tag tree construction, PDF writing, font handling, validation reports, goldmaster tests, stress fixtures, external PDF fixtures, corpus scoring tools, native verification, and report renderers.

That existing calibration and regression surface is a solid starting point for ML. The ML plan should build on it rather than replace it. In practical terms:

- Deterministic output remains the baseline and fallback.
- Goldmasters remain the behavioral lock for known fixtures.
- Existing external PDFs remain early real-world anchors.
- Validator, writer, tag-delta, native verification, and corpus reports remain primary evidence.
- ML starts as shadow evidence and earns authority only where it improves measured weak slices.

## High-Level Flow

```text
real PDF intake
  -> provenance and safety review
  -> fingerprinting and profile detection
  -> deterministic engine run
  -> optional seed-label audit
  -> mathematical real-derived transform
  -> transformed-case verification
  -> calibrated ML shadow inference
  -> OOD and abstention policy
  -> report and human audit queue
  -> optional label enrichment
  -> active-learning queue
  -> curated training/evaluation promotion
```

## Readiness Condition

Real PDFs can be fed to the ML only after the mathematical corpus calibration reaches these gates:

- Synthetic calibration corpus has a completed dataset datasheet.
- Wave 2 transform corpus has parent-clustered and worst-child metrics.
- Calibration reports exist for all model task heads.
- OOD and abstention thresholds are set on validation data.
- Leakage scanner passes.
- The model runs in shadow mode without changing engine output.
- Real-anchor smoke corpus has deterministic baseline metrics.

Before those gates, real PDFs may be collected, profiled, and run through the deterministic engine, but their ML outputs are research-only.

## Intake Batches

Real PDFs enter as batches. A batch is immutable after registration.

Each batch records:

- Batch ID.
- Intake date.
- Owner.
- Source family.
- License and redistribution status.
- Privacy/sensitivity status.
- Intended use: smoke, real-anchor, shadow, audit, training candidate, release gate.
- Whether the batch may seed real-derived transforms.
- Hash manifest.
- Processing status.

The batch manifest should validate against the draft schema:

[contracts-draft/real-pdf-intake.schema.json](contracts-draft/real-pdf-intake.schema.json)

## Per-PDF Intake Record

Every PDF records:

- Stable document ID.
- Absolute or corpus-relative path.
- SHA-256 hash.
- Source URL or provenance note.
- License or redistribution status.
- Privacy review state.
- Page count.
- Producer metadata.
- Language/script profile.
- Born-digital, scanned, or hybrid profile.
- Existing tag/structure state when available.
- Fingerprints for leakage and near-duplicate detection.
- Profile routing decision.
- OOD decision.
- ML mode: disabled, research-only, shadow, assistive-candidate.
- Human audit state.

## Routing States

Real PDFs move through explicit states:

| State | Meaning | ML behavior |
| --- | --- | --- |
| `registered` | Batch and files are known by hash | No ML |
| `profiled` | Metadata, fingerprints, and document profile exist | No ML or research-only |
| `deterministic-baselined` | Current engine has produced pipeline artifacts | No output changes |
| `ml-shadowed` | Calibrated ML has run in shadow mode | Predictions are evidence only |
| `audit-queued` | Human review is required | Predictions remain non-authoritative |
| `audit-accepted` | Human review accepted labels or behavior | Candidate for curated use |
| `training-candidate` | Approved for future training data | Requires leakage checks |
| `real-derived-seed` | Approved as a parent for mathematical transforms | Derivatives inherit split and policy |
| `release-gate` | Approved for release evaluation | Never used for training |
| `quarantined` | Unsafe, ambiguous, unlabeled, corrupt, or policy-failing | Excluded from training/release |

## Shadow Inference

For real PDFs, ML inference starts in shadow mode:

- The deterministic engine remains final.
- ML predictions are emitted through `ml-predictions.schema.json` or its promoted successor.
- Every prediction includes calibrated confidence, abstention reason, OOD score, and contract projection.
- Decision logs compare deterministic decision, ML decision, final decision, and fallback reason.
- Reports highlight where ML would have changed tags.

Shadow mode is the primary mechanism for learning from real PDFs without risking output quality.

## OOD And Abstention

Real PDFs should be assumed out of distribution until proven otherwise.

The system must abstain when:

- Document profile is `out-of-distribution` or `unknown`.
- Calibrated confidence is below task threshold.
- Role is a contract gap.
- Input is ambiguous or extraction evidence is insufficient.
- PDF profile is outside validated release envelope.
- Runtime policy requires deterministic-only output.

Abstention is not a failure. It is the expected safe behavior for unfamiliar PDFs.

## Human Audit Loop

Audit is triggered by:

- High-confidence disagreement between deterministic and ML outputs.
- Low-confidence predictions on high-impact roles.
- OOD near-boundary documents.
- New producer profiles.
- Rare structures: footnotes, endnotes, sparse tables, borderless tables, stamps, captions, forms, and multilingual pages.
- Validator regressions.

Audit outcomes:

- `correct-deterministic`
- `correct-ml`
- `both-wrong`
- `label-needed`
- `ambiguous`
- `contract-gap`
- `parser-issue`
- `layout-issue`
- `semantic-issue`
- `reading-order-issue`
- `tag-builder-issue`
- `writer-or-validator-issue`

Only audited and leakage-safe real PDFs can become training candidates.

## Active Learning Queue

Real PDFs should feed an active-learning queue, not raw training sets.

Priority score:

```text
priority =
  0.25 * uncertainty +
  0.20 * deterministic_ml_disagreement +
  0.15 * ood_nearness +
  0.15 * role_rarity +
  0.10 * validator_impact +
  0.10 * producer_novelty +
  0.05 * human_business_value
```

The queue should surface small audit packets with page render, overlay, deterministic output, ML prediction, OOD score, confidence, and suggested owner.

## Promotion Rules

Real PDFs can be promoted to:

- Smoke anchor: light public-regression coverage.
- Evaluation anchor: real-world evaluation only.
- Release gate: locked release evaluation.
- Training candidate: future supervised training after audit and leakage checks.

Rules:

- Release-gate PDFs must never enter training.
- Training candidates cannot share near-duplicate fingerprints with validation, test, or release-gate PDFs.
- Real PDFs with privacy uncertainty stay quarantined.
- Ambiguous cases stay out of supervised loss but can remain in audit and OOD reports.
- Contract-gap cases can drive contract work but should not be treated as model failures.

## Reports

Real-PDF ingestion should produce:

- Intake batch report.
- Deterministic baseline report.
- ML shadow report.
- Deterministic-vs-ML disagreement report.
- OOD and abstention report.
- Human audit queue report.
- Promotion report.
- Drift report comparing new real PDFs to calibrated synthetic and real-anchor profiles.

## Minimal First Implementation

The first implementation should be deliberately small:

1. Register a batch of real PDFs with provenance and hashes.
2. Run profile detection and deterministic pipeline.
3. Run calibrated ML in shadow mode only.
4. Generate a disagreement and abstention report.
5. Select audit packets.
6. Promote only reviewed cases to real-anchor evaluation or training-candidate pools.
