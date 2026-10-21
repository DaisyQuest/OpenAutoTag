# Choosing a Profile for PDF Remediation

When you submit a PDF for accessibility tagging, the pipeline applies a **profile** that controls how the document is processed. Profiles tune OCR sensitivity, column detection, heading classification, font embedding, and validation — so different document types get the right treatment without manual configuration.

## Available Profiles

| Profile | Best For | Key Differences |
|---------|----------|-----------------|
| **Default** | General-purpose documents | Balanced thresholds, auto-OCR, standard column detection |
| **Legal** | Court filings, briefs, case law | Tighter column gaps for legal layouts, lower OCR threshold for scanned filings, stricter line grouping |
| **Scientific** | Academic papers, journal articles | Narrow column gutters for two-column journals, extended heading hierarchy (H1–H4) |
| **Scanned / Low-Quality** | Photocopies, faxes, degraded scans | Forces OCR on every page, 4 retries, adds 600-DPI render variant |
| **Forms** | PDFs with interactive form fields | Keeps text blocks separate, recognizes checkbox options and form sections, prioritizes AcroForm /DA validation |
| **CJK** | Chinese, Japanese, Korean documents | CJK OCR languages, Identity-H encoding, Noto Sans CJK fallback |

## How to Choose

```
Is your PDF a scanned image or low-quality photocopy?
  └─ Yes → Scanned / Low-Quality

Is it a court filing, legal brief, or case decision?
  └─ Yes → Legal

Is it a scientific paper or journal article with two columns?
  └─ Yes → Scientific

Does it contain interactive form fields (text boxes, checkboxes)?
  └─ Yes → Forms

Is the primary language Chinese, Japanese, or Korean?
  └─ Yes → CJK

None of the above?
  └─ Use Default
```

## Selecting a Profile

The Forms profile disables paragraph merging so separate field labels and
checkbox options are not combined. Other profiles retain paragraph merging
with guards for field relationships, checkbox boundaries, intervening semantic
elements, and widely separated labels.

In the default `auto` writer mode, an already tagged document with a structure
tree, `MarkInfo.Marked=true`, and sufficient marked-content coverage uses the
configured already-tagged policy before considering text matching. The default
`passthrough` policy preserves the authored structure, field placement, title,
and language while refreshing metadata incrementally. Confirmed wrapped heading
lines are consolidated into one heading using matching font, size, alignment,
tight spacing, and a linguistic continuation cue such as a trailing "in" or
"of". Existing MCIDs, IDs, styles, and field references are retained; the writer
reports the number of repairs as `headingContinuationsMerged`. Independent
headings, intervening body text, and different sections remain separate.
The semantic engine applies the same continuation rule before tag construction,
retaining the component block IDs in `sourceBlockIds`. Existing structure is
preserved even when a new heuristic tree achieves a high operator match score.
The writer report marks this with `sourceTaggingPreserved: true`. This does not
establish PDF/UA compliance; the validator still reports existing problems.

To deliberately replace existing tags, request `--writer-mode native` with the
pipeline CLI. `PASSTHROUGH_MINIMAL=0` retains the optional broader legacy
passthrough repair pass; the default preservation pass leaves source structure
and content intact apart from confirmed wrapped-heading repairs.

### Via the Dashboard

1. Open the pipeline dashboard at `http://localhost:3000`
2. In the upload area, use the **Profile** dropdown to select your profile
3. Optionally click **Advanced** to override specific settings
4. Upload your PDF(s) — the selected profile applies to all files in the batch

### Via the API

Include `profileId` in your submission request:

```bash
curl -X POST http://localhost:3000/process-pdf \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/path/to/input.pdf", "outputDir": "/path/to/output", "workloadId": "accessibility-tagging", "profileId": "legal"}'
```

For multipart uploads:

```bash
curl -X POST http://localhost:3000/process-pdf-upload \
  -F "file=@input.pdf" \
  -F "workloadId=accessibility-tagging" \
  -F "profileId=legal"
```

### With Overrides

You can override individual profile fields without creating a new profile:

```bash
curl -X POST http://localhost:3000/process-pdf \
  -H "Content-Type: application/json" \
  -d '{
    "filePath": "/path/to/input.pdf",
    "outputDir": "/path/to/output",
    "workloadId": "accessibility-tagging",
    "profileId": "legal",
    "profileOverrides": {
      "parser": { "ocrMode": "force" },
      "readingOrder": { "lineGroupEpsilon": 8 }
    }
  }'
```

Overrides are applied on top of the resolved profile chain. For example, if `legal` extends `default`, the resolution order is: `default` → `legal` → your overrides.

## What Each Profile Controls

### Parser (OCR)

| Setting | Default | Legal | Scanned |
|---------|---------|-------|---------|
| OCR mode | auto | auto | **force** |
| Max OCR retries | 2 | **3** | **4** |
| Min accepted OCR score | 0.4 | **0.35** | **0.25** |
| Sparse character threshold | 24 | **16** | **999** |

