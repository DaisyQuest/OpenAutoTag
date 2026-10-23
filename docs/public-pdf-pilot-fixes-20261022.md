# Official-source pilot: verified engine fixes

Recorded 2026-10-22, America/New_York. This delivery addresses bounded defects from the [eight-document pilot](public-pdf-pilot-20261022.md). Exact input/output hashes, report hashes, implementation fingerprints and assertions are in the [evidence record](evidence/public-pdf-pilot-fixes-20261022.json).

Hinode now reads its left prose column before its right column, with both detached footer elements last. Census retains all 58 page-resource fingerprints and completes its large saved-structure comparison. Checker Unicode corruption, duplicate table-fragment IDs and misleading successful CLI exit codes are corrected. Native writing now stops explicitly when OCR text has no source text operators to attach to.

The frozen sample produces six review candidates covering 84 pages. The STEREO poster and booklet stop at writer safeguards. Fewer candidates than the original seven is intentional: the poster previously produced an empty tagged structure. No candidate is automatically accepted as accessible.

## Changes and verification boundaries

| Change | Implemented behavior | Evidence and limit |
| --- | --- | --- |
| Large comparison output | `scripts/run-json-command.js` pipes subprocess JSON to a temporary file; enforces a 128 MiB stdout cap, 64 KiB stderr cap and 60-second default timeout; rejects partial, invalid, oversized and failed output; cleans temporary files. | Census's approximately 40 MB result now completes through the normal checker. Tests cover output above the former 32 MiB limit, Unicode, spawn failure, nonzero exit, truncation, timeout and invalid JSON. JSON is still parsed in memory after bounded collection; this is not an unlimited streaming comparator. |
| Windows Unicode transport | The Java low-level inspector writes explicit UTF-8 bytes for both output modes. | A real PDF/subprocess test forces Windows-1252 stdout encoding and checks curly punctuation, accented/Euro and Japanese text. Genuine saved-text corruption tests remain. No special UTF-8 launch workaround was used for the replay. |
| Dense prose order and spanning bands | Repeated aligned prose lines with a clear gutter can establish two columns despite bridging title/subtitle text. Spanning bands constrain order. A small detached footer band needs a URL/page-number anchor, matching baseline and clear separation before it is moved after both columns. | Form pages and known table cells are excluded from the new prose detector. Synthetic positive/negative tests and full module integration pass. Independent pypdf traversal confirms all 13 left-body spans precede all 13 right-body spans in the final Hinode PDF, followed by the two footer nodes. This does not qualify arbitrary layouts or solve all paragraph fragmentation. |
| Table-fragment identities | Re-entering an interrupted table group creates deterministic unique fragment IDs, including collision avoidance against reserved source-group names. | Tests retain every source identity and content order. The booklet's tagging tree has no duplicate IDs. Its writer now reaches a separate missing-header attachment error; full booklet remediation is unfinished. |
| Native text attachment guard | Before rewriting, every page with intended text must have native text operators. Auto and explicit native modes fail when this is impossible. | Real image-only PDF fixtures reject before creating output and preserve source bytes. The STEREO poster now fails explicitly. This does not create an OCR text layer, correct the probe's zero-operator match-rate metric, or prove every intended node has coverage on mixed-content pages. |
| Passthrough resource preservation | The Java passthrough writer records Form/Image streams that originally omit optional `/Type`; in minimal mode it removes only a subsequently inserted `/Type /XObject` before saving. | This reverses a PDFBox accessor side effect. The synthetic tagged-form fixture retains its stream bytes and fields; all 58 Census page content/resource hashes now match. Arbitrary resource changes remain disallowed; the preservation checker was not weakened. |
| Batch failure status | The pipeline CLI returns exit code 1 when its JSON status is `failed`. | A malformed-PDF integration test exercises the CLI. Both failed real documents now exit 1. Completed `review_required` runs still exit 0; callers must inspect quality disposition. |

No dependencies, validator suppressions, schema changes or blanket acceptance exceptions were added. Source-prefix and table-header-reference guards remain in place.

## Frozen replay results

The same eight input hashes and seeded official-source selection were retained. Candidate validation was rerun with PDFBox 3.0.8 and veraPDF 1.30.3 Greenfield, `ua1`; source validation reuses the original hash-bound baseline. The default profile and production checks were used, with two concurrent documents and a 600-second pipeline limit. Java used `-XX:TieredStopAtLevel=1` because the earlier environment exhibited a FontBox C2 crash. These timings are not a performance qualification.

| PDF | Pages | Final outcome | Raw failed veraPDF checks | Saved semantic checks: passed / failed |
| --- | ---: | --- | ---: | ---: |
| NASA STEREO poster | 2 | No candidate: OCR text attachment required | Not run on a new candidate | Not run |
| IRS W-9 | 6 | Passthrough; review required | 26 | 7,790 / 160 inherited findings |
| Census Income in the United States: 2024 | 58 | Passthrough; review required, previously rejected | 16,148 | 397,058 / 74 inherited findings |
| NIST SP 1300 | 9 | Passthrough; review required | 7 | 7,471 / 54 inherited findings |
| IRS 1040 | 2 | Passthrough; review required | 446 | 13,598 / 605 inherited findings |
| NIST SP 1299 | 8 | Passthrough; review required | 25 | 2,719 / 63 inherited findings |
| NASA Hinode | 1 | Native; review required, previously rejected | 0 | 531 / 0 |
| NASA STEREO booklet | 61 | No candidate: missing emitted table-header ID | Not run on a new candidate | Not run |

