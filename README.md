# PDF Accessibility Engine

This repository is a contract-first scaffold for a horizontally scalable PDF accessibility tagging pipeline. It is designed so Codex agents can implement modules in parallel without touching shared runtime code.

## Current state

- Shared contracts are frozen in [`contracts/`](C:/Users/tabur/Videos/BuildEverything/contracts).
- Every module has an isolated CLI boundary under [`modules/`](C:/Users/tabur/Videos/BuildEverything/modules).
- The orchestrator runs modules as separate processes, so modules do not import each other.
- The orchestrator now routes jobs through a workload registry, so new workloads can reuse the same queue, server, batch UI, and retry model without cloning the orchestration layer.
- Parser, layout analysis, semantic mapping, reading order, and tag tree construction are implemented as a working baseline.
- The PDF writer and validator expose stable CLIs and produce deterministic artifacts for integration, but native PDF/UA structure injection remains a later swap-in implementation.
- The pipeline now records stage timelines, retries retryable failures, preserves partial artifacts on failure, and returns structured stage diagnostics in each job snapshot.
- Layout and semantic detection now go beyond simple heading detection with stronger column inference, ordered-list metadata, table-cell detection, grouped lists, and richer reading-order handling.
- The pipeline now also emits a read-only `sourceTextMap` diagnostic that aligns parser blocks with text runs extracted directly from the original PDF content streams.
- The pipeline now also emits a read-only `tableStructureMap` diagnostic that extracts ruled-table geometry and merged-cell signals from low-level page drawing operations.
- Ruled-table evidence now feeds back into `layout-analyzer`, so vector-grid tables and merged header spans affect the actual semantic and tag output instead of living only as diagnostics.
- The tag tree now preserves explicit table sections (`THead` / `TBody` / `TFoot`), and the PDF writer preserves native table attributes for tagged `TH` / `TD` cells, including merged-cell spans and header scope when that structure is available upstream.
- The parser now includes a selective OCR fallback for scanned or sparse-text pages using PDFBox page rendering plus multi-pass `tesseract.js` recognition and candidate scoring.
- OCR reliability now includes per-profile retries, local worker cache reuse, consensus-based candidate ranking across render variants, duplicate-line suppression, and partial-failure handling when one OCR path breaks but others succeed.
- The parser, semantic engine, and writer now detect Spanish text, prefer bilingual OCR (`spa+eng`) when Spanish is likely, and preserve the detected document language into tagged PDF metadata.
- The test suite now includes a PDFBox-generated multi-page hell document with mathematically placed columns, ruled tables, broken borders, aligned prose traps, and exact goldmaster expectations.
- The stress corpus now also includes an academic hell document with theorem-style columns, two independent borderless tables on one page, and notation rows that look tabular but must remain prose.
- A second production workload now performs SSN redaction by detecting likely social security numbers, raster-redacting them out of the output PDF, and emitting a masked redaction report for browser review.
- A third composed workload now performs accessibility tagging plus SSN redaction in one job, masking SSNs from both the visible page content and the accessibility tree before validation.

## Quick start

```bash
npm install
npm run install:verapdf
npm run test:ci
npm test
npm run test:goldmaster
npm run goldmaster:update
npm run testing-matrix:update
npm start
npm run serve
npm run map:source-text -- --pdf tmp/sample.pdf --layout tmp/run/01-layout.json --output tmp/run/01b-source-text-map.json
npm run map:table-structure -- --pdf tmp/sample.pdf --layout tmp/run/01-layout.json --output tmp/run/01c-table-structure-map.json
npm run inspect:pdf -- --pdf tmp/run/06-tagged.pdf
```

Java 21 is required for the native PDFBox-backed writer and validator modules.
The validator uses veraPDF for PDF/UA validation. `npm run install:verapdf` now installs it cross-platform, and the validator also accepts `VERAPDF_PATH`, `VALIDATOR_JAVA_HOME`, `VALIDATOR_JAVA_PATH`, `VALIDATOR_JAVAC_PATH`, and `VERAPDF_FLAVOUR` overrides when needed.
On Azure App Service Linux, runtime uploads, job artifacts, OCR cache, and Java helper build outputs should live under a writable runtime root. Set `PIPELINE_DATA_ROOT` if you need to override the default. `GET /health` now reports the active runtime paths.
The OCR fallback uses `tesseract.js`, which downloads language data on first use and caches it locally.

Open the local UI:

```text
http://localhost:3000
```

Coverage matrix:

```text
http://localhost:3000/testing-matrix.html
```

The browser UI supports:

- workload selection from a registry-backed catalog
- drag and drop for individual PDFs
- drag and drop for directories that contain PDFs
- folder selection with `webkitdirectory`
- automatic batch upload, workload execution, polling, and artifact download
- inline browser-native previews of validation, writer, tag-tree, and redaction reports directly inside the dashboard inspector
- on-demand browser reports for validation output, writer metrics, logical tag trees, and redaction reports
- a browser-rendered testing matrix that maps unit, integration, goldmaster, runtime, and browser-facing coverage

You can still submit a single path-based job through the JSON API:

```bash
curl -X POST http://localhost:3000/process-pdf ^
  -H "Content-Type: application/json" ^
  -d "{\"filePath\":\"C:/path/to/input.pdf\",\"outputDir\":\"C:/path/to/output\",\"workloadId\":\"accessibility-tagging\"}"
```

Batch uploads use multipart form data:

