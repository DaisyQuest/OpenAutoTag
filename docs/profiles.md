# Choosing a Profile for PDF Remediation

When you submit a PDF for accessibility tagging, the pipeline applies a **profile** that controls how the document is processed. Profiles tune OCR sensitivity, column detection, heading classification, font embedding, and validation — so different document types get the right treatment without manual configuration.

## Available Profiles

| Profile | Best For | Key Differences |
|---------|----------|-----------------|
| **Default** | General-purpose documents | Balanced thresholds, auto-OCR, standard column detection |
| **Legal** | Court filings, briefs, case law | Tighter column gaps for legal layouts, lower OCR threshold for scanned filings, stricter line grouping |
| **Scientific** | Academic papers, journal articles | Narrow column gutters for two-column journals, extended heading hierarchy (H1–H4) |
| **Scanned / Low-Quality** | Photocopies, faxes, degraded scans | Forces OCR on every page, 4 retries, adds 600-DPI render variant |
| **Forms** | PDFs with interactive form fields | Aggressive font substitution, prioritizes AcroForm /DA validation |
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