All raw veraPDF summaries for the six produced candidates are unchanged from the original pilot candidates. The gains here concern semantic order, preservation and trustworthy failure/reporting behavior, not removal of the inherited conformance failures.

Every failed saved comparison in the five passthrough outputs is a `STRUCTURE_INTEGRITY` finding already present in the identical source issue inventory. Those are checker findings requiring review, not newly introduced regressions or independently adjudicated PDF defects. Fields, widgets, headings, structure and content-order inventories are unchanged; all page geometry/content/resource/annotation fingerprints match. Existing passthrough behavior also fills blank link descriptions with their unchanged URI: 46 Census, 45 NIST 1300 and 23 NIST 1299 links. Other inspected link properties are unchanged; this is not a new repair in this delivery.

The eight-document batch preceded the final detached-footer refinement. Hinode was then rerun into `output/public-pdf-fixes-20261022/nasa-hinode-final`; that final candidate, not the intermediate `nasa-hinode` candidate, is used for all reported Hinode hashes, order checks and render comparisons. The final full baseline includes the footer refinement. The other five outputs preserve source tags, so their saved semantic order does not use the inferred footer order; their intermediate inference artifacts were not regenerated after that refinement.

## Preservation and regression evidence

- **232 production-baseline tests passed**, zero failed/skipped. A separate layout/reading-order/tag-builder compatibility run passed 76 tests; suites overlap.
- The three new helpers together measured **100% line, 94.74% branch and 95.45% function coverage**. This is not repository-wide or Java coverage. `run-json-command.js` measured 100% in all three categories.
- **All 84 produced pilot pages are pixel-identical in Poppler**: 150 DPI for W-9, 1040 and Hinode; 96 DPI for Census and both NIST documents. Hinode's final page was visually inspected.
- The previously qualified two-page TEST-FORM candidate was processed as an additional control. Both pages are pixel-identical at 150 DPI; 32 terminal fields and 33 widgets remain intact; all 1,828 saved-reference checks pass. veraPDF remains at 106 passed rules / 9,874 passed checks, zero raw failures; the font audit has zero findings. This control starts from `output/TEST-FORM-verified-20261021/06-candidate.pdf`, not the original download.
- PDF.js 4.10.38 compares four first-page pairs at 150 DPI: W-9, 1040, final Hinode and TEST-FORM. All match. W-9 retains 23 fields/widgets, 1040 retains 199 fields/widgets, and TEST-FORM retains 32 fields/33 widgets. One text field and one checkbox in each source/candidate form were filled, saved and reopened; all three edited first-page pairs also match. These are bounded probes, not every field/action or keyboard/reader qualification.
- All frozen source hashes remain unchanged. All six passthrough outputs, including the control, retain the exact source byte prefix. Native Hinode still has `IDENTITY_MAPPING_REQUIRED`; render equality and saved intent checks do not substitute for complete source-to-candidate identity mapping.

Final Hinode SHA-256: `8ffe33d557a2325819a185e58a29794c93184dda98844ba720bf34601f97c6a0`.

TEST-FORM control SHA-256: `95670a8b893a4490ea31e5030398fc03ec7c79e39688e6971535d35b1fafd2aa`.

## Remaining work

1. Resolve the booklet's `Missing emitted table header ID: tag:table:table:2:1:H_r1c0_2` by tracing intended header text through matching and emission. Preserve the header-reference guard; acceptance requires the entire booklet to write and retain intended content with valid relationships.
2. Implement and qualify tagged OCR text attachment for image-only and mixed pages, including geometry, Unicode, content coverage and unchanged appearance. The new guard makes this limitation explicit; it does not implement the missing layer.
3. Provide complete native content identity/coverage proof. Hinode still requires review under the existing production preservation policy.
4. Improve paragraph granularity and meaningful figure/caption coverage against reviewed references; address inherited font/link/structure findings through narrowly qualified repairs. No generic image description is invented.
5. Run independently adjudicated semantic and human reader/keyboard checks. This sample is now a development set; future general accuracy measurements need an unseen holdout.

## Reproduction

Use Node 22 and Java 21 from the repository root. Check source SHA-256 against the original manifest before processing; use a fresh output directory, and do not silently substitute changed bytes from official URLs.

```powershell
$env:JAVA_TOOL_OPTIONS = '-XX:TieredStopAtLevel=1'
npm run test:production-baseline
node orchestrator/pipeline-runner.js --pdf <source.pdf> --output-dir <new-directory> --production-checks true
# For passthrough output:
node scripts/check-saved-semantics.js --pdf <candidate.pdf> --reference <source.pdf> --report-only true --output <comparison.json>
# For native output:
node scripts/check-saved-semantics.js --pdf <candidate.pdf> --tags <05-tagging.json> --report-only true --output <comparison.json>
```

`--report-only true` writes findings without treating them as a CLI failure; inspect the report. Production gating is separate. Large JSON reports can be redirected to files instead of a terminal.

Full local evidence is under `output/public-pdf-fixes-20261022/`, including `09-saved-semantics.json`, source/candidate inventories, `visual-comparison.json`, `interaction-and-pdfjs.json`, `hinode-order-proof.json` and the control reports. Logs are `tmp/pilot-fixes-production-final.log`, `tmp/pilot-fixes-compatibility.log` and `tmp/pilot-fixes-coverage.log`. Investigation helpers and PDFs remain ignored local artifacts; they are not packaged tooling or distributed with the committed evidence summary.
