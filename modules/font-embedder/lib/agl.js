// Minimal Adobe Glyph List subset. Maps PostScript glyph names to Unicode
// scalars for the most common Latin / punctuation glyphs found in encoded
// Type1 / Differences arrays. This is intentionally small — production
// installations should swap in the full AGL/AGLFN data file.

const AGL = new Map(Object.entries({
  ".notdef": 0,
  space: 0x20,
  exclam: 0x21,
  quotedbl: 0x22,
  numbersign: 0x23,
  dollar: 0x24,
  percent: 0x25,
  ampersand: 0x26,
  quoteright: 0x2019,
  parenleft: 0x28,
  parenright: 0x29,
  asterisk: 0x2a,
  plus: 0x2b,
  comma: 0x2c,
  hyphen: 0x2d,
  period: 0x2e,
  slash: 0x2f,
  zero: 0x30,
  one: 0x31,
  two: 0x32,
  three: 0x33,
  four: 0x34,
  five: 0x35,
  six: 0x36,
  seven: 0x37,
  eight: 0x38,
  nine: 0x39,
  colon: 0x3a,
  semicolon: 0x3b,
  less: 0x3c,
  equal: 0x3d,
  greater: 0x3e,
  question: 0x3f,
  at: 0x40,
  bracketleft: 0x5b,
  backslash: 0x5c,
  bracketright: 0x5d,
  asciicircum: 0x5e,
  underscore: 0x5f,
  quoteleft: 0x2018,
  braceleft: 0x7b,
  bar: 0x7c,
  braceright: 0x7d,
  asciitilde: 0x7e,
  endash: 0x2013,
  emdash: 0x2014,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  quotesingle: 0x27,
  bullet: 0x2022,
  ellipsis: 0x2026,
  trademark: 0x2122,
  copyright: 0xa9,
  registered: 0xae,
  paragraph: 0xb6,
  section: 0xa7,
  degree: 0xb0,
  plusminus: 0xb1,
  multiply: 0xd7,
  divide: 0xf7
}));

// A through Z and a through z
for (let codePoint = 0x41; codePoint <= 0x5a; codePoint += 1) {
  AGL.set(String.fromCharCode(codePoint), codePoint);
}
for (let codePoint = 0x61; codePoint <= 0x7a; codePoint += 1) {
  AGL.set(String.fromCharCode(codePoint), codePoint);
}

// Conventional uniXXXX / uXXXXXX names used in Type1 Differences arrays.
function decodeConventionalGlyphName(name) {
  if (!name) {
    return null;
  }

  const uniMatch = /^uni([0-9A-F]{4})$/.exec(name);
  if (uniMatch) {
    return parseInt(uniMatch[1], 16);
  }

  const uMatch = /^u([0-9A-F]{4,6})$/.exec(name);
  if (uMatch) {
    return parseInt(uMatch[1], 16);
  }

  return null;
}

export function lookupGlyphName(name) {
  if (!name) {
    return null;
  }

  if (AGL.has(name)) {
    return AGL.get(name);
  }

  const conventional = decodeConventionalGlyphName(name);
  if (conventional !== null) {
    return conventional;
  }

  return null;
}

export function isPrivateUseArea(codePoint) {
  if (typeof codePoint !== "number" || codePoint < 0) {
    return true;
  }
  // BMP PUA, Supplementary PUA-A, Supplementary PUA-B
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}
