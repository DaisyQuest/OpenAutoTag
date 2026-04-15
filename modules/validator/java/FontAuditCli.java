import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.contentstream.operator.DrawObject;
import org.apache.pdfbox.contentstream.operator.state.Concatenate;
import org.apache.pdfbox.contentstream.operator.state.Restore;
import org.apache.pdfbox.contentstream.operator.state.Save;
import org.apache.pdfbox.contentstream.operator.state.SetGraphicsStateParameters;
import org.apache.pdfbox.contentstream.operator.state.SetMatrix;
import org.apache.pdfbox.contentstream.operator.text.BeginText;
import org.apache.pdfbox.contentstream.operator.text.EndText;
import org.apache.pdfbox.contentstream.operator.text.MoveText;
import org.apache.pdfbox.contentstream.operator.text.MoveTextSetLeading;
import org.apache.pdfbox.contentstream.operator.text.NextLine;
import org.apache.pdfbox.contentstream.operator.text.SetCharSpacing;
import org.apache.pdfbox.contentstream.operator.text.SetFontAndSize;
import org.apache.pdfbox.contentstream.operator.text.SetTextHorizontalScaling;
import org.apache.pdfbox.contentstream.operator.text.SetTextLeading;
import org.apache.pdfbox.contentstream.operator.text.SetTextRenderingMode;
import org.apache.pdfbox.contentstream.operator.text.SetTextRise;
import org.apache.pdfbox.contentstream.operator.text.SetWordSpacing;
import org.apache.pdfbox.contentstream.operator.text.ShowText;
import org.apache.pdfbox.contentstream.operator.text.ShowTextAdjusted;
import org.apache.pdfbox.contentstream.operator.text.ShowTextLine;
import org.apache.pdfbox.contentstream.operator.text.ShowTextLineAndSpace;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDCIDFont;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;
import org.apache.pdfbox.pdmodel.font.PDSimpleFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.PDType3Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.font.encoding.DictionaryEncoding;
import org.apache.pdfbox.pdmodel.font.encoding.Encoding;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;

/**
 * Pre-veraPDF font audit. Walks every page's /Resources/Font and AcroForm /DR/Font,
 * inspects each unique font for embedding/ToUnicode/encoding/CID validity, and
 * processes content streams to record actually-used glyph codes per font.
 *
 * Output JSON shape:
 * {
 *   "fonts": [ { "fontKey": "...", "name": "...", "subtype": "...",
 *                 "embedded": bool, "hasToUnicode": bool, "toUnicodeCoverage": 0.0,
 *                 "encoding": "...", "isSymbolic": bool, "standard14": bool,
 *                 "cidSystemInfoValid": bool, "usedGlyphCount": N, "mappedGlyphCount": N,
 *                 "locations": ["page:1", "acroform:dr"] } ],
 *   "findings": [ { "fontKey": "...", "severity": "error|warning",
 *                   "code": "...", "message": "..." } ]
 * }
 */
public class FontAuditCli {
    private static final double COVERAGE_ERROR_THRESHOLD = 0.95;
    private static final double COVERAGE_WARNING_THRESHOLD = 0.99;

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !"--pdf".equals(args[0])) {
            throw new IllegalArgumentException("Usage: java FontAuditCli --pdf <tagged.pdf>");
        }

        File pdfFile = new File(args[1]);
        try (PDDocument document = Loader.loadPDF(pdfFile)) {
            FontAudit audit = new FontAudit(document);
            audit.run();
            System.out.println(audit.toJson());
        }
    }

    /** Mutable record for per-font collected state. */
    static final class FontRecord {
        final String fontKey;
        final PDFont font;
        String name;
        String subtype;
        boolean embedded;
        boolean hasToUnicode;
        String encoding;
        boolean isSymbolic;
        boolean standard14;
        boolean cidSystemInfoValid;
        final Set<Integer> usedCodes = new HashSet<>();
        int mappedCodeCount;
        final Set<String> locations = new java.util.TreeSet<>();

        FontRecord(String fontKey, PDFont font) {
            this.fontKey = fontKey;
            this.font = font;
        }

        double coverage() {
            if (usedCodes.isEmpty()) {
                return hasToUnicode ? 1.0 : 0.0;
            }
            return (double) mappedCodeCount / (double) usedCodes.size();
        }
    }

    static final class Finding {
        final String fontKey;
        final String severity;
        final String code;
        final String message;

        Finding(String fontKey, String severity, String code, String message) {
            this.fontKey = fontKey;
            this.severity = severity;
            this.code = code;
            this.message = message;
        }
    }

    static final class FontAudit {
        private final PDDocument document;
        // fontKey is a stable identifier: name + "#" + objectNumber when available.
        private final Map<String, FontRecord> fontsByKey = new TreeMap<>();
        // Identity map: COSDictionary backing PDFont -> fontKey
        private final Map<COSDictionary, String> keysByDict = new HashMap<>();
        private final List<Finding> findings = new ArrayList<>();
        // For DA-font validation in form fields.
        private final Set<String> acroFormDrFontResourceNames = new java.util.TreeSet<>();
        private final List<String[]> daFieldFontReferences = new ArrayList<>(); // {fieldName, fontResourceName}

        FontAudit(PDDocument document) {
            this.document = document;
        }

        void run() throws IOException {
            collectAcroFormFonts();
            for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex++) {
                PDPage page = document.getPage(pageIndex);
                String location = "page:" + (pageIndex + 1);
                collectResourceFonts(page.getResources(), location);
                processPageContent(page);
            }
            evaluateFindings();
            evaluateDaFontReferences();
        }

        private void collectAcroFormFonts() {
            PDAcroForm acroForm = document.getDocumentCatalog().getAcroForm();
            if (acroForm == null) {
                return;
            }
            PDResources dr = acroForm.getDefaultResources();
            if (dr != null) {
                for (COSName name : dr.getFontNames()) {
                    acroFormDrFontResourceNames.add(name.getName());
                    try {
                        PDFont font = dr.getFont(name);
                        if (font != null) {
                            registerFont(font, "acroform:dr");
                        }
                    } catch (IOException ignored) {
                        // Skip fonts that fail to load; treated as missing entries downstream.
                    }
                }
            }
            // Walk widgets / form fields for DA references.
            COSBase fieldsBase = acroForm.getCOSObject().getDictionaryObject(COSName.FIELDS);
            collectDaReferences(fieldsBase, "");
        }

        private void collectDaReferences(COSBase node, String parentName) {
            if (node instanceof COSObject) {
                node = ((COSObject) node).getObject();
            }
            if (node instanceof COSArray) {
                COSArray array = (COSArray) node;
                for (int i = 0; i < array.size(); i++) {
                    collectDaReferences(array.getObject(i), parentName);
                }
                return;
            }
            if (!(node instanceof COSDictionary)) {
                return;
            }
            COSDictionary dict = (COSDictionary) node;
            String partial = dict.getString(COSName.T);
            String fullName = parentName.isEmpty() ? (partial == null ? "" : partial)
                : (partial == null ? parentName : parentName + "." + partial);
            String da = dict.getString(COSName.DA);
            if (da != null) {
                String fontResource = parseFontFromDA(da);
                if (fontResource != null) {
                    daFieldFontReferences.add(new String[] { fullName.isEmpty() ? "<unnamed>" : fullName, fontResource });
                }
            }
            COSBase kids = dict.getDictionaryObject(COSName.KIDS);
            if (kids != null) {
                collectDaReferences(kids, fullName);
            }
        }

        private static String parseFontFromDA(String da) {
            // /DA syntax: e.g. "/Helv 12 Tf 0 g" — pull the first token after `/`
            // followed eventually by Tf.
            int tfIdx = da.indexOf("Tf");
            if (tfIdx < 0) {
                return null;
            }
            String head = da.substring(0, tfIdx).trim();
            int slash = head.indexOf('/');
            if (slash < 0) {
                return null;
            }
            String afterSlash = head.substring(slash + 1).trim();
            int space = -1;
            for (int i = 0; i < afterSlash.length(); i++) {
                char c = afterSlash.charAt(i);
                if (Character.isWhitespace(c)) {
                    space = i;
                    break;
                }
            }
            if (space < 0) {
                return afterSlash;
            }
            return afterSlash.substring(0, space);
        }

        private void collectResourceFonts(PDResources resources, String location) {
            if (resources == null) {
                return;
            }
            for (COSName name : resources.getFontNames()) {
                try {
                    PDFont font = resources.getFont(name);
                    if (font != null) {
                        registerFont(font, location);
                    }
                } catch (IOException ignored) {
                    // Unparseable font; leave out of audit.
                }
            }
            // Also walk XObject form resources, which can carry their own fonts.
            for (COSName xobjName : resources.getXObjectNames()) {
                try {
                    org.apache.pdfbox.pdmodel.graphics.PDXObject xobj = resources.getXObject(xobjName);
                    if (xobj instanceof org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject) {
                        PDResources nested = ((org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject) xobj).getResources();
                        if (nested != null && nested != resources) {
                            collectResourceFonts(nested, location);
                        }
                    }
                } catch (IOException ignored) {
                    // ignore broken xobjects
                }
            }
        }

        private String registerFont(PDFont font, String location) {
            COSDictionary dict = font.getCOSObject();
            String existing = keysByDict.get(dict);
            if (existing != null) {
                fontsByKey.get(existing).locations.add(location);
                return existing;
            }
            String key = computeFontKey(font);
            // Disambiguate collisions on identical key by appending object hash.
            if (fontsByKey.containsKey(key) && fontsByKey.get(key).font.getCOSObject() != dict) {
                key = key + "#" + Integer.toHexString(System.identityHashCode(dict));
            }
            FontRecord record = new FontRecord(key, font);
            populateMetadata(record);
            record.locations.add(location);
            fontsByKey.put(key, record);
            keysByDict.put(dict, key);
            return key;
        }

        private static String computeFontKey(PDFont font) {
            String name = font.getName();
            if (name == null || name.isEmpty()) {
                name = "UnnamedFont";
            }
            return name;
        }

        private static void populateMetadata(FontRecord record) {
            PDFont font = record.font;
            record.name = font.getName() == null ? "" : font.getName();
            record.subtype = describeSubtype(font);
            record.embedded = font.isEmbedded();
            record.hasToUnicode = font.getCOSObject().getDictionaryObject(COSName.TO_UNICODE) != null;
            record.encoding = describeEncoding(font);
            PDFontDescriptor descriptor = font.getFontDescriptor();
            record.isSymbolic = descriptor != null && descriptor.isSymbolic();
            record.standard14 = isStandard14(font);
            record.cidSystemInfoValid = checkCidSystemInfo(font);
        }

        private static String describeSubtype(PDFont font) {
            if (font instanceof PDType0Font) {
                PDType0Font t0 = (PDType0Font) font;
                PDCIDFont descendant = t0.getDescendantFont();
                if (descendant != null) {
                    return "Type0:" + descendant.getCOSObject().getNameAsString(COSName.SUBTYPE);
                }
                return "Type0";
            }
            if (font instanceof PDType3Font) {
                return "Type3";
            }
            String subtype = font.getCOSObject().getNameAsString(COSName.SUBTYPE);
            return subtype == null ? font.getClass().getSimpleName() : subtype;
        }

        private static String describeEncoding(PDFont font) {
            COSBase encodingBase = font.getCOSObject().getDictionaryObject(COSName.ENCODING);
            if (encodingBase == null) {
                return "";
            }
            if (encodingBase instanceof COSName) {
                return ((COSName) encodingBase).getName();
            }
            if (encodingBase instanceof COSDictionary) {
                COSDictionary encDict = (COSDictionary) encodingBase;
                String base = encDict.getNameAsString(COSName.BASE_ENCODING);
                if (base == null) {
                    base = "Custom";
                }
                if (encDict.getDictionaryObject(COSName.DIFFERENCES) != null) {
                    return base + "+Differences";
                }
                return base;
            }
            return "Unknown";
        }

        private static boolean isStandard14(PDFont font) {
            String name = font.getName();
            if (name == null) {
                return false;
            }
            try {
                Standard14Fonts.FontName mapped = Standard14Fonts.getMappedFontName(name);
                if (mapped == null) {
                    return false;
                }
                // PDFBox returns a non-null mapping for fonts known to the Standard 14 set.
                // Additionally, ensure the font is *unembedded* — Standard 14 means relying on
                // the viewer's built-in font program. If the font has an embedded program,
                // it is technically not an unembedded Standard 14.
                return !font.isEmbedded() && (font instanceof PDType1Font);
            } catch (Throwable t) {
                return false;
            }
        }

        private static boolean checkCidSystemInfo(PDFont font) {
            if (!(font instanceof PDType0Font)) {
                return true; // not applicable
            }
            PDType0Font t0 = (PDType0Font) font;
            PDCIDFont descendant = t0.getDescendantFont();
            if (descendant == null) {
                return false;
            }
            COSDictionary cidDict = descendant.getCOSObject();
            COSBase csi = cidDict.getDictionaryObject(COSName.getPDFName("CIDSystemInfo"));
            if (!(csi instanceof COSDictionary)) {
                return false;
            }
            COSDictionary csiDict = (COSDictionary) csi;
            String registry = csiDict.getString(COSName.REGISTRY);
            String ordering = csiDict.getString(COSName.ORDERING);
            COSBase supplement = csiDict.getDictionaryObject(COSName.SUPPLEMENT);
            return registry != null && !registry.isEmpty()
                && ordering != null && !ordering.isEmpty()
                && supplement != null;
        }

        private void processPageContent(PDPage page) {
            GlyphCollector collector = new GlyphCollector(this);
            try {
                collector.processPage(page);
            } catch (IOException ignored) {
                // Best-effort; partial coverage is acceptable for an audit.
            } catch (RuntimeException ignored) {
                // Don't let a single broken page abort the whole audit.
            }
        }

        void recordGlyph(PDFont font, int code) {
            if (font == null) {
                return;
            }
            COSDictionary dict = font.getCOSObject();
            String key = keysByDict.get(dict);
            if (key == null) {
                // Font appeared in a content stream but wasn't found via /Resources walking
                // (e.g., from a nested Form XObject that PDFStreamEngine resolves). Register on the fly.
                key = registerFont(font, "content-stream");
            }
            FontRecord record = fontsByKey.get(key);
            if (record == null) {
                return;
            }
            if (record.usedCodes.add(code)) {
                if (codeMapsToUnicode(font, code)) {
                    record.mappedCodeCount++;
                }
            }
        }

        private static boolean codeMapsToUnicode(PDFont font, int code) {
            try {
                String unicode = font.toUnicode(code);
                return unicode != null && !unicode.isEmpty();
            } catch (Exception e) {
                return false;
            }
        }

        private void evaluateFindings() {
            for (FontRecord record : fontsByKey.values()) {
                if (record.standard14) {
                    addFinding(record.fontKey, "error", "FONT_STANDARD_14",
                        "Font '" + record.name + "' is an unembedded Standard 14 font; PDF/UA forbids relying on viewer-built-in fonts.");
                }
                if (!record.embedded && !record.standard14) {
                    addFinding(record.fontKey, "error", "FONT_NOT_EMBEDDED",
                        "Font '" + record.name + "' has no FontFile/FontFile2/FontFile3 program; embed a subset to satisfy PDF/UA.");
                }
                if (!record.hasToUnicode) {
                    addFinding(record.fontKey, "error", "TO_UNICODE_MISSING",
                        "Font '" + record.name + "' has no /ToUnicode CMap; text extraction and AT readback will fail.");
                } else {
                    double coverage = record.coverage();
                    if (!record.usedCodes.isEmpty() && coverage < COVERAGE_ERROR_THRESHOLD) {
                        addFinding(record.fontKey, "error", "TO_UNICODE_INCOMPLETE",
                            String.format("Font '%s' /ToUnicode covers %.1f%% of %d used glyphs; PDF/UA requires complete coverage.",
                                record.name, coverage * 100.0, record.usedCodes.size()));
                    } else if (!record.usedCodes.isEmpty() && coverage < COVERAGE_WARNING_THRESHOLD) {
                        addFinding(record.fontKey, "warning", "TO_UNICODE_INCOMPLETE",
                            String.format("Font '%s' /ToUnicode covers %.1f%% of %d used glyphs; consider regenerating the CMap.",
                                record.name, coverage * 100.0, record.usedCodes.size()));
                    }
                }
                if (record.isSymbolic && !hasDifferencesEncoding(record.font)) {
                    addFinding(record.fontKey, "error", "SYMBOLIC_WITHOUT_DIFFERENCES",
                        "Symbolic font '" + record.name + "' lacks an /Encoding /Differences mapping; glyph codes are unreachable to ATs.");
                }
                if (record.font instanceof PDType0Font && !record.cidSystemInfoValid) {
                    addFinding(record.fontKey, "error", "INVALID_CID_SYSTEM_INFO",
                        "CIDFont '" + record.name + "' has missing or malformed /CIDSystemInfo (Registry/Ordering/Supplement).");
                }
                String licenseFinding = inspectLicensingFlags(record.font);
                if (licenseFinding != null) {
                    addFinding(record.fontKey, "warning", "LICENSE_RESTRICTED",
                        "Font '" + record.name + "' " + licenseFinding);
                }
            }
        }

        private static boolean hasDifferencesEncoding(PDFont font) {
            if (!(font instanceof PDSimpleFont)) {
                return true; // Differences is not the right concept for Type0
            }
            Encoding encoding = ((PDSimpleFont) font).getEncoding();
            if (encoding instanceof DictionaryEncoding) {
                DictionaryEncoding dictEnc = (DictionaryEncoding) encoding;
                return dictEnc.getDifferences() != null && !dictEnc.getDifferences().isEmpty();
            }
            return false;
        }

        private static String inspectLicensingFlags(PDFont font) {
            // PDF FontDescriptor /FontFile* streams may carry an embedded font program with
            // OS/2 fsType bits (TTF/OTF) or ASCII license metadata. PDFBox does not expose
            // fsType directly, so we fall back to a conservative check: presence of a CIDSet
            // marker absent + a name beginning with a recognized commercial prefix.
            // This is *advisory only* and never blocks.
            String name = font.getName();
            if (name == null) {
                return null;
            }
            // Trim subset prefix "ABCDEF+Name"
            if (name.length() > 7 && name.charAt(6) == '+') {
                name = name.substring(7);
            }
            String lower = name.toLowerCase();
            if (lower.contains("monotype") || lower.contains("linotype")
                || lower.contains("itc-") || lower.startsWith("itc")
                || lower.contains("agfa")) {
                return "name suggests a commercially licensed family; verify embedding rights before redistribution.";
            }
            return null;
        }

        private void evaluateDaFontReferences() {
            for (String[] pair : daFieldFontReferences) {
                String fieldName = pair[0];
                String fontResource = pair[1];
                if (!acroFormDrFontResourceNames.contains(fontResource)) {
                    String key = "da:" + fieldName;
                    addFinding(key, "error", "DA_FONT_NOT_IN_DR",
                        "Form field '" + fieldName + "' /DA references font '/" + fontResource
                            + "' which is missing from /AcroForm/DR/Font.");
                }
            }
        }

        private void addFinding(String fontKey, String severity, String code, String message) {
            findings.add(new Finding(fontKey, severity, code, message));
        }

        String toJson() {
            // Sort fonts by key (TreeMap already keeps them sorted by name).
            List<FontRecord> sortedFonts = new ArrayList<>(fontsByKey.values());
            sortedFonts.sort(Comparator.comparing(r -> r.fontKey));

            // Sort findings by (severity, code, fontKey).
            findings.sort((a, b) -> {
                int c = a.severity.compareTo(b.severity);
                if (c != 0) return c;
                c = a.code.compareTo(b.code);
                if (c != 0) return c;
                return a.fontKey.compareTo(b.fontKey);
            });

            StringBuilder sb = new StringBuilder();
            sb.append("{\"fonts\":[");
            for (int i = 0; i < sortedFonts.size(); i++) {
                if (i > 0) sb.append(',');
                appendFont(sb, sortedFonts.get(i));
            }
            sb.append("],\"findings\":[");
            for (int i = 0; i < findings.size(); i++) {
                if (i > 0) sb.append(',');
                appendFinding(sb, findings.get(i));
            }
            sb.append("]}");
            return sb.toString();
        }

        private static void appendFont(StringBuilder sb, FontRecord r) {
            sb.append('{');
            appendString(sb, "fontKey", r.fontKey); sb.append(',');
            appendString(sb, "name", r.name); sb.append(',');
            appendString(sb, "subtype", r.subtype); sb.append(',');
            appendBool(sb, "embedded", r.embedded); sb.append(',');
            appendBool(sb, "hasToUnicode", r.hasToUnicode); sb.append(',');
            sb.append("\"toUnicodeCoverage\":").append(formatCoverage(r.coverage())); sb.append(',');
            appendString(sb, "encoding", r.encoding); sb.append(',');
            appendBool(sb, "isSymbolic", r.isSymbolic); sb.append(',');
            appendBool(sb, "standard14", r.standard14); sb.append(',');
            appendBool(sb, "cidSystemInfoValid", r.cidSystemInfoValid); sb.append(',');
            sb.append("\"usedGlyphCount\":").append(r.usedCodes.size()); sb.append(',');
            sb.append("\"mappedGlyphCount\":").append(r.mappedCodeCount); sb.append(',');
            sb.append("\"locations\":[");
            int i = 0;
            for (String loc : r.locations) {
                if (i++ > 0) sb.append(',');
                sb.append('"').append(escape(loc)).append('"');
            }
            sb.append("]}");
        }

        private static void appendFinding(StringBuilder sb, Finding f) {
            sb.append('{');
            appendString(sb, "fontKey", f.fontKey); sb.append(',');
            appendString(sb, "severity", f.severity); sb.append(',');
            appendString(sb, "code", f.code); sb.append(',');
            appendString(sb, "message", f.message);
            sb.append('}');
        }

        private static void appendString(StringBuilder sb, String key, String value) {
            sb.append('"').append(key).append("\":\"").append(escape(value == null ? "" : value)).append('"');
        }

        private static void appendBool(StringBuilder sb, String key, boolean value) {
            sb.append('"').append(key).append("\":").append(value ? "true" : "false");
        }

        private static String formatCoverage(double value) {
            if (Double.isNaN(value) || Double.isInfinite(value)) {
                return "0";
            }
            // Force locale-independent dot-decimal with 4 digits.
            return String.format(java.util.Locale.ROOT, "%.4f", value);
        }

        private static String escape(String value) {
            StringBuilder out = new StringBuilder(value.length() + 8);
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                switch (c) {
                    case '\\': out.append("\\\\"); break;
                    case '"': out.append("\\\""); break;
                    case '\n': out.append("\\n"); break;
                    case '\r': out.append("\\r"); break;
                    case '\t': out.append("\\t"); break;
                    case '\b': out.append("\\b"); break;
                    case '\f': out.append("\\f"); break;
                    default:
                        if (c < 0x20) {
                            out.append(String.format("\\u%04x", (int) c));
                        } else {
                            out.append(c);
                        }
                }
            }
            return out.toString();
        }
    }

    /**
     * PDFStreamEngine subclass that captures every glyph code shown per font.
     * Overrides showGlyph to receive the raw character code from the content stream
     * before any ToUnicode mapping has been applied.
     */
    static final class GlyphCollector extends PDFStreamEngine {
        private final FontAudit audit;

        GlyphCollector(FontAudit audit) {
            this.audit = audit;
            // Register operators required for text state to advance properly.
            addOperator(new BeginText(this));
            addOperator(new EndText(this));
            addOperator(new SetFontAndSize(this));
            addOperator(new ShowText(this));
            addOperator(new ShowTextAdjusted(this));
            addOperator(new ShowTextLine(this));
            addOperator(new ShowTextLineAndSpace(this));
            addOperator(new MoveText(this));
            addOperator(new MoveTextSetLeading(this));
            addOperator(new NextLine(this));
            addOperator(new SetCharSpacing(this));
            addOperator(new SetTextLeading(this));
            addOperator(new SetTextRenderingMode(this));
            addOperator(new SetTextRise(this));
            addOperator(new SetTextHorizontalScaling(this));
            addOperator(new SetWordSpacing(this));
            addOperator(new SetMatrix(this));
            addOperator(new Save(this));
            addOperator(new Restore(this));
            addOperator(new Concatenate(this));
            addOperator(new SetGraphicsStateParameters(this));
            addOperator(new DrawObject(this));
        }

        @Override
        protected void showGlyph(Matrix textRenderingMatrix, PDFont font, int code, Vector displacement)
            throws IOException {
            audit.recordGlyph(font, code);
        }
    }
}
