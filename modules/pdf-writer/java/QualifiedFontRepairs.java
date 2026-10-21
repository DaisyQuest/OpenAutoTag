import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.awt.geom.Point2D;
import org.apache.fontbox.cff.*;
import org.apache.fontbox.ttf.TTFParser;
import org.apache.fontbox.ttf.TrueTypeFont;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;

/** Opt-in repairs with a narrow, versioned qualification boundary. No appearance regeneration. */
public final class QualifiedFontRepairs {
    private static final int MAX_NODES = 200000, MAX_DEPTH = 128, MAX_STREAM = 64 * 1024 * 1024;
    private static final COSName CID_SET = COSName.getPDFName("CIDSet");
    private static final Map<String, String> PROGRAM_HASHES = Map.of(
        "FoxitDingbats.pfb", "845c752392b6c914fb989c75a08b7792b88f542d2499042ef2889f8c814a16ed",
        "FoxitSerif.pfb", "4f57d2b9d884af8f907bf22df6019b52d86cbf6214fdbd02b1ae05472a543f35");
    private final PDDocument document;
    private final Path fontDir;
    private final List<Map<String, Object>> ledger = new ArrayList<>();
    private final List<COSDictionary> dictionaries = new ArrayList<>();
    private final Set<COSBase> visited = Collections.newSetFromMap(new IdentityHashMap<>());
    private final Map<COSDictionary, Set<Integer>> uses = new IdentityHashMap<>();
    private final Set<COSDictionary> dynamicFonts = Collections.newSetFromMap(new IdentityHashMap<>());
    private boolean usageComplete = true;
    private int nodes;

