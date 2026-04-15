// Turn a raw font usage record (pdfjs Font + per-page stats) into a
// contract-compliant fontEntry object. Also computes the ToUnicode repair
// strategy and the writer plan action.

import { createHash } from "node:crypto";
import { isPrivateUseArea, lookupGlyphName } from "./agl.js";
import {
  canonicalizeBaseFont,
  isStandard14,
  standard14FallbackKey,
  stripSubsetPrefix
} from "./standard14.js";
import { buildGidToUnicodeMap, classifyFsType, readOs2FsType } from "./ttf-tables.js";

const ENCODING_NAMES = new Set([
  "WinAnsiEncoding",
  "MacRomanEncoding",
  "MacExpertEncoding",
  "StandardEncoding",
  "Identity-H",
  "Identity-V",
  "Custom",
  "Symbolic",
  "Unknown"
]);

const SUBTYPE_NAMES = new Set([
  "Type0",
  "Type1",
  "Type3",
  "TrueType",
  "CIDFontType0",
  "CIDFontType2",
  "MMType1",
  "Unknown"
]);

function normalizeSubtype(pdfFont) {
  if (!pdfFont) return "Unknown";
  const candidates = [
    pdfFont.subtype,
    pdfFont.type,
    pdfFont.composite ? "Type0" : null,
    pdfFont.cidFontType,
    pdfFont.fontType,
    pdfFont.mimetype
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = String(candidate);
    if (SUBTYPE_NAMES.has(value)) {
      return value;
    }
  }

  // pdfjs sometimes reports the inner CIDFontType for composite fonts via
  // `cidFontType` numeric (0 or 2). Recover that here.
  if (pdfFont.cidFontType === 0) return "CIDFontType0";
  if (pdfFont.cidFontType === 2) return "CIDFontType2";
  if (pdfFont.composite) return "Type0";

  return "Unknown";
}

function normalizeEncodingName(pdfFont) {
  if (!pdfFont) return "Unknown";
  const candidate =
    pdfFont.encodingName ||
    pdfFont.cMap?.name ||
    pdfFont.cmap?.name ||
    pdfFont.baseEncodingName ||
    "";
  const name = String(candidate);
  if (ENCODING_NAMES.has(name)) {
    return name;
  }
  if (/identity-h/i.test(name)) return "Identity-H";
  if (/identity-v/i.test(name)) return "Identity-V";
  if (pdfFont?.composite) {
    return "Identity-H";
  }
  if (pdfFont?.isSymbolicFont || pdfFont?.symbolic) {
    return "Symbolic";
  }
  if (pdfFont?.differences && Object.keys(pdfFont.differences).length > 0) {
    return "Custom";
  }
  return "Unknown";
}

function detectIsEmbedded(pdfFont) {
  if (!pdfFont) return false;
  if (pdfFont.isType3Font) {
    // Type3 fonts embed glyph procedures inline — count as embedded.
    return true;
  }
  // pdfjs sets `isStandardFont` when it substituted a Standard 14 metric
  // table for a missing FontFile — treat that as not-embedded.
  if (pdfFont.isStandardFont === true) {
    return false;
  }
  if (pdfFont.missingFile === true) {
    return false;
  }
  if (pdfFont.data && pdfFont.data.length > 0) {
    return true;
  }
  if (pdfFont.file && pdfFont.file.length > 0) {
    return true;
  }
  if (pdfFont.fontFile || pdfFont.fontFile2 || pdfFont.fontFile3) {
    return true;
  }
  return Boolean(pdfFont.isEmbedded);
}

function getEmbeddedBytes(pdfFont) {
  if (!pdfFont) return null;
  const candidate = pdfFont.data || pdfFont.file;
  if (!candidate) return null;
  if (candidate instanceof Uint8Array) return candidate;
  if (Array.isArray(candidate)) return Uint8Array.from(candidate);
  if (typeof candidate === "string") return new TextEncoder().encode(candidate);
  return null;
}

function getCidSystemInfo(pdfFont) {
  if (!pdfFont) return null;
  const info = pdfFont.cidSystemInfo;
  if (!info) return null;
  const registry = typeof info.registry === "string" ? info.registry : "";
  const ordering = typeof info.ordering === "string" ? info.ordering : "";
  const supplement = Number.isFinite(info.supplement) ? info.supplement : 0;
  if (!registry && !ordering && supplement === 0) {
    return null;
  }
  return { registry, ordering, supplement: Math.max(0, supplement | 0) };
}

