# ML Release Gates

## Purpose

This file defines hard gates for moving from planning to training, from training to shadow mode, and from shadow mode to ML-assisted output.

## Gate A: Training Readiness

Bulk model training is blocked until:

- Task ontology is frozen for the first training wave.
- `ml-ground-truth.schema.json` draft covers all training labels.
- Label confidence tiers are present in every truth manifest.
- Contract-gap roles are excluded from production training targets unless explicitly scoped.
- Dataset datasheet is complete for the training corpus.
- Real-anchor smoke corpus exists and has deterministic baseline metrics.
- Leakage scanner passes with no unapproved hard failures.
- Human audit has sampled every generator family and wave 2 transform family.
- Ambiguity taxonomy is in use.

## Gate B: Model Evaluation Readiness

A trained model cannot be considered a release candidate until:

- Model card is complete.
- Calibration report is generated.
- OOD report is generated.
- Parent-clustered wave 2 metrics are generated.
- Real-anchor metrics are generated.
- Locked audit has not been used for threshold tuning.
- Runtime and memory reports are generated.

## Gate B1: Real-PDF Feed Readiness

Real PDFs may be fed to calibrated ML only when:

- The mathematical synthetic corpus calibration has passed its dataset datasheet and calibration gates.
- Wave 2 parent-clustered and worst-child reports exist.
- OOD and abstention thresholds are selected on validation data.
- Real-PDF batch manifests validate against the draft or promoted real-PDF intake contract.
- Every PDF has provenance, privacy status, fingerprints, profile routing, and deterministic baseline artifacts.
- ML mode is `shadow` or `research-only`; deterministic output remains final.
- Unknown, sensitive, ambiguous, or OOD PDFs are quarantined or routed to audit.

## Gate C: Shadow Mode

Shadow mode may run only when:

- Existing deterministic engine output remains the final output.
- ML predictions are emitted through the draft or promoted ML prediction contract.
- Every prediction includes calibrated confidence, abstention status, OOD status, and contract projection.
- Decision logs compare deterministic decision, ML decision, final decision, and fallback reason.
- No production tag-tree changes are made from ML evidence.

## Gate D: Assistive Mode

ML-assisted output may be enabled only when:

- Shadow-mode reports show improvement on target weak slices.
- Strong deterministic slices do not regress.
- Validator impact is non-negative on synthetic, wave 2, real-anchor, and locked audit suites.
- Calibration passes globally and on critical slices.
- OOD behavior is conservative.
- Abstention coverage is acceptable.
- Emergency disable flag is tested.
- Rollback procedure is tested.
- Model version is pinned.

## Gate E: Ongoing Release Health

After release:

- CI runs a small ML smoke subset.
- Nightly jobs run medium synthetic, wave 2, and real-anchor subsets.
- Weekly jobs run larger corpus slices.
- Drift reports compare new real PDFs to validated profiles.
- Human audit samples uncertain, novel, and high-impact cases.
- Any model retraining requires a new dataset datasheet and model card.
