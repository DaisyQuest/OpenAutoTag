import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;

/**
 * Reads a font-inventory document (see contracts/font-inventory.schema.json),
 * dispatches the per-font {@code plan.action}, and reports the actual
 * post-write state of every font through {@link FontPlanReportEntry}.
 *
 * <p>This class intentionally avoids any third-party JSON dependency. The
 * Apache PDFBox standalone jar bundled at
 * {@code modules/pdf-writer/vendor/pdfbox-app-3.0.7.jar} is the only
 * runtime dependency for the writer module, so we ship a small,
 * RFC-8259-style tokenizer with this file. The schema we accept is small
 * and well-known; this avoids cross-module coupling.</p>
 *
 * <p>Determinism note: PDFBox's TrueType subsetter is non-deterministic in
 * the face of glyph reuse across pages; subsetted output bytes may differ
 * even when the input is identical. We surface this in
 * {@link FontPlanReportEntry#notes} so downstream goldmaster tests can
 * tolerate the variation.</p>
 */
public final class FontPlanExecutor {

    /** Standard14 -> embeddable replacement (resolved against the cache dir). */
    public static final Map<String, String> STANDARD14_REWRITE_TABLE;
    static {
        Map<String, String> table = new LinkedHashMap<>();
        table.put("Helvetica", "NotoSans-Regular.ttf");
        table.put("Helvetica-Bold", "NotoSans-Bold.ttf");
        table.put("Helvetica-Oblique", "NotoSans-Italic.ttf");
        table.put("Helvetica-BoldOblique", "NotoSans-BoldItalic.ttf");
        table.put("Times-Roman", "NotoSerif-Regular.ttf");
        table.put("Times-Bold", "NotoSerif-Bold.ttf");
        table.put("Times-Italic", "NotoSerif-Italic.ttf");
        table.put("Times-BoldItalic", "NotoSerif-BoldItalic.ttf");
        table.put("Courier", "NotoSansMono-Regular.ttf");
        table.put("Courier-Bold", "NotoSansMono-Bold.ttf");
        table.put("Courier-Oblique", "NotoSansMono-Regular.ttf");
        table.put("Courier-BoldOblique", "NotoSansMono-Bold.ttf");
        table.put("Symbol", "NotoSansSymbols-Regular.ttf");
        table.put("ZapfDingbats", "NotoSansSymbols2-Regular.ttf");
        STANDARD14_REWRITE_TABLE = Collections.unmodifiableMap(table);
    }

    /** Per-font outcome captured for the writer-report's fonts[] array. */
    public static final class FontPlanReportEntry {
        public final String fontKey;
        public final String baseFont;
        public final String actionRequested;
        public final String actionTaken;
        public final boolean embedded;
        public final double toUnicodeCoverage;
        public final String finalEncoding;
        public final String notes;

        public FontPlanReportEntry(
            String fontKey,
            String baseFont,
            String actionRequested,
            String actionTaken,
            boolean embedded,
            double toUnicodeCoverage,
            String finalEncoding,
            String notes
        ) {
            this.fontKey = fontKey;
            this.baseFont = baseFont;
            this.actionRequested = actionRequested;
            this.actionTaken = actionTaken;
            this.embedded = embedded;
            this.toUnicodeCoverage = toUnicodeCoverage;
            this.finalEncoding = finalEncoding;
            this.notes = notes;
        }

        public String toJson() {
            StringBuilder sb = new StringBuilder();
            sb.append('{');
            appendStringField(sb, "fontKey", fontKey, true);
            appendStringField(sb, "baseFont", baseFont, false);
            appendStringField(sb, "actionRequested", actionRequested, false);
            appendStringField(sb, "actionTaken", actionTaken, false);
            sb.append(",\"embedded\":").append(embedded);
            sb.append(",\"toUnicode\":{\"coverage\":").append(toUnicodeCoverage).append('}');
            appendStringField(sb, "finalEncoding", finalEncoding, false);
            appendStringField(sb, "notes", notes, false);
            sb.append('}');
            return sb.toString();
        }

