# Native Tagging — 10-Point Improvement Plan

**Current state (build `19g-ocrByteStrip`)**: 23 of 27 corpus docs produce
zero VeraPDF findings; 4 docs have 10 source-PDF-specific findings.
Sanity suite: 26/27 docs pass 11 invariants. Pipeline-output regression:
29/29 tests green.

## Draft plan

### Category A — Correctness & coverage (5)

1. **CIDSet post-save cleanup** — PDFBox regenerates `/CIDSet` on save
   that fails VERAPDF_7_21_4_2_2. Add a post-save pass: re-open the
   output, strip/correct CIDSet entries on descendant CIDFontType2
   dicts, re-save. Target: 3 docs (nist-sp-1271, usgs, irs-p1040).

2. **Per-span `/Lang` via `/A /O /NSO`** — semantic engine detects
   language runs; plumb through so tag-builder emits `/Span` with a
   namespaced `/Lang` attribute. Today only document-level `/Lang` is
   set. Fixes VERAPDF_7_2_14 on irs-p1040 and enables voice-switch on
   multilingual docs.

3. **Multi-column `/Sect` wrapping** — reading-order module knows
   which column each node belongs to; tag-builder currently flattens.
   Wrap contiguous same-column runs in `/Sect` so readers with
   content-stream fallback (VoiceOver, Narrator) don't cross-read
   columns on academic PDFs.

4. **AcroForm regression fixture** — add a real-world native AcroForm
   (irs-fw4) to the corpus with per-doc pins: every Widget has `/TU`;
   every widget has `/OBJR` in `/Form`; VERAPDF_7_18_4_1/4_2 suppressed
   via the probe. Current plumbing is exercised only on irs-w9 (which
   has widgets but is read-only per /Perms).

5. **CI-integrated sanity suite** — extract tmp/SanityCheck.java into
   `modules/pdf-writer/java/SanityCheckCli.java` and wire into the
   pipeline-output regression. Not "at most allowlist" but "exactly
   zero structural violations." Pin MCID uniqueness, /Pg validity,
   parent-tree resolvability, BDC/EMC balance, Tabs=S presence,
   /StructParents presence.

### Category B — Investigations (2)

6. **PDFBox text-extraction quirk ("T h i s")** — deterministic probe
   that reproduces the spacing artifact on scotus-24-656 and
   un-ecosoc-multilingual. Identify which PDFBox API call injects
   spurious spaces. Fix (likely a font-width copy or hmtx override) or
   document as a PDFBox 3.0.7 limitation that doesn't affect Adobe or
   AT (confirmed via Adobe tag-panel text preview).

7. **Orphan MCID references on irs-p1040** — 13 struct leaves point to
   MCIDs absent from content streams. Trace back: are these from Form
   XObjects we don't rewrite? Tagged content whose rewrite failed
   silently? Fix the root cause or pin per-doc tolerance.

### Category C — Documentation (3)

8. **Writer architecture doc** (`docs/native-tagging-design.md` refresh)
   — data-flow diagram (parser → matcher → rewriter → accessibility
   pass → validator), list of every pass in `applyPdfUaAccessibilityPass`
   with the invariant each establishes, how they compose. Audience:
   contributors.

9. **Known-limitations + troubleshooting guide** (`docs/known-limitations.md`)
   — symptom → cause → workaround for: Form-XObject font trade-off,
   VeraPDF PDFBox-backend suppressions (5_1, 7_1_9, 7_18_4_1/2,
   7_18_5_1), source-PDF-specific findings, PDFBox extraction quirks.
   Include "how to verify a finding is ours vs source." Audience:
   operators.

10. **Corpus diversity audit + pins** — inventory existing fixtures by
    (producer, PDF version, form type, language script, scan/born-
    digital). Identify 2-3 gaps (PDF 2.0 input, encrypted doc, 500+
    page doc, CJK-only, dense-math). Add fixtures to close gaps. Pin
    each fixture's expected findings in regression tests.

---

## Hole review

Reading the plan back, the holes I see:

