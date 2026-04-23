# Real-Anchor Corpus Plan

## Purpose

Synthetic data provides scale and ground truth, but the ML plan must be anchored against real PDFs before training claims matter. This corpus is the guardrail against generator bias and shortcut learning.

This plan is complemented by [real-pdf-ingestion-mechanism.md](real-pdf-ingestion-mechanism.md), which defines how real PDFs move from intake to profiling, deterministic baseline, ML shadow inference, audit, and promotion.

The project already has a strong deterministic baseline and useful calibration surfaces: goldmasters, hellish stress fixtures, academic stress fixtures, external PDF fixtures, validator reports, writer reports, tag-delta reports, native verification, and corpus scoring. The real-anchor corpus should use those surfaces as the first measurement layer before any ML-assisted behavior is trusted.

## Target Size

Build a real-anchor corpus in three stages:

| Stage | PDFs | Purpose |
| --- | ---: | --- |
| Smoke anchor | 250 | Quick pipeline and reporting check |
| Training-readiness anchor | 1,000 | Baseline deterministic metrics before model training |
| Release anchor | 5,000 to 10,000 | Release gate and distribution-shift measurement |

The release anchor should include both born-digital and scanned PDFs.

## Source Families

Target public, redistributable documents where possible:

- Government notices and regulatory PDFs.
- Court opinions and legal briefs.
- Tax forms and schedules.
- Scientific articles and technical reports.
- Standards-like manuals and specifications.
- Financial reports and tables.
- Multilingual UN-style documents.
- Public health and safety documents.
- Old scans and OCR-heavy documents.
- Accessibility-tool-generated PDFs.

Private or sensitive PDFs should only enter after redaction and provenance review.

## Labeling Strategy

Not every real PDF needs full manual labels. Use tiers:

- Corpus-level profile labels for all documents.
- Page-level structure labels for a stratified sample.
- Region-level labels for difficult slices.
- Full truth labels for a smaller release-critical subset.
- Human audit labels for every real-anchor release blocker.

Minimum manual audit targets:

- 100 percent of release-anchor failures sampled for release decisions.
- At least 10 percent of PDFs in the 1,000-PDF training-readiness anchor.
- At least 2 percent of PDFs in the 5,000 to 10,000 release anchor.
- Oversampling for rare roles: footnotes, endnotes, captions, figures, forms, stamps, sparse tables, and multilingual text.

## Synthetic-To-Real Divergence

Measure divergence between synthetic and real-anchor corpora:

- Page size distribution.
- Text density distribution.
- Font size and font count distribution.
- Producer profile distribution.
- Vector line counts.
- Image occupancy.
- OCR/text-layer coverage.
- Role distribution.
- Table shape distribution.
- Artifact frequency.
- Parser warning frequency.

The corpus atlas should highlight any synthetic slice that lacks a real counterpart and any real slice that lacks synthetic coverage.

## Release Gate

ML-assisted output cannot be enabled unless:

- Real-anchor deterministic baseline is recorded.
- Real-anchor ML shadow report is recorded.
- Real-PDF intake manifests exist for every release-anchor batch.
- Every release-anchor PDF has provenance, privacy status, profile state, OOD decision, and routing state.
- Weak deterministic slices improve or stay neutral.
- Strong deterministic slices do not regress.
- Validator impact is non-negative.
- OOD behavior is conservative on unknown real profiles.
- Human-audited release subset passes agreed thresholds.

## Provenance

Every real PDF must record:

- Source URL or internal provenance.
- Acquisition date.
- License or redistribution status.
- Hash.
- Page count.
- Producer metadata.
- Language/script profile.
- Whether it is born-digital, scanned, or hybrid.
- Whether manual labels are available.
