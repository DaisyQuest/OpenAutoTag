# Dataset Datasheet Template

Use this template for every frozen corpus version before it is used for training or release evaluation.

## Dataset Identity

- Dataset name:
- Dataset version:
- Release date:
- Owner:
- Contact:
- Related schemas:
- Corpus waves included:
- Hash manifest path:

## Motivation

- Why was this dataset created?
- Which engine risks does it target?
- Which model tasks is it intended to support?
- Which tasks is it explicitly not intended to support?

## Composition

- Total PDFs:
- Total pages:
- Total labels:
- Synthetic PDFs:
- Wave 2 derivative PDFs:
- Real-anchor PDFs:
- Train PDFs:
- Validation PDFs:
- Test PDFs:
- Locked audit PDFs:
- Role distribution:
- Document-family distribution:
- Language/script distribution:
- Producer-profile distribution:
- Scan/OCR distribution:

## Label Quality

- Label confidence tier counts:
- Human-verified label count:
- Ambiguous label count:
- Contract-gap label count:
- Label audit method:
- Inter-reviewer agreement:
- Known label limitations:

## Generation And Collection

- Synthetic generator version:
- Wave 2 transform versions:
- Real-anchor collection sources:
- Date range collected:
- Sampling strategy:
- Exclusion rules:
- Redaction or privacy treatment:

## Leakage Controls

- Split assignment method:
- Selection unit definition:
- Holdout types:
- Leakage scanner version:
- Fingerprint collision summary:
- Known waivers:

## Verification

- Structural verification status:
- Render verification status:
- Extraction verification status:
- Engine verification status:
- Human audit status:
- VIVID evidence report paths:

## Recommended Uses

- Approved training uses:
- Approved validation uses:
- Approved release-gating uses:
- Approved regression uses:

## Non-Recommended Uses

- Known unsafe uses:
- Unsupported document families:
- Unsupported languages/scripts:
- Unsupported PDF producer profiles:
- Unsupported downstream contracts:

## Maintenance

- Update schedule:
- Deprecation policy:
- Known drift risks:
- How to add new cases:
- How to quarantine cases:
- How to report label bugs:
