# Form-label association delivery — 2026-10-21

The engine now resolves seven of TEST-FORM's eight remaining association cases. One remains explicitly unresolved: `LocalCourt` has an authored tooltip but no printed label. The blank court line cannot acquire a visual label while preserving the page appearance. Its tooltip is retained; the engine does not borrow “County of” from the next field or invent page content.

These changes improve semantic inference and review evidence. They do not rewrite `/T`, `/TU`, `/V`, `/AP`, field actions, tab order or the preserved structure tree. The existing accessible names remain authored names. A proposed association is not proof of a particular screen reader's announcement.

## Evidence and rules

| Cases | Association | Guardrails |
| --- | --- | --- |
| Reset Form, Print Form | Decoded text inside each widget's normal appearance, keyed by annotation identity. | Only push-button captions are exposed. Page text and editable field values are excluded. Missing, unsupported, invisible or excessive decoded text abstains. A caption without a tooltip still requests accessible-name review. |
| CountyName | “County of” is a unique adjacent prompt contained in the expanded authored tooltip. | Short prompt, matching meaningful words/numbers, same row, bounded gap and one target. Duplicate or conflicting candidates abstain. |
| Explanations | EXPLANATION is the section label; the next two lines are instructions. | One multiline field, aligned short heading, contiguous instructions, at least 80% authored-tooltip content-word overlap, no intervening heading or competing field. The heading retains its role. |
| AffirmationDay, AffirmationMonth, AffirmationYear | Authored component names share the surrounding sentence and separators. | Three distinct adjacent date components, common authored context, a unique leading prompt and printed separators. Shared context uses `describes` edges; it is not assigned as three identical labels. |
| LocalCourt | Authored name retained; visual association remains unresolved. | No automatic name, value, appearance or nearby-label substitution. |

Parser evidence reuses the existing PDF.js operator pass. No dependencies were added. Layout and semantic schemas add typed appearance text, multiline metadata and association provenance. The date group records widget identities separately from page-node references. Existing paragraph-merger remapping preserves label, instruction and shared-context references; regression tests now cover all three.

`formNavigation.unresolvedWidgetIds` recognizes explicit appearance/context associations as well as page labels. The statuses distinguish `associated-appearance`, `associated-context` and ordinary `associated`; it no longer treats every non-page label as unresolved. The remaining `340R` case still produces `FORM_LABEL_AMBIGUOUS`, and navigation remains `requires-reader-test`.

## Verified result

The [committed evidence summary](evidence/form-label-associations-20261021.json) records hashes and local artifact paths. PDFs and detailed reports remain outside Git.

- 213 production-baseline tests passed, zero failed/skipped. After final guard refinements, 26 focused tests passed and reproduced the saved form relationships/review tasks exactly. These suites overlap.
- The two new helpers measured 100% line coverage and 97.97% combined branch coverage in the focused suite. This is not repository-wide coverage.
- Candidate: `output/TEST-FORM-labels-20261021/06-candidate.pdf`, SHA-256 `be29ddbd30b2f456db539a1d403f2f976ae37f6c8fe775571a457cbcde50f00a`.
- veraPDF 1.30.3 Greenfield: 106 passed rules, 9,874 passed checks, zero raw failures. Independent font audit: zero findings.
- All 32 terminal fields, 33 widgets, nine links and five saved headings remain. Source/candidate page, field, widget, link, heading, structure and content-order inventories are equal. All 1,828 saved-reference checks pass.
- Both pages are pixel-identical to the prior candidate at 150 DPI in Poppler and PDF.js. Both Poppler pages were visually inspected. Original and prior candidate hashes remain unchanged.
- Text/checkbox and accented/Euro fill-save-reopen probes pass. Additional probes verify court/county dropdowns, day/month/year and multiline explanation values through save/reopen, retaining 32 fields.
- No stale label, instruction or context references remain after merging and reading-order stages. Unresolved visual/context associations fall from eight to one.

Candidate disposition remains `review_required`. Actual screen-reader/keyboard sessions and independent corpus calibration remain pending. The new lexical rules are bounded English rules; multilingual expansion remains deferred. Rotated, complex, ambiguous or unsupported appearance/section/date arrangements may still abstain.

## Reproduction

```powershell
npm run test:production-baseline
node orchestrator/pipeline-runner.js --pdf output/TEST-FORM-accuracy-20261021/06-candidate.pdf --output-dir output/TEST-FORM-labels-20261021 --production-checks true
node scripts/check-saved-semantics.js --pdf output/TEST-FORM-labels-20261021/06-candidate.pdf --reference output/TEST-FORM-accuracy-20261021/06-candidate.pdf --output output/TEST-FORM-labels-20261021/09-saved-semantics.json
```

Use a fresh output directory for a new run. The remaining court case requires a reviewed design decision if a printed label is desired; no appearance change was made in this delivery.