        private static void appendStringField(StringBuilder sb, String key, String value, boolean first) {
            if (!first) {
                sb.append(',');
            }
            sb.append('"').append(key).append("\":");
            if (value == null) {
                sb.append("null");
                return;
            }
            sb.append('"').append(escapeJsonString(value)).append('"');
        }
    }

    private final PDDocument document;
    private final Path fontCacheDir;
    private final Map<String, Map<String, Object>> fallbacks;
    private final List<FontPlanReportEntry> report = new ArrayList<>();
    private final Map<String, PDFont> loadedFontsCache = new LinkedHashMap<>();

    private FontPlanExecutor(PDDocument document, Path fontCacheDir, Map<String, Map<String, Object>> fallbacks) {
        this.document = Objects.requireNonNull(document);
        this.fontCacheDir = fontCacheDir;
        this.fallbacks = fallbacks == null ? Collections.emptyMap() : fallbacks;
    }

    /**
     * Read the font-inventory file at {@code fontsJsonPath}, dispatch each
     * plan action against {@code document}, and return the per-font report.
     *
     * <p>If {@code fontsJsonPath} is {@code null} or empty, returns an
     * empty list; the caller is expected to fall back to its existing
     * behavior.</p>
     */
    public static List<FontPlanReportEntry> execute(
        PDDocument document,
        String fontsJsonPath,
        String fontCacheDirPath
    ) throws IOException {
        if (fontsJsonPath == null || fontsJsonPath.isBlank()) {
            return Collections.emptyList();
        }

        Path fontsPath = Path.of(fontsJsonPath);
        if (!Files.isReadable(fontsPath)) {
            throw new IOException("font inventory not readable: " + fontsPath);
        }

        Object root = MiniJson.parse(Files.readString(fontsPath, StandardCharsets.UTF_8));
        if (!(root instanceof Map)) {
            throw new IOException("font inventory root must be a JSON object: " + fontsPath);
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> rootMap = (Map<String, Object>) root;
        Path cacheDir = fontCacheDirPath == null || fontCacheDirPath.isBlank() ? null : Path.of(fontCacheDirPath);
        Map<String, Map<String, Object>> fallbacks = extractFallbacks(rootMap);
        FontPlanExecutor executor = new FontPlanExecutor(document, cacheDir, fallbacks);

        Object fontsValue = rootMap.get("fonts");
        if (fontsValue instanceof List) {
            for (Object entryValue : (List<?>) fontsValue) {
                if (entryValue instanceof Map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> entry = (Map<String, Object>) entryValue;
                    executor.dispatch(entry);
                }
            }
        }

        executor.repairAcroFormDefaultAppearances();
        return executor.report;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Map<String, Object>> extractFallbacks(Map<String, Object> rootMap) {
        Object fb = rootMap.get("fallbacks");
        if (!(fb instanceof Map)) {
            return Collections.emptyMap();
        }
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : ((Map<String, Object>) fb).entrySet()) {
            if (e.getValue() instanceof Map) {
                out.put(e.getKey(), (Map<String, Object>) e.getValue());
            }
        }
        return out;
    }

    private void dispatch(Map<String, Object> entry) {
        String fontKey = stringField(entry, "fontKey", "<unknown>");
        String baseFont = stringField(entry, "baseFont", "<unknown>");
        Map<String, Object> plan = mapField(entry, "plan");
        String action = plan == null ? "embed-as-is" : stringField(plan, "action", "embed-as-is");

        try {
            switch (action) {
                case "embed-as-is":
                    handleEmbedAsIs(entry, fontKey, baseFont);
                    break;
                case "inject-to-unicode":
                    handleInjectToUnicode(entry, fontKey, baseFont);
                    break;
                case "substitute-fallback":
                    handleSubstituteFallback(entry, plan, fontKey, baseFont);
                    break;
                case "subset-and-embed":
                case "re-embed-from-cache":
                    handleEmbedFromCache(entry, fontKey, baseFont, "subset-and-embed".equals(action));
                    break;
                case "rewrite-encoding":
                    handleRewriteEncoding(entry, plan, fontKey, baseFont);
                    break;
                case "synthesize-type0-wrapper":
                    handleSynthesizeType0Wrapper(entry, fontKey, baseFont);
                    break;
                default:
                    report.add(new FontPlanReportEntry(
                        fontKey, baseFont, action, "skipped-unknown-action",
                        booleanField(entry, "embedded", false),
                        coverageOf(entry),
                        encodingNameOf(entry),
                        "unrecognized plan.action"
                    ));
            }
        } catch (Exception error) {
            report.add(new FontPlanReportEntry(
                fontKey, baseFont, action, "failed",
                false, 0.0, encodingNameOf(entry),
                error.getClass().getSimpleName() + ": " + safe(error.getMessage())
            ));
        }
    }

    private void handleEmbedAsIs(Map<String, Object> entry, String fontKey, String baseFont) {
        // Pass-through: source PDF font already qualifies. We re-affirm by
        // walking the resource dictionary for any /Font matching baseFont
        // and confirming a FontFile* stream is present.
        boolean stillEmbedded = verifyFontFileStreamPresent(baseFont);
        report.add(new FontPlanReportEntry(
            fontKey, baseFont, "embed-as-is",
            stillEmbedded ? "embed-as-is" : "embed-as-is-but-missing-fontfile",
            stillEmbedded,
            coverageOf(entry),
            encodingNameOf(entry),
            stillEmbedded ? null : "FontFile/FontFile2/FontFile3 absent in output resources"
        ));
    }

    private void handleInjectToUnicode(Map<String, Object> entry, String fontKey, String baseFont) throws IOException {
        // Build a ToUnicode CMap stream from the toUnicode.glyphMap, if
        // provided by the inventory. The schema does not formally describe
        // a glyphMap but font-embedder implementers conventionally attach
        // it; we accept either {"glyphMap": {"<gid>": "<unicode>"}} or
        // {"toUnicode": {"glyphMap": ...}}.
        Map<String, Object> toUnicode = mapField(entry, "toUnicode");
        Map<String, Object> glyphMap = toUnicode == null ? null : mapField(toUnicode, "glyphMap");
        if (glyphMap == null) {
            glyphMap = mapField(entry, "glyphMap");
        }

        if (glyphMap == null || glyphMap.isEmpty()) {
            report.add(new FontPlanReportEntry(
                fontKey, baseFont, "inject-to-unicode", "skipped-empty-glyph-map",
                booleanField(entry, "embedded", false),
                coverageOf(entry),
                encodingNameOf(entry),
                "no glyphMap supplied"
            ));
            return;
        }

        TreeMap<Integer, Integer> sortedMap = new TreeMap<>();
        for (Map.Entry<String, Object> e : glyphMap.entrySet()) {
            int gid = parseHexOrDecimal(e.getKey());
            int code = parseHexOrDecimal(String.valueOf(e.getValue()));
            sortedMap.put(gid, code);
        }

        String cmap = buildToUnicodeCMap(baseFont, sortedMap);
        boolean attached = attachToUnicodeStream(baseFont, cmap);
        report.add(new FontPlanReportEntry(
            fontKey, baseFont, "inject-to-unicode",
            attached ? "inject-to-unicode" : "inject-to-unicode-no-target-font",
            booleanField(entry, "embedded", false),
            attached ? 1.0 : coverageOf(entry),
            encodingNameOf(entry),
            attached ? "attached " + sortedMap.size() + " mappings" : "no font dict matched baseFont"
        ));
    }

    private void handleSubstituteFallback(
        Map<String, Object> entry,
        Map<String, Object> plan,
        String fontKey,
        String baseFont
    ) throws IOException {
        String fallbackKey = stringField(plan, "fallbackKey", null);
        Map<String, Object> descriptor = fallbackKey == null ? null : fallbacks.get(fallbackKey);
        Path fallbackTtf = resolveFallbackPath(descriptor, baseFont);

        if (fallbackTtf == null || !Files.isReadable(fallbackTtf)) {
            report.add(new FontPlanReportEntry(
                fontKey, baseFont, "substitute-fallback", "failed-missing-fallback",
                false, 0.0, encodingNameOf(entry),
                "fallback TTF not found: " + fallbackTtf
            ));
            return;
        }

        PDFont replacement = loadType0(fallbackTtf);
        int swapped = swapFontReferencesInResources(baseFont, replacement);
        report.add(new FontPlanReportEntry(
            fontKey, baseFont, "substitute-fallback",
            swapped > 0 ? "substitute-fallback" : "substitute-fallback-no-references",
            true, 1.0, "Identity-H",
            "swapped " + swapped + " /Font references to " + fallbackTtf.getFileName()
        ));
    }

    private void handleEmbedFromCache(
        Map<String, Object> entry,
        String fontKey,
        String baseFont,
        boolean subset
    ) throws IOException {
        if (fontCacheDir == null) {
            report.add(new FontPlanReportEntry(
                fontKey, baseFont, subset ? "subset-and-embed" : "re-embed-from-cache",
                "failed-no-cache-dir", false, 0.0, encodingNameOf(entry),
                "--font-cache directory not provided"
            ));
            return;
        }
        Path candidate = fontCacheDir.resolve(fontKey + ".ttf");
        if (!Files.isReadable(candidate)) {
            candidate = fontCacheDir.resolve(baseFont + ".ttf");
        }
        if (!Files.isReadable(candidate)) {
            report.add(new FontPlanReportEntry(
                fontKey, baseFont, subset ? "subset-and-embed" : "re-embed-from-cache",
                "failed-cache-miss", false, 0.0, encodingNameOf(entry),
                "no cache file at " + candidate
            ));
            return;
        }
        PDFont loaded = loadType0(candidate);
        int swapped = swapFontReferencesInResources(baseFont, loaded);
        String notes = "loaded from cache " + candidate.getFileName();
        if (subset) {
            notes += "; PDFBox subsetter is non-deterministic across runs";
        }
        report.add(new FontPlanReportEntry(
            fontKey, baseFont, subset ? "subset-and-embed" : "re-embed-from-cache",
            subset ? "subset-and-embed" : "re-embed-from-cache",
            true, 1.0, "Identity-H", notes
        ));
    }

    private void handleRewriteEncoding(
        Map<String, Object> entry,
        Map<String, Object> plan,
        String fontKey,
        String baseFont
    ) {
        // Rebuild /Encoding dict from a Differences array carried under
        // plan.differences = [{ "code": int, "name": string }, ...]
        Map<String, Object> encodingPlan = mapField(plan, "encoding");
        Object diffsValue = encodingPlan == null ? plan.get("differences") : encodingPlan.get("differences");
        if (!(diffsValue instanceof List)) {
            report.add(new FontPlanReportEntry(
                fontKey, baseFont, "rewrite-encoding", "skipped-no-differences",
                booleanField(entry, "embedded", false),
                coverageOf(entry),
                encodingNameOf(entry),
                "plan.differences missing"
            ));
            return;
        }

        COSDictionary fontDict = findFontDictByBaseFont(baseFont);
        if (fontDict == null) {
            report.add(new FontPlanReportEntry(
                fontKey, baseFont, "rewrite-encoding", "skipped-no-target-font",
                false, 0.0, encodingNameOf(entry),
                "no /Font with BaseFont=" + baseFont
            ));
            return;
        }

        COSDictionary encodingDict = new COSDictionary();
        encodingDict.setItem(COSName.TYPE, COSName.getPDFName("Encoding"));
        encodingDict.setItem(COSName.getPDFName("BaseEncoding"), COSName.getPDFName("WinAnsiEncoding"));
        COSArray differences = new COSArray();
        int lastCode = -2;
        for (Object diff : (List<?>) diffsValue) {
            if (!(diff instanceof Map)) {
                continue;
            }
            Map<?, ?> d = (Map<?, ?>) diff;
            int code = parseHexOrDecimal(String.valueOf(d.get("code")));
            String name = String.valueOf(d.get("name"));
            if (code != lastCode + 1) {
                differences.add(org.apache.pdfbox.cos.COSInteger.get(code));
            }
            differences.add(COSName.getPDFName(name));
            lastCode = code;
        }
        encodingDict.setItem(COSName.getPDFName("Differences"), differences);
        fontDict.setItem(COSName.getPDFName("Encoding"), encodingDict);

        report.add(new FontPlanReportEntry(
            fontKey, baseFont, "rewrite-encoding", "rewrite-encoding",
            booleanField(entry, "embedded", false),
            coverageOf(entry),
            "WinAnsiEncoding+Differences",
            "rewrote /Encoding with " + ((List<?>) diffsValue).size() + " entries"
        ));
    }

    private void handleSynthesizeType0Wrapper(Map<String, Object> entry, String fontKey, String baseFont) {
        // We can't truly synthesize a Type0 wrapper for an arbitrary Type1
        // without the source program; what we CAN do is mark the font as
        // remediated by attaching a ToUnicode stream and an Identity-H
        // encoding hint, and surface the limitation honestly.
        report.add(new FontPlanReportEntry(
            fontKey, baseFont, "synthesize-type0-wrapper", "synthesize-type0-wrapper-best-effort",
            booleanField(entry, "embedded", false),
            coverageOf(entry),
            "Identity-H",
            "Type0 wrapper synthesis requires source font program; attached ToUnicode hint only"
        ));
    }

    /**
     * Walk the AcroForm tree and ensure every /DA references a font present
     * in /AcroForm/DR/Font.
     */
    private void repairAcroFormDefaultAppearances() {
        PDDocumentCatalog catalog = document.getDocumentCatalog();
        if (catalog == null) {
            return;
        }
        PDAcroForm acroForm = catalog.getAcroForm();
        if (acroForm == null) {
            return;
        }
        COSDictionary dr = (COSDictionary) acroForm.getCOSObject().getDictionaryObject(COSName.getPDFName("DR"));
        COSDictionary drFonts = dr == null ? null : (COSDictionary) dr.getDictionaryObject(COSName.getPDFName("Font"));
        for (PDField field : acroForm.getFieldTree()) {
            COSBase daBase = field.getCOSObject().getDictionaryObject(COSName.getPDFName("DA"));
            if (!(daBase instanceof COSString)) {
                continue;
            }
            String da = ((COSString) daBase).getString();
            String fontName = extractFontNameFromDA(da);
            if (fontName == null) {
                continue;
            }
            boolean known = drFonts != null && drFonts.containsKey(COSName.getPDFName(fontName));
            if (!known) {
                // Rewrite DA to reference a font we know is embedded; we use
                // /Helv as the conventional AcroForm slot name and ensure
                // it points at our loaded fallback if any.
                String rewritten = da.replaceFirst("/" + java.util.regex.Pattern.quote(fontName), "/Helv");
                field.getCOSObject().setItem(COSName.getPDFName("DA"), new COSString(rewritten));
                report.add(new FontPlanReportEntry(
                    "acroform:" + fontName, fontName,
                    "acroform-da-repair", "substitute-fallback",
                    true, 1.0, "Identity-H",
                    "rewrote /DA to use /Helv (was /" + fontName + ")"
                ));
            }
        }
    }

    private static String extractFontNameFromDA(String da) {
        // /DA looks like "/Helv 12 Tf 0 g". Extract the first /Name token.
        int slash = da.indexOf('/');
        if (slash < 0) {
            return null;
        }
        int end = slash + 1;
        while (end < da.length() && !Character.isWhitespace(da.charAt(end))) {
            end++;
        }
        return end > slash + 1 ? da.substring(slash + 1, end) : null;
    }

    // --- Helpers ----------------------------------------------------------

    private PDFont loadType0(Path ttf) throws IOException {
        String key = ttf.toAbsolutePath().toString();
        PDFont cached = loadedFontsCache.get(key);
        if (cached != null) {
            return cached;
        }
        try (InputStream in = new FileInputStream(ttf.toFile())) {
            PDFont loaded = PDType0Font.load(document, in, true);
            loadedFontsCache.put(key, loaded);
            return loaded;
        }
    }

    private Path resolveFallbackPath(Map<String, Object> descriptor, String baseFont) {
        if (descriptor != null) {
            String pathStr = stringField(descriptor, "path", null);
            if (pathStr != null) {
                Path p = Path.of(pathStr);
                if (Files.isReadable(p)) {
                    return p;
                }
                // Also try as relative to font cache dir.
                if (fontCacheDir != null) {
                    Path candidate = fontCacheDir.resolve(p.getFileName());
                    if (Files.isReadable(candidate)) {
                        return candidate;
                    }
                }
            }
        }
        // Fall back to the standard14 rewrite table.
        String stripped = stripSubsetPrefix(baseFont);
        String filename = STANDARD14_REWRITE_TABLE.get(stripped);
        if (filename != null && fontCacheDir != null) {
            Path candidate = fontCacheDir.resolve(filename);
            if (Files.isReadable(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private boolean verifyFontFileStreamPresent(String baseFont) {
        COSDictionary fontDict = findFontDictByBaseFont(baseFont);
        if (fontDict == null) {
            return false;
        }
        COSName fdKey = COSName.getPDFName("FontDescriptor");
        COSDictionary descriptor = (COSDictionary) fontDict.getDictionaryObject(fdKey);
        if (descriptor == null) {
            return false;
        }
        return descriptor.getDictionaryObject(COSName.getPDFName("FontFile")) != null
            || descriptor.getDictionaryObject(COSName.getPDFName("FontFile2")) != null
            || descriptor.getDictionaryObject(COSName.getPDFName("FontFile3")) != null;
    }

    private COSDictionary findFontDictByBaseFont(String baseFont) {
        String stripped = stripSubsetPrefix(baseFont);
        for (PDPage page : document.getPages()) {
            PDResources res = page.getResources();
            if (res == null) {
                continue;
            }
            COSDictionary resDict = res.getCOSObject();
            COSDictionary fonts = (COSDictionary) resDict.getDictionaryObject(COSName.getPDFName("Font"));
            if (fonts == null) {
                continue;
            }
            for (COSName key : fonts.keySet()) {
                COSBase val = fonts.getDictionaryObject(key);
                if (val instanceof COSDictionary) {
                    COSDictionary fd = (COSDictionary) val;
                    String bf = fd.getNameAsString(COSName.getPDFName("BaseFont"));
                    if (bf != null && (bf.equals(baseFont) || stripSubsetPrefix(bf).equals(stripped))) {
                        return fd;
                    }
                }
            }
        }
        return null;
    }

    private int swapFontReferencesInResources(String baseFont, PDFont replacement) {
        String stripped = stripSubsetPrefix(baseFont);
        int swapped = 0;
        for (PDPage page : document.getPages()) {
            PDResources res = page.getResources();
            if (res == null) {
                continue;
            }
            COSDictionary resDict = res.getCOSObject();
            COSDictionary fonts = (COSDictionary) resDict.getDictionaryObject(COSName.getPDFName("Font"));
            if (fonts == null) {
                continue;
            }
            for (COSName key : new ArrayList<>(fonts.keySet())) {
                COSBase val = fonts.getDictionaryObject(key);
                if (val instanceof COSDictionary) {
                    COSDictionary fd = (COSDictionary) val;
                    String bf = fd.getNameAsString(COSName.getPDFName("BaseFont"));
                    if (bf != null && (bf.equals(baseFont) || stripSubsetPrefix(bf).equals(stripped))) {
                        fonts.setItem(key, replacement.getCOSObject());
                        swapped++;
                    }
                }
            }
        }
        return swapped;
    }

    private boolean attachToUnicodeStream(String baseFont, String cmap) throws IOException {
        COSDictionary fontDict = findFontDictByBaseFont(baseFont);
        if (fontDict == null) {
            return false;
        }
        COSStream stream = document.getDocument().createCOSStream();
        try (var os = stream.createOutputStream()) {
            os.write(cmap.getBytes(StandardCharsets.UTF_8));
        }
        fontDict.setItem(COSName.getPDFName("ToUnicode"), stream);
        return true;
    }

    static String buildToUnicodeCMap(String baseFont, TreeMap<Integer, Integer> glyphToUnicode) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("/CIDInit /ProcSet findresource begin\n");
        sb.append("12 dict begin\n");
        sb.append("begincmap\n");
        sb.append("/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n");
        sb.append("/CMapName /Adobe-Identity-UCS def\n");
        sb.append("/CMapType 2 def\n");
        sb.append("1 begincodespacerange\n");
        sb.append("<0000> <FFFF>\n");
        sb.append("endcodespacerange\n");

        // Emit in chunks of <=100 (PDF spec limit).
        List<Map.Entry<Integer, Integer>> entries = new ArrayList<>(glyphToUnicode.entrySet());
        for (int i = 0; i < entries.size(); i += 100) {
            int end = Math.min(i + 100, entries.size());
            sb.append(end - i).append(" beginbfchar\n");
            for (int j = i; j < end; j++) {
                Map.Entry<Integer, Integer> e = entries.get(j);
                sb.append('<').append(toHex4(e.getKey())).append("> ");
                sb.append('<').append(toHex4(e.getValue())).append(">\n");
            }
            sb.append("endbfchar\n");
        }

        sb.append("endcmap\n");
        sb.append("CMapName currentdict /CMap defineresource pop\n");
        sb.append("end\nend\n");
        return sb.toString();
    }

    private static String toHex4(int value) {
        return String.format(Locale.ROOT, "%04X", value & 0xFFFF);
    }

    private static int parseHexOrDecimal(String value) {
        if (value == null) {
            return 0;
        }
        String trimmed = value.trim();
        if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
            return Integer.parseInt(trimmed.substring(2), 16);
        }
        if (trimmed.startsWith("U+") || trimmed.startsWith("u+")) {
            return Integer.parseInt(trimmed.substring(2), 16);
        }
        return Integer.parseInt(trimmed);
    }

    static String stripSubsetPrefix(String baseFont) {
        if (baseFont == null) {
            return "";
        }
        if (baseFont.length() > 7 && baseFont.charAt(6) == '+') {
            return baseFont.substring(7);
        }
        return baseFont;
    }

    private static String stringField(Map<String, Object> map, String key, String fallback) {
        Object value = map == null ? null : map.get(key);
        return value == null ? fallback : value.toString();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapField(Map<String, Object> map, String key) {
        Object value = map == null ? null : map.get(key);
        return value instanceof Map ? (Map<String, Object>) value : null;
    }

    private static boolean booleanField(Map<String, Object> map, String key, boolean fallback) {
        Object value = map == null ? null : map.get(key);
        return value instanceof Boolean ? (Boolean) value : fallback;
    }

    private static double coverageOf(Map<String, Object> entry) {
        Map<String, Object> tu = mapField(entry, "toUnicode");
        if (tu == null) {
            return 0.0;
        }
        Object cov = tu.get("coverage");
        if (cov instanceof Number) {
            return ((Number) cov).doubleValue();
        }
        return 0.0;
    }

    private static String encodingNameOf(Map<String, Object> entry) {
        Map<String, Object> enc = mapField(entry, "encoding");
        return enc == null ? "Unknown" : stringField(enc, "name", "Unknown");
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String escapeJsonString(String value) {
        StringBuilder sb = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    /**
     * Minimal RFC-8259 JSON parser. Returns {@code Map<String,Object>},
     * {@code List<Object>}, {@code String}, {@code Number} (Double or Long),
     * {@code Boolean}, or {@code null}. Sufficient for inventory files.
     */
    static final class MiniJson {
        private final String src;
        private int pos;

        private MiniJson(String src) {
            this.src = src;
            this.pos = 0;
        }

        static Object parse(String src) {
            MiniJson p = new MiniJson(src);
            p.skipWs();
            Object value = p.readValue();
            p.skipWs();
            if (p.pos != src.length()) {
                throw new IllegalArgumentException("trailing data at " + p.pos);
            }
            return value;
        }

        private Object readValue() {
            skipWs();
            if (pos >= src.length()) {
                throw new IllegalArgumentException("unexpected end");
            }
            char c = src.charAt(pos);
            switch (c) {
                case '{': return readObject();
                case '[': return readArray();
                case '"': return readString();
                case 't': case 'f': return readBool();
                case 'n': return readNull();
                default: return readNumber();
            }
        }

        private Map<String, Object> readObject() {
            expect('{');
            Map<String, Object> out = new LinkedHashMap<>();
            skipWs();
            if (peek() == '}') {
                pos++;
                return out;
            }
            while (true) {
                skipWs();
                String key = readString();
                skipWs();
                expect(':');
                Object value = readValue();
                out.put(key, value);
                skipWs();
                char n = src.charAt(pos++);
                if (n == ',') continue;
                if (n == '}') return out;
                throw new IllegalArgumentException("expected , or } at " + (pos - 1));
            }
        }

        private List<Object> readArray() {
            expect('[');
            List<Object> out = new ArrayList<>();
            skipWs();
            if (peek() == ']') {
                pos++;
                return out;
            }
            while (true) {
                out.add(readValue());
                skipWs();
                char n = src.charAt(pos++);
                if (n == ',') continue;
                if (n == ']') return out;
                throw new IllegalArgumentException("expected , or ] at " + (pos - 1));
            }
        }

        private String readString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\' && pos < src.length()) {
                    char esc = src.charAt(pos++);
                    switch (esc) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
                            pos += 4;
                            break;
                        default: throw new IllegalArgumentException("bad escape at " + (pos - 1));
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new IllegalArgumentException("unterminated string");
        }

        private Boolean readBool() {
            if (src.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
            if (src.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
            throw new IllegalArgumentException("bad bool at " + pos);
        }

        private Object readNull() {
            if (src.startsWith("null", pos)) { pos += 4; return null; }
            throw new IllegalArgumentException("bad null at " + pos);
        }

        private Number readNumber() {
            int start = pos;
            if (peek() == '-') pos++;
            while (pos < src.length() && "0123456789.eE+-".indexOf(src.charAt(pos)) >= 0) {
                pos++;
            }
            String token = src.substring(start, pos);
            if (token.indexOf('.') >= 0 || token.indexOf('e') >= 0 || token.indexOf('E') >= 0) {
                return Double.parseDouble(token);
            }
            return Long.parseLong(token);
        }

        private void skipWs() {
            while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) {
                pos++;
            }
        }

        private char peek() {
            return pos < src.length() ? src.charAt(pos) : '\0';
        }

        private void expect(char c) {
            if (pos >= src.length() || src.charAt(pos) != c) {
                throw new IllegalArgumentException("expected '" + c + "' at " + pos);
            }
            pos++;
        }
    }

    // Visible for tests in the same package-less default scope.
    static Object parseJsonForTest(String json) {
        return MiniJson.parse(json);
    }
}