### Hole A — No end-user AT test
None of the 10 points actually validates that a screen reader reads
the output correctly. VeraPDF "pass" ≠ "NVDA reads it." Missing: a
smoke test with an actual screen reader (NVDA headless via Accessible
Name and Description Inspector) on 2-3 representative docs.

### Hole B — No rollback/kill-switch mechanism
Every pass added this session became default-on. If a future producer
trips a new edge case we haven't seen, we have no single flag to
disable newly-added passes. Missing: `OAT_MINIMAL_ACCESSIBILITY_PASS=1`
override that skips the risky passes (OCR strip, table demotion,
source-MC strip) and just emits minimal tagging.

### Hole C — Performance unspecified
A 115-page PDF (thai-constitution-en) takes ~15 seconds end-to-end.
That's tolerable for a single doc but 330+ arxiv PDFs at that rate is
80+ minutes. No P99 latency target, no per-pass budget. Missing:
baseline measurement + budget.

### Hole D — PDF/UA-2 deferred entirely
Plan doesn't mention PDF/UA-2 (ISO 14289-2:2024) at all. That's a
major direction in the ecosystem. Defer is defensible but should be
named; otherwise readers assume we're targeting UA-2 already.

### Hole E — Points 1-7 are implementer-scoped; 8-10 are writer-scoped
The plan mixes "do this code change" with "write this doc." Should
either interleave (each feature → doc update) or phase (all code,
then all docs). Currently it's the latter implicitly — risk is docs
lag behind code.

### Hole F — No Adobe Acrobat verification plan
We've confirmed VeraPDF + PDFBox. Adobe Acrobat has its own checker
(PAC 2024, Acrobat Accessibility Check). A doc that passes VeraPDF
can fail PAC. Missing: a run of at least 3 corpus docs through PAC
2024 and record the findings.

### Hole G — Item #6 and #7 are "investigate" not "do"
They say "identify root cause" but don't commit to a fix. Investigation
without a deliverable is a known way to never finish. Should define
success: "X is closed when findings count is Y or the issue is
demonstrated to be PDFBox-only and documented."

### Hole H — Corpus pins are all-or-nothing
Current pipeline-output-regression uses `ALLOWED_FINDING_CODES` as an
allowlist but doesn't enforce per-doc floors. A regression that adds a
new finding on one doc goes unnoticed if the code was already in the
allowlist. Missing: per-doc expected-findings set.

### Hole I — No "what if we discover this isn't fixable" path
Several items assume the fix exists. If the investigation reveals the
underlying layer (PDFBox, VeraPDF) has a bug we can't work around, we
need an escalation path: upstream bug report or vendored patch.

### Hole J — No owner/priority
Plan doesn't say which items are P0 vs P3, or who owns them, or what
the next session should pick up.

---

## Revised plan (closing the holes)

Each original item carries explicit success criteria, rollback, and
doc update. Two new items (A, B) address holes.

### 1. CIDSet post-save cleanup
- **Do**: implement `stripCidSetsPostSave(outputPath)` that re-opens
  the saved PDF, strips `/CIDSet` from CIDFontType2 descendant
  FontDescriptors, re-saves.
- **Success**: VERAPDF_7_21_4_2_2 drops from 3 docs → 0.
- **Rollback**: `OAT_CIDSET_STRIP=0` env disables.
- **Doc**: Add entry to `known-limitations.md` documenting why PDFBox
  regenerates CIDSet and when to disable.

### 2. Per-span `/Lang` via `/A /O /NSO`
- **Do**: semantic engine emits `lang` field per paragraph run; tag-
  builder translates to `/Span` with namespaced `/Lang` attribute.
- **Success**: VERAPDF_7_2_14 → 0; manual NVDA test confirms voice
  switch on a mixed-language test fixture.
- **Rollback**: `OAT_SPAN_LANG=0`.
- **Doc**: native-tagging-design.md updated with new pass.

### 3. Multi-column `/Sect` wrapping
- **Do**: reading-order module exposes column ID; tag-builder wraps
  contiguous same-column runs in `/Sect`.
