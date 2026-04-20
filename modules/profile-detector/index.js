// Profile detector — heuristic profile recommendation from cheap
// PDF signals. Given a parser operators.json (or a PDF path and a
// parser CLI to invoke), decides which of the six shipped profiles
// is most appropriate:
//
//   - scanned-low-quality: pages with little or no text operators
//     (scan-plus-OCR pipeline needed)
//   - forms-heavy: PDF carries a populated /AcroForm
//   - cjk: dominant script is Chinese/Japanese/Korean
//   - scientific: producer chain indicates TeX/dvips/Ghostscript
//   - legal: high density of legal citation tokens ("v.", "No. ##-",
//     "¶", Cite, Dkt, et seq.)
//   - default: no specialized match — general-purpose
//
// The detector returns { profileId, signals, reasoning, confidence }
// and is deliberately explanation-forward: every decision names the
// signal that drove it, so an operator can audit why auto-mode
// picked what it picked.
//
// Designed to be cheap: it consumes the same operators.json the
// matcher already produces (no new parser invocation) and samples at
// most ~500 operators for script detection.

import { readFile } from "node:fs/promises";

// Script ranges. Kept compact and explicit rather than using full
// Unicode Script property tables — the detector only needs to
// distinguish a handful of scripts, not validate every code point.
const SCRIPT_RANGES = {
  latin:    [[0x0020, 0x024F]],                        // Basic Latin + Latin-1 Supplement + Extended-A
  cjk:      [[0x3000, 0x303F],                         // CJK Symbols/Punctuation
             [0x3040, 0x309F],                         // Hiragana
             [0x30A0, 0x30FF],                         // Katakana
             [0x3400, 0x4DBF],                         // CJK Extension A
             [0x4E00, 0x9FFF],                         // CJK Unified Ideographs
             [0xAC00, 0xD7AF],                         // Hangul Syllables
             [0xFF00, 0xFFEF]],                        // Halfwidth/Fullwidth
  arabic:   [[0x0600, 0x06FF], [0x0750, 0x077F]],     // Arabic + Supplement
  hebrew:   [[0x0590, 0x05FF]],                       // Hebrew
  cyrillic: [[0x0400, 0x04FF], [0x0500, 0x052F]]      // Cyrillic + Supplement
};

function codePointScript(cp) {
  for (const [name, ranges] of Object.entries(SCRIPT_RANGES)) {
    for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return name;
  }
  return null;
}

// Producer chains indicating a TeX/Ghostscript scientific pipeline.
// Match is case-insensitive substring; the long list covers
// dvips, pdfTeX (all variants), luahbtex, XeTeX, GPL Ghostscript,
// pikepdf (used by arXiv's rewrap layer) and similar academic
// toolchains.
const SCIENTIFIC_PRODUCER_PATTERNS = [
  "pdftex", "luahbtex", "xetex", "dvips", "ghostscript", "pikepdf",
  "tex live", "miktex"
];

// Legal citation markers. Detection is density-based (hits per 1000
// characters) rather than presence-based — a casual "e.g." in a
// scientific paper shouldn't trigger the legal profile.
//
// Patterns balance false-positive avoidance (generic words) against
// the fact that court filings use distinctive short-form citations.
// Verified empirically against SCOTUS + gpo Federal Register docs.
const LEGAL_CITATION_PATTERNS = [
  /\bv\.\s+[A-Z]/g,                    // "v. Foo" (plaintiff v defendant)
  /\bNo\.\s*\d{1,3}[-–]\d{2,}/g,       // "No. 24-656" (case number)
  /\b\d+\s+U\.S\.\s+\d+\b/g,           // "410 U.S. 113" (reporter citation)
  /\b\d+\s+F\.\d+d\s+\d+\b/g,          // "456 F.3d 789"
  /\bSee,?\s+e\.g\.,/g,                // "See, e.g.,"
  /\bet\s+seq\.\b/gi,                  // "et seq."
  /¶\s*\d+/g,                          // "¶ 5"
  /§\s*\d+/g,                          // "§ 14"
  /\bSlip\s+[Oo]p\.\b/g,               // "Slip Op."
  /\bDkt\.\s+No\./g                    // "Dkt. No."
];

// "Forms-heavy" fires when AcroForm is populated AND the doc is
// sparse-text (real forms are mostly labels + field widgets — the
// text operator density is low). Federal Register notices and some
// iText-produced PDFs carry AcroForm dictionaries for navigation or
// signature widgets but are otherwise dense publications; those
// should NOT route to forms-heavy because the forms profile
// substitutes fonts aggressively in ways that can break body text.
const FORMS_HEAVY_OPS_PER_PAGE_CEILING = 200;