    private QualifiedFontRepairs(PDDocument document, Path fontDir) { this.document = document; this.fontDir = fontDir; }
    private static COSBase resolve(COSBase v) { return v instanceof COSObject ? ((COSObject)v).getObject() : v; }
    private static String ref(COSBase v) { return v.getKey() == null ? "direct" : v.getKey().getNumber() + " " + v.getKey().getGeneration() + " R"; }
    private static byte[] bytes(COSStream stream) throws IOException {
        try (InputStream in = stream.createInputStream()) {
            byte[] data = in.readNBytes(MAX_STREAM + 1);
            if (data.length > MAX_STREAM) throw new IOException("Font repair stream limit exceeded");
            return data;
        }
    }
    private static String hash(byte[] data) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data)); }
    private void record(String rule, COSDictionary target, String decision, String reason) {
        ledger.add(Map.of("ruleId", rule, "version", 1, "target", ref(target), "decision", decision, "reason", reason));
    }
    private void walk(COSBase raw, int depth) throws IOException {
        if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new IOException("Font repair traversal limit exceeded");
        COSBase v = resolve(raw);
        if (v == null || !visited.add(v)) return;
        if (v instanceof COSArray) for (COSBase child : (COSArray)v) walk(child, depth + 1);
        if (v instanceof COSDictionary) {
            COSDictionary d = (COSDictionary)v; dictionaries.add(d);
            // Pattern/Type3 text execution is outside the whitespace-only qualification boundary.
            if (d.containsKey(COSName.PATTERN) || "Type3".equals(d.getNameAsString(COSName.SUBTYPE))) usageComplete = false;
            List<COSName> keys = new ArrayList<>(d.keySet()); keys.sort(Comparator.comparing(COSName::getName));
            for (COSName key : keys) walk(d.getItem(key), depth + 1);
        }
    }
    private void apply() throws Exception {
        if (document.isEncrypted() || !document.getSignatureDictionaries().isEmpty()) throw new IOException("Encrypted or signed PDFs are outside the qualified font repair scope");
        walk(document.getDocumentCatalog().getCOSObject(), 0);
        // /DR can be inherited by fields. Never qualify a future editable text font from current page use.
        for (COSDictionary d : dictionaries) {
            COSDictionary dr = d.getCOSDictionary(COSName.DR), fonts = dr == null ? null : dr.getCOSDictionary(COSName.FONT);
            if (fonts != null) for (COSBase raw : fonts.getValues()) if (resolve(raw) instanceof COSDictionary) dynamicFonts.add((COSDictionary)resolve(raw));
        }
        if (dictionaries.stream().anyMatch(d -> "Times-Roman".equals(d.getNameAsString(COSName.BASE_FONT)) || "Helvetica".equals(d.getNameAsString(COSName.BASE_FONT)))) scanUses();
        for (COSDictionary d : dictionaries) {
            if (!"Font".equals(d.getNameAsString(COSName.TYPE))) continue;
            String subtype = d.getNameAsString(COSName.SUBTYPE, ""), base = d.getNameAsString(COSName.BASE_FONT, "");
            if (subtype.equals("CIDFontType2")) repairCidSet(d);
            if (subtype.equals("Type1") && (base.equals("ZapfDingbats") || base.equals("Times-Roman"))) repairStandard(d, base);
            if (subtype.equals("TrueType") && dynamicFonts.contains(d)) repairEditableUnicode(d);
            if (subtype.equals("Type1") && base.equals("Helvetica") && dynamicFonts.contains(d)) repairEditableHelvetica(d);
        }
    }
    private void repairEditableUnicode(COSDictionary dictionary) throws Exception {
        if (dictionary.containsKey(COSName.TO_UNICODE)) return;
        String rule = "editable-truetype-unicode";
        PDFont parsed = PDFontFactory.createFont(dictionary);
        if (!(parsed instanceof PDTrueTypeFont) || !parsed.isEmbedded() || !COSName.WIN_ANSI_ENCODING.equals(dictionary.getDictionaryObject(COSName.ENCODING))) {
            record(rule, dictionary, "review", "Requires embedded nonsymbolic TrueType with explicit WinAnsiEncoding"); return;
        }
        PDTrueTypeFont font = (PDTrueTypeFont)parsed;
        COSDictionary descriptor = dictionary.getCOSDictionary(COSName.FONT_DESC);
        COSStream program = descriptor == null ? null : descriptor.getCOSStream(COSName.FONT_FILE2);
        if (program == null || font.isSymbolic()) { record(rule, dictionary, "review", "No qualified embedded nonsymbolic program"); return; }
        byte[] data = bytes(program);
        try (TrueTypeFont ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(data))) {
            var cmap = ttf.getUnicodeCmapLookup();
            for (int code = 0; code < 256; code++) {
                String glyph = font.getEncoding().getName(code);
                if (".notdef".equals(glyph)) continue;
                String unicode = font.getGlyphList().toUnicode(glyph);
                if (unicode == null || unicode.codePointCount(0, unicode.length()) != 1 || !Objects.equals(unicode, font.toUnicode(code)) || font.codeToGID(code) == 0 ||
                    font.codeToGID(code) != cmap.getGlyphId(unicode.codePointAt(0))) {
                    record(rule, dictionary, "review", "Encoding/glyph/cmap mismatch at code " + code); return;
                }
            }
        }
        dictionary.setItem(COSName.TO_UNICODE, unicodeMap(font));
        record(rule, dictionary, "apply", "Full defined WinAnsi code-to-glyph-to-Unicode proof; existing program sha256:" + hash(data));
    }
    private void repairEditableHelvetica(COSDictionary dictionary) throws Exception {
        if (dictionary.getCOSDictionary(COSName.FONT_DESC) != null) return;
        String rule = "editable-helvetica-source-program";
        // This default may be embedded only if it is unused in every existing page/appearance.
        // It reuses an authored, complete Arial program, retaining the exact encoding and advances.
        if (!usageComplete || uses.containsKey(dictionary) || dictionary.containsKey(COSName.WIDTHS) ||
            dictionary.keySet().stream().anyMatch(k -> !Set.of("Type","Subtype","BaseFont","Name","Encoding","ToUnicode").contains(k.getName()))) {
            record(rule, dictionary, "review", "Requires an unused bare editable Helvetica default and complete usage scan"); return;
        }
        PDSimpleFont old = (PDSimpleFont)PDFontFactory.createFont(dictionary);
        List<COSDictionary> donors = dictionaries.stream().filter(d -> "TrueType".equals(d.getNameAsString(COSName.SUBTYPE)) &&
            "Arial".equals(d.getNameAsString(COSName.BASE_FONT)) && dynamicFonts.contains(d)).toList();
        if (donors.size() != 1) { record(rule, dictionary, "review", "Requires one existing authored Arial default program"); return; }
        COSDictionary donor = donors.get(0), descriptor = donor.getCOSDictionary(COSName.FONT_DESC);
        COSStream program = descriptor == null ? null : descriptor.getCOSStream(COSName.FONT_FILE2);
        if (program == null || !COSName.WIN_ANSI_ENCODING.equals(donor.getDictionaryObject(COSName.ENCODING))) {
            record(rule, dictionary, "review", "Donor has no qualified program or encoding"); return;
        }
        byte[] data = bytes(program); COSArray widths = new COSArray();
        COSDictionary expected = new COSDictionary(dictionary);
        expected.setName(COSName.SUBTYPE, "TrueType"); expected.setName(COSName.BASE_FONT, "Arial"); expected.setItem(COSName.FONT_DESC, descriptor);
        // Keep a direct source-derived encoding even if none was explicitly supplied.
        if (!expected.containsKey(COSName.ENCODING)) expected.setItem(COSName.ENCODING, COSName.STANDARD_ENCODING);
        PDTrueTypeFont replacement = new PDTrueTypeFont(expected);
        try (TrueTypeFont ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(data))) {
            var cmap = ttf.getUnicodeCmapLookup();
            for (int code = 0; code < 256; code++) {
                String glyph = old.getEncoding().getName(code), unicode = old.getGlyphList().toUnicode(glyph);
                float advance = old.getWidth(code); widths.add(new COSFloat(advance));
                if (".notdef".equals(glyph)) continue;
                int gid = replacement.codeToGID(code);
                if (unicode == null || unicode.codePointCount(0, unicode.length()) != 1 || gid == 0 || gid != cmap.getGlyphId(unicode.codePointAt(0)) ||
                    Math.abs(advance - ttf.getAdvanceWidth(gid) * 1000f / ttf.getUnitsPerEm()) > 1.0f) {
                    record(rule, dictionary, "review", "Donor glyph or advance mismatch at code " + code + " (" + glyph + ", source advance " + advance +
                        ", donor advance " + ttf.getAdvanceWidth(gid) * 1000f / ttf.getUnitsPerEm() + ")"); return;
                }
            }
        }
        COSStream unicode = dictionary.containsKey(COSName.TO_UNICODE) ? null : unicodeMap(old);
        dictionary.setName(COSName.SUBTYPE, "TrueType"); dictionary.setName(COSName.BASE_FONT, "Arial"); dictionary.setItem(COSName.FONT_DESC, descriptor);
        if (!dictionary.containsKey(COSName.ENCODING)) dictionary.setItem(COSName.ENCODING, COSName.STANDARD_ENCODING);
        dictionary.setInt(COSName.FIRST_CHAR, 0); dictionary.setInt(COSName.LAST_CHAR, 255); dictionary.setItem(COSName.WIDTHS, widths);
        if (unicode != null) dictionary.setItem(COSName.TO_UNICODE, unicode);
        record(rule, dictionary, "apply", "Unused editable default; original encoding and 256 advances retained; authored Arial program sha256:" + hash(data));
    }
    private void scanUses() {
        try {
            if (document.getNumberOfPages() == 0) { usageComplete = false; return; }
            for (PDPage page : document.getPages()) new UsageScanner(page).processPage(page);
            PDPage page = document.getPage(0);
            Set<COSStream> appearances = Collections.newSetFromMap(new IdentityHashMap<>());
            for (COSDictionary d : dictionaries) {
                if (d instanceof COSStream && "Form".equals(d.getNameAsString(COSName.SUBTYPE))) appearances.add((COSStream)d);
                COSDictionary ap = d.getCOSDictionary(COSName.AP);
                if (ap != null) for (COSBase raw : ap.getValues()) {
                    COSBase v = resolve(raw);
                    if (v instanceof COSStream) appearances.add((COSStream)v);
                    else if (v instanceof COSDictionary) for (COSBase state : ((COSDictionary)v).getValues()) {
                        COSBase s = resolve(state); if (s instanceof COSStream) appearances.add((COSStream)s);
                    }
                }
            }
            for (COSStream stream : appearances) new UsageScanner(page).scan(new PDFormXObject(stream), page);
        } catch (IOException | RuntimeException e) { usageComplete = false; }
    }
    private final class UsageScanner extends PDFGraphicsStreamEngine {
        private final Set<COSStream> active = Collections.newSetFromMap(new IdentityHashMap<>());
        private int glyphs;
        private Point2D point = new Point2D.Float();
        UsageScanner(PDPage page) { super(page); }
        void scan(PDFormXObject form, PDPage page) throws IOException { processChildStream(form, page); }
        @Override protected void showGlyph(Matrix m, PDFont font, int code, Vector displacement) throws IOException {
            if (++glyphs > 1000000) throw new IOException("Glyph scan limit exceeded");
            uses.computeIfAbsent(font.getCOSObject(), ignored -> new TreeSet<>()).add(code);
        }
        @Override public void showForm(PDFormXObject form) throws IOException {
            if (active.size() >= 64 || !active.add(form.getCOSObject())) throw new IOException("Recursive form XObject");
            try { super.showForm(form); } finally { active.remove(form.getCOSObject()); }
        }
        @Override public void appendRectangle(Point2D a, Point2D b, Point2D c, Point2D d) { point = a; }
        @Override public void drawImage(PDImage i) {}
        @Override public void clip(int r) {}
        @Override public void moveTo(float x, float y) { point = new Point2D.Float(x, y); }
        @Override public void lineTo(float x, float y) { moveTo(x, y); }
        @Override public void curveTo(float a, float b, float c, float d, float x, float y) { moveTo(x, y); }
        @Override public Point2D getCurrentPoint() { return point; }
        @Override public void closePath() {}
        @Override public void endPath() {}
        @Override public void strokePath() {}
        @Override public void fillPath(int r) {}
        @Override public void fillAndStrokePath(int r) {}
        @Override public void shadingFill(COSName n) {}
    }
    private void repairCidSet(COSDictionary font) throws Exception {
        COSDictionary fd = font.getCOSDictionary(COSName.FONT_DESC);
        COSStream program = fd == null ? null : fd.getCOSStream(COSName.FONT_FILE2);
        if (fd == null || !fd.containsKey(CID_SET)) return;
        String rule = "identity-cidset-complete";
        if (program == null || !COSName.IDENTITY.equals(font.getDictionaryObject(COSName.CID_TO_GID_MAP))) {
            record(rule, font, "review", "Requires an embedded TrueType program and explicit Identity CIDToGIDMap"); return;
        }
        // A shared descriptor must have the same mapping for every font using it.
        if (dictionaries.stream().anyMatch(d -> d != font && d.getCOSDictionary(COSName.FONT_DESC) == fd &&
            (!"CIDFontType2".equals(d.getNameAsString(COSName.SUBTYPE)) || !COSName.IDENTITY.equals(d.getDictionaryObject(COSName.CID_TO_GID_MAP))))) {
            record(rule, font, "review", "Shared descriptor has conflicting font mappings"); return;
        }
        byte[] data = bytes(program); int count;
        try (var ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(data))) { count = ttf.getNumberOfGlyphs(); }
        if (count < 1 || count > 65535) throw new IOException("Invalid TrueType glyph count");
        byte[] bits = new byte[(count + 7) / 8];
        for (int i = 0; i < count; i++) bits[i / 8] |= (byte)(128 >> (i % 8));
        COSStream existing = fd.getCOSStream(CID_SET);
        if (existing != null && Arrays.equals(bits, bytes(existing))) return;
        // Keep this small bitmap uncompressed. veraPDF's PDFBox 1.28.2 adapter reads
        // decoded CIDSet bytes using the encoded /Length, truncating compressed sets.
        fd.setItem(CID_SET, stream(bits, false));
        record(rule, font, "apply", "Identity GIDs 0.." + (count - 1) + "; original program sha256:" + hash(data));
    }
    private void repairStandard(COSDictionary font, String base) throws Exception {
        String rule = base.equals("ZapfDingbats") ? "standard-dingbats-embed" : "space-only-times-embed";
        COSDictionary descriptor = font.getCOSDictionary(COSName.FONT_DESC);
        if (descriptor != null && (descriptor.containsKey(COSName.FONT_FILE) || descriptor.containsKey(COSName.FONT_FILE2) || descriptor.containsKey(COSName.FONT_FILE3))) return;
        Set<String> allowed = Set.of("Type", "Subtype", "BaseFont", "Name", "Encoding", "ToUnicode");
        boolean canonical = font.keySet().stream().allMatch(k -> allowed.contains(k.getName()));
        COSBase encoding = font.getDictionaryObject(COSName.ENCODING);
        canonical &= base.equals("ZapfDingbats") ? encoding == null : encoding == null || COSName.WIN_ANSI_ENCODING.equals(encoding) || COSName.STANDARD_ENCODING.equals(encoding);
        if (!canonical) { record(rule, font, "review", "Custom font dictionary, metrics or encoding"); return; }
        if (base.equals("Times-Roman") && (!usageComplete || dynamicFonts.contains(font) || !Set.of(32).equals(uses.get(font)))) {
            record(rule, font, "review", "Requires complete observed usage of code 32 only, outside editable form resources"); return;
        }
        PDSimpleFont old = (PDSimpleFont)PDFontFactory.createFont(font);
        String filename = base.equals("ZapfDingbats") ? "FoxitDingbats.pfb" : "FoxitSerif.pfb";
        Path file = fontDir.resolve(filename);
        if (Files.size(file) > MAX_STREAM) throw new IOException("Font program exceeds limit");
        byte[] data = Files.readAllBytes(file);
        if (!PROGRAM_HASHES.get(filename).equals(hash(data))) throw new IOException("Unqualified font program hash: " + filename);
        CFFType1Font cff = (CFFType1Font)new CFFParser().parse(data, () -> data).get(0);
        COSArray widths = new COSArray(), differences = new COSArray(); differences.add(COSInteger.ZERO);
        for (int code = 0; code < 256; code++) {
            String glyph = old.getEncoding().getName(code);
            boolean requireMatch = base.equals("ZapfDingbats") || code == 32;
            if (requireMatch && !".notdef".equals(glyph) && (!cff.hasGlyph(glyph) || Math.abs(old.getWidth(code) - cff.getWidth(glyph)) > 0.01)) {
                record(rule, font, "review", "Glyph or advance mismatch at code " + code); return;
            }
            widths.add(new COSFloat(cff.getWidth(glyph))); differences.add(COSName.getPDFName(glyph));
        }
        // The Times rule is valid only for an empty outline, even if a future program passes its hash pin.
        if (base.equals("Times-Roman") && !cff.getPath("space").getBounds2D().isEmpty()) throw new IOException("Space has a visible outline");
        COSStream program = stream(data, true); program.setName(COSName.SUBTYPE, "Type1C");
        COSDictionary fd = new COSDictionary(); fd.setName(COSName.TYPE, "FontDescriptor"); fd.setName(COSName.FONT_NAME, cff.getName());
        fd.setInt(COSName.FLAGS, base.equals("ZapfDingbats") ? 4 : 34); fd.setItem(COSName.FONT_FILE3, program);
        var bbox = cff.getFontBBox(); COSArray box = new COSArray();
        for (float n : new float[]{bbox.getLowerLeftX(), bbox.getLowerLeftY(), bbox.getUpperRightX(), bbox.getUpperRightY()}) box.add(new COSFloat(n));
        fd.setItem(COSName.FONT_BBOX, box);
        fd.setFloat(COSName.ITALIC_ANGLE, ((Number)cff.getTopDict().getOrDefault("ItalicAngle", 0)).floatValue());
        fd.setFloat(COSName.ASCENT, bbox.getUpperRightY()); fd.setFloat(COSName.DESCENT, bbox.getLowerLeftY());
        fd.setFloat(COSName.CAP_HEIGHT, base.equals("Times-Roman") ? (float)cff.getPath("H").getBounds2D().getMaxY() : bbox.getUpperRightY());
        fd.setFloat(COSName.STEM_V, ((Number)cff.getPrivateDict().getOrDefault("StdVW", 0)).floatValue());
        COSDictionary enc = new COSDictionary(); enc.setName(COSName.TYPE, "Encoding"); enc.setItem(COSName.DIFFERENCES, differences);
        COSBase unicode = font.getItem(COSName.TO_UNICODE);
        if (unicode == null) unicode = unicodeMap(old);
        font.setName(COSName.BASE_FONT, cff.getName()); font.setItem(COSName.FONT_DESC, fd); font.setItem(COSName.ENCODING, enc);
        font.setInt(COSName.FIRST_CHAR, 0); font.setInt(COSName.LAST_CHAR, 255); font.setItem(COSName.WIDTHS, widths); font.setItem(COSName.TO_UNICODE, unicode);
        record(rule, font, "apply", base + (base.equals("ZapfDingbats") ? "; all defined code/glyph advances retained" : "; observed code 32 only, empty outline and advance retained") + "; program sha256:" + hash(data));
    }
    private COSStream stream(byte[] data, boolean compress) throws IOException {
        COSStream stream = document.getDocument().createCOSStream();
        try (OutputStream out = compress ? stream.createOutputStream(COSName.FLATE_DECODE) : stream.createOutputStream()) { out.write(data); }
        return stream;
    }
    private COSStream unicodeMap(PDSimpleFont font) throws IOException {
        StringBuilder s = new StringBuilder("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /QualifiedFontUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n");
        for (int c = 0; c < 256; c++) {
            if (".notdef".equals(font.getEncoding().getName(c))) continue;
            String u = font.toUnicode(c);
            if (u == null || u.isEmpty()) throw new IOException("No Unicode mapping for defined font code " + c);
            s.append("1 beginbfchar\n<").append(String.format(Locale.ROOT, "%02X", c)).append("> <")
                .append(HexFormat.of().formatHex(u.getBytes(StandardCharsets.UTF_16BE))).append(">\nendbfchar\n");
        }
        s.append("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        return stream(s.toString().getBytes(StandardCharsets.US_ASCII), true);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4 || !Set.of("repair", "verify").contains(args[0])) throw new IOException("Usage: repair|verify source candidate font-dir");
        Path source = Path.of(args[1]), target = Path.of(args[2]), fonts = Path.of(args[3]);
        if (source.toAbsolutePath().normalize().equals(target.toAbsolutePath().normalize())) throw new IOException("Output must differ from source");
        if (args[0].equals("repair") && Files.exists(target)) throw new IOException("Refusing to overwrite existing output");
        try (PDDocument doc = Loader.loadPDF(source.toFile())) {
            QualifiedFontRepairs repairs = new QualifiedFontRepairs(doc, fonts); repairs.apply();
            Map<String, Object> verification;
            if (args[0].equals("verify")) verification = SavedObjectVerifier.verify(doc, target);
            else {
                Path temp = Files.createTempFile(target.toAbsolutePath().getParent(), ".font-repair-", ".pdf");
                try {
                    if (repairs.ledger.stream().noneMatch(r -> r.get("decision").equals("apply"))) Files.copy(source, temp, StandardCopyOption.REPLACE_EXISTING);
                    else try (OutputStream out = Files.newOutputStream(temp)) { doc.saveIncremental(out); }
                    // Rebuild the expectation from source; save may assign new indirect keys in doc.
                    try (PDDocument original = Loader.loadPDF(source.toFile())) {
                        QualifiedFontRepairs replay = new QualifiedFontRepairs(original, fonts); replay.apply(); verification = SavedObjectVerifier.verify(original, temp);
                    }
                    if (!verification.get("status").equals("pass")) throw new IOException(verification.get("reason").toString());
                    Files.move(temp, target);
                } finally { Files.deleteIfExists(temp); }
            }
            System.out.println(QualifiedStructureRepairs.json(Map.of("repairLedger", repairs.ledger, "verification", verification)));
        }
    }
}
