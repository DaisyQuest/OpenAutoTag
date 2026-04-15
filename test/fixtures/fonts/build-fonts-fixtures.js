// Font-stress fixtures for the font-embedding-hardening track.
//
// These six PDFs intentionally exercise the broken or borderline font
// configurations that the font-embedder, pdf-writer rework, and validator-audit
// modules must repair. Each fixture has an accompanying `<name>.expected.json`
// that captures the inventory findings the font-embedder is expected to emit
// and the validator outcome the full pipeline must achieve.
//
// All six fixtures are emitted via a minimal hand-rolled PDF builder
// (`buildRawPdf`). pdf-lib is intentionally NOT used here because it
// silently auto-corrects malformed or under-described font dictionaries
// (the very thing we want each fixture to express). The hand-rolled
// builder also keeps the fixture step zero-dependency, so it works in
// CI even before `npm install` runs.
//
// Each generated PDF is < 50 KB and byte-deterministic (no PDF /CreationDate,
// no embedded XMP timestamps), so they can be committed to the repo.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal raw PDF builder
// ---------------------------------------------------------------------------

function bufferConcat(parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "binary"))));
}

/**
 * buildRawPdf: assemble a minimal PDF from an array of object bodies.
 *
 * `objects` is an array. Index 0 is reserved (object number 1). Each entry is
 * either a string (object body without `n 0 obj` / `endobj` wrapper) or a
 * Buffer for stream payloads. The trailer's /Root must be specified.
 */
