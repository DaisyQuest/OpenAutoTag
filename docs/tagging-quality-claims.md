# Tagging quality: claims, evidence and limits

Updated 2026-10-22 for the [official-source PDF pilot](public-pdf-pilot-20261022.md), following the [verified tagging follow-up](verified-tagging-improvements-20261021.md). This register governs current OpenAutoTag capability statements. Older design notes and corpus runs are historical evidence for their named builds. Proposed roadmap targets are not achieved accuracy.

## Supported description

OpenAutoTag performs deterministic PDF semantic inference, native operator tagging and bounded repairs to existing tagged PDFs. Supported repairs are checked against the saved PDF, including forms, annotations, content and font resources. Ambiguous cases are exposed for review. Automated conformance checks, preservation checks and human usability observations are reported separately.

## Claim register

| ID | Claim we can make | Implementation and evidence | Boundary |
| --- | --- | --- | --- |
| C01 | Native tagging and preservation of qualifying existing tags are implemented. | `modules/pdf-writer/index.js`; native parser/matcher/rewriter; preservation and writer-mode tests. | Auto mode can choose raster output. An operator-match rate measures matching, not semantic correctness. A sidecar-only copy is not newly tagged output. |
| C02 | Bounded rules improve heading membership and combine qualifying wrapped headings. | `semantic-quality.js`, `heading-continuation.js`, reviewed heading repair and their tests. TEST-FORM retains the full Supplemental Affirmation title and changes the field label `Index #:` to P. | An evidence-carrying document outline and repeated numbered-style rank refinement are implemented; complete hierarchy and arbitrary heading detection are not qualified. A repaired heading sequence does not prove that every heading belongs in that sequence. |
| C03 | Form relationships distinguish labels, instructions and authored field identity. | `document-relations.js`, form-semantics tests and semantic benchmark. Authored push-button `/CA` names and painted captions have separate provenance; conflicts require review. | These are inference artifacts. Tooltips retain precedence, and navigation is a proposal. TEST-FORM has one unresolved visual association: the court selector has a tooltip but no printed label. No generic field-name or tab-order rewrite is claimed. |
| C04 | Reading order implements column and explicit semantic constraints, with demonstrated limits. | `modules/reading-order/constraints.js`, spanning-heading and anchor tests; official-source pilot. | Hinode's saved body text interleaves two prose columns line by line. Supported synthetic cases do not establish reliable general column detection/order. Caption/footnote/aside anchoring requires evidence supplied upstream. |
| C05 | Qualified list/paragraph continuations retain distinct content ownership. | `semantic-quality.js`, tag-builder continuation tests and saved numbering tests. | Both paragraph strategies preserve merged source identities and references. Single-Tj native list labels split at exact glyph boundaries with pixel tests; unsupported operand forms remain review/rejection cases. |
| C06 | Both writer paths serialize table header relationships and reject invalid references. | `StructureIdentifiers.java`, `advanced-structure.test.js`, `saved-table-semantics.test.js`. Includes Headers, Scope, IDs and IDTree; new cell replacement text lives on an inner Span. Saved comparisons reject unexpected ActualText/Alt. | Correct serialization does not establish correct table recognition, complete glyph ownership, multi-page topology or observed reader behavior. |
| C07 | Qualified font, link and structure changes have saved-object replay verification. | `QualifiedFontRepairs.java`, `QualifiedStructureRepairs.java`, `QualifiedSemanticRepairs.java`, `SavedObjectVerifier.java`, negative mutation tests. | A font inventory is a proposal. Arbitrary font substitution, custom encodings, signed/encrypted repair and unrestricted semantic rewrites are not covered. |
| C08 | The qualified TEST-FORM candidates pass the configured machine checks and preservation comparisons. | Evidence below; independent raw veraPDF and font audit; exact candidate hash. | One two-page document and specific render/interaction probes do not establish general corpus accuracy or every viewer's behavior. |
| C09 | Candidate download gating and exact-byte qualification records are implemented. | `orchestrator/artifact-policy.js`, preservation checker, reader-qualification checker and negative tests. | Gating is opt-in. A successful check remains `review_required`. Evidence-record validation cannot independently prove a human performed the recorded observations. Automatic promotion to accepted output is unfinished. |
| C10 | The current automated regression baseline passes. | 220 production-baseline tests; 60 compatibility tests; 16 synthetic cases / 74 benchmark checks. The new caption helper has 100% measured line/branch/function coverage. | Suites overlap. Synthetic expectations are maintainer-authored, with independent expert review pending. These counts are not a general accuracy percentage or repository-wide coverage measurement. |

