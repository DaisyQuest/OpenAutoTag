# Profile Developer Guide

This guide covers adding new profiles, understanding the knob surface, and using the evaluation harness to validate profile changes.

## Architecture

```
contracts/profile.schema.json     ← frozen contract, every field documented
orchestrator/profiles/*.json      ← preset profiles (composable via "extends")
orchestrator/profile-registry.js  ← resolution engine: list, get, resolve, merge
orchestrator/profile-runtime.js   ← creates per-job context, injects env vars
```

A **profile** is a JSON document conforming to `contracts/profile.schema.json`. It bundles per-stage configuration into a named, versioned, inheritable unit. At job submission time, the orchestrator:

1. Resolves the profile chain (`extends` → parent → grandparent → ... → root)
2. Deep-merges the chain, last writer wins
3. Applies any runtime `profileOverrides` from the API caller
4. Freezes the result as an immutable context object
5. Passes the context to each pipeline stage

## Adding a New Profile

1. Create `orchestrator/profiles/<your-id>.json`:

```json
{
  "schemaVersion": "1.0.0",
  "profileId": "my-custom-profile",
  "label": "My Custom Profile",
  "description": "One paragraph explaining when to use this.",
  "extends": "default",
  "tags": ["custom", "your-domain"],
  "parser": { "ocrMode": "force" }
}
```

2. Validate against the schema:

```bash
node -e "
import Ajv from 'ajv/dist/2020.js';
import schema from './contracts/profile.schema.json' with {type:'json'};
import profile from './orchestrator/profiles/my-custom-profile.json' with {type:'json'};
const ajv = new Ajv.default();
const ok = ajv.compile(schema)(profile);
console.log(ok ? 'VALID' : ajv.errorsText());
"
```

3. Test resolution:

```bash
node -e "
import {resolveProfile} from './orchestrator/profile-registry.js';
const r = await resolveProfile('my-custom-profile');
console.log(JSON.stringify(r.parser, null, 2));
"
```

4. Restart the server — your profile appears in `GET /profiles` and the dashboard dropdown.

## The Knob Surface

Every tunable is documented in `contracts/profile.schema.json` with type, default, range, and effect. The major groups:

### Parser (OCR)
- `ocrMode`: auto/off/force/required
- `ocrLanguages`: Tesseract language codes
- `ocrMaxAttempts`: retry limit per profile
- `sparseTextBlockThreshold`, `sparseCharacterThreshold`, `sparseCoverageThreshold`: triggers for auto-OCR
- `minAcceptedOcrScore`, `minCharacterGain`, `characterGainMultiplier`: acceptance filters
- `renderVariants`: DPI/color-mode combos for page rendering
- `recognitionProfiles`: Tesseract page segmentation modes

### Layout Analyzer
- `columnGapThresholdPercent`, `columnGapMinPixels`: column detection sensitivity
- `headingScoreThreshold`, `headingBoldScoreThreshold`: heading classification
- `headingH1Threshold`, `headingH2Threshold`: heading level boundaries
- `rowTolerancePixels`, `tableRowMinItems`, `tableRowMinSpanPercent`, `tableRowMinGapPixels`: table detection

### Semantic Engine
- `confidenceDefaults`: per-role confidence scores
- `tableContinuationDistanceY/X`: grouping distance
- `listGapThreshold`: list continuation
- `languageHint`: BCP-47 tag

### Reading Order
- `lineGroupEpsilon`: vertical tolerance for same-line grouping (critical for dense text)
- `columnBandThresholdPercent`, `columnBandMinPixels`: column detection

### Tag Builder
- `headingLevelClampMin/Max`: heading normalization range

### Font Embedder / PDF Writer / Validator / Redactor / Orchestrator
See `contracts/profile.schema.json` for the full field list.

## Evaluation Scoring

Each profile includes an optional `evaluation` section:

```json
"evaluation": {
  "groundTruthRef": null,
  "scoringWeights": {
    "veraPdfFindings": 0.4,
    "fontEmbedCoverage": 0.2,
    "readingOrderInversions": 0.25,
    "ocrConfidence": 0.15
  },
  "acceptanceThresholds": {
    "veraPdfFindings": 0,
    "fontEmbedCoverage": 0.99
  }
}
```

### Metrics

| Metric | Source | Range | Ideal |
|--------|--------|-------|-------|
| veraPdfFindings | validation-report.json | 0–∞ | 0 |
| fontEmbedCoverage | writer-report.json fonts[] | 0–1 | 1.0 |
| readingOrderInversions | semantic-ordered.json | 0–∞ | 0 |
| ocrConfidence | layout.json pages[].ocr | 0–1 | 1.0 |

### Running Evaluation

```bash
# Score a single job
npm run eval:score -- <jobDir>

# Or use the MCP tool:
# score_job({ jobDir: "path/to/job" })
```

### Comparing Profiles

```bash
# Run two profiles against the same corpus
npm run eval:run -- --profile default --corpus /path/to/pdfs --output /tmp/run-default
npm run eval:run -- --profile legal  --corpus /path/to/pdfs --output /tmp/run-legal

# Diff the results
npm run eval:diff -- --a /tmp/run-default --b /tmp/run-legal
```

## Profile Inheritance

Profiles form a chain via `extends`. Resolution walks the chain bottom-up and merges top-down:

```
default.json (base)
  └─ legal.json (extends: "default")
       └─ my-org-legal.json (extends: "legal")
            └─ runtime overrides (from API call)
```

Fields at each level override the same field from the parent. Objects are deep-merged; arrays and scalars are replaced wholesale.

Circular inheritance (`a extends b extends a`) is detected and rejected at resolution time.

## Environment Variable Fallback

For backward compatibility, stages still check environment variables when a profile field is absent. The mapping is:

| Profile Field | Env Var |
|---------------|---------|
| parser.ocrMode | PARSER_OCR_MODE |
| parser.ocrLanguages | PARSER_OCR_LANGS |
| parser.ocrMaxAttempts | PARSER_OCR_MAX_ATTEMPTS |
| parser.ocrTempRoot | PARSER_OCR_TEMP_ROOT |
| validator.veraPdfFlavour | VERAPDF_FLAVOUR |

The profile system is the preferred configuration surface. Env vars are for deployment-level overrides that apply regardless of profile.