function evaluateToUnicodeFromMap(toUnicodeMap, glyphIds) {
  if (!toUnicodeMap || glyphIds.length === 0) {
    return { coverage: 0, missing: glyphIds.slice() };
  }

  const lookup = (id) => {
    if (typeof toUnicodeMap.get === "function") {
      try {
        return toUnicodeMap.get(id);
      } catch {
        return undefined;
      }
    }
    if (Array.isArray(toUnicodeMap)) {
      return toUnicodeMap[id];
    }
    return undefined;
  };

  let resolved = 0;
  const missing = [];

  for (const id of glyphIds) {
    const value = lookup(id);
    if (typeof value !== "string" || value.length === 0) {
      missing.push(id);
      continue;
    }
    const codePoint = value.codePointAt(0);
    if (typeof codePoint !== "number" || isPrivateUseArea(codePoint)) {
      missing.push(id);
      continue;
    }
    resolved += 1;
  }

  const coverage = glyphIds.length === 0 ? 0 : resolved / glyphIds.length;
  return { coverage, missing };
}

function tryReconstructFromCmap(pdfFont, glyphIds) {
  const bytes = getEmbeddedBytes(pdfFont);
  if (!bytes) return null;
  const map = buildGidToUnicodeMap(bytes);
  if (!map) return null;

  const reconstructed = new Map();
  for (const glyphId of glyphIds) {
    const codePoint = map.get(glyphId);
    if (typeof codePoint === "number" && !isPrivateUseArea(codePoint)) {
      reconstructed.set(glyphId, String.fromCodePoint(codePoint));
    }
  }

  if (reconstructed.size === 0) {
    return null;
  }

  return { strategy: "from-cmap-table", reconstructed };
}

function tryReconstructFromDifferences(pdfFont, glyphIds) {
  const differences = pdfFont?.differences;
  if (!differences || typeof differences !== "object") {
    return null;
  }

  const reconstructed = new Map();
  for (const [code, name] of Object.entries(differences)) {
    const codeNum = Number(code);
    if (!Number.isFinite(codeNum)) continue;
    const codePoint = lookupGlyphName(name);
    if (typeof codePoint === "number" && !isPrivateUseArea(codePoint)) {
      reconstructed.set(codeNum, String.fromCodePoint(codePoint));
    }
  }

  // Restrict to glyphIds we actually encountered, but also accept reconstructed
  // entries whose code is referenced.
  if (reconstructed.size === 0) {
    return null;
  }
  return { strategy: "from-differences", reconstructed };
}

function tryReconstructFromAGL(pdfFont, glyphIds) {
  // Many Type1 fonts encode glyphs with conventional names even without an
  // explicit Differences array — pdfjs surfaces them via the `glyphNames`
  // map. We map each used charcode to its glyph name and resolve via AGL.
  const glyphNameByCode = pdfFont?.glyphNameMap || pdfFont?.glyphNames;
  if (!glyphNameByCode) return null;

  const reconstructed = new Map();
  for (const glyphId of glyphIds) {
    const name = typeof glyphNameByCode.get === "function"
      ? glyphNameByCode.get(glyphId)
      : glyphNameByCode[glyphId];
    const codePoint = lookupGlyphName(name);
    if (typeof codePoint === "number" && !isPrivateUseArea(codePoint)) {
      reconstructed.set(glyphId, String.fromCodePoint(codePoint));
    }
  }

  if (reconstructed.size === 0) {
    return null;
  }

  return { strategy: "from-agl", reconstructed };
}

function tryReconstructFromCidRos(pdfFont, glyphIds) {
  const cidInfo = getCidSystemInfo(pdfFont);
  if (!cidInfo) return null;
  // We do not bundle full CID -> Unicode maps. Treat known Adobe-Identity /
  // Adobe-GB1 / Adobe-Japan1 / Adobe-Korea1 collections as best-effort
  // identity passes — the writer is expected to wire in the real CMap when
  // it materializes the font.
  const known = new Set(["Adobe-Identity", "Adobe-GB1", "Adobe-Japan1", "Adobe-Korea1", "Adobe-CNS1"]);
  if (!known.has(cidInfo.ordering)) return null;

  const reconstructed = new Map();
  for (const glyphId of glyphIds) {
    if (cidInfo.ordering === "Adobe-Identity" && glyphId > 0 && glyphId < 0x10ffff) {
      if (!isPrivateUseArea(glyphId)) {
        reconstructed.set(glyphId, String.fromCodePoint(glyphId));
      }
    }
  }

  if (reconstructed.size === 0) {
    return null;
  }

  return { strategy: "from-cid-ros", reconstructed };
}