function buildRawPdf({ objects, rootObjectNumber }) {
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
  const offsets = [];
  const chunks = [header];
  let cursor = header.length;

  for (let i = 0; i < objects.length; i += 1) {
    const objectNumber = i + 1;
    offsets.push(cursor);
    const head = Buffer.from(`${objectNumber} 0 obj\n`, "binary");
    const body = Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i], "binary");
    const tail = Buffer.from("\nendobj\n", "binary");
    chunks.push(head, body, tail);
    cursor += head.length + body.length + tail.length;
  }

  const xrefOffset = cursor;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const off of offsets) {
    xrefLines.push(`${String(off).padStart(10, "0")} 00000 n \n`);
  }
  const xref = Buffer.from(xrefLines.join(""), "binary");
  const trailer = Buffer.from(
    `trailer\n<< /Size ${objects.length + 1} /Root ${rootObjectNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    "binary"
  );

  chunks.push(xref, trailer);
  return bufferConcat(chunks);
}

function streamObject(dictBody, payload) {
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "binary");
  const dict = `<< ${dictBody} /Length ${payloadBuf.length} >>\nstream\n`;
  const tail = "\nendstream";
  return bufferConcat([dict, payloadBuf, tail]);
}

// ---------------------------------------------------------------------------
// Fixture: std14-only.pdf
// ---------------------------------------------------------------------------

function buildStd14Only() {
  const catalog = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pages = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  const content = streamObject(
    "",
    "BT /F1 14 Tf 72 720 Td (Standard 14 only.) Tj ET\n" +
      "BT /F1 11 Tf 72 696 Td (This document references Helvetica without embedding.) Tj ET\n"
  );
  const helv = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  return buildRawPdf({
    objects: [catalog, pages, page, content, helv],
    rootObjectNumber: 1
  });
}

// ---------------------------------------------------------------------------
// Fixture: acroform-da-unembedded.pdf
// ---------------------------------------------------------------------------
//
// AcroForm with a Tx field whose /DA references "/Helv 0 Tf 0 g" but the
// AcroForm /DR/Font dict has *no* Helv resource. This is the writer's
// canonical AcroForm-DA repair scenario.

function buildAcroFormDaUnembedded() {
  // 1: Catalog
  // 2: Pages
  // 3: Page
  // 4: AcroForm dict (with /Fields and empty /DR/Font)
  // 5: Form field (Tx, /DA referencing /Helv)
  // 6: Page content stream
  const catalog = `<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>`;
  const pages = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << >> >> /Contents 6 0 R /Annots [5 0 R] >>`;
  // AcroForm /DR/Font intentionally empty -> /Helv referenced in /DA is unresolved.
  const acroForm = `<< /Fields [5 0 R] /DR << /Font << >> >> /DA (/Helv 0 Tf 0 g) /NeedAppearances true >>`;
  const field =
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (FullName) ` +
    `/Rect [72 700 300 720] /P 3 0 R /DA (/Helv 12 Tf 0 g) /V (Sample) >>`;
  const content = streamObject("", "BT /F1 0 Tf 72 750 Td () Tj ET\n");

  return buildRawPdf({
    objects: [catalog, pages, page, acroForm, field, content],
    rootObjectNumber: 1
  });
}

// ---------------------------------------------------------------------------
// Fixture: embedded-ttf-no-tounicode.pdf
// ---------------------------------------------------------------------------
//
// A single-page PDF that draws "AB" using a TrueType font dict with an
// embedded FontFile2 stream but NO /ToUnicode CMap. Because we are not
// shipping a real TTF (the font-embedder vendor work owns that), we embed
// a *placeholder* FontFile2 stream of well-known sentinel bytes. The
// font-embedder is responsible for replacing the stream during repair; the
// fixture only needs to assert structural shape ("FontFile2 present, no
// ToUnicode, encoding has Differences from /A and /B") for the inventory.

function placeholderFontFile2() {
  // 256 bytes of repeated "FAKE" so the stream is recognisably synthetic.
  return Buffer.alloc(256, 0).map((_, i) => "FAKE"[i % 4].charCodeAt(0));
}

function buildEmbeddedTtfNoToUnicode() {
  const fontFileStream = streamObject("/Length1 256", placeholderFontFile2());
  // 1: Catalog
  // 2: Pages
  // 3: Page
  // 4: Content stream (uses /F1)
  // 5: Font dict (TrueType, Subtype/TrueType, references /FontDescriptor 6 0 R, NO /ToUnicode)
  // 6: FontDescriptor referencing /FontFile2 7 0 R
  // 7: FontFile2 stream
  const content = streamObject(
    "",
    "BT /F1 24 Tf 72 720 Td <0102> Tj ET\n"
  );
  const fontDict =
    `<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+CustomSubset ` +
    `/FirstChar 1 /LastChar 2 /Widths [500 500] ` +
    `/Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /A /B] >> ` +
    `/FontDescriptor 6 0 R >>`;
  const fontDescriptor =
    `<< /Type /FontDescriptor /FontName /AAAAAA+CustomSubset ` +
    `/Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 ` +
    `/Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>`;
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  const pages = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const catalog = `<< /Type /Catalog /Pages 2 0 R >>`;

  return buildRawPdf({
    objects: [catalog, pages, page, content, fontDict, fontDescriptor, fontFileStream],
    rootObjectNumber: 1
  });
}

// ---------------------------------------------------------------------------
// Fixture: cjk-identity-h.pdf
// ---------------------------------------------------------------------------
//
// A Type0 / CIDFontType2 font with Identity-H encoding and an intact
// ToUnicode CMap mapping CIDs 0x4E2D 0x6587 -> U+4E2D U+6587 (Chinese
// "Zhongwen"). FontFile2 is again a placeholder; only the structure matters.

function cjkToUnicodeCMap() {
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "2 beginbfchar",
    "<4E2D> <4E2D>",
    "<6587> <6587>",
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end"
  ].join("\n");
}

function buildCjkIdentityH() {
  const fontFileStream = streamObject("/Length1 256", placeholderFontFile2());
  const toUnicodePayload = cjkToUnicodeCMap();
  const toUnicodeStream = streamObject("", toUnicodePayload);
  // Page draws the two CIDs as a hex-encoded TJ string.
  const content = streamObject("", "BT /F1 24 Tf 72 720 Td <4E2D6587> Tj ET\n");

  // 1 catalog, 2 pages, 3 page, 4 content,
  // 5 type0 font, 6 cidfont, 7 fontdescriptor, 8 fontfile2, 9 tounicode
  const catalog = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pages = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  const type0 =
    `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+CJKSans-Regular ` +
    `/Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>`;
  const cid =
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+CJKSans-Regular ` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
    `/FontDescriptor 7 0 R /CIDToGIDMap /Identity /W [0 [500]] >>`;
  const fd =
    `<< /Type /FontDescriptor /FontName /AAAAAA+CJKSans-Regular ` +
    `/Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 ` +
    `/Descent -120 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>`;

  return buildRawPdf({
    objects: [
      catalog,
      pages,
      page,
      content,
      type0,
      cid,
      fd,
      fontFileStream,
      toUnicodeStream
    ],
    rootObjectNumber: 1
  });
}