// Producers unambiguously indicating a form-authoring tool. When we
// see these, the AcroForm-plus-dense-text heuristic above is
// overridden — the doc is definitely a form even if it has many
// text ops (large forms like IRS 1040 instructions with inline help).
const FORMS_PRODUCER_PATTERNS = [
  "designer 6",        // Adobe LiveCycle Designer (all IRS fillable forms)
  "designer 7",
  "designer 8",
  "designer 9",
  "designer 10",
  "designer 11",
  "livecycle",
  "adobe acroform",
  "foxit phantom",
  "pdfelement",
  "nitro pdf"
];
//
function formsProducerMatch(producer) {
  if (!producer) return false;
  const lower = producer.toLowerCase();
  return FORMS_PRODUCER_PATTERNS.some((p) => lower.includes(p));
}

// "Scanned" detection is more nuanced: any-text-layer PDFs vary in
// op density hugely (a short GAO memo might have 50 ops/page; a
// dense IRS instruction 400 ops/page). We anchor on a sub-10-ops-
// per-page floor across the whole doc as the strong signal, with a
// fallback for docs that are pure-image with no text at all.
const SCANNED_OPS_PER_PAGE_FLOOR = 10;

function inRanges(script, cp) {
  const ranges = SCRIPT_RANGES[script];
  if (!ranges) return false;
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

function sampleTextForScriptAnalysis(operators, maxOps = 500, maxCharsPerOp = 200) {
  // Sample evenly across pages so a document whose first pages are
  // cover/title stays representative. For each op we truncate by
  // character count to avoid letting one huge op dominate the
  // distribution (a CJK doc with one tiny English header op
  // shouldn't be classified as Latin).
  const out = [];
  const stride = Math.max(1, Math.floor(operators.length / maxOps));
  for (let i = 0; i < operators.length && out.length < maxOps; i += stride) {
    const text = (operators[i].text || "").slice(0, maxCharsPerOp);
    if (text) out.push(text);
  }
  return out.join(" ");
}

function scriptCounts(sampled) {
  const counts = { latin: 0, cjk: 0, arabic: 0, hebrew: 0, cyrillic: 0, other: 0 };
  for (let i = 0; i < sampled.length; i++) {
    const cp = sampled.codePointAt(i);
    // Skip whitespace/punctuation explicitly — they don't discriminate
    // script and would dilute the ratios.
    if (cp <= 0x0020 || (cp >= 0x0080 && cp <= 0x009F)) continue;
    if (cp >= 0xD800 && cp <= 0xDFFF) continue; // surrogate half (shouldn't happen)
    const s = codePointScript(cp);
    if (s) counts[s]++; else counts.other++;
    if (cp > 0xFFFF) i++; // skip low surrogate
  }
  return counts;
}

function dominantScript(counts) {
  let total = 0;
  for (const v of Object.values(counts)) total += v;
  if (total < 20) return { script: "unknown", ratio: 0, total };
  let topScript = "other", topCount = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (k === "other") continue;
    if (v > topCount) { topCount = v; topScript = k; }
  }
  return { script: topScript, ratio: topCount / total, total };
}

function legalCitationDensity(sampled) {
  if (sampled.length < 100) return 0;
  let hits = 0;
  for (const pat of LEGAL_CITATION_PATTERNS) {
    const matches = sampled.match(pat);
    if (matches) hits += matches.length;
  }
  return (hits / sampled.length) * 1000;
}

function scientificProducerMatch(producer) {
  if (!producer) return false;
  const lower = producer.toLowerCase();
  return SCIENTIFIC_PRODUCER_PATTERNS.some((p) => lower.includes(p));
}

function textOperatorCoverage(pages) {
  if (!pages.length) return 0;
  let totalOps = 0;
  for (const p of pages) totalOps += p.operatorCount || 0;
  return totalOps / pages.length;
}

/**
 * Detect the best profile for a PDF from a parsed operators.json
 * payload. The input is the same JSON shape the
 * NativeContentStreamParser emits. This function does no I/O and is
 * pure — callers load the JSON however they like.
 *
 * @returns {{ profileId: string, signals: object, reasoning: string, confidence: number, alternates: string[] }}
 */
