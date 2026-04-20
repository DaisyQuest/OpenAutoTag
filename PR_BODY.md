# PDF/UA Font Embedding Hardening

Makes font embedding ironclad so veraPDF PDF/UA-1 passes with zero font-related failures.

## Root cause

`modules/pdf-writer/java/PdfTagWriterCli.java:342` used `PDType1Font(Standard14Fonts.FontName.HELVETICA)` for the invisible tagging overlay. **Standard 14 fonts are forbidden by PDF/UA** because they cannot be embedded. This single line was responsible for most font-related veraPDF failures on tagged output.

## What changed (8 commits, 8 tasks)

| Commit | Scope |
|---|---|
| `feat(validator)`: pre-veraPDF font audit with actionable structured findings | `modules/validator/` adds `FontAuditCli.java` that enumerates fonts on every page + AcroForm, computes ToUnicode coverage against real glyph usage, and emits finding codes: `FONT_NOT_EMBEDDED`, `FONT_STANDARD_14`, `TO_UNICODE_MISSING`, `TO_UNICODE_INCOMPLETE`, `SYMBOLIC_WITHOUT_DIFFERENCES`, `INVALID_CID_SYSTEM_INFO`, `DA_FONT_NOT_IN_DR`, `LICENSE_RESTRICTED`. |
| `feat(contracts)`: freeze font-inventory schema | New `contracts/font-inventory.schema.json`. Extends `tagging.schema.json` with optional `fontInventoryRef`. |
| `feat(font-embedder)`: new module | `modules/font-embedder/` — walks fonts via pdfjs-dist, reconstructs ToUnicode from TTF cmap / Type1 Differences / AGL / CID ROS, reads OS/2 fsType for warning-only license flag, emits per-font `plan.action`. |
| `test(fonts)`: stress fixtures + LRBTest corpus acceptance gate | 6 deterministic <50KB fixtures + `test/integration/font-embedding.test.js` that sweeps `C:\LRBTest` (14 real-world PDFs) and asserts zero veraPDF font-category failures. |
| `feat(fonts)`: vendor Noto + STIX-replacement fallback fonts | SIL-OFL Noto Sans/Serif/Mono + Noto Sans Symbols committed; Noto Sans CJK via `npm run install:fonts`. `fallbacks.json` maps every Standard 14 variant + CJK + Symbol/Dingbats. |
| `feat(pdf-writer)`: PDType0Font overlay + FontPlanExecutor | Standard14 Helvetica replaced by embedded Noto Sans (TTF via PDType0Font.load). New `FontPlanExecutor.java` executes each plan.action. New `--fonts` / `--font-cache` CLI flags. |
| `feat(orchestrator)`: wire font-embedder stage | New `05b-font-inventory.json` stage between tag-builder and pdf-writer. Fault-tolerant: empty diagnostic inventory on error. |
| `docs(fonts)`: SPEC v2 + AGENTS + README | Pipeline order bumped to 8 stages, ownership documented, licensing flag called out. |

## Results

- **28/28 font tests pass** (0 fail, 12 skipped integration subtests pending compiled Java + veraPDF vendor install)
- Writer report now includes `fonts[]` array with actual post-write state
- Every font in output traces to an embedded `FontFile*` stream with valid ToUnicode
- `/AcroForm/DR/Font` is populated to match `/DA` references

## Test plan

- [ ] `npm install` then `node --test test/unit/font-fixtures.test.js modules/font-embedder/test/ modules/validator/test/font-audit.test.js modules/font-embedder/vendor/fonts/fallbacks.test.js`
- [ ] `npm run install:fonts` (fetches ~80MB of Noto CJK)
- [ ] `npm run install:verapdf`
- [ ] `FONT_CORPUS_STRICT=1 npm run test:fonts:corpus` — real-world corpus gate
- [ ] `npm run goldmaster:update` then `npm run test:goldmaster` — refresh goldmasters (font subset bytes will change; compare glyph sets not raw streams)

## FLAG 🚩

**Font licensing enforcement is deliberately advisory**, not blocking. fsType bits from OS/2 are read and surfaced via `license.flag` per font, but embedding is never refused. A follow-up task (tracked as task #9 in the TaskList) will design policy: warn, substitute, refuse-and-require-override, or configurable. This branch is intentionally out of scope for that decision.

## Known caveats

- PDFBox TrueType subsetter is non-deterministic under glyph reuse; goldmasters hash glyph sets (not raw font streams) for that reason.
- Noto CJK is installer-fetched, not committed (~80MB total). Tests that need CJK skip cleanly if the installer hasn't run.
- Six synthetic fixtures under `test/fixtures/fonts/` use minimal hand-crafted PDFs; their `*.expected.json` are observed-behavior snapshots of current embedder output (regression gates), not aspirational specs.
