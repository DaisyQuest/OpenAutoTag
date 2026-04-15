// The PDF "Standard 14" font names. Forbidden for PDF/UA compliance unless
// the writer substitutes an embedded fallback. We compare against the BaseFont
// after stripping any 6-letter subset prefix.
const STANDARD_14 = new Set([
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Symbol",
  "ZapfDingbats"
]);

// Common synonym normalizations. pdfjs and various tools expose these aliases
// for the same Standard 14 glyph sets (e.g. "TimesNewRoman" -> "Times-Roman",
// "Arial" effectively maps to Helvetica metrics in PDF viewers).
const SYNONYMS = new Map([
  ["TimesNewRoman", "Times-Roman"],
  ["TimesNewRomanPS", "Times-Roman"],
  ["TimesNewRomanPSMT", "Times-Roman"],
  ["TimesNewRoman-Bold", "Times-Bold"],
  ["TimesNewRomanPS-Bold", "Times-Bold"],
  ["TimesNewRomanPS-BoldMT", "Times-Bold"],
  ["TimesNewRoman-Italic", "Times-Italic"],
  ["TimesNewRomanPS-Italic", "Times-Italic"],
  ["TimesNewRomanPS-ItalicMT", "Times-Italic"],
  ["TimesNewRoman-BoldItalic", "Times-BoldItalic"],
  ["TimesNewRomanPS-BoldItalic", "Times-BoldItalic"],
  ["TimesNewRomanPS-BoldItalicMT", "Times-BoldItalic"],
  ["Arial", "Helvetica"],
  ["ArialMT", "Helvetica"],
  ["Arial-Bold", "Helvetica-Bold"],
  ["Arial-BoldMT", "Helvetica-Bold"],
  ["Arial-Italic", "Helvetica-Oblique"],
  ["Arial-ItalicMT", "Helvetica-Oblique"],
  ["Arial-BoldItalic", "Helvetica-BoldOblique"],
  ["Arial-BoldItalicMT", "Helvetica-BoldOblique"],
  ["CourierNew", "Courier"],
  ["CourierNewPS", "Courier"],
  ["CourierNewPSMT", "Courier"],
  ["CourierNew-Bold", "Courier-Bold"],
  ["CourierNewPS-BoldMT", "Courier-Bold"],
  ["CourierNew-Italic", "Courier-Oblique"],
  ["CourierNewPS-ItalicMT", "Courier-Oblique"],
  ["CourierNew-BoldItalic", "Courier-BoldOblique"],
  ["CourierNewPS-BoldItalicMT", "Courier-BoldOblique"]
]);

export function stripSubsetPrefix(baseFont) {
  if (!baseFont) {
    return { prefix: null, name: "" };
  }

  const match = /^([A-Z]{6})\+(.+)$/.exec(baseFont);
  if (match) {
    return { prefix: match[1], name: match[2] };
  }

  return { prefix: null, name: baseFont };
}

export function canonicalizeBaseFont(baseFont) {
  const { name } = stripSubsetPrefix(baseFont);
  return SYNONYMS.get(name) || name;
}

export function isStandard14(baseFont) {
  return STANDARD_14.has(canonicalizeBaseFont(baseFont));
}

export function standard14FallbackKey(baseFont) {
  const canonical = canonicalizeBaseFont(baseFont);
  if (!STANDARD_14.has(canonical)) {
    return null;
  }

  const lower = canonical.toLowerCase();
  const isBold = lower.includes("bold");
  const isItalic = lower.includes("italic") || lower.includes("oblique");
  const family = lower.startsWith("times")
    ? "NotoSerif"
    : lower.startsWith("courier")
      ? "NotoSansMono"
      : lower.startsWith("symbol")
        ? "NotoSansSymbols"
        : lower.startsWith("zapf")
          ? "NotoSansSymbols2"
          : "NotoSans";

  let style;
  if (family === "NotoSansMono") {
    style = isBold ? "MonoBold" : "Mono";
  } else if (isBold && isItalic) {
    style = "BoldItalic";
  } else if (isBold) {
    style = "Bold";
  } else if (isItalic) {
    style = "Italic";
  } else {
    style = "Regular";
  }

  return `${family}-${style}`;
}

export const STANDARD_14_NAMES = STANDARD_14;
