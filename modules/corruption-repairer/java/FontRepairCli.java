import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.PDType3Font;
import org.apache.pdfbox.pdmodel.font.PDTrueTypeFont;
import org.apache.pdfbox.pdmodel.font.PDCIDFont;
import org.apache.pdfbox.pdmodel.font.PDCIDFontType0;
import org.apache.pdfbox.pdmodel.font.PDCIDFontType2;
import org.apache.pdfbox.pdmodel.font.PDSimpleFont;
import org.apache.pdfbox.pdmodel.font.encoding.Encoding;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSInteger;

/**
 * Comprehensive font analysis and repair engine for PDFs.
 * Implements 24 checks across 5 categories:
 *   1. Embedding (5 checks)
 *   2. Encoding & Mapping (6 checks)
 *   3. Metrics & Rendering (4 checks)
 *   4. Structure (5 checks)
 *   5. Accessibility (4 checks)
 *
 * Usage: java FontRepairCli --pdf <input.pdf> --output <repaired.pdf>
 */
public class FontRepairCli {

    // ── Standard 14 font names ──────────────────────────────────────────
    private static final Set<String> STANDARD_14 = new HashSet<>(Arrays.asList(
        "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
        "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
        "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
        "Symbol", "ZapfDingbats"
    ));

    // ── Noto fallback mapping ───────────────────────────────────────────
    private static final Map<String, String> NOTO_FALLBACK = new LinkedHashMap<>();
    static {
        NOTO_FALLBACK.put("Helvetica", "NotoSans-Regular");
        NOTO_FALLBACK.put("Helvetica-Bold", "NotoSans-Bold");
        NOTO_FALLBACK.put("Helvetica-Oblique", "NotoSans-Italic");
        NOTO_FALLBACK.put("Helvetica-BoldOblique", "NotoSans-BoldItalic");
        NOTO_FALLBACK.put("Times-Roman", "NotoSerif-Regular");
        NOTO_FALLBACK.put("Times-Bold", "NotoSerif-Bold");
        NOTO_FALLBACK.put("Times-Italic", "NotoSerif-Italic");
        NOTO_FALLBACK.put("Times-BoldItalic", "NotoSerif-BoldItalic");
        NOTO_FALLBACK.put("Courier", "NotoSansMono-Regular");
        NOTO_FALLBACK.put("Courier-Bold", "NotoSansMono-Bold");
        NOTO_FALLBACK.put("Courier-Oblique", "NotoSansMono-Regular");
        NOTO_FALLBACK.put("Courier-BoldOblique", "NotoSansMono-Bold");
        NOTO_FALLBACK.put("Symbol", "NotoSansSymbols-Regular");
        NOTO_FALLBACK.put("ZapfDingbats", "NotoSansSymbols2-Regular");
    }

    // ── Adobe Glyph List (partial, common mappings) ─────────────────────
    private static final Map<String, String> ADOBE_GLYPH_LIST = new LinkedHashMap<>();
    static {
        ADOBE_GLYPH_LIST.put("space", "0020"); ADOBE_GLYPH_LIST.put("exclam", "0021");
        ADOBE_GLYPH_LIST.put("quotedbl", "0022"); ADOBE_GLYPH_LIST.put("numbersign", "0023");
        ADOBE_GLYPH_LIST.put("dollar", "0024"); ADOBE_GLYPH_LIST.put("percent", "0025");
        ADOBE_GLYPH_LIST.put("ampersand", "0026"); ADOBE_GLYPH_LIST.put("quotesingle", "0027");
        ADOBE_GLYPH_LIST.put("parenleft", "0028"); ADOBE_GLYPH_LIST.put("parenright", "0029");
        ADOBE_GLYPH_LIST.put("asterisk", "002A"); ADOBE_GLYPH_LIST.put("plus", "002B");
        ADOBE_GLYPH_LIST.put("comma", "002C"); ADOBE_GLYPH_LIST.put("hyphen", "002D");
        ADOBE_GLYPH_LIST.put("period", "002E"); ADOBE_GLYPH_LIST.put("slash", "002F");
        ADOBE_GLYPH_LIST.put("zero", "0030"); ADOBE_GLYPH_LIST.put("one", "0031");
        ADOBE_GLYPH_LIST.put("two", "0032"); ADOBE_GLYPH_LIST.put("three", "0033");
        ADOBE_GLYPH_LIST.put("four", "0034"); ADOBE_GLYPH_LIST.put("five", "0035");
        ADOBE_GLYPH_LIST.put("six", "0036"); ADOBE_GLYPH_LIST.put("seven", "0037");
        ADOBE_GLYPH_LIST.put("eight", "0038"); ADOBE_GLYPH_LIST.put("nine", "0039");
        ADOBE_GLYPH_LIST.put("colon", "003A"); ADOBE_GLYPH_LIST.put("semicolon", "003B");
        ADOBE_GLYPH_LIST.put("less", "003C"); ADOBE_GLYPH_LIST.put("equal", "003D");
        ADOBE_GLYPH_LIST.put("greater", "003E"); ADOBE_GLYPH_LIST.put("question", "003F");
        ADOBE_GLYPH_LIST.put("at", "0040");
        for (char c = 'A'; c <= 'Z'; c++) {
            ADOBE_GLYPH_LIST.put(String.valueOf(c), String.format("%04X", (int) c));
        }
        for (char c = 'a'; c <= 'z'; c++) {
            ADOBE_GLYPH_LIST.put(String.valueOf(c), String.format("%04X", (int) c));
        }
        ADOBE_GLYPH_LIST.put("bracketleft", "005B"); ADOBE_GLYPH_LIST.put("backslash", "005C");
        ADOBE_GLYPH_LIST.put("bracketright", "005D"); ADOBE_GLYPH_LIST.put("underscore", "005F");
        ADOBE_GLYPH_LIST.put("braceleft", "007B"); ADOBE_GLYPH_LIST.put("bar", "007C");
        ADOBE_GLYPH_LIST.put("braceright", "007D"); ADOBE_GLYPH_LIST.put("tilde", "007E");
        ADOBE_GLYPH_LIST.put("bullet", "2022"); ADOBE_GLYPH_LIST.put("endash", "2013");
        ADOBE_GLYPH_LIST.put("emdash", "2014"); ADOBE_GLYPH_LIST.put("quotedblleft", "201C");
        ADOBE_GLYPH_LIST.put("quotedblright", "201D"); ADOBE_GLYPH_LIST.put("quoteleft", "2018");
        ADOBE_GLYPH_LIST.put("quoteright", "2019"); ADOBE_GLYPH_LIST.put("fi", "FB01");
        ADOBE_GLYPH_LIST.put("fl", "FB02"); ADOBE_GLYPH_LIST.put("ellipsis", "2026");
        ADOBE_GLYPH_LIST.put("copyright", "00A9"); ADOBE_GLYPH_LIST.put("registered", "00AE");
        ADOBE_GLYPH_LIST.put("trademark", "2122"); ADOBE_GLYPH_LIST.put("degree", "00B0");
    }

    // ── Per-font data holder ────────────────────────────────────────────
    static class FontInfo {
        String fontKey;           // e.g. "AAAAAA+Helvetica"
        String baseFont;          // e.g. "Helvetica"
        String subtype;           // Type0, Type1, TrueType, Type3, CIDFontType0, CIDFontType2
        boolean embedded;
        String encoding;
        Set<Integer> pages = new TreeSet<>();
        int glyphsUsed;
        List<Map<String, Object>> findings = new ArrayList<>();
        PDFont pdFont;
        COSDictionary fontDict;

        // health
        double score = 1.0;
        int errorCount, warningCount, infoCount;

        void addFinding(String checkId, String category, String severity,
                        String description, boolean repaired, String repairAction,
                        Map<String, Object> details) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("checkId", checkId);
            f.put("category", category);
            f.put("severity", severity);
            f.put("description", description);
            f.put("repaired", repaired);
            f.put("repairAction", repairAction != null ? repairAction : "none");
            if (details != null && !details.isEmpty()) f.put("details", details);
            findings.add(f);