### Layout Analyzer

| Setting | Default | Legal | Scientific |
|---------|---------|-------|------------|
| Column gap threshold | 16% | **12%** | **10%** |
| Column gap min pixels | 48 | **36** | **32** |
| Heading score threshold | 1.55 | **1.45** | **1.4** |

### Reading Order

| Setting | Default | Legal |
|---------|---------|-------|
| Line group epsilon | 6pt | **4pt** |
| Column band threshold | 18% | **14%** |

### Validation

| Setting | Default | All |
|---------|---------|-----|
| veraPDF flavour | ua1 | ua1 |
| Skip font audit | false | false |

## Opt-in preservation checks and list-form repair

The accessibility pipeline accepts `--preservation-check true` (programmatic option
`options.preservationCheck: true`). It inspects the source and saved candidate,
then writes `08-quality-report.json` and two inspection sidecars. It compares page
geometry/content/resources, field properties and hierarchy, widget appearance and
ownership, and standard heading content references. Validation must have completed
with the mandatory font audit and a matching `pdfSha256`; older reports must be
regenerated. An inspection failure or missing/stale checker report is `error`, and
a proven preservation regression is `rejected`. Either fails the pipeline stage
without retry. A completed stage is still `review_required`; this bounded check
does not certify accessibility. Reports for full rewrites flag the unavailable
object-identity mapping instead of claiming the preservation checks passed.

`PASSTHROUGH_REPAIR_LIST_FORMS=1` enables the first list-container repair for
already-tagged PDFs. The default is disabled. It moves direct `Form` children of
an `LI` into its existing `LBody`, keeping form objects, widget references,
ParentTree/IDTree targets, and relative form/body-content order. The rule requires
one MCID-only body, at most one label, and uniquely owned widget-only form content
on the same page. Ambiguous bodies, shared objects, cross-page widgets, and other
child roles are left unchanged. `06-writer-report.json` and the tag manifest expose
`listFormContainersRepaired`. Repeat application is a no-op.

Example from the repository root in PowerShell:

```powershell
$env:PASSTHROUGH_REPAIR_LIST_FORMS = "1"
node orchestrator/pipeline-runner.js --pdf input.pdf --output-dir output/review --profile forms-heavy --preservation-check true
```

Use both switches together when qualifying a repair. The saved PDF remains a
candidate, including after a failed quality stage. `--production-checks true`
also stages an independent input copy, enables bounded list/link repairs and
candidate download gating, and requires the validator and preservation checks.
The server requires an explicit `candidate=1` request and matching inspected
PDF bytes for a passing review candidate. Atomic promotion to an accepted
artifact remains future work. The
quality stage is available in the accessibility pipeline; it is not enabled for
redaction, which intentionally changes content.

The portable regression suite is `npm run test:production-baseline`. Its required
suites are enumerated in `package.json` and `scripts/run-ci-tests.js`, independent
of optional external corpora. Fixtures are generated with existing dependencies.
The 2026-10-21 run passed 171 tests with no skips. `npm run benchmark:semantic`
adds 16 synthetic cases with 74 checks; independent expert reference review and
human reader testing remain pending. See [claims and evidence](tagging-quality-claims.md).

The installed validator is pinned to veraPDF 1.30.3 Greenfield; PDFBox helpers use
3.0.8. Raw failures are retained. Changing `VERAPDF_FLAVOUR` selects a validation
profile; it does not automatically convert the writer output to that PDF version
or establish PDF/UA-2 support.

## Creating a Custom Profile

If the presets don't match your documents, create a JSON file in `orchestrator/profiles/`:

```json
{
  "schemaVersion": "1.0.0",
  "profileId": "my-org-legal",
  "label": "My Organization Legal",
  "description": "Legal profile tuned for our specific court filing format.",
  "extends": "legal",
  "tags": ["legal", "custom"],
  "parser": {
    "ocrMode": "force",
    "ocrLanguages": "eng"
  },
  "readingOrder": {
    "lineGroupEpsilon": 3
  }
}
```

The profile inherits from `legal` (which itself inherits from `default`). Only specify the fields you want to change — everything else comes from the parent chain.

Restart the server after adding a new profile file. It will appear in the dashboard dropdown and the `GET /profiles` API.

## FAQ

**Q: What happens if I don't select a profile?**
A: The `default` profile is used automatically.

**Q: Can I change a profile mid-batch?**
A: No. Each batch uses one profile. Submit separate batches for different profiles.

**Q: Do profiles affect SSN redaction?**
A: Yes. The `redactor` section controls SSN pattern matching and redaction box padding. Most presets inherit the default redaction settings unchanged.

**Q: How do I know if my profile choice improved results?**
A: Check the validation report for each job. Compare veraPDF finding counts and font embedding coverage. The evaluation tools (`npm run eval:score`) can aggregate metrics across a corpus to measure profile effectiveness.