// ---------------------------------------------------------------------------
// Fixture: symbol-zapfdingbats.pdf
// ---------------------------------------------------------------------------
//
// Standard 14 Symbol + ZapfDingbats. Both unembedded; writer must substitute
// from STIX/Noto with /Differences preserving glyph semantics (e.g. /alpha,
// /a4 -> "Heavy Check Mark").

function buildSymbolZapfDingbats() {
  const catalog = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pages = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`;
  const symbol = `<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>`;
  const dingbats = `<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>`;
  // 'a' in Symbol = lowercase alpha; 0x34 ('4') in ZapfDingbats = heavy check mark.
  const content = streamObject(
    "",
    "BT /F1 24 Tf 72 720 Td (a) Tj ET\nBT /F2 24 Tf 72 690 Td (4) Tj ET\n"
  );

  return buildRawPdf({
    objects: [catalog, pages, page, symbol, dingbats, content],
    rootObjectNumber: 1
  });
}

// ---------------------------------------------------------------------------
// Fixture: broken-differences.pdf
// ---------------------------------------------------------------------------
//
// Type1 font with a malformed /Differences array: index `1` followed by a
// /name, then a stray *number* in the name slot, then a glyph name that is
// not in the AGL ("/notarealglyph"). Writer / font-embedder must
// rewrite-encoding and still produce accurate ToUnicode.

function buildBrokenDifferences() {
  const catalog = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pages = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`;
  // Differences array is intentionally malformed:
  //   [ 1 /A /notarealglyph 999 /B ]
  // The "999" appears where a name should follow /notarealglyph, and
  // /notarealglyph is not in the Adobe Glyph List.
  const fontDict =
    `<< /Type /Font /Subtype /Type1 /BaseFont /AAAAAA+BrokenDiff ` +
    `/FirstChar 1 /LastChar 4 /Widths [500 500 500 500] ` +
    `/Encoding << /Type /Encoding /Differences [1 /A /notarealglyph 999 /B] >> ` +
    `/FontDescriptor 6 0 R >>`;
  const content = streamObject("", "BT /F1 24 Tf 72 720 Td <01020304> Tj ET\n");
  const fontDescriptor =
    `<< /Type /FontDescriptor /FontName /AAAAAA+BrokenDiff ` +
    `/Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 ` +
    `/Descent -200 /CapHeight 700 /StemV 80 >>`;

  return buildRawPdf({
    objects: [catalog, pages, page, fontDict, content, fontDescriptor],
    rootObjectNumber: 1
  });
}

// ---------------------------------------------------------------------------
// Manifest of all fixtures and their expected inventories
// ---------------------------------------------------------------------------