function applyReconstruction(toUnicodeBefore, reconstructed) {
  const merged = new Map();
  if (toUnicodeBefore && typeof toUnicodeBefore.forEach === "function") {
    toUnicodeBefore.forEach((value, key) => merged.set(key, value));
  }
  for (const [key, value] of reconstructed) {
    if (!merged.has(key)) {
      merged.set(key, value);
    }
  }
  return merged;
}

function pickRepairStrategy(pdfFont, glyphIds, baselineMissing) {
  if (baselineMissing.length === 0) {
    return { strategy: null, reconstructed: null };
  }

  const candidates = [
    tryReconstructFromCmap,
    tryReconstructFromDifferences,
    tryReconstructFromAGL,
    tryReconstructFromCidRos
  ];

  for (const builder of candidates) {
    const attempt = builder(pdfFont, baselineMissing);
    if (attempt && attempt.reconstructed.size > 0) {
      return attempt;
    }
  }

  // Synthesize a best-effort identity map for any remaining ASCII-range codes.
  const synthesized = new Map();
  for (const id of baselineMissing) {
    if (id >= 0x20 && id <= 0x7e) {
      synthesized.set(id, String.fromCodePoint(id));
    }
  }
  if (synthesized.size > 0) {
    return { strategy: "synthesized", reconstructed: synthesized };
  }

  return { strategy: "impossible", reconstructed: null };
}

function buildFontKey(baseFont, subtype, encodingName, pageRefSet) {
  const hash = createHash("sha256");
  hash.update(String(baseFont || ""));
  hash.update("|");
  hash.update(subtype);
  hash.update("|");
  hash.update(encodingName);
  hash.update("|");
  hash.update([...pageRefSet].sort((left, right) => left - right).join(","));
  return hash.digest("hex").slice(0, 16);
}

function detectIsSymbolic(pdfFont) {
  if (!pdfFont) return false;
  if (pdfFont.isSymbolicFont === true) return true;
  if (pdfFont.symbolic === true) return true;
  // Standard 14 Symbol/ZapfDingbats are symbolic.
  const canonical = canonicalizeBaseFont(pdfFont.name || pdfFont.loadedName || "");
  return canonical === "Symbol" || canonical === "ZapfDingbats";
}

function detectHasDifferences(pdfFont) {
  if (!pdfFont) return false;
  if (pdfFont.hasDifferences === true) return true;
  const differences = pdfFont.differences;
  if (!differences) return false;
  if (Array.isArray(differences)) return differences.length > 0;
  return Object.keys(differences).length > 0;
}

function pickPlanAction({ embedded, standard14, encoding, repairStrategy, baseFont, subtype, toUnicodePresent, coverage }) {
  if (standard14) {
    return { action: "substitute-fallback", fallbackKey: standard14FallbackKey(baseFont) };
  }

  if (!embedded) {
    return { action: "subset-and-embed", fallbackKey: null };
  }

  if (encoding.isSymbolic && !encoding.hasDifferences) {
    return { action: "rewrite-encoding", fallbackKey: null };
  }

  if (subtype === "Type1" && (!toUnicodePresent || coverage < 1)) {
    return { action: "synthesize-type0-wrapper", fallbackKey: null };
  }

  if (!toUnicodePresent || coverage < 1) {
    if (repairStrategy && repairStrategy !== "impossible") {
      return { action: "inject-to-unicode", fallbackKey: null };
    }
    return { action: "substitute-fallback", fallbackKey: standard14FallbackKey(baseFont) };
  }

  return { action: "embed-as-is", fallbackKey: null };
}

function pickBlocker({ embedded, standard14, encoding, toUnicodePresent, coverage, repairStrategy, subtype, cidSystemInfo }) {
  if (standard14) {
    return { blocker: "standard-14", severity: "error" };
  }

  if (!embedded) {
    return { blocker: "not-embedded", severity: "error" };
  }

  if (subtype === "Type0" && !cidSystemInfo) {
    return { blocker: "missing-cid-system-info", severity: "error" };
  }

  if (encoding.isSymbolic && !encoding.hasDifferences) {
    return { blocker: "symbolic-without-differences", severity: "warning" };
  }

  if (!toUnicodePresent) {
    return { blocker: "missing-to-unicode", severity: "warning" };
  }

  if (coverage < 1 && repairStrategy === "impossible") {
    return { blocker: "broken-to-unicode", severity: "warning" };
  }

  return null;
}

