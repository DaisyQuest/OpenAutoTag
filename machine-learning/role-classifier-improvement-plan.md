# Role Classifier 10-Point Improvement Plan

## Review Summary

The first baseline proved that a deterministic, auditable classifier can run inside the OpenAutoTag pipeline, but the pilot metrics were too easy to overread. The classifier was trained from engine-projected semantic roles, the evaluation split had weak rare-role coverage, and the model had limited evidence for table headers, artifacts, and neighboring layout context.

## Plan

1. Preserve document-level split boundaries so near-duplicate nodes from one PDF never cross train/evaluation.
2. Make the split role-aware so rare labels such as `TH`, `H2`, and `Artifact` are represented whenever the corpus contains them.
3. Add explicit table features from enriched layout metadata: table section, row/column indexes, table role, synthetic header status, and table confidence.
4. Add artifact and stamp-like evidence: artifact type, top/bottom page bands, URL/header/footer cues, and small-font publication notice patterns.
5. Add neighboring-context features from reading order without using neighbor labels.
6. Add safer text-shape features: URL, all-caps, ending punctuation, first/last token class, short note-marker pattern, currency, percent, and table keywords.
7. Reduce majority-role bias through a tunable class-prior exponent instead of purely empirical priors.
8. Support deterministic feature pruning through a minimum feature count, with the chosen value recorded in the model.
9. Run a deterministic hyperparameter sweep over smoothing, class-prior exponent, and feature-pruning values, scored by supported macro F1, accuracy, and calibration.
10. Emit training gates and diagnostics: split role counts, zero-support eval roles, per-role metrics, model hash, selected hyperparameters, and release status.

## Execution Policy

This remains a research-only and shadow-mode classifier. Deterministic engine output remains final until release gates prove non-regression on synthetic, wave 2, real-anchor, and locked audit corpora.