export const FIXTURES = [
  {
    name: "std14-only",
    description: "Helvetica only, unembedded (Standard 14 forbidden by PDF/UA).",
    build: buildStd14Only,
    expected: {
      inventory: {
        fonts: [
          {
            baseFont: "Helvetica",
            subtype: "Type1",
            embedded: false,
            standard14: true,
            toUnicode: { present: false },
            plan: { action: "substitute-fallback", fallbackKey: "noto-sans-regular" }
          }
        ],
        summary: {
          blockers: [{ blocker: "standard-14", severity: "error" }]
        }
      },
      validator: { fontCategoryErrors: 0 }
    }
  },
  {
    name: "embedded-ttf-no-tounicode",
    description:
      "Embedded TrueType subset that omits /ToUnicode. Embedder must repair from the cmap table.",
    build: buildEmbeddedTtfNoToUnicode,
    expected: {
      inventory: {
        fonts: [
          {
            baseFont: "AAAAAA+CustomSubset",
            subtype: "TrueType",
            embedded: true,
            standard14: false,
            toUnicode: { present: false, repairStrategy: "from-cmap-table" },
            plan: { action: "inject-to-unicode" }
          }
        ],
        summary: {
          blockers: [{ blocker: "missing-to-unicode", severity: "error" }]
        }
      },
      validator: { fontCategoryErrors: 0 }
    }
  },
  {
    name: "cjk-identity-h",
    description: "Type0 / CIDFontType2 + Identity-H + intact ToUnicode. Pipeline must preserve.",
    build: buildCjkIdentityH,
    expected: {
      inventory: {
        fonts: [
          {
            baseFont: "AAAAAA+CJKSans-Regular",
            subtype: "Type0",
            embedded: true,
            standard14: false,
            toUnicode: { present: true },
            encoding: { name: "Identity-H" },
            plan: { action: "embed-as-is" }
          }
        ],
        summary: { blockers: [] }
      },
      validator: { fontCategoryErrors: 0 }
    }
  },
  {
    name: "acroform-da-unembedded",
    description:
      "AcroForm /DA references /Helv but /AcroForm/DR/Font is empty. Writer must add embedded Noto to DR and rewrite DA.",
    build: buildAcroFormDaUnembedded,
    expected: {
      inventory: {
        fonts: [
          {
            baseFont: "Helvetica",
            subtype: "Type1",
            embedded: false,
            standard14: true,
            toUnicode: { present: false },
            usage: { inFormDA: true },
            plan: { action: "substitute-fallback", fallbackKey: "noto-sans-regular" }
          }
        ],
        summary: {
          blockers: [{ blocker: "standard-14", severity: "error" }]
        }
      },
      validator: { fontCategoryErrors: 0 }
    }
  },
  {
    name: "symbol-zapfdingbats",
    description:
      "Symbol + ZapfDingbats. Writer substitutes STIX / Noto with Differences preserving glyph semantics.",
    build: buildSymbolZapfDingbats,
    expected: {
      inventory: {
        fonts: [
          {
            baseFont: "Symbol",
            subtype: "Type1",
            embedded: false,
            standard14: true,
            encoding: { name: "Symbolic", isSymbolic: true },
            plan: { action: "substitute-fallback", fallbackKey: "stix-two-math-regular" }
          },
          {
            baseFont: "ZapfDingbats",
            subtype: "Type1",
            embedded: false,
            standard14: true,
            encoding: { name: "Symbolic", isSymbolic: true },
            plan: { action: "substitute-fallback", fallbackKey: "noto-sans-symbols2-regular" }
          }
        ],
        summary: {
          blockers: [
            { blocker: "standard-14", severity: "error" },
            { blocker: "standard-14", severity: "error" }
          ]
        }
      },
      validator: { fontCategoryErrors: 0 }
    }
  },
  {
    name: "broken-differences",
    description:
      "Type1 with a malformed /Differences array. Writer / embedder must rewrite-encoding and synthesize accurate ToUnicode.",
    build: buildBrokenDifferences,
    expected: {
      inventory: {
        fonts: [
          {
            baseFont: "AAAAAA+BrokenDiff",
            subtype: "Type1",
            embedded: false,
            standard14: false,
            encoding: { hasDifferences: true },
            toUnicode: { present: false, repairStrategy: "from-differences" },
            plan: { action: "rewrite-encoding" }
          }
        ],
        summary: {
          blockers: [
            { blocker: "invalid-encoding", severity: "error" },
            { blocker: "missing-to-unicode", severity: "error" }
          ]
        }
      },
      validator: { fontCategoryErrors: 0 }
    }
  }
];

export async function buildAllFixtures(targetDir = here) {
  await mkdir(targetDir, { recursive: true });
  const built = [];
  for (const fixture of FIXTURES) {
    const pdfPath = path.join(targetDir, `${fixture.name}.pdf`);
    const expectedPath = path.join(targetDir, `${fixture.name}.expected.json`);
    const bytes = fixture.build();
    await writeFile(pdfPath, bytes);
    const expectedDocument = {
      schemaVersion: "1.0.0",
      fixture: fixture.name,
      description: fixture.description,
      ...fixture.expected
    };
    await writeFile(expectedPath, `${JSON.stringify(expectedDocument, null, 2)}\n`);
    built.push({ name: fixture.name, pdfPath, expectedPath });
  }
  return built;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  buildAllFixtures()
    .then((built) => {
      for (const entry of built) {
        process.stdout.write(`built ${entry.name} -> ${entry.pdfPath}\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