            if ("error".equals(severity))   { errorCount++;   score -= 0.25; }
            if ("warning".equals(severity)) { warningCount++; score -= 0.10; }
            if ("info".equals(severity))    { infoCount++;    score -= 0.03; }
            if (score < 0) score = 0;
        }

        String grade() {
            if (score >= 0.9) return "A";
            if (score >= 0.75) return "B";
            if (score >= 0.6) return "C";
            if (score >= 0.4) return "D";
            return "F";
        }
    }

    // ── Main ────────────────────────────────────────────────────────────

    public static void main(String[] args) {
        String inputPath = null;
        String outputPath = null;

        for (int i = 0; i < args.length; i++) {
            if ("--pdf".equals(args[i]) && i + 1 < args.length)    inputPath  = args[++i];
            if ("--output".equals(args[i]) && i + 1 < args.length) outputPath = args[++i];
        }

        if (inputPath == null) {
            System.err.println("Usage: java FontRepairCli --pdf <input.pdf> [--output <repaired.pdf>]");
            System.exit(1);
        }

        File inputFile = new File(inputPath);
        if (!inputFile.exists()) {
            System.err.println("ERROR: File not found: " + inputPath);
            System.exit(1);
        }

        new FontRepairCli().run(inputFile, outputPath);
    }

    private void run(File inputFile, String outputPath) {
        PDDocument doc = null;
        boolean repairsApplied = false;
        Map<String, FontInfo> fontMap = new LinkedHashMap<>();

        try {
            doc = Loader.loadPDF(inputFile);

            // ── Phase 1: Walk all pages, collect font usage ─────────
            int pageCount = doc.getNumberOfPages();
            for (int p = 0; p < pageCount; p++) {
                PDPage page = doc.getPage(p);
                int pageNum = p + 1;
                collectFontsFromResources(page.getResources(), fontMap, pageNum);
            }

            // ── Phase 2: Run all 24 checks on each font ────────────
            for (FontInfo fi : fontMap.values()) {
                // Category 1: Embedding
                checkFontNotEmbedded(fi);
                checkFontProgramCorrupt(fi);
                checkFontProgramTruncated(fi);
                checkStandard14Reliance(fi);
                checkMissingFontDescriptor(fi);

                // Category 2: Encoding & Mapping
                checkToUnicodeMissing(fi, doc);
                checkToUnicodeCorrupt(fi);
                checkIdentityHNoToUnicode(fi);
                checkSymbolicNoDifferences(fi);
                checkEncodingMismatch(fi);
                checkPuaWithoutToUnicode(fi);

                // Category 3: Metrics & Rendering
                checkWidthTableMismatch(fi);
                checkMissingRequiredGlyphs(fi);
                checkFontBBoxInvalid(fi, doc);
                checkMetricsInvalid(fi, doc);

                // Category 4: Structure
                checkCidSystemInfoMissing(fi);
                checkDescendantFontsInvalid(fi);
                checkCidToGidMapBroken(fi);
                checkSubsetPrefixMismatch(fi);
                checkCidSetIncomplete(fi, doc);

                // Category 5: Accessibility
                checkType3FontFound(fi);
                checkFontLanguageMismatch(fi, doc);
            }

            // Accessibility checks at document level
            checkDaFontNotInDr(doc, fontMap);
            checkFontNotInResources(doc, fontMap);

            // ── Phase 3: Apply repairs where feasible ───────────────
            for (FontInfo fi : fontMap.values()) {
                for (Map<String, Object> finding : fi.findings) {
                    if (Boolean.TRUE.equals(finding.get("repaired"))) {
                        repairsApplied = true;
                        break;
                    }
                }
                if (repairsApplied) break;
            }

            // ── Phase 4: Save repaired doc if output specified ──────
            if (outputPath != null && repairsApplied) {
                try {
                    doc.save(outputPath);
                    System.err.println("Repaired PDF saved to: " + outputPath);
                } catch (Exception e) {
                    System.err.println("WARNING: Could not save repaired PDF: " + e.getMessage());
                }
            }

            // ── Phase 5: Output JSON report ─────────────────────────
            System.out.println(buildJsonReport(inputFile.getAbsolutePath(), fontMap, repairsApplied));

        } catch (Exception e) {
            System.err.println("FATAL: " + e.getMessage());
            e.printStackTrace(System.err);
            // output minimal JSON even on fatal
            System.out.println("{\"error\":\"" + escapeJson(e.getMessage()) + "\"}");
            System.exit(2);
        } finally {
            if (doc != null) {
                try { doc.close(); } catch (Exception ignored) {}
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Font collection
    // ═══════════════════════════════════════════════════════════════════

    private void collectFontsFromResources(PDResources resources,
                                           Map<String, FontInfo> fontMap,
                                           int pageNum) {
        if (resources == null) return;
        try {
            for (COSName name : resources.getFontNames()) {
                try {
                    PDFont font = resources.getFont(name);
                    if (font == null) continue;
                    String key = name.getName() + "|" + font.getName();
                    FontInfo fi = fontMap.get(key);
                    if (fi == null) {
                        fi = new FontInfo();
                        fi.fontKey = name.getName();
                        fi.pdFont = font;
                        fi.fontDict = font.getCOSObject();
                        fi.baseFont = font.getName() != null ? font.getName() : "(unknown)";
                        fi.subtype = getSubtype(font);
                        fi.embedded = isEmbedded(font);
                        fi.encoding = getEncodingName(font);
                        fi.glyphsUsed = estimateGlyphsUsed(font);
                        fontMap.put(key, fi);
                    }
                    fi.pages.add(pageNum);
                } catch (Exception e) {
                    // Corrupt font entry -- create a stub
                    String key = name.getName() + "|CORRUPT";
                    if (!fontMap.containsKey(key)) {
                        FontInfo fi = new FontInfo();
                        fi.fontKey = name.getName();
                        fi.baseFont = "(corrupt)";
                        fi.subtype = "Unknown";
                        fi.embedded = false;
                        fi.encoding = "unknown";
                        fi.fontDict = null;
                        fi.pdFont = null;
                        fi.pages.add(pageNum);
                        fi.addFinding("FONT_PROGRAM_CORRUPT", "embedding", "error",
                            "Font entry is corrupt and cannot be loaded: " + e.getMessage(),
                            false, "requires-manual-review", null);
                        fontMap.put(key, fi);
                    }
                }
            }
        } catch (Exception e) {
            // Resources iteration failed
        }
    }

    private String getSubtype(PDFont font) {
        if (font instanceof PDType0Font) return "Type0";
        if (font instanceof PDType1Font) return "Type1";
        if (font instanceof PDTrueTypeFont) return "TrueType";
        if (font instanceof PDType3Font) return "Type3";
        COSDictionary dict = font.getCOSObject();
        COSName sub = dict.getCOSName(COSName.SUBTYPE);
        return sub != null ? sub.getName() : "Unknown";
    }

    private boolean isEmbedded(PDFont font) {
        try { return font.isEmbedded(); } catch (Exception e) { return false; }
    }

    private String getEncodingName(PDFont font) {
        try {
            COSBase enc = font.getCOSObject().getDictionaryObject(COSName.ENCODING);
            if (enc instanceof COSName) return ((COSName) enc).getName();
            if (enc instanceof COSDictionary) {
                COSName baseEnc = ((COSDictionary) enc).getCOSName(COSName.BASE_ENCODING);
                return baseEnc != null ? baseEnc.getName() : "DictionaryEncoding";
            }
            if (font instanceof PDSimpleFont) {
                Encoding e = ((PDSimpleFont) font).getEncoding();
                if (e != null) return e.getClass().getSimpleName();
            }
        } catch (Exception ignored) {}
        return "unknown";
    }

    private int estimateGlyphsUsed(PDFont font) {
        try {
            COSDictionary dict = font.getCOSObject();
            // Check /Widths array length
            COSArray widths = dict.getCOSArray(COSName.WIDTHS);
            if (widths != null) return widths.size();
            // For CID fonts, check /W array
            COSArray w = dict.getCOSArray(COSName.W);
            if (w != null) {
                int count = 0;
                for (int i = 0; i < w.size(); i++) {
                    COSBase item = w.getObject(i);
                    if (item instanceof COSArray) count += ((COSArray) item).size();
                    else count++;
                }
                return count;
            }
        } catch (Exception ignored) {}
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CATEGORY 1: EMBEDDING (5 checks)
    // ═══════════════════════════════════════════════════════════════════

    // Check 1: FONT_NOT_EMBEDDED
    private void checkFontNotEmbedded(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            if (fi.embedded) return;
            if ("Type3".equals(fi.subtype)) return; // Type3 are inline

            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            boolean hasFontFile = false;
            if (desc != null) {
                hasFontFile = desc.getFontFile() != null
                           || desc.getFontFile2() != null
                           || desc.getFontFile3() != null;
            }
            if (!hasFontFile) {
                String stripped = stripSubsetPrefix(fi.baseFont);
                String notoFallback = NOTO_FALLBACK.get(stripped);
                String action = notoFallback != null
                    ? "substitute-" + notoFallback.toLowerCase().replace(" ", "-")
                    : "repairable-by-font-embedder";
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("strippedName", stripped);
                if (notoFallback != null) details.put("notoFallback", notoFallback);
                fi.addFinding("FONT_NOT_EMBEDDED", "embedding", "error",
                    "Font '" + fi.baseFont + "' has no embedded font program (no FontFile/FontFile2/FontFile3)",
                    false, action, details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "FONT_NOT_EMBEDDED", "embedding", e);
        }
    }

    // Check 2: FONT_PROGRAM_CORRUPT
    private void checkFontProgramCorrupt(FontInfo fi) {
        try {
            if (fi.pdFont == null || !fi.embedded) return;
            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            if (desc == null) return;

            // Try to access the font program -- PDFBox will parse it
            boolean corrupt = false;
            String errorMsg = "";
            try {
                if (fi.pdFont instanceof PDType0Font) {
                    PDCIDFont cidFont = ((PDType0Font) fi.pdFont).getDescendantFont();
                    if (cidFont != null) cidFont.getCOSObject(); // force load
                }
                // Access glyph data to trigger parse
                fi.pdFont.getHeight(65); // 'A'
            } catch (Exception ex) {
                corrupt = true;
                errorMsg = ex.getMessage();
            }

            if (corrupt) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("error", errorMsg);
                fi.addFinding("FONT_PROGRAM_CORRUPT", "embedding", "error",
                    "Embedded font program cannot be parsed: " + errorMsg,
                    false, "requires-manual-review", details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "FONT_PROGRAM_CORRUPT", "embedding", e);
        }
    }

    // Check 3: FONT_PROGRAM_TRUNCATED
    private void checkFontProgramTruncated(FontInfo fi) {
        try {
            if (fi.pdFont == null || !fi.embedded) return;
            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            if (desc == null) return;

            COSDictionary descDict = desc.getCOSObject();
            // Check FontFile, FontFile2, FontFile3
            String[] fontFileKeys = {"FontFile", "FontFile2", "FontFile3"};
            for (String ffKey : fontFileKeys) {
                COSBase ffBase = descDict.getDictionaryObject(COSName.getPDFName(ffKey));
                if (ffBase == null) continue;
                COSBase resolved = ffBase;
                if (resolved instanceof COSObject) resolved = ((COSObject) resolved).getObject();
                if (!(resolved instanceof COSStream)) continue;

                COSStream stream = (COSStream) resolved;
                long actualLength = -1;
                try (InputStream is = stream.createInputStream()) {
                    byte[] buf = new byte[8192];
                    long total = 0;
                    int read;
                    while ((read = is.read(buf)) != -1) total += read;
                    actualLength = total;
                } catch (Exception ignored) {}

                // Compare against /Length1 hint
                long length1 = stream.getLong(COSName.LENGTH1);
                if (length1 > 0 && actualLength > 0 && actualLength < length1 * 0.9) {
                    Map<String, Object> details = new LinkedHashMap<>();
                    details.put("fontFileKey", ffKey);
                    details.put("expectedLength", length1);
                    details.put("actualLength", actualLength);
                    details.put("ratio", Math.round(((double) actualLength / length1) * 100) + "%");
                    fi.addFinding("FONT_PROGRAM_TRUNCATED", "embedding", "error",
                        "Font program appears truncated: actual " + actualLength +
                        " bytes vs expected " + length1 + " bytes",
                        false, "requires-manual-review", details);
                }
            }
        } catch (Exception e) {
            wrapCheckError(fi, "FONT_PROGRAM_TRUNCATED", "embedding", e);
        }
    }

    // Check 4: STANDARD_14_RELIANCE
    private void checkStandard14Reliance(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            String stripped = stripSubsetPrefix(fi.baseFont);
            if (STANDARD_14.contains(stripped) && !fi.embedded) {
                String noto = NOTO_FALLBACK.get(stripped);
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("standardFontName", stripped);
                if (noto != null) details.put("notoSubstitute", noto);
                fi.addFinding("STANDARD_14_RELIANCE", "embedding", "error",
                    "Relies on Standard 14 font '" + stripped + "' without embedding. PDF/UA forbids this.",
                    false, noto != null ? "substitute-" + noto.toLowerCase() : "requires-font-embedding",
                    details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "STANDARD_14_RELIANCE", "embedding", e);
        }
    }

    // Check 5: MISSING_FONT_DESCRIPTOR
    private void checkMissingFontDescriptor(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            if ("Type3".equals(fi.subtype)) return; // Type3 doesn't need descriptor
            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            if (desc == null) {
                fi.addFinding("MISSING_FONT_DESCRIPTOR", "embedding", "warning",
                    "Font '" + fi.baseFont + "' has no /FontDescriptor entry",
                    false, "requires-manual-review", null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "MISSING_FONT_DESCRIPTOR", "embedding", e);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CATEGORY 2: ENCODING & MAPPING (6 checks)
    // ═══════════════════════════════════════════════════════════════════

    // Check 6: TOUNICODE_MISSING
    private void checkToUnicodeMissing(FontInfo fi, PDDocument doc) {
        try {
            if (fi.pdFont == null) return;
            COSBase toUnicode = fi.fontDict.getDictionaryObject(COSName.TO_UNICODE);
            if (toUnicode == null) {
                boolean canRepair = false;
                String repairAction = "requires-manual-review";

                // For TrueType, we could reconstruct from cmap table
                if (fi.pdFont instanceof PDTrueTypeFont && fi.embedded) {
                    canRepair = true;
                    repairAction = "reconstruct-from-truetype-cmap";
                }
                // For Type1 with Differences, reconstruct from AGL
                if (fi.pdFont instanceof PDType1Font) {
                    COSBase enc = fi.fontDict.getDictionaryObject(COSName.ENCODING);
                    if (enc instanceof COSDictionary) {
                        COSArray diffs = ((COSDictionary) enc).getCOSArray(COSName.DIFFERENCES);
                        if (diffs != null && diffs.size() > 0) {
                            canRepair = true;
                            repairAction = "reconstruct-from-differences-agl";
                            // Attempt actual repair
                            try {
                                String cmapData = buildToUnicodeFromDifferences(diffs);
                                if (cmapData != null) {
                                    COSStream cmapStream = new COSStream();
                                    try (java.io.OutputStream os = cmapStream.createOutputStream()) {
                                        os.write(cmapData.getBytes(StandardCharsets.UTF_8));
                                    }
                                    fi.fontDict.setItem(COSName.TO_UNICODE, cmapStream);
                                    fi.addFinding("TOUNICODE_MISSING", "encoding", "warning",
                                        "Missing /ToUnicode CMap -- reconstructed from /Differences + Adobe Glyph List",
                                        true, repairAction, null);
                                    return;
                                }
                            } catch (Exception ignored) {}
                        }
                    }
                }

                fi.addFinding("TOUNICODE_MISSING", "encoding",
                    fi.pdFont instanceof PDType0Font ? "error" : "warning",
                    "Font '" + fi.baseFont + "' has no /ToUnicode CMap. Text extraction may fail.",
                    false, repairAction, null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "TOUNICODE_MISSING", "encoding", e);
        }
    }

    // Check 7: TOUNICODE_CORRUPT
    private void checkToUnicodeCorrupt(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            COSBase toUnicode = fi.fontDict.getDictionaryObject(COSName.TO_UNICODE);
            if (toUnicode == null) return;

            try {
                fi.pdFont.toUnicode(65); // Try to use ToUnicode mapping
            } catch (Exception ex) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("error", ex.getMessage());
                fi.addFinding("TOUNICODE_CORRUPT", "encoding", "error",
                    "ToUnicode CMap is present but cannot be parsed: " + ex.getMessage(),
                    false, "requires-manual-review", details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "TOUNICODE_CORRUPT", "encoding", e);
        }
    }

    // Check 8: IDENTITY_H_NO_TOUNICODE
    private void checkIdentityHNoToUnicode(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            if (!(fi.pdFont instanceof PDType0Font)) return;

            COSBase enc = fi.fontDict.getDictionaryObject(COSName.ENCODING);
            boolean isIdentityH = false;
            if (enc instanceof COSName) {
                String encName = ((COSName) enc).getName();
                isIdentityH = "Identity-H".equals(encName) || "Identity-V".equals(encName);
            }

            if (isIdentityH) {
                COSBase toUnicode = fi.fontDict.getDictionaryObject(COSName.TO_UNICODE);
                if (toUnicode == null) {
                    fi.addFinding("IDENTITY_H_NO_TOUNICODE", "encoding", "error",
                        "Type0 font with Identity-H encoding but no ToUnicode. " +
                        "Text is unextractable. Common CJK problem.",
                        false, "requires-manual-review", null);
                }
            }
        } catch (Exception e) {
            wrapCheckError(fi, "IDENTITY_H_NO_TOUNICODE", "encoding", e);
        }
    }

    // Check 9: SYMBOLIC_NO_DIFFERENCES
    private void checkSymbolicNoDifferences(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            if (desc == null) return;

            int flags = desc.getFlags();
            boolean symbolic = (flags & (1 << 2)) != 0; // bit 3 (0-indexed bit 2)
            if (!symbolic) return;

            COSBase enc = fi.fontDict.getDictionaryObject(COSName.ENCODING);
            boolean hasDifferences = false;
            if (enc instanceof COSDictionary) {
                COSArray diffs = ((COSDictionary) enc).getCOSArray(COSName.DIFFERENCES);
                hasDifferences = diffs != null && diffs.size() > 0;
            }

            if (!hasDifferences) {
                fi.addFinding("SYMBOLIC_NO_DIFFERENCES", "encoding", "warning",
                    "Symbolic font '" + fi.baseFont + "' has no /Differences in /Encoding. " +
                    "Glyph mapping may be unreliable.",
                    false, "requires-manual-review", null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "SYMBOLIC_NO_DIFFERENCES", "encoding", e);
        }
    }

    // Check 10: ENCODING_MISMATCH
    private void checkEncodingMismatch(FontInfo fi) {
        try {
            if (fi.pdFont == null || !fi.embedded) return;
            if (!(fi.pdFont instanceof PDSimpleFont)) return;

            PDSimpleFont simpleFont = (PDSimpleFont) fi.pdFont;
            Encoding encoding = simpleFont.getEncoding();
            if (encoding == null) return;

            int mismatches = 0;
            List<String> mismatchExamples = new ArrayList<>();
            for (int code = 0; code < 256; code++) {
                try {
                    String glyphName = encoding.getName(code);
                    if (glyphName == null || ".notdef".equals(glyphName)) continue;
                    // Check if font actually has this glyph
                    if (simpleFont.hasGlyph(glyphName)) continue;
                    // Check via code
                    try {
                        if (simpleFont.hasGlyph(String.valueOf(code))) continue;
                    } catch (Exception ignored) {}
                    mismatches++;
                    if (mismatchExamples.size() < 5) {
                        mismatchExamples.add("code=" + code + " glyph='" + glyphName + "'");
                    }
                } catch (Exception ignored) {}
            }

            if (mismatches > 0) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("mismatchCount", mismatches);
                details.put("examples", mismatchExamples);
                fi.addFinding("ENCODING_MISMATCH", "encoding", "warning",
                    "Encoding declares " + mismatches + " glyph names not found in font program",
                    false, "requires-manual-review", details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "ENCODING_MISMATCH", "encoding", e);
        }
    }

    // Check 11: PUA_WITHOUT_TOUNICODE
    private void checkPuaWithoutToUnicode(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;

            boolean hasPua = false;
            List<String> puaCodes = new ArrayList<>();

            // Check ToUnicode mappings for PUA usage
            for (int code = 0; code < 256; code++) {
                try {
                    String unicode = fi.pdFont.toUnicode(code);
                    if (unicode != null) {
                        for (int i = 0; i < unicode.length(); i++) {
                            int cp = unicode.codePointAt(i);
                            if (cp >= 0xE000 && cp <= 0xF8FF) {
                                hasPua = true;
                                if (puaCodes.size() < 10)
                                    puaCodes.add("U+" + String.format("%04X", cp) + " (code=" + code + ")");
                            }
                            if (cp > 0xFFFF) i++;
                        }
                    }
                } catch (Exception ignored) {}
            }

            // Also check Type0 fonts with higher code ranges
            if (fi.pdFont instanceof PDType0Font) {
                for (int code = 0; code < 0x10000 && puaCodes.size() < 10; code += 256) {
                    try {
                        String unicode = fi.pdFont.toUnicode(code);
                        if (unicode != null) {
                            for (int i = 0; i < unicode.length(); i++) {
                                int cp = unicode.codePointAt(i);
                                if (cp >= 0xE000 && cp <= 0xF8FF) {
                                    hasPua = true;
                                    if (puaCodes.size() < 10)
                                        puaCodes.add("U+" + String.format("%04X", cp) + " (code=" + code + ")");
                                }
                                if (cp > 0xFFFF) i++;
                            }
                        }
                    } catch (Exception ignored) {}
                }
            }

            if (hasPua) {
                COSBase toUnicode = fi.fontDict != null
                    ? fi.fontDict.getDictionaryObject(COSName.TO_UNICODE) : null;
                // The PUA mapping IS the ToUnicode -- but it maps to PUA, which is the problem
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("puaMappings", puaCodes);
                fi.addFinding("PUA_WITHOUT_TOUNICODE", "encoding", "warning",
                    "Font maps to Private Use Area (U+E000-U+F8FF) without providing real Unicode mappings. " +
                    "Text extraction will produce garbage.",
                    false, "requires-manual-review", details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "PUA_WITHOUT_TOUNICODE", "encoding", e);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CATEGORY 3: METRICS & RENDERING (4 checks)
    // ═══════════════════════════════════════════════════════════════════

    // Check 12: WIDTH_TABLE_MISMATCH
    private void checkWidthTableMismatch(FontInfo fi) {
        try {
            if (fi.pdFont == null || !fi.embedded) return;
            if (fi.fontDict == null) return;

            double maxDeviation = 0;
            int checked = 0;
            int mismatches = 0;

            if (fi.pdFont instanceof PDSimpleFont) {
                COSArray widths = fi.fontDict.getCOSArray(COSName.WIDTHS);
                if (widths == null) return;
                int firstChar = fi.fontDict.getInt(COSName.FIRST_CHAR, 0);

                for (int i = 0; i < widths.size(); i++) {
                    try {
                        COSBase w = widths.getObject(i);
                        if (!(w instanceof COSNumber)) continue;
                        float declared = ((COSNumber) w).floatValue();
                        int code = firstChar + i;

                        float actual = fi.pdFont.getWidth(code);
                        if (actual <= 0) continue;
                        checked++;

                        double dev = Math.abs(declared - actual);
                        if (dev > maxDeviation) maxDeviation = dev;
                        if (dev > 1.0) mismatches++;
                    } catch (Exception ignored) {}
                }
            }

            if (mismatches > 0) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("checked", checked);
                details.put("mismatches", mismatches);
                details.put("maxDeviation", Math.round(maxDeviation * 100.0) / 100.0);
                fi.addFinding("WIDTH_TABLE_MISMATCH", "metrics", "warning",
                    "Width table has " + mismatches + " mismatches vs actual glyph widths (max deviation: " +
                    Math.round(maxDeviation) + " units)",
                    false, "requires-manual-review", details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "WIDTH_TABLE_MISMATCH", "metrics", e);
        }
    }

    // Check 13: MISSING_REQUIRED_GLYPHS
    private void checkMissingRequiredGlyphs(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;

            int missing = 0;
            List<String> missingCodes = new ArrayList<>();

            // Check common character codes
            int limit = fi.pdFont instanceof PDType0Font ? 0x1000 : 256;
            for (int code = 32; code < limit; code++) {
                try {
                    float w = fi.pdFont.getWidth(code);
                    // Width of 0 for a non-.notdef glyph is suspicious
                    // but we can't conclusively say it's missing without content stream analysis
                } catch (Exception ex) {
                    missing++;
                    if (missingCodes.size() < 10) {
                        missingCodes.add("code=" + code);
                    }
                }
            }

            if (missing > 0) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("missingCount", missing);
                details.put("examples", missingCodes);
                fi.addFinding("MISSING_REQUIRED_GLYPHS", "metrics", "warning",
                    missing + " character codes throw errors when accessing glyph data",
                    false, "requires-manual-review", details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "MISSING_REQUIRED_GLYPHS", "metrics", e);
        }
    }

    // Check 14: FONTBBOX_INVALID
    private void checkFontBBoxInvalid(FontInfo fi, PDDocument doc) {
        try {
            if (fi.pdFont == null) return;
            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            if (desc == null) return;

            COSDictionary descDict = desc.getCOSObject();
            COSArray bbox = descDict.getCOSArray(COSName.FONT_BBOX);

            boolean invalid = false;
            String reason = "";

            if (bbox == null) {
                invalid = true;
                reason = "FontBBox is missing";
            } else if (bbox.size() < 4) {
                invalid = true;
                reason = "FontBBox has fewer than 4 elements";
            } else {
                float llx = getFloat(bbox, 0);
                float lly = getFloat(bbox, 1);
                float urx = getFloat(bbox, 2);
                float ury = getFloat(bbox, 3);
                if (llx == 0 && lly == 0 && urx == 0 && ury == 0) {
                    invalid = true;
                    reason = "FontBBox is [0 0 0 0]";
                }
            }

            if (invalid) {
                // Attempt repair: calculate from font program bounds
                boolean repaired = false;
                String repairAction = "requires-manual-review";

                try {
                    if (fi.embedded && fi.pdFont.getBoundingBox() != null) {
                        var fbox = fi.pdFont.getBoundingBox();
                        if (fbox.getWidth() > 0 && fbox.getHeight() > 0) {
                            COSArray newBbox = new COSArray();
                            newBbox.add(new COSFloat((float) fbox.getLowerLeftX()));
                            newBbox.add(new COSFloat((float) fbox.getLowerLeftY()));
                            newBbox.add(new COSFloat((float) fbox.getUpperRightX()));
                            newBbox.add(new COSFloat((float) fbox.getUpperRightY()));
                            descDict.setItem(COSName.FONT_BBOX, newBbox);
                            repaired = true;
                            repairAction = "calculated-from-font-program";
                        }
                    }
                } catch (Exception ignored) {}

                Map<String, Object> details = new LinkedHashMap<>();
                details.put("reason", reason);
                fi.addFinding("FONTBBOX_INVALID", "metrics", "warning",
                    "FontDescriptor /FontBBox is invalid: " + reason,
                    repaired, repairAction, details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "FONTBBOX_INVALID", "metrics", e);
        }
    }

    // Check 15: METRICS_INVALID
    private void checkMetricsInvalid(FontInfo fi, PDDocument doc) {
        try {
            if (fi.pdFont == null) return;
            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            if (desc == null) return;

            List<String> problems = new ArrayList<>();
            float ascent = desc.getAscent();
            float descent = desc.getDescent();
            float capHeight = desc.getCapHeight();
            float italicAngle = desc.getItalicAngle();

            if (ascent == 0) problems.add("Ascent=0");
            if (descent == 0) problems.add("Descent=0");
            if (capHeight == 0) problems.add("CapHeight=0");
            if (Float.isNaN(italicAngle)) problems.add("ItalicAngle=NaN");

            if (!problems.isEmpty()) {
                boolean repaired = false;
                String repairAction = "requires-manual-review";

                // Attempt repair from font program
                try {
                    if (fi.embedded && fi.pdFont.getBoundingBox() != null) {
                        var fbox = fi.pdFont.getBoundingBox();
                        COSDictionary descDict = desc.getCOSObject();
                        if (ascent == 0 && fbox.getUpperRightY() > 0) {
                            descDict.setFloat(COSName.ASCENT, (float) fbox.getUpperRightY());
                            repaired = true;
                        }
                        if (descent == 0 && fbox.getLowerLeftY() < 0) {
                            descDict.setFloat(COSName.DESCENT, (float) fbox.getLowerLeftY());
                            repaired = true;
                        }
                        if (capHeight == 0 && fbox.getUpperRightY() > 0) {
                            descDict.setFloat(COSName.CAP_HEIGHT, (float) (fbox.getUpperRightY() * 0.7));
                            repaired = true;
                        }
                        if (repaired) repairAction = "calculated-from-font-program";
                    }
                } catch (Exception ignored) {}

                Map<String, Object> details = new LinkedHashMap<>();
                details.put("problems", problems);
                details.put("ascent", ascent);
                details.put("descent", descent);
                details.put("capHeight", capHeight);
                details.put("italicAngle", Float.isNaN(italicAngle) ? "NaN" : italicAngle);
                fi.addFinding("METRICS_INVALID", "metrics", "warning",
                    "FontDescriptor has invalid metrics: " + String.join(", ", problems),
                    repaired, repairAction, details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "METRICS_INVALID", "metrics", e);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CATEGORY 4: STRUCTURE (5 checks)
    // ═══════════════════════════════════════════════════════════════════

    // Check 16: CID_SYSTEM_INFO_MISSING
    private void checkCidSystemInfoMissing(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            if (!(fi.pdFont instanceof PDType0Font)) return;

            PDType0Font type0 = (PDType0Font) fi.pdFont;
            PDCIDFont cidFont = type0.getDescendantFont();
            if (cidFont == null) return;

            COSDictionary cidDict = cidFont.getCOSObject();
            COSBase cidSysInfo = cidDict.getDictionaryObject(COSName.getPDFName("CIDSystemInfo"));
            if (cidSysInfo == null) {
                fi.addFinding("CID_SYSTEM_INFO_MISSING", "structure", "warning",
                    "CIDFont is missing /CIDSystemInfo dictionary",
                    false, "requires-manual-review", null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "CID_SYSTEM_INFO_MISSING", "structure", e);
        }
    }

    // Check 17: DESCENDANT_FONTS_INVALID
    private void checkDescendantFontsInvalid(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            if (!(fi.pdFont instanceof PDType0Font)) return;

            COSArray descendants = fi.fontDict.getCOSArray(COSName.DESCENDANT_FONTS);
            if (descendants == null || descendants.size() == 0) {
                fi.addFinding("DESCENDANT_FONTS_INVALID", "structure", "error",
                    "Type0 font /DescendantFonts is missing or empty",
                    false, "requires-manual-review", null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "DESCENDANT_FONTS_INVALID", "structure", e);
        }
    }

    // Check 18: CID_TO_GID_MAP_BROKEN
    private void checkCidToGidMapBroken(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            if (!(fi.pdFont instanceof PDType0Font)) return;

            PDType0Font type0 = (PDType0Font) fi.pdFont;
            PDCIDFont cidFont = type0.getDescendantFont();
            if (cidFont == null) return;

            COSDictionary cidDict = cidFont.getCOSObject();
            COSBase cidToGid = cidDict.getDictionaryObject(COSName.getPDFName("CIDToGIDMap"));
            if (cidToGid == null) return;
            if (cidToGid instanceof COSName) return; // "Identity" is valid

            // It should be a stream
            COSBase resolved = cidToGid;
            if (resolved instanceof COSObject) resolved = ((COSObject) resolved).getObject();
            if (resolved instanceof COSStream) {
                try (InputStream is = ((COSStream) resolved).createInputStream()) {
                    byte[] buf = new byte[4];
                    int read = is.read(buf);
                    if (read <= 0) {
                        fi.addFinding("CID_TO_GID_MAP_BROKEN", "structure", "error",
                            "CIDToGIDMap stream is empty or unreadable",
                            false, "requires-manual-review", null);
                    }
                } catch (Exception ex) {
                    Map<String, Object> details = new LinkedHashMap<>();
                    details.put("error", ex.getMessage());
                    fi.addFinding("CID_TO_GID_MAP_BROKEN", "structure", "error",
                        "CIDToGIDMap stream cannot be read: " + ex.getMessage(),
                        false, "requires-manual-review", details);
                }
            } else {
                fi.addFinding("CID_TO_GID_MAP_BROKEN", "structure", "error",
                    "CIDToGIDMap is neither a name nor a stream",
                    false, "requires-manual-review", null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "CID_TO_GID_MAP_BROKEN", "structure", e);
        }
    }

    // Check 19: SUBSET_PREFIX_MISMATCH
    private void checkSubsetPrefixMismatch(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            String name = fi.baseFont;
            if (name == null) return;

            // Check for XXXXXX+ prefix
            boolean hasPrefix = name.length() > 7
                && name.charAt(6) == '+'
                && name.substring(0, 6).matches("[A-Z]{6}");

            if (hasPrefix && fi.embedded) {
                // Check if it's actually subsetted -- full font programs are usually > 50KB
                PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
                if (desc != null) {
                    long size = 0;
                    COSDictionary descDict = desc.getCOSObject();
                    for (String key : new String[]{"FontFile", "FontFile2", "FontFile3"}) {
                        COSBase ff = descDict.getDictionaryObject(COSName.getPDFName(key));
                        if (ff == null) continue;
                        if (ff instanceof COSObject) ff = ((COSObject) ff).getObject();
                        if (ff instanceof COSStream) {
                            try (InputStream is = ((COSStream) ff).createInputStream()) {
                                byte[] buf = new byte[8192];
                                int r;
                                while ((r = is.read(buf)) != -1) size += r;
                            } catch (Exception ignored) {}
                        }
                    }
                    // Heuristic: if font is very large, it might not be subsetted
                    if (size > 500_000) {
                        Map<String, Object> details = new LinkedHashMap<>();
                        details.put("fontProgramSize", size);
                        details.put("subsetPrefix", name.substring(0, 7));
                        fi.addFinding("SUBSET_PREFIX_MISMATCH", "structure", "info",
                            "Font has subset prefix '" + name.substring(0, 7) +
                            "' but font program is " + size +
                            " bytes, suggesting it may not be actually subsetted",
                            false, "informational", details);
                    }
                }
            } else if (hasPrefix && !fi.embedded) {
                fi.addFinding("SUBSET_PREFIX_MISMATCH", "structure", "warning",
                    "Font has subset prefix but no embedded font program",
                    false, "requires-manual-review", null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "SUBSET_PREFIX_MISMATCH", "structure", e);
        }
    }

    // Check 20: CIDSET_INCOMPLETE
    private void checkCidSetIncomplete(FontInfo fi, PDDocument doc) {
        try {
            if (fi.pdFont == null) return;
            PDFontDescriptor desc = fi.pdFont.getFontDescriptor();
            if (desc == null) return;

            COSDictionary descDict = desc.getCOSObject();
            COSBase cidSet = descDict.getDictionaryObject(COSName.getPDFName("CIDSet"));
            if (cidSet == null) return;

            // Our proven fix: remove CIDSet entirely for PDF/A-2 and later
            COSBase resolved = cidSet;
            if (resolved instanceof COSObject) resolved = ((COSObject) resolved).getObject();
            if (resolved instanceof COSStream) {
                try (InputStream is = ((COSStream) resolved).createInputStream()) {
                    byte[] data = readAllBytes(is);
                    if (data.length == 0) {
                        fi.addFinding("CIDSET_INCOMPLETE", "structure", "error",
                            "CIDSet stream is empty",
                            false, "remove-cidset", null);
                        return;
                    }

                    // Count CIDs declared in CIDSet
                    int declaredCids = 0;
                    for (byte b : data) {
                        declaredCids += Integer.bitCount(b & 0xFF);
                    }

                    // Check if this looks incomplete (heuristic)
                    if (fi.pdFont instanceof PDType0Font) {
                        PDCIDFont cidFont = ((PDType0Font) fi.pdFont).getDescendantFont();
                        if (cidFont != null) {
                            // Compare against actual glyph count if possible
                            int estimatedGlyphs = estimateGlyphsUsed(cidFont);
                            if (estimatedGlyphs > 0 && declaredCids < estimatedGlyphs) {
                                // Apply repair: remove CIDSet
                                descDict.removeItem(COSName.getPDFName("CIDSet"));
                                Map<String, Object> details = new LinkedHashMap<>();
                                details.put("cidSetDeclared", declaredCids);
                                details.put("estimatedGlyphs", estimatedGlyphs);
                                fi.addFinding("CIDSET_INCOMPLETE", "structure", "error",
                                    "CIDSet declares " + declaredCids + " CIDs but font uses ~" +
                                    estimatedGlyphs + " glyphs. Removed CIDSet (proven fix).",
                                    true, "remove-cidset", details);
                                return;
                            }
                        }
                    }

                    // Still report if CIDSet exists (for awareness)
                    Map<String, Object> details = new LinkedHashMap<>();
                    details.put("cidSetSize", data.length);
                    details.put("declaredCids", declaredCids);
                    fi.addFinding("CIDSET_INCOMPLETE", "structure", "info",
                        "CIDSet present with " + declaredCids + " declared CIDs",
                        false, "none", details);

                } catch (IOException ioEx) {
                    fi.addFinding("CIDSET_INCOMPLETE", "structure", "error",
                        "CIDSet stream cannot be read: " + ioEx.getMessage(),
                        false, "remove-cidset", null);
                }
            }
        } catch (Exception e) {
            wrapCheckError(fi, "CIDSET_INCOMPLETE", "structure", e);
        }
    }

    private int estimateGlyphsUsed(PDCIDFont cidFont) {
        try {
            COSArray w = cidFont.getCOSObject().getCOSArray(COSName.W);
            if (w == null) return 0;
            int count = 0;
            for (int i = 0; i < w.size(); i++) {
                COSBase item = w.getObject(i);
                if (item instanceof COSArray) count += ((COSArray) item).size();
                else count++;
            }
            return count;
        } catch (Exception e) { return 0; }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CATEGORY 5: ACCESSIBILITY (4 checks)
    // ═══════════════════════════════════════════════════════════════════

    // Check 21: DA_FONT_NOT_IN_DR (document-level)
    private void checkDaFontNotInDr(PDDocument doc, Map<String, FontInfo> fontMap) {
        try {
            PDAcroForm acroForm = doc.getDocumentCatalog().getAcroForm();
            if (acroForm == null) return;

            PDResources dr = acroForm.getDefaultResources();
            Set<String> drFontNames = new HashSet<>();
            if (dr != null) {
                for (COSName name : dr.getFontNames()) {
                    drFontNames.add(name.getName());
                }
            }

            for (PDField field : acroForm.getFieldTree()) {
                try {
                    String da = field.getCOSObject().getString(COSName.DA);
                    if (da == null) continue;

                    // Parse DA for font references: e.g., "/Helv 12 Tf"
                    String[] tokens = da.split("\\s+");
                    for (int i = 0; i < tokens.length - 1; i++) {
                        if ("Tf".equals(tokens[i + 1]) || "Tf".equals(tokens[Math.min(i + 2, tokens.length - 1)])) {
                            if (tokens[i].startsWith("/")) {
                                String fontName = tokens[i].substring(1);
                                if (!drFontNames.contains(fontName)) {
                                    // Add finding to a synthetic font entry or first font
                                    String key = "ACROFORM|" + fontName;
                                    FontInfo fi = fontMap.get(key);
                                    if (fi == null) {
                                        fi = new FontInfo();
                                        fi.fontKey = fontName;
                                        fi.baseFont = fontName;
                                        fi.subtype = "AcroFormRef";
                                        fi.embedded = false;
                                        fi.encoding = "unknown";
                                        fontMap.put(key, fi);
                                    }
                                    Map<String, Object> details = new LinkedHashMap<>();
                                    details.put("fieldName", field.getFullyQualifiedName());
                                    details.put("daString", da);
                                    details.put("drFonts", new ArrayList<>(drFontNames));
                                    fi.addFinding("DA_FONT_NOT_IN_DR", "accessibility", "error",
                                        "AcroForm field '" + field.getFullyQualifiedName() +
                                        "' /DA references font '/" + fontName +
                                        "' not found in /AcroForm/DR/Font",
                                        false, "requires-manual-review", details);
                                }
                            }
                        }
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            // AcroForm check failed -- non-fatal
            System.err.println("WARNING: AcroForm DA check failed: " + e.getMessage());
        }
    }

    // Check 22: FONT_NOT_IN_RESOURCES (document-level)
    private void checkFontNotInResources(PDDocument doc, Map<String, FontInfo> fontMap) {
        try {
            for (int p = 0; p < doc.getNumberOfPages(); p++) {
                PDPage page = doc.getPage(p);
                PDResources resources = page.getResources();
                Set<String> resourceFonts = new HashSet<>();
                if (resources != null) {
                    for (COSName name : resources.getFontNames()) {
                        resourceFonts.add(name.getName());
                    }
                }

                // Parse content stream to find Tf operators
                try {
                    COSBase contents = page.getCOSObject().getDictionaryObject(COSName.CONTENTS);
                    if (contents == null) continue;

                    // Simple text scan of the content stream for /FontName ... Tf patterns
                    byte[] streamData = getContentStreamBytes(contents);
                    if (streamData == null) continue;
                    String streamText = new String(streamData, StandardCharsets.ISO_8859_1);

                    // Find font references
                    int idx = 0;
                    while ((idx = streamText.indexOf("Tf", idx)) != -1) {
                        // Look backwards for /FontName
                        int searchStart = Math.max(0, idx - 100);
                        String before = streamText.substring(searchStart, idx);
                        int slashIdx = before.lastIndexOf('/');
                        if (slashIdx >= 0) {
                            String rest = before.substring(slashIdx + 1).trim();
                            String[] parts = rest.split("\\s+");
                            if (parts.length > 0) {
                                String fontName = parts[0];
                                if (!fontName.isEmpty() && !resourceFonts.contains(fontName)) {
                                    String key = "MISSING_RES|" + fontName + "|p" + (p + 1);
                                    if (!fontMap.containsKey(key)) {
                                        FontInfo fi = fontMap.get(key);
                                        if (fi == null) {
                                            fi = new FontInfo();
                                            fi.fontKey = fontName;
                                            fi.baseFont = fontName;
                                            fi.subtype = "Unknown";
                                            fi.embedded = false;
                                            fi.encoding = "unknown";
                                            fi.pages.add(p + 1);
                                            fontMap.put(key, fi);
                                        }
                                        Map<String, Object> details = new LinkedHashMap<>();
                                        details.put("page", p + 1);
                                        details.put("registeredFonts", new ArrayList<>(resourceFonts));
                                        fi.addFinding("FONT_NOT_IN_RESOURCES", "accessibility", "error",
                                            "Content stream on page " + (p + 1) + " uses font '/" +
                                            fontName + "' not registered in page /Resources/Font",
                                            false, "requires-manual-review", details);
                                    }
                                }
                            }
                        }
                        idx += 2;
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            System.err.println("WARNING: Font-in-resources check failed: " + e.getMessage());
        }
    }

    // Check 23: TYPE3_FONT_FOUND
    private void checkType3FontFound(FontInfo fi) {
        try {
            if (fi.pdFont == null) return;
            if (fi.pdFont instanceof PDType3Font) {
                fi.addFinding("TYPE3_FONT_FOUND", "accessibility", "warning",
                    "Type3 font '" + fi.baseFont + "' detected. Type3 fonts are not searchable " +
                    "or accessible. Consider replacing with an outline font.",
                    false, "requires-font-replacement", null);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "TYPE3_FONT_FOUND", "accessibility", e);
        }
    }

    // Check 24: FONT_LANGUAGE_MISMATCH
    private void checkFontLanguageMismatch(FontInfo fi, PDDocument doc) {
        try {
            if (fi.pdFont == null || !fi.embedded) return;

            // Get document language
            String docLang = null;
            try {
                COSDictionary catalog = doc.getDocumentCatalog().getCOSObject();
                docLang = catalog.getString(COSName.LANG);
            } catch (Exception ignored) {}
            if (docLang == null || docLang.isEmpty()) return;

            // Determine script from lang tag
            String langLower = docLang.toLowerCase();
            String expectedScript = "Latin"; // default
            if (langLower.startsWith("zh") || langLower.startsWith("ja") || langLower.startsWith("ko")) {
                expectedScript = "CJK";
            } else if (langLower.startsWith("ar") || langLower.startsWith("he") || langLower.startsWith("fa")) {
                expectedScript = "RTL";
            } else if (langLower.startsWith("hi") || langLower.startsWith("bn") || langLower.startsWith("ta")) {
                expectedScript = "Indic";
            }

            // Check font name for script hints
            String fontNameLower = fi.baseFont.toLowerCase();
            boolean mismatch = false;
            if ("CJK".equals(expectedScript) && !fontNameLower.matches(".*(cjk|jp|cn|kr|gothic|ming|song|hei|kai).*")) {
                // CJK doc but font doesn't look CJK -- only flag if it's a simple Type1
                if ("Type1".equals(fi.subtype)) mismatch = true;
            }
            if ("RTL".equals(expectedScript) && !fontNameLower.matches(".*(arab|hebrew|naskh|kufi).*")) {
                if ("Type1".equals(fi.subtype)) mismatch = true;
            }

            if (mismatch) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("documentLanguage", docLang);
                details.put("expectedScript", expectedScript);
                details.put("fontName", fi.baseFont);
                fi.addFinding("FONT_LANGUAGE_MISMATCH", "accessibility", "info",
                    "Document language '" + docLang + "' implies " + expectedScript +
                    " script but font '" + fi.baseFont + "' may not support it",
                    false, "informational", details);
            }
        } catch (Exception e) {
            wrapCheckError(fi, "FONT_LANGUAGE_MISMATCH", "accessibility", e);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════

    private void wrapCheckError(FontInfo fi, String checkId, String category, Exception e) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("internalError", e.getClass().getSimpleName() + ": " + e.getMessage());
        if (fi != null) {
            fi.addFinding(checkId, category, "info",
                "Check '" + checkId + "' could not complete: " + e.getMessage(),
                false, "none", details);
        }
    }

    private String stripSubsetPrefix(String name) {
        if (name != null && name.length() > 7 && name.charAt(6) == '+'
            && name.substring(0, 6).matches("[A-Z]{6}")) {
            return name.substring(7);
        }
        return name;
    }

    private float getFloat(COSArray arr, int idx) {
        try {
            COSBase b = arr.getObject(idx);
            if (b instanceof COSNumber) return ((COSNumber) b).floatValue();
        } catch (Exception ignored) {}
        return 0;
    }

    private byte[] readAllBytes(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int read;
        while ((read = is.read(buf)) != -1) baos.write(buf, 0, read);
        return baos.toByteArray();
    }

    private byte[] getContentStreamBytes(COSBase contents) {
        try {
            if (contents instanceof COSObject) contents = ((COSObject) contents).getObject();
            if (contents instanceof COSStream) {
                try (InputStream is = ((COSStream) contents).createInputStream()) {
                    return readAllBytes(is);
                }
            }
            if (contents instanceof COSArray) {
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                COSArray arr = (COSArray) contents;
                for (int i = 0; i < arr.size(); i++) {
                    COSBase item = arr.getObject(i);
                    if (item instanceof COSObject) item = ((COSObject) item).getObject();
                    if (item instanceof COSStream) {
                        try (InputStream is = ((COSStream) item).createInputStream()) {
                            byte[] data = readAllBytes(is);
                            baos.write(data);
                            baos.write(' ');
                        }
                    }
                }
                return baos.toByteArray();
            }
        } catch (Exception ignored) {}
        return null;
    }

    private String buildToUnicodeFromDifferences(COSArray diffs) {
        StringBuilder bfChars = new StringBuilder();
        int code = 0;
        int count = 0;

        for (int i = 0; i < diffs.size(); i++) {
            COSBase item = diffs.getObject(i);
            if (item instanceof COSNumber) {
                code = ((COSNumber) item).intValue();
            } else if (item instanceof COSName) {
                String glyphName = ((COSName) item).getName();
                String unicode = ADOBE_GLYPH_LIST.get(glyphName);
                if (unicode != null) {
                    bfChars.append(String.format("<%02X> <%s>\n", code, unicode));
                    count++;
                }
                code++;
            }
        }

        if (count == 0) return null;

        StringBuilder cmap = new StringBuilder();
        cmap.append("/CIDInit /ProcSet findresource begin\n");
        cmap.append("12 dict begin\n");
        cmap.append("begincmap\n");
        cmap.append("/CIDSystemInfo\n");
        cmap.append("<< /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n");
        cmap.append("/CMapName /Adobe-Identity-UCS def\n");
        cmap.append("/CMapType 2 def\n");
        cmap.append("1 begincodespacerange\n");
        cmap.append("<00> <FF>\n");
        cmap.append("endcodespacerange\n");

        // Split into chunks of 100 (PDF spec limit)
        String[] lines = bfChars.toString().split("\n");
        for (int i = 0; i < lines.length; i += 100) {
            int chunkSize = Math.min(100, lines.length - i);
            cmap.append(chunkSize).append(" beginbfchar\n");
            for (int j = i; j < i + chunkSize; j++) {
                cmap.append(lines[j]).append("\n");
            }
            cmap.append("endbfchar\n");
        }

        cmap.append("endcmap\n");
        cmap.append("CMapName currentdict /CMap defineresource pop\n");
        cmap.append("end\n");
        cmap.append("end\n");

        return cmap.toString();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  JSON Report Builder (hand-rolled, no external deps)
    // ═══════════════════════════════════════════════════════════════════

    private String buildJsonReport(String docPath, Map<String, FontInfo> fontMap, boolean repairsApplied) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"documentPath\": ").append(jsonString(docPath)).append(",\n");
        sb.append("  \"fontCount\": ").append(fontMap.size()).append(",\n");

        // fonts array
        sb.append("  \"fonts\": [\n");
        int fi_idx = 0;
        int totalErrors = 0, totalWarnings = 0, totalInfos = 0, totalFindings = 0;
        int healthyFonts = 0, damagedFonts = 0, repairsCount = 0;
        double scoreSum = 0;

        for (FontInfo fi : fontMap.values()) {
            if (fi_idx > 0) sb.append(",\n");
            sb.append("    {\n");
            sb.append("      \"fontKey\": ").append(jsonString(fi.fontKey)).append(",\n");
            sb.append("      \"baseFont\": ").append(jsonString(fi.baseFont)).append(",\n");
            sb.append("      \"subtype\": ").append(jsonString(fi.subtype)).append(",\n");
            sb.append("      \"embedded\": ").append(fi.embedded).append(",\n");
            sb.append("      \"encoding\": ").append(jsonString(fi.encoding)).append(",\n");
            sb.append("      \"pages\": ").append(jsonIntList(fi.pages)).append(",\n");
            sb.append("      \"glyphsUsed\": ").append(fi.glyphsUsed).append(",\n");

            // findings
            sb.append("      \"findings\": [\n");
            for (int f = 0; f < fi.findings.size(); f++) {
                if (f > 0) sb.append(",\n");
                sb.append("        ").append(jsonMap(fi.findings.get(f)));
            }
            sb.append("\n      ],\n");

            // health
            double clampedScore = Math.max(0, Math.min(1, fi.score));
            clampedScore = Math.round(clampedScore * 100.0) / 100.0;
            sb.append("      \"health\": {\n");
            sb.append("        \"score\": ").append(clampedScore).append(",\n");
            sb.append("        \"grade\": ").append(jsonString(fi.grade())).append(",\n");
            sb.append("        \"errorCount\": ").append(fi.errorCount).append(",\n");
            sb.append("        \"warningCount\": ").append(fi.warningCount).append(",\n");
            sb.append("        \"infoCount\": ").append(fi.infoCount).append("\n");
            sb.append("      }\n");
            sb.append("    }");

            totalErrors += fi.errorCount;
            totalWarnings += fi.warningCount;
            totalInfos += fi.infoCount;
            totalFindings += fi.findings.size();
            scoreSum += clampedScore;
            if (fi.errorCount == 0 && fi.warningCount == 0) healthyFonts++;
            else damagedFonts++;
            for (Map<String, Object> finding : fi.findings) {
                if (Boolean.TRUE.equals(finding.get("repaired"))) repairsCount++;
            }
            fi_idx++;
        }
        sb.append("\n  ],\n");

        // summary
        double overallHealth = fontMap.isEmpty() ? 1.0 : Math.round((scoreSum / fontMap.size()) * 100.0) / 100.0;
        String overallGrade;
        if (overallHealth >= 0.9) overallGrade = "A";
        else if (overallHealth >= 0.75) overallGrade = "B";
        else if (overallHealth >= 0.6) overallGrade = "C";
        else if (overallHealth >= 0.4) overallGrade = "D";
        else overallGrade = "F";

        sb.append("  \"summary\": {\n");
        sb.append("    \"totalFonts\": ").append(fontMap.size()).append(",\n");
        sb.append("    \"healthyFonts\": ").append(healthyFonts).append(",\n");
        sb.append("    \"damagedFonts\": ").append(damagedFonts).append(",\n");
        sb.append("    \"totalFindings\": ").append(totalFindings).append(",\n");
        sb.append("    \"errorFindings\": ").append(totalErrors).append(",\n");
        sb.append("    \"warningFindings\": ").append(totalWarnings).append(",\n");
        sb.append("    \"infoFindings\": ").append(totalInfos).append(",\n");
        sb.append("    \"repairsApplied\": ").append(repairsCount).append(",\n");
        sb.append("    \"overallFontHealth\": ").append(overallHealth).append(",\n");
        sb.append("    \"overallGrade\": ").append(jsonString(overallGrade)).append("\n");
        sb.append("  },\n");
        sb.append("  \"repairsApplied\": ").append(repairsApplied).append("\n");
        sb.append("}\n");

        return sb.toString();
    }

    // ── JSON serialization helpers ──────────────────────────────────────

    private String jsonString(String s) {
        if (s == null) return "null";
        return "\"" + escapeJson(s) + "\"";
    }

    static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    private String jsonIntList(Set<Integer> set) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (int v : set) {
            if (!first) sb.append(", ");
            sb.append(v);
            first = false;
        }
        sb.append("]");
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private String jsonMap(Map<String, Object> map) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(", ");
            sb.append(jsonString(e.getKey())).append(": ");
            sb.append(jsonValue(e.getValue()));
            first = false;
        }
        sb.append("}");
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private String jsonValue(Object val) {
        if (val == null) return "null";
        if (val instanceof Boolean) return val.toString();
        if (val instanceof Number) return val.toString();
        if (val instanceof String) return jsonString((String) val);
        if (val instanceof Map) return jsonMap((Map<String, Object>) val);
        if (val instanceof List) {
            List<?> list = (List<?>) val;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(jsonValue(list.get(i)));
            }
            sb.append("]");
            return sb.toString();
        }
        return jsonString(val.toString());
    }
}
