# ML Enhanced vs Vanilla NoML Experiment

This experiment runs the same PDF set through OpenAutoTag twice:

1. `ML-enhanced`: classifier enabled in shadow mode with the current default role model.
2. `vanilla-noML`: classifier disabled, using the deterministic baseline.

The default experiment is intentionally small so it is easy to run during development:

```powershell
npm run ml:experiment
```

The default preset is `matrix-smoke`. It uses:

- Input PDFs: `output\ml-fine-tuned-corpus\v2\pdfs`
- Model: `output\ml-pilot\role-baseline-large-v4-matrix.json`
- Output: `output\ml-experiments\ml-vs-vanilla-matrix-smoke`
- Limit: `6` PDFs

To increase the matrix sample size:

```powershell
npm run ml:experiment -- --limit 25
```

To run a real PDF directory through both arms:

```powershell
npm run ml:compare -- --input-dir "C:\PDFs\real-docs" --output-dir output\ml-experiments\real-docs --limit 25
```

Each run writes:

- `ml-toggle-comparison-summary.json`: machine-readable comparison summary.
- `ml-toggle-comparison-report.html`: human-readable A/B report.
- Per-PDF case directories with separate `with-ml` and `without-ml` artifacts.

The ML arm remains shadow-mode evidence. The deterministic engine output remains the final production behavior until the release gates say otherwise.