export function analyzeFont(rawRecord) {
  const pdfFont = rawRecord.pdfFont || {};
  const baseFontRaw = pdfFont.name || pdfFont.loadedName || rawRecord.fontId || "Unknown";
  const { prefix, name } = stripSubsetPrefix(baseFontRaw);
  const subtype = normalizeSubtype(pdfFont);
  const encodingName = normalizeEncodingName(pdfFont);
  const isSymbolic = detectIsSymbolic(pdfFont);
  const hasDifferences = detectHasDifferences(pdfFont);
  const embedded = detectIsEmbedded(pdfFont);
  const standard14 = isStandard14(name);
  const cidSystemInfo = getCidSystemInfo(pdfFont);
  const glyphIds = rawRecord.glyphIds || [];

  const toUnicodeMap = pdfFont.toUnicode;
  const baselineToUnicodePresent = toUnicodeMap !== null && toUnicodeMap !== undefined;
  let { coverage, missing } = evaluateToUnicodeFromMap(toUnicodeMap, glyphIds);

  let repairStrategy = null;
  if (missing.length > 0) {
    const repair = pickRepairStrategy(pdfFont, glyphIds, missing);
    repairStrategy = repair.strategy;
    if (repair.reconstructed) {
      const merged = applyReconstruction(toUnicodeMap, repair.reconstructed);
      const reEvaluated = evaluateToUnicodeFromMap(merged, glyphIds);
      coverage = reEvaluated.coverage;
      missing = reEvaluated.missing;
    }
  }

  if (glyphIds.length === 0) {
    coverage = baselineToUnicodePresent ? 1 : 0;
  }

  const fsTypeBytes = getEmbeddedBytes(pdfFont);
  const fsType = fsTypeBytes ? readOs2FsType(fsTypeBytes) : null;
  const license = {
    fsType: typeof fsType === "number" ? fsType : 0,
    flag: classifyFsType(fsType),
    source: typeof fsType === "number" ? "os2-table" : "unknown"
  };

  const fontKey = buildFontKey(baseFontRaw, subtype, encodingName, rawRecord.pages || []);

  const encoding = {
    name: encodingName,
    hasDifferences,
    isSymbolic
  };

  const plan = pickPlanAction({
    embedded,
    standard14,
    encoding,
    repairStrategy,
    baseFont: name,
    subtype,
    toUnicodePresent: baselineToUnicodePresent,
    coverage
  });

  const planNotes = [];
  if (plan.action === "inject-to-unicode") {
    planNotes.push(`reconstructed via ${repairStrategy}`);
  }
  if (plan.action === "subset-and-embed") {
    planNotes.push(`needs source font for ${name}`);
  }
  if (plan.action === "substitute-fallback" && standard14) {
    planNotes.push("standard-14 source forbidden by PDF/UA — substitute embedded fallback");
  }

  const planObject = {
    action: plan.action
  };
  if (plan.fallbackKey !== undefined) {
    planObject.fallbackKey = plan.fallbackKey;
  }
  if (plan.action === "subset-and-embed" || plan.action === "inject-to-unicode" || plan.action === "rewrite-encoding") {
    planObject.glyphsToSubset = glyphIds.slice().sort((left, right) => left - right);
  }
  if (planNotes.length > 0) {
    planObject.notes = planNotes.join("; ");
  }

  const fontEntry = {
    fontKey,
    baseFont: baseFontRaw,
    subsetPrefix: prefix,
    subtype,
    embedded,
    standard14,
    toUnicode: {
      present: baselineToUnicodePresent,
      coverage: Math.max(0, Math.min(1, coverage)),
      missingGlyphs: missing.slice().sort((left, right) => left - right),
      repairStrategy
    },
    encoding,
    cidSystemInfo,
    usage: {
      pages: rawRecord.pages.slice().sort((left, right) => left - right),
      glyphCount: rawRecord.glyphCount,
      sampleText: rawRecord.sampleText || "",
      inFormDA: Boolean(rawRecord.inFormDA)
    },
    license,
    plan: planObject
  };

  const blocker = pickBlocker({
    embedded,
    standard14,
    encoding,
    toUnicodePresent: baselineToUnicodePresent,
    coverage,
    repairStrategy,
    subtype,
    cidSystemInfo
  });

  return { fontEntry, blocker };
}
