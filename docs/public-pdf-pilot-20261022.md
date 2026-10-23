# Official-source PDF pilot — 2026-10-22

Historical baseline. The subsequent [verified engine fixes and frozen replay](public-pdf-pilot-fixes-20261022.md) correct several problems below and record the remaining blockers.

Seven of eight inputs produced candidate PDFs. All 86 candidate pages were pixel-identical to their sources in the tested Poppler renders, and the two IRS forms retained 222 terminal fields/widgets and passed bounded fill/save/reopen probes. Semantic inspection nevertheless found substantial problems. Neither a visually unchanged PDF nor a zero-failure veraPDF result establishes usable tagging.

No engine implementation changed during this pilot. The baseline is `b52856c71082a93ea868dfd23f17ee558b8eee2c`; existing unrelated Studio/UI changes were excluded. The [machine-readable evidence](evidence/public-pdf-pilot-20261022.json) records source and output hashes, selection, results, diagnostics, and artifact hashes. Local PDFs and detailed artifacts are under `output/public-pdf-pilot-20261022/` and are not distributed in Git.

## Selection and method

We assembled 17 candidates from official US government sites. Ten met the download, encryption, size and page-count limits; seven returned HTTP 403 and were recorded as sourcing exclusions, not engine failures. We selected eight using the frozen seed `OpenAutoTag-public-pdf-pilot-2026-10-22-v1`: sort by SHA-256 of `seed|url`, take one per available publisher, then fill remaining slots in hash order. The draw preceded pipeline results. This is a reproducible exploratory sample from a curated pool, not a statistical sample of the internet.

The sample contains 147 pages, two fillable tax forms, two untagged NASA publications, reports with dense tables and columns, and six inputs with existing structure trees. Five candidates used passthrough with bounded repairs; those outcomes do not measure reconstruction accuracy. The tagged NASA booklet attempted a native rewrite and failed.

Runs used the default profile with production checks enabled, PDFBox 3.0.8, veraPDF 1.30.3 Greenfield (`ua1`), Node 22.20.0, and two concurrent documents. The effective OCR setting was **auto**: the profile overrode the launcher's `PARSER_OCR_MODE=off`. Java used `-XX:TieredStopAtLevel=1` for this environment. Pipeline times below are wall times under this concurrency, not throughput benchmarks.

Originals were validated separately using an empty sidecar manifest. Only their `rawSummary`/`rawFindings` and independent font audit are relevant; their missing-sidecar/overall validation status is excluded. All input hashes remained unchanged.

## Results

