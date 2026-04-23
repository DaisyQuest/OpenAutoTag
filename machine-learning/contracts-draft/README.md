# Draft ML Contracts

These schemas are proposals for the machine-learning planning track. They are not active engine contracts and should not be consumed by production modules until the shared contract owner promotes reviewed versions into `contracts/`.

The goal is to make the critique actionable without inventing private formats later:

- `ml-ground-truth.schema.json`: truth-bearing corpus manifest with label confidence, lineage, leakage fingerprints, and human audit status.
- `ml-predictions.schema.json`: classifier evidence output with task heads, calibration, abstention, OOD scoring, and shadow-mode diagnostics.
- `real-pdf-intake.schema.json`: real-PDF batch intake manifest for provenance, privacy, profiling, routing, shadow inference, audit, and promotion state.

Promotion rules:

1. Draft schemas may evolve quickly inside `machine-learning/contracts-draft/`.
2. Engine modules must not depend on these paths.
3. Any live adoption requires an additive contract change under `contracts/`.
4. Any role that cannot project into the current engine contracts must be marked with a contract-gap status.