```text
GET /workloads
POST /process-pdf-upload
GET /batches/:batchId
GET /jobs/:jobId/artifacts/taggedPdf
GET /jobs/:jobId/artifacts/redactedPdf
GET /jobs/:jobId/artifacts/validationReport
GET /jobs/:jobId/artifacts/redactionReport
GET /report.html?jobId=<jobId>&artifact=validationReport
GET /report.html?jobId=<jobId>&artifact=redactionReport
```

Every job snapshot now includes:

- `stages`: per-stage status, attempts, durations, and produced artifacts
- `stageSummary`: counts for completed, failed, skipped, and retried stages
- `failureStage`: the exact failed stage when a run aborts after partial progress
- `sourceTextMap`: a non-blocking diagnostic artifact that shows which parser blocks align to original source-stream text runs
- `tableStructureMap`: a non-blocking diagnostic artifact that surfaces ruled grids, inferred cells, and merge-span signals for border-drawn tables

## Workloads

The orchestrator now treats each product flow as a workload definition under [`orchestrator/workloads/`](C:/Users/tabur/Videos/BuildEverything/orchestrator/workloads). Each workload publishes:

- a stable workload id and label for the API and dashboard
- a processor function that reuses the shared queue, retry, and stage timeline model
- primary, previewable, and downloadable artifacts for the browser UI
- a summary mapper so mixed workloads still render coherently in the same results table

Current workloads:

- `accessibility-tagging`: the full tagging, writing, and PDF/UA validation pipeline
- `ssn-redaction`: a focused privacy workload that parses layout, detects likely SSNs, raster-redacts them from the output PDF, and emits a masked redaction report
- `tag-and-ssn-redact`: a composed workload that keeps the tagging pipeline, masks SSNs from semantic/tag content before writing, applies black-box redactions to the reconstructed page image, and then validates the final tagged output

## OCR fallback

The parser only invokes OCR when a page looks empty or suspiciously sparse. The current flow is:

- extract native text with `pdfjs-dist`
- gate OCR to pages with missing or sparse text coverage
- render those pages with PDFBox in multiple variants (`gray-300`, `binary-300`, `gray-450`)
- run `tesseract.js` in multiple segmentation modes and score the candidates
- retry failed OCR profiles before giving up on that path
- compare candidate text across variants and boost consensus-backed outputs
- replace native page text only when the OCR result is materially better

Useful overrides:

- `PARSER_OCR_MODE=off`: disable OCR entirely
- `PARSER_OCR_MODE=force`: run OCR on every page
- `PARSER_OCR_MODE=required`: fail parsing if OCR fails
- `PARSER_OCR_LANGS=eng+spa`: change OCR languages
- `PARSER_OCR_MAX_ATTEMPTS=3`: retry failed OCR profiles more aggressively
- `PARSER_OCR_TEMP_ROOT=C:/path/to/tmp`: control the OCR working directory root

When OCR languages are not forced explicitly, the parser now detects likely document language from extracted text and chooses OCR languages accordingly:

- confident English text defaults to `eng`
- detected Spanish defaults to `spa+eng`
- uncertain or sparse text falls back to `eng+spa`

Parser output now records OCR diagnostics under `source.ocr` and `pages[*].ocr`, including whether OCR was skipped, applied, retained as advisory only, or failed gracefully.

## Goldmasters

The repository now includes a goldmaster suite under [`test/goldmasters/`](C:/Users/tabur/Videos/BuildEverything/test/goldmasters) that locks:

- normalized end-to-end pipeline artifacts for the native sample document
- normalized live OCR parser output for a scanned rasterized sample document
- normalized end-to-end pipeline artifacts for a native Spanish sample that locks language detection, OCR language targeting, and tagged-PDF `/Lang`
- normalized end-to-end pipeline artifacts for a PDFBox-generated hell document that mixes column pressure, merged ruled tables, border gaps, and false-table alignment traps
- normalized end-to-end pipeline artifacts for a second PDFBox-generated academic hell document that stresses theorem layout, borderless table segmentation, and anti-false-positive notation rows

Use:

- `npm run test:goldmaster` to validate the current product against the checked-in goldmasters
- `npm run goldmaster:update` to intentionally regenerate them after approved behavioral changes

## Testing matrix

Coverage inventory is maintained in [`test/testing-matrix.definition.json`](C:/Users/tabur/Videos/BuildEverything/test/testing-matrix.definition.json) and rendered to [`orchestrator/public/testing-matrix.data.json`](C:/Users/tabur/Videos/BuildEverything/orchestrator/public/testing-matrix.data.json) with:

- `npm run testing-matrix:update`

The browser view at `http://localhost:3000/testing-matrix.html` highlights:

- coverage by layer across unit, integration, goldmaster, live-runtime, and browser-facing surfaces
- evidence files for each capability row
- explicit gap cards for scenarios that still need coverage

For careful low-level debugging, use:

```bash
npm run inspect:pdf -- --pdf C:/path/to/file.pdf
```

That inspector reports page resources, content-stream operator counts, struct-tree presence, marked-content operators, and text/image samples so you can compare an original PDF against a tagged output before changing the writer.

## Module contract

Each module:

- owns `modules/<module-name>/**`
- must not import another module
- may only depend on files in `contracts/` plus third-party packages
- must expose a CLI entrypoint

See [`SPEC.txt`](C:/Users/tabur/Videos/BuildEverything/SPEC.txt) and [`AGENTS.md`](C:/Users/tabur/Videos/BuildEverything/AGENTS.md) for the executable working agreement.
