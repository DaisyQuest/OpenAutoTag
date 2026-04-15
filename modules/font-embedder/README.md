# font-embedder

Per-document font inventory and PDF/UA remediation planner.

The font-embedder runs after `tag-builder` and before `pdf-writer`. It reads
the source PDF and (optionally) the tagging artifact, walks every page with
`pdfjs-dist` to discover the fonts used, and emits a single JSON document
that satisfies `contracts/font-inventory.schema.json`. Downstream stages
consume this inventory:

- `pdf-writer` honors each `plan.action` to embed, re-encode, inject a
  ToUnicode CMap, or substitute a vendored fallback for every font.
- `validator` cross-checks the published `summary.blockers` against the
  realized PDF/UA output.

## Contract

This module satisfies `contracts/font-inventory.schema.json` (FontInventory).
Every output is validated against the schema before it is written to disk —
non-conformant runs fail with a non-zero exit code.

It optionally consumes `contracts/tagging.schema.json` (when the
`fontInventoryRef` field is wired up by the orchestrator) to surface tagging
context for diagnostics; tagging payloads are not required.

## CLI

```
node modules/font-embedder/index.js \
  --pdf <input.pdf> \
  --tags <tagging.json> \
  --output <fonts.json>
```

- `--pdf` (required): path to the source PDF.
- `--tags` (optional): path to a `tagging.schema.json` document.
- `--output` (required): path where the inventory JSON will be written.

A short, human-readable summary is also written to stdout. Errors go to
stderr with a non-zero exit code.

## What gets analyzed

For every font that appears on a page or in an AcroForm `/DA` string the
embedder records:

- `baseFont`, `subsetPrefix`, `subtype`
- whether the font has an embedded `FontFile` / `FontFile2` / `FontFile3`
- whether the source name is one of the Standard 14 PDF fonts
- ToUnicode coverage with the per-glyph mapping repair strategy
- encoding name, `Differences` presence, symbolic flag
- CID `Registry`/`Ordering`/`Supplement` for Type0 fonts
- per-page usage, glyph count, sample text (≤120 chars), and form-DA flag
- OS/2 `fsType` license hints (warning-only — never blocks embedding)

## ToUnicode reconstruction

When the source `ToUnicode` CMap is missing or incomplete, the embedder
attempts the following strategies in order and stops at the first hit:

1. `from-cmap-table` — TrueType cmap glyph id → Unicode
2. `from-differences` — Type1 `Differences` array + Adobe Glyph List
3. `from-agl` — Adobe Glyph List from `glyphNames`
4. `from-cid-ros` — CID Registry/Ordering/Supplement → Unicode
5. `synthesized` — best-effort identity for ASCII codes
6. `impossible` — flagged for the writer to substitute a fallback

## Plan actions

`plan.action` instructs `pdf-writer` how to materialize each font:

| action                    | when                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `embed-as-is`             | font is embedded with valid ToUnicode                             |
| `inject-to-unicode`       | embedded but ToUnicode missing/broken (reconstructed)             |
| `re-embed-from-cache`     | needs embedding; source font is identifiable in a cache           |
| `subset-and-embed`        | needs embedding; the on-page glyph set is known                   |
| `rewrite-encoding`        | symbolic font with unusable `Differences`                         |
| `synthesize-type0-wrapper`| Type1 needs Type0 wrapping for ToUnicode                          |
| `substitute-fallback`     | source unrecoverable (incl. Standard 14 → Noto fallback)          |

## Tests

```
node --test modules/font-embedder/test/
```

Tests cover:
- Standard 14 unembedded → `substitute-fallback`
- Embedded TTF with valid ToUnicode → `embed-as-is`
- Embedded TTF without ToUnicode → `inject-to-unicode` via
  `from-cmap-table`
- CID Identity-H Type0 → valid `cidSystemInfo`
- Deterministic sorting of fonts and glyph arrays
- CLI-shape end-to-end inventory write and re-validation

## Dependencies

Uses repo-root npm dependencies only: `pdfjs-dist`, `ajv`, and `pdf-lib` for
fixture generation. No imports from sibling modules.