Implementation filenames without a path in this table live under `modules/semantic-engine/` or `modules/pdf-writer/java/` as appropriate. Exact delivery details and reproduction commands are in [the production plan, section 22](production-tagging-engine-plan.md#22-semantic-quality-improvements-16-and-benchmark-delivery-2026-10-21).

## Latest accuracy evidence

The [official-source pilot](public-pdf-pilot-20261022.md) and [hash-bound evidence](evidence/public-pdf-pilot-20261022.json) cover eight PDFs / 147 pages from NASA, IRS, NIST and Census. Seven candidates were produced; all 86 output pages matched the sources in the tested Poppler renders. Two IRS forms retained 222 terminal fields/widgets and passed bounded interaction probes. Five outputs preserved existing tags. Neither of the two zero-failure veraPDF candidates establishes successful semantic remediation: Hinode interleaves columns, while STEREO's OCR text has no attached page content. The booklet failed on duplicate table IDs. Unicode transport and large-result limitations also affected the checkers. No output cleared all production checks. This is a seeded exploratory sample with agent spot checks, not independently adjudicated accuracy or human reader qualification.

The [TEST-FORM hash-bound summary](evidence/verified-tagging-improvements-20261021.json) records the earlier table/text/button follow-up. Each generated native/raster table passes 155 saved intent checks, with unchanged native glyph positions and pixels. TEST-FORM passes 1,828 saved-reference checks and retains its validation and appearance/interaction results. It preserves existing tags; the generated fixtures exercise new cell construction separately.

The [accuracy delivery](tagging-accuracy-delivery-20261021.md), [accuracy evidence](evidence/tagging-accuracy-20261021.json) and [form-label evidence](evidence/form-label-associations-20261021.json) record prior candidates. Nine primary real PDFs completed extraction through tag building with no lost source identities or duplicate tag ownership. Their references remain unreviewed, so this is a diagnostic result, not measured tagging accuracy. Corpus calibration rejects insufficient evidence and does not promote output automatically. Figure geometry/caption candidates and OCR/native conflicts remain review evidence; no general figure, chart or multilingual qualification is claimed.

## Prior recorded evidence (before accuracy delivery)

The [committed evidence summary](evidence/tagging-quality-20261021.json) records hashes and counts from the local run. PDFs, field content, raw inspection files, screenshots and local logs remain outside Git under `output/` and `tmp/`; the summary does not imply those artifacts are distributed in a clone.

| Measurement | Recorded result | Local evidence |
| --- | --- | --- |
| Production baseline, repeated before commit | 171 passed; 0 failed; 0 skipped | `tmp/commit-production-baseline.log` |
| Semantic benchmark | 16 cases, 74 checks, all pass; expert review pending | `output/TEST-FORM-quality-20261021/11-semantic-benchmark.json` |
| veraPDF 1.30.3 Greenfield, `ua1` | 106 passed rules; 9,874 passed checks; 0 failed rules/checks; 0 suppressions | `07-validation-report.json` in the same output folder |
| Independent font audit | 0 findings | Same validation report and `09-quality-verification.json` |
| Preserved interaction objects | 32 terminal fields, 33 widgets, 9 links | Preservation inventories and both repair proofs in the same folder |
| Appearance and text | Both normal pages pixel-identical to the preceding candidate at 150 DPI in Poppler and PDF.js; all 20 checked boxes match in PDF.js; extracted page text identical | `09-quality-verification.json`, rendering probes and visual inspection |
| Interaction | Text/checkbox fill-save-reopen passed; accented/Euro probe passed using both existing Arial and the newly embedded default | `10-interaction-probe.json`, `10-accented-interaction.log` |
| Human reader qualification | Not performed; candidate remains `review_required` | Reader status and delivery record |

Candidate: `output/TEST-FORM-quality-20261021/06-candidate.pdf`.
SHA-256: `e9fc4c318c7d0b75048c9c3dbe035acb1f376be0f80fb1559b101540b3e3b858`.

The native/raster table tests verify saved PDFs separately. The 16-case semantic benchmark starts from layout JSON and stops at tagging JSON; it does not itself run PDF extraction, writing, rendering or assistive technology. In its 74 checks, 38 concern content ownership. Three label checks and three table-header checks are not enough to estimate accuracy on unfamiliar forms or tables.

## Wording and qualification policy

- Use “passed the named validator/profile on the identified candidate,” with date, version and hash. Avoid an unconditional “PDF/UA certified,” “WCAG compliant,” “production ready,” “perfect,” or “99% accurate” claim.
- Use “preserved in the qualified path and checked example.” Avoid implying raster reconstruction or every arbitrary repair preserves editable forms.
- Use “proposed font remediation” for inventory output, and “verified repair” only after examining the saved PDF with the appropriate proof.
- Keep `rawSummary` and `rawFindings` authoritative. The retired PDFBox-backend suppressions are historical; they are not current policy. Counts across different validator backends are not an engine-improvement metric.
- State installed versions as pins: PDFBox 3.0.8 and veraPDF 1.30.3 Greenfield. “Latest” needs a new upstream check at the time of the claim.
- Keep production packaging, operational limits, PDF/UA-2, expert corpus review and observed reader/viewer support explicitly pending until their own evidence exists.

veraPDF documents that its PDF/UA checks cover machine-verifiable requirements. Human observations remain necessary for the intended acceptance scope. [veraPDF validation scope](https://docs.verapdf.org/validation/).

For meaningful sequence and interactive content, qualification should include reading and keyboard order, table relationships, and exposed form name/role/value. The W3C techniques provide useful test examples, rather than a product certification: [PDF3](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF3), [PDF6](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6), [PDF12](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF12).

## Reproduction

From the repository root, using Node 22 and Java 21:

```powershell
npm ci
npm run install:verapdf
npm run test:production-baseline
npm run benchmark:semantic
```

For actual human observations, supply a record following `contracts/reader-qualification.schema.json` to `npm run qualify:semantic -- --pdf <candidate.pdf> --reader-evidence <record.json>`. The qualification command also requires independently reviewed corpus references and named viewer versions. Missing evidence stays pending. This command records qualification inputs; it does not run a screen reader or publish an accepted PDF.