- **Success**: hierarchy-regression asserts `maxDepth >= 4` on
  arxiv-2501.18462 (currently depth 5 by accident — need to pin
  explicitly).
- **Rollback**: `TAG_BUILDER_ENABLE_COLUMN_SECTIONS=0`.
- **Doc**: native-tagging-design.md "multi-column layouts" section.

### 4. AcroForm regression fixture
- **Do**: download irs-fw4 (native fillable form), add to
  `test/fixtures/external/`, run pipeline, pin per-doc: every Widget
  has /TU; every widget has /OBJR in /Form; suppression fires.
- **Success**: new fixture in the 29/29 test suite.
- **Rollback**: fixture can be removed.
- **Doc**: mention in known-limitations.md that Sig-type widgets are
  skipped by design.

### 5. CI-integrated sanity suite
- **Do**: promote tmp/SanityCheck.java to
  `modules/pdf-writer/java/SanityCheckCli.java`; add assertion in
  pipeline-output-regression that invokes it and expects exactly 11/11
  per doc.
- **Success**: all 27 docs pass 11/11 (currently 26/27 — includes
  closing #7 on irs-p1040).
- **Rollback**: N/A (test-only).
- **Doc**: `known-limitations.md` defines each of the 11 invariants.

### 6. PDFBox text-extraction quirk — RESOLVE, not just investigate
- **Do**: reproduce the "T h i s" artifact with a minimal test PDF
  (10-line scotus excerpt). Compare PDFTextStripper output between
  PDFBox's declared `/Widths` path and the embedded TTF's hmtx path.
  Either (a) fix by adjusting replacement font widths, or (b)
  confirm it's a PDFBox-3.0.7 limitation and file upstream report.
- **Success**: word-count ratio (output/source) for scotus and
  un-ecosoc drops from 4.2x to within 1.1x.
- **Fallback**: if PDFBox-only and upstream unresponsive, document
  in known-limitations.md with "doesn't affect Adobe/NVDA/JAWS" proof
  (manual Adobe Acrobat text-copy-from-tag-panel test).
- **Doc**: known-limitations.md entry.

### 7. Orphan MCID on irs-p1040 — RESOLVE
- **Do**: trace the 13 orphan MCIDs to a specific pipeline stage.
  Likely candidates: Form XObject content (which rewriter doesn't
  modify) gets MCIDs in the plan but those MCIDs never reach the page
  content stream. Fix either by (a) rewriting Form XObject streams
  too, or (b) dropping assignments that target XObject-internal ops.
- **Success**: irs-p1040 passes sanity check 11/11 (from current
  10/11).
- **Fallback**: pin 13 orphan MCIDs as accepted for irs-p1040 with
  specific exemption in sanity check.
- **Doc**: design doc explains Form XObject content-stream handling.

### 8. Writer architecture doc
- **Do**: `docs/native-tagging-design.md` refresh with pipeline
  flowchart, every pass in `applyPdfUaAccessibilityPass`, invariants
  each establishes, data shapes between stages.
- **Success**: a new contributor can follow the doc to add a new
  accessibility pass without reading source.
- **Doc owner**: whoever writes each pass updates the corresponding
  section.

### 9. Known-limitations + troubleshooting guide
- **Do**: `docs/known-limitations.md` with entries per (a) trade-off,
  (b) suppression, (c) source-PDF issue, (d) PDFBox quirk. Each: what
  it looks like in validator output, what caused it, what to do about
  it.
- **Success**: user filing a bug "my PDF has VERAPDF_X" can self-
  diagnose in under 5 minutes.

### 10. Corpus diversity audit + pins
- **Do**: inventory existing 27 fixtures by (producer, PDF version,
  form type, language, scan vs. born-digital, page count). Add 3
  fixtures: (i) PDF 2.0 input, (ii) encrypted PDF (with read-only
  perms), (iii) 500+ page doc. Pin each fixture's EXACT expected
  finding set (closes hole H — per-doc floors).
- **Success**: regression test uses per-doc-expected-codes instead of
  corpus-wide allowlist; any new finding on any specific doc fails.

### A (new — closes holes B, I). Minimal-pass kill-switch + upstream escalation path
- **Do**: add `OAT_MINIMAL_ACCESSIBILITY_PASS=1` env that skips: table
  demotion, OCR strip, source-MC strip, CIDSet patch. Falls back to
  the minimal Pg-attach + heading normalize + font embed. When a
  production doc triggers a bug, operator sets the flag while we
  investigate. Plus: escalation template for filing PDFBox/VeraPDF
  bugs (issue template, repro steps format).
- **Success**: new flag verified on 1 corpus doc; escalation template
  at `docs/upstream-escalation-template.md`.

### B (new — closes hole A, F). Adobe + NVDA smoke verification
- **Do**: pick 3 corpus docs (1 LRB scan, 1 arxiv, 1 IRS form). Run
  each through Adobe Acrobat Accessibility Check (Acrobat DC or PAC
  2024). Record findings. For AT: use NVDA in speech-viewer mode to
  read the first 2 pages; compare to source. Capture in
  `docs/at-verification-matrix.md`.
- **Success**: matrix committed with objective pass/fail per (tool,
  doc).
- **Cadence**: re-run on every major build ID bump.

### Hole D (PDF/UA-2 direction) — explicitly deferred
UA-2 requires PDF 2.0 writer + namespaced structure tree + AF
plumbing + vocabulary migration. Large enough to be its own
multi-session effort. Noted here so future contributors know the
direction.

### Hole C (performance) — deferred with baseline
Not addressed in this plan. Note: baseline end-to-end pipeline time
on the 27-doc corpus is ~6 minutes (measured 2026-04-19). If anyone
complains about throughput, start with per-stage profiling; no
optimization work until a real user hits a latency budget.

### Owner + priority

| # | Priority | Effort | Blocks |
|---|---|---|---|
| 1 | P0 | Small | — |
| 5 | P0 | Small | closes hole H via #10 |
| 6 | P1 | Medium | — |
| 7 | P1 | Medium | needed to finish #5 |
| 9 | P1 | Medium | unblocks operator self-serve |
| 2 | P2 | Small | — |
| 3 | P2 | Medium | — |
| 4 | P2 | Small | — |
| 8 | P2 | Medium | contributor onboarding |
| 10 | P2 | Medium | — |
| A | P1 | Small | — |
| B | P1 | Small | — |

**Next session start**: #1 (CIDSet strip) + #5 (CI sanity) as the two
low-effort, high-value P0 items. #6 and #7 after since they need
deeper investigation.

---

## Execution log

### Item #1: CIDSet strip — CLOSED (2026-04-19)

Investigation revealed the in-memory `stripMalformedCidSets` pass was
silently failing to reach descendant CIDFont dicts because it didn't
resolve `COSObject` wrappers. PDFBox wraps indirect refs in
`DescendantFonts` arrays as `COSObject`, and my `instanceof
COSDictionary` check returned false, so the strip never ran.

**Fix** (two lines):
```java
COSBase resolved = dBase instanceof COSObject ? ((COSObject) dBase).getObject() : dBase;
COSDictionary descendant = resolved instanceof COSDictionary ? (COSDictionary) resolved : null;
```

Applied to both `stripCidSetsInResources` and
`stripCidSetsInResourcesAggressive`. Once the strip actually runs,
PDFBox respects the absent entry and doesn't regenerate `/CIDSet` on
save.

**Result**: VERAPDF_7_21_4_2_2 **3 docs → 0** (nist-sp-1271, usgs, p1040
all clean). Net corpus improvement: 4 → 2 docs with findings, 10 → 7
total findings, 23 → 25 of 27 completely clean.

**Rejected alternative**: A second `doc.save()` with `NO_COMPRESSION`
was attempted to work around presumed regeneration — it broke font
embedding on 25 docs (FONT_NOT_EMBEDDED went 0 → 764). Reverted.

**Build ID**: `passthrough-2026-04-19h-cidSetCosObjectFix`.