| Official source | Pages | Path / time | Raw veraPDF failed checks, source → candidate | Production outcome |
| --- | ---: | --- | ---: | --- |
| [NASA STEREO lithograph](https://stereo-ssc.nascom.nasa.gov/img/litho.pdf) | 2 | Native / 135.27 s | 7 → 0 | Rejected: OCR content unattached; checker Unicode errors also present |
| [IRS Form W-9](https://www.irs.gov/pub/irs-pdf/fw9.pdf) | 6 | Passthrough / 13.45 s | 26 → 26 | Review required; inherited validation/structure findings |
| [Census: Income in the United States, 2024](https://www2.census.gov/library/publications/2025/demo/p60-286.pdf) | 58 | Passthrough / 264.77 s | 16,241 → 16,148 | Rejected: resource-hash changes on 53 pages; separate saved comparison exceeded its buffer |
| [NIST SP 1300](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1300.pdf) | 9 | Passthrough / 11.77 s | 99 → 7 | Review required; residual validation/font findings |
| [IRS Form 1040](https://www.irs.gov/pub/irs-pdf/f1040.pdf) | 2 | Passthrough / 12.58 s | 446 → 446 | Review required; inherited validation/structure findings |
| [NIST SP 1299](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1299.pdf) | 8 | Passthrough / 16.98 s | 73 → 25 | Review required; residual findings and heading-reference review |
| [NASA Hinode fact sheet](https://science.nasa.gov/wp-content/uploads/2023/09/hinode-one-pager.pdf) | 1 | Native / 9.52 s | 209 → 0 | Rejected by the default checker; independent review also finds incorrect column order |
| [NASA STEREO booklet](https://stereo-ssc.nascom.nasa.gov/img/STEREObooklet.pdf) | 61 | Writer failed / 67.95 s | 5,703 → no candidate | Duplicate emitted table structure ID |

These are failed **checks**, including repeated instances, not accuracy percentages. Both native candidates had zero font-audit errors as well as zero raw veraPDF failures. The five passthrough candidates retained 13, 16, 5, 5 and 12 font-audit errors for W-9, 1040, NIST 1300, NIST 1299 and Census respectively. All eight CLI processes exited zero; the result JSON correctly reports four completed and four failed pipelines. A batch caller must inspect JSON status rather than equating exit zero with success.

There were four `review_required` candidates, three rejected candidates and one writer failure. None cleared every production check. Human review is an expected part of the workflow; this count is not a measurement of how many PDFs humans could successfully remediate.

## Preservation and interaction evidence

- **86/86 pages** matched pixel-for-pixel in Poppler: 150 DPI for the two IRS forms and two small NASA documents, 96 DPI for Census and NIST. All pages of every produced candidate were compared.
- **5/5 additional sampled pages** matched in PDF.js 4.10.38 at 150 DPI: both STEREO pages, Hinode, and page one of each IRS form. Source and candidate contact sheets were visually inspected.
- W-9 retained **23 terminal fields / 23 widgets**, and 1040 retained **199 / 199**. The preservation checks passed for fields and widgets. PDF-lib 1.17.1 filled one editable text field and checked one box in each original and candidate, saved copies, and reopened them with values and field counts intact. Both edited first-page pairs also rendered identically in PDF.js. This does not qualify all field actions, keyboard navigation or screen-reader announcements.
- All five passthrough outputs retained the source bytes as a prefix. Their inspector issue arrays were unchanged. The saved comparator reported 160 inherited integrity findings on W-9, 605 on 1040, 54 on NIST 1300 and 63 on NIST 1299. These are **not new regressions** and have not all been independently adjudicated as actual PDF defects.
- Census retained identical page-content hashes on all 58 pages, but resource hashes differed on 53. A focused independent comparison on page 7 found an added `/Type` key in `/Resources/XObject/Fm0`, with no decoded-stream difference in that resource comparison. All 58 pages rendered identically. This narrows the investigation; it does not justify bypassing the resource-preservation gate.

## Confirmed defects and diagnostic limits

### 1. Hinode interleaves two text columns

The saved structure follows left line, right line, next left line, next right line. Nodes `n-1-4`, `n-1-5`, `n-1-6` begin this sequence; the left-column sentence continues at `n-1-6`, not at the intervening right-column node. The source rendering shows two separate prose columns. The intent and saved tree agree, so this is a semantic ordering error upstream of serialization. Most body lines also remain separate P elements, interrupting paragraph continuity. The resources panel label remains P rather than a navigable heading.

**Acceptance target:** a reviewed Hinode reference must place each column's prose in continuous reading order and preserve paragraph/source ownership. Include a spanning-title fixture and a real table fixture so a column repair does not turn legitimate row-wise table order into column-wise order.

### 2. STEREO OCR has no attached text content

The writer reports native mode with **zero text operators**. After removing the checker encoding problem described below, **23 `CONTENT_ATTACHED` failures remain**. The candidate has no extractable page text in pypdf. Its generated OCR structure exists, but text-bearing tags have no content references. OCR also introduces noise, misses the large visual title, and promotes a URL-like OCR fragment to H1.

**Acceptance target:** image-only pages require a correctly positioned, searchable and tagged OCR text layer or an explicit unsupported/review outcome. Native mode must not be treated as successful text attachment when there are no text operators. Preserve original image pixels and test actual saved text/MCID ownership; zero raw veraPDF failures is insufficient.

### 3. Duplicate table identifiers stop the booklet writer

The writer fails with `Duplicate emitted structure ID: oat:tag:table:table:15:2`. The tagging plan already contains duplicate IDs for that table, another page-15 borderless table, and their row identifiers. No final candidate exists. The downstream uniqueness guard worked; the upstream tag plan needs correction.

**Acceptance target:** unique, deterministic IDs across repeated/split table fragments before writer invocation; a 61-page regression must complete, with no dropped rows or duplicate content ownership. Do not solve this by removing the writer's uniqueness check.

### 4. Windows checker output corrupts punctuation in transit

Default saved comparisons reported six ActualText mismatches for Hinode and seven for STEREO. An independent pypdf traversal found **all 13 saved PDF values exactly matched tagging intent**. Rerunning only the checker with `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8` removed all 13 mismatches. Hinode then passed **531/531** intent checks; STEREO passed 288 with the 23 attachment failures remaining. This is checker transport evidence, not a PDF text-corruption finding. The diagnostic did not replace the recorded default production outcomes.

**Acceptance target:** explicitly UTF-8 Java/Node I/O, exercised through real subprocesses on Windows with curly punctuation and non-ASCII text. Retain negative tests for genuine saved-text corruption. Hinode's reading-order error must still be caught by a semantic reference even when serialization checks pass.

### 5. Large saved comparisons exceed the output buffer

The Census default saved comparator failed with `stdout maxBuffer length exceeded`. The same comparison using previously saved inventories and file-backed stdout produced **39,930,153 bytes**, exceeding the wrapper's 32 MiB cap. It recorded **397,058 passed / 74 failed** checks; all 74 were integrity findings already present in the source inventory. The inventories each contain 36,096 structure entries.

**Acceptance target:** bounded summaries plus file-backed details or streaming, with identical comparison semantics and visible truncation/error handling. Test a large structure tree without making the runtime's memory limit proportional to duplicated textual check output.

### 6. Preservation needs a qualified path for resource normalization and native rebuilding

Census shows how resource mutations can trigger rejection despite identical content streams and pixels. The two native candidates separately receive `IDENTITY_MAPPING_REQUIRED` because the existing object-preservation gate requires a retained source-byte prefix. Pixel tests added here are useful evidence but do not replace a complete content identity mapping.

**Acceptance target:** identify the Census `/Type` mutation and either avoid it or explicitly prove and narrowly authorize it. Add saved content ownership/mapping evidence for native rebuilds. Retain rejection for altered field values, appearances, fonts, page geometry, links and omitted content.

### 7. Meaningful figures and incomplete existing tags remain review work

Both native candidates have meaningful solar imagery but **no saved Figure elements**. Figure-description review tasks are present. Existing-tag preservation also leaves substantial source problems unresolved, including font/Unicode issues, ambiguous form labels, annotation relationships and sparse heading structures. These findings support preserving review tasks and improving coverage; they do not justify invented descriptions, destructive font substitution or blanket tag reconstruction.

**Acceptance target:** independently reviewed figure/caption associations and supplied descriptions, plus narrowly scoped repairs to existing tags with no new conformance or preservation failures. Keep reader testing separate.

## Next engineering order

1. Repair checker UTF-8 transport and large-result handling; add failure-aware batch status handling. These make subsequent measurements trustworthy.
2. Fix duplicate table IDs and exercise the entire booklet pipeline.
3. Fix Hinode column/paragraph order against a small reviewed reference.
4. Correct the OCR content-attachment path and reject empty native text tagging.
5. Qualify resource normalization and native content mappings without weakening preservation.
6. Extend figure/heading and existing-tag remediation, then repeat this frozen corpus and add independently reviewed screen-reader observations.

The sample is now a development/regression set. Future accuracy claims need a separate held-out set to avoid measuring only documents used to tune the engine. The current evidence supports controlled pilot use with review, not a general "fully accessible PDF" claim.

## Reproduction and local evidence

The committed evidence includes all 17 source candidates, the eight selected IDs, URLs and SHA-256 hashes. Download selected files to a new output directory, verify hashes before processing, and stop if an official URL now serves different bytes. Do not replace the frozen source hash silently. Local `source-pdfs.py` records acquisition; `run-pilot.py` runs the pipeline, source validation and saved checks; `compare-renders.py`, `check-forms-and-pdfjs.mjs` and `collect-evidence.py` record the additional probes. These investigation helpers and downloaded assets remain under the ignored output directory; they are not packaged product tooling.

Core commands from the repository root, with each placeholder replaced by a selected source and a fresh output directory:

```powershell
$env:JAVA_TOOL_OPTIONS = '-XX:TieredStopAtLevel=1'
node orchestrator/pipeline-runner.js --pdf <source.pdf> --output-dir <run-directory> --production-checks true
# Read status and quality disposition in the JSON result, even when exit code is zero.

# Write {} to a separate empty-baseline.json first. Use rawSummary/rawFindings only.
node modules/validator/index.js --pdf <source.pdf> --manifest <empty-baseline.json>

# Existing-tag passthrough candidate:
node scripts/check-saved-semantics.js --pdf <candidate.pdf> --reference <source.pdf> --report-only true --output <comparison.json>
# Newly generated structure:
node scripts/check-saved-semantics.js --pdf <candidate.pdf> --tags <05-tagging.json> --report-only true --output <comparison.json>
```

Retain the default result, then separately reproduce the encoding diagnosis by setting `JAVA_TOOL_OPTIONS` to `-XX:TieredStopAtLevel=1 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8` for a new saved-comparison output. For the Census diagnostic, feed `{ "inspection": <candidate inventory>, "reference": <source inventory> }` as a JSON file to `node modules/validator/saved-semantics-cli.js <input.json>` and redirect stdout to a file. Do not count either diagnostic as a new successful production pipeline.

Evidence artifacts include each document's `pipeline-result.json`, `run-status.json`, `00-source-validation.json`, writer/validation/quality reports, default `09-saved-semantics.json` when produced, diagnostic `10-*` files, `visual-comparison.json`, and `interaction-and-pdfjs.json`. JSON evidence, source selection, counts, source prefixes, documentation links and evidence hashes were checked before recording this report. Engine regression suites were not rerun because this task changed documentation/evidence only.