export function detectProfileFromOperators(doc) {
  const source = doc.source || {};
  const pages = doc.pages || [];
  const allOps = [];
  for (const p of pages) for (const op of p.operators || []) allOps.push(op);

  const opsPerPage = textOperatorCoverage(pages);
  const sampled = sampleTextForScriptAnalysis(allOps);
  const counts = scriptCounts(sampled);
  const dom = dominantScript(counts);
  const citationDensity = legalCitationDensity(sampled);
  const isScientificProducer = scientificProducerMatch(source.producer);
  const hasAcroForm = !!source.hasAcroForm;

  const signals = {
    producer: source.producer || "",
    hasAcroForm,
    hasStructTree: !!source.hasStructTree,
    markInfoMarked: !!source.markInfoMarked,
    pdfVersion: source.pdfVersion || "",
    totalPages: pages.length,
    opsPerPage: Math.round(opsPerPage),
    scriptCounts: counts,
    dominantScript: dom.script,
    dominantScriptRatio: Number(dom.ratio.toFixed(3)),
    legalCitationDensity: Number(citationDensity.toFixed(3)),
    scientificProducerMatch: isScientificProducer,
    scriptSampleChars: sampled.length
  };

  // Decision tree. Ordered by specificity — the earlier rules
  // describe unambiguous document classes, later rules capture
  // content-type hints that can be overridden by stronger signals.
  //
  // Scanned detection comes first only when the doc has ZERO text
  // operators across all pages (image-only PDF). Low-text-layer PDFs
  // with some operators but sparse coverage are not auto-routed to
  // scanned-low-quality here — the default profile's own OCR
  // auto-mode handles those correctly, and misrouting them forces
  // unnecessary 4x high-DPI render variants.
  if (opsPerPage === 0 && pages.length > 0) {
    return {
      profileId: "scanned-low-quality",
      signals,
      reasoning: "Zero text operators across all pages — document is image-only (scanned or rasterized). Scanned profile forces OCR and allocates multiple render variants.",
      confidence: 0.95,
      alternates: ["default"]
    };
  }

  // AcroForm detection is double-gated: either a forms-authoring
  // producer (Designer 6/7/..., LiveCycle, Acrobat) or an
  // AcroForm-plus-sparse-text combination. Dense publications with
  // navigation/signature widgets (Federal Register notices,
  // iText-signed PDFs) will carry AcroForm dictionaries but
  // shouldn't be force-routed to the forms profile.
  const isFormsProducer = formsProducerMatch(source.producer);
  if (hasAcroForm && (isFormsProducer || opsPerPage <= FORMS_HEAVY_OPS_PER_PAGE_CEILING)) {
    return {
      profileId: "forms-heavy",
      signals: { ...signals, formsProducerMatch: isFormsProducer },
      reasoning: isFormsProducer
        ? `Producer "${source.producer}" is a known forms-authoring tool and /AcroForm is populated.`
        : `Populated /AcroForm with sparse text (${Math.round(opsPerPage)} ops/page ≤ ${FORMS_HEAVY_OPS_PER_PAGE_CEILING}). Likely a fillable form rather than a publication with auxiliary widgets.`,
      confidence: isFormsProducer ? 0.95 : 0.75,
      alternates: ["default"]
    };
  }

  if (dom.script === "cjk" && dom.ratio >= 0.3) {
    return {
      profileId: "cjk",
      signals,
      reasoning: `Dominant script is CJK (${(dom.ratio * 100).toFixed(0)}% of sampled non-whitespace characters). CJK profile configures OCR for Japanese+Chinese+Korean and uses Identity-H font encoding.`,
      confidence: dom.ratio >= 0.6 ? 0.95 : 0.8,
      alternates: ["default"]
    };
  }

  // Legal signal requires both citation density AND a ratio of
  // Latin-dominant text — legal citations inside a CJK/Arabic doc
  // are almost certainly just a translated reference section and
  // shouldn't pull the whole doc into the legal profile.
  if (citationDensity >= 0.5 && dom.script === "latin" && dom.ratio >= 0.7) {
    return {
      profileId: "legal",
      signals,
      reasoning: `Legal citation density ${citationDensity.toFixed(2)}/1k chars (e.g. "v. <Name>", case numbers, §/¶ markers, reporter citations). Legal profile tightens column detection and reading-order epsilon for dense caption/header lines typical in court filings.`,
      confidence: citationDensity >= 1.0 ? 0.9 : 0.7,
      alternates: ["default"]
    };
  }

  if (isScientificProducer) {
    return {
      profileId: "scientific",
      signals,
      reasoning: `Producer "${source.producer}" matches a LaTeX/Ghostscript scientific toolchain. Scientific profile widens column gap detection (two-column journal layouts) and extends heading hierarchy to H4.`,
      confidence: 0.85,
      alternates: ["default"]
    };
  }

  return {
    profileId: "default",
    signals,
    reasoning: "No specialized signals detected — falling through to the general-purpose default profile.",
    confidence: 0.6,
    alternates: []
  };
}

/**
 * Load the operators JSON at `path` and run detection.
 */
export async function detectProfileFromOperatorsFile(operatorsJsonPath) {
  const doc = JSON.parse(await readFile(operatorsJsonPath, "utf8"));
  return detectProfileFromOperators(doc);
}
