import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.awt.geom.Point2D;
import java.awt.geom.PathIterator;
import org.apache.fontbox.cff.*;
import org.apache.fontbox.ttf.TTFParser;
import org.apache.fontbox.ttf.TrueTypeFont;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDTransparencyGroup;
import org.apache.pdfbox.contentstream.operator.Operator;
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
    private record Donor(String target, String sha256, byte[] program) {}
    private final List<Donor> donors;
    private final boolean repairUnicode;
    private final List<Map<String, Object>> unicodeDiagnostics = new ArrayList<>();
    private int unicodeCodeCount;
    private final List<Map<String, Object>> ledger = new ArrayList<>();
    private final List<COSDictionary> dictionaries = new ArrayList<>();
    private final Set<COSBase> visited = Collections.newSetFromMap(new IdentityHashMap<>());
    private final Map<COSDictionary, Set<Integer>> uses = new IdentityHashMap<>();
    private final Set<COSDictionary> dynamicFonts = Collections.newSetFromMap(new IdentityHashMap<>());
    private boolean usageComplete = true;
    private boolean cidUsageComplete = true;
    private boolean replacementTextPresent;
    private final Set<COSStream> invokedForms = Collections.newSetFromMap(new IdentityHashMap<>());
    private int scannedGlyphs, scannedOperators;
    private int copiedDescriptorNodes;
    private int nodes;

    private QualifiedFontRepairs(PDDocument document, Path fontDir, List<Donor> donors, boolean repairUnicode) { this.document = document; this.fontDir = fontDir; this.donors = donors; this.repairUnicode = repairUnicode; }
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
    private static String fileHash(Path file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = Files.newInputStream(file)) { byte[] chunk = new byte[65536]; int count; while ((count = in.read(chunk)) != -1) digest.update(chunk, 0, count); }
        return HexFormat.of().formatHex(digest.digest());
    }
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
            if (d.containsKey(COSName.ACTUAL_TEXT)) replacementTextPresent = true;
            // Pattern/Type3 text execution is outside the whitespace-only qualification boundary.
            if (d.containsKey(COSName.PATTERN) || "Type3".equals(d.getNameAsString(COSName.SUBTYPE))) usageComplete = false;
            if ("Type3".equals(d.getNameAsString(COSName.SUBTYPE))) cidUsageComplete = false;
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
        if (repairUnicode || !donors.isEmpty() || dictionaries.stream().anyMatch(d -> "Times-Roman".equals(d.getNameAsString(COSName.BASE_FONT)) || "Helvetica".equals(d.getNameAsString(COSName.BASE_FONT)) ||
            "Type0".equals(d.getNameAsString(COSName.SUBTYPE)) && !d.containsKey(COSName.TO_UNICODE) ||
            "CIDFontType2".equals(d.getNameAsString(COSName.SUBTYPE)) && !d.containsKey(COSName.CID_TO_GID_MAP))) scanUses();
        // Complete all missing maps before CIDSet qualification examines shared descriptors.
        for (COSDictionary d : dictionaries) if ("Font".equals(d.getNameAsString(COSName.TYPE)) && "CIDFontType2".equals(d.getNameAsString(COSName.SUBTYPE))) repairMissingCidMap(d);
        if (repairUnicode) for (COSDictionary d : dictionaries) if ("Font".equals(d.getNameAsString(COSName.TYPE)) &&
            !d.getNameAsString(COSName.SUBTYPE, "").startsWith("CIDFont")) inspectUnicode(d);
        for (COSDictionary d : dictionaries) {
            if (!"Font".equals(d.getNameAsString(COSName.TYPE))) continue;
            String subtype = d.getNameAsString(COSName.SUBTYPE, ""), base = d.getNameAsString(COSName.BASE_FONT, "");
            if (subtype.equals("CIDFontType2")) repairCidSet(d);
            if (subtype.equals("Type0") && !repairUnicode) repairSymbolUnicode(d);
            if (subtype.equals("Type1") && (base.equals("ZapfDingbats") || base.equals("Times-Roman"))) repairStandard(d, base);
            if (subtype.equals("TrueType") && dynamicFonts.contains(d)) repairEditableUnicode(d);
            if (subtype.equals("Type1") && base.equals("Helvetica") && dynamicFonts.contains(d)) repairEditableHelvetica(d);
        }
        for (Donor donor : donors) {
            COSDictionary target = dictionaries.stream().filter(d -> ref(d).equals(donor.target)).findFirst().orElse(null);
            if (target == null) throw new IOException("Font donor target is not reachable: " + donor.target);
            repairDonorProgram(target, donor);
        }
    }
    private static String fullFontName(String name) { return name == null ? "" : name.replaceFirst("^[A-Z]{6}\\+", ""); }
    private COSBase copyDirectValue(COSBase value, int depth) throws IOException {
        if (depth > MAX_DEPTH || ++copiedDescriptorNodes > MAX_NODES) throw new IOException("Font descriptor copy limit exceeded");
        if (value == null || value instanceof COSObject || value.getKey() != null || value instanceof COSStream) return value;
        if (value instanceof COSArray) {
            COSArray copy = new COSArray(); for (COSBase item : (COSArray)value) copy.add(copyDirectValue(item, depth + 1)); return copy;
        }
        if (value instanceof COSDictionary) {
            COSDictionary copy = new COSDictionary(); for (var entry : ((COSDictionary)value).entrySet()) copy.setItem(entry.getKey(), copyDirectValue(entry.getValue(), depth + 1)); return copy;
        }
        return value;
    }
    private COSDictionary isolatedDescriptor(COSDictionary original) throws IOException {
        // Direct arrays/dictionaries serialize inline and cannot retain sharing
        // with the old descriptor. Preserve indirect references, copy inline data.
        COSDictionary copy = new COSDictionary();
        for (var entry : original.entrySet()) copy.setItem(entry.getKey(), copyDirectValue(entry.getValue(), 0));
        return copy;
    }
    private void repairDonorProgram(COSDictionary dictionary, Donor donor) throws Exception {
        String rule = "exact-truetype-program-recovery";
        COSDictionary descriptor = dictionary.getCOSDictionary(COSName.FONT_DESC);
        if (!"Font".equals(dictionary.getNameAsString(COSName.TYPE)) || !"TrueType".equals(dictionary.getNameAsString(COSName.SUBTYPE)) || descriptor == null) {
            record(rule, dictionary, "review", "Requires a simple TrueType font and existing descriptor"); return;
        }
        if (descriptor.containsKey(COSName.FONT_FILE) || descriptor.containsKey(COSName.FONT_FILE2) || descriptor.containsKey(COSName.FONT_FILE3)) {
            record(rule, dictionary, "review", "Existing program entries are retained"); return;
        }
        Set<Integer> codes = uses.getOrDefault(dictionary, Set.of());
        if (!cidUsageComplete || codes.isEmpty() || dynamicFonts.contains(dictionary)) {
            record(rule, dictionary, "review", "Requires complete observed usage outside editable font defaults"); return;
        }
        COSDictionary proposedDescriptor = isolatedDescriptor(descriptor); StringBuilder evidence = new StringBuilder();
        try (TrueTypeFont ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(donor.program))) {
            int glyphCount = validateTrueTypeTables(ttf);
            if (ttf.getTableMap().containsKey("fvar")) throw new IOException("Variable font programs require separate qualification");
            var os2 = ttf.getOS2Windows();
            if (os2 == null || (os2.getFsType() & ~0x0108) != 0) throw new IOException("Donor does not declare installable/editable outline embedding permission");
            String name = ttf.getName();
            if (!fullFontName(dictionary.getNameAsString(COSName.BASE_FONT)).equals(name) || !fullFontName(descriptor.getNameAsString(COSName.FONT_NAME)).equals(name))
                throw new IOException("Donor PostScript name differs from source font identity");
            PDTrueTypeFont before = new PDTrueTypeFont(dictionary);
            if (before.isEmbedded() || before.isDamaged() || before.isSymbolic()) throw new IOException("Requires an undamaged nonsymbolic unembedded source font");
            byte[] resolved;
            try (InputStream in = before.getTrueTypeFont().getOriginalData()) { resolved = in.readNBytes(MAX_STREAM + 1); }
            if (resolved.length > MAX_STREAM || !donor.sha256.equals(hash(resolved))) throw new IOException("Donor differs from the exact program currently resolved for source glyphs");
            COSStream program = stream(donor.program, true); program.setInt(COSName.LENGTH1, donor.program.length); proposedDescriptor.setItem(COSName.FONT_FILE2, program);
            COSDictionary proposed = new COSDictionary(dictionary); proposed.setItem(COSName.FONT_DESC, proposedDescriptor);
            PDTrueTypeFont after = new PDTrueTypeFont(proposed);
            if (!after.isEmbedded() || after.isDamaged()) throw new IOException("Donor failed embedded parsing");
            for (int code : codes) {
                int gid = before.codeToGID(code); float width = before.getWidth(code), programWidth = before.getWidthFromFont(code);
                if (code < 0 || code > 255 || gid <= 0 || gid >= glyphCount || after.codeToGID(code) != gid ||
                    !Float.isFinite(width) || !Float.isFinite(programWidth) || Math.abs(width - programWidth) > 0.5f ||
                    width != after.getWidth(code) || programWidth != after.getWidthFromFont(code) ||
                    !sameVector(before.getDisplacement(code), after.getDisplacement(code)) || !Objects.equals(before.toUnicode(code), after.toUnicode(code)))
                    throw new IOException("Used glyph, Unicode or advance differs at code " + code);
                String shape = outline(before, code);
                if (!shape.equals(outline(after, code))) throw new IOException("Used glyph outline differs at code " + code);
                // PDFBox PageDrawer scales non-embedded glyphs to explicit PDF widths.
                // Embedding must not silently remove that scaling, including rounding.
                float paintWidth = before.getDisplacement(code).getX() * 1000;
                if (before.hasExplicitWidth(code) && paintWidth > 0 && programWidth > 0 && Math.abs(programWidth - paintWidth) > 0.0001f &&
                    !before.getPath(code).getPathIterator(null).isDone())
                    throw new IOException("Embedding would remove source glyph scaling at code " + code + " (PDF " + paintWidth + ", program " + programWidth + ")");
                evidence.append(code).append(':').append(gid).append(':').append(width).append(':').append(programWidth).append(':').append(before.toUnicode(code)).append(':').append(shape).append('\n');
            }
        } catch (IOException | IllegalArgumentException error) { record(rule, dictionary, "review", error.getMessage()); return; }
        // Isolate the requested font when a descriptor is also used elsewhere.
        boolean shared = dictionaries.stream().anyMatch(d -> d != dictionary && d.getCOSDictionary(COSName.FONT_DESC) == descriptor);
        if (shared) dictionary.setItem(COSName.FONT_DESC, proposedDescriptor);
        else descriptor.setItem(COSName.FONT_FILE2, proposedDescriptor.getItem(COSName.FONT_FILE2));
        record(rule, dictionary, "apply", "Exact resolved program sha256:" + donor.sha256 + "; " + codes.size() +
            " used codes; glyph/advance/Unicode/paint evidence sha256:" + hash(evidence.toString().getBytes(StandardCharsets.UTF_8)) +
            (shared ? "; isolated shared descriptor" : "; original descriptor retained"));
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
        // PDXObject constructors set /Type and /Subtype even when used to read.
        // Restore these exact authored entries for every reachable stream,
        // including objects instantiated indirectly during page traversal.
        Map<COSStream, COSBase[]> streamTypes = new IdentityHashMap<>();
        for (COSDictionary dictionary : dictionaries) if (dictionary instanceof COSStream)
            streamTypes.put((COSStream)dictionary, new COSBase[]{dictionary.getItem(COSName.TYPE), dictionary.getItem(COSName.SUBTYPE)});
        try {
            if (document.getNumberOfPages() == 0) { usageComplete = false; cidUsageComplete = false; return; }
            for (PDPage page : document.getPages()) new UsageScanner(page).processPage(page);
            PDPage page = document.getPage(0);
            Set<COSStream> appearances = Collections.newSetFromMap(new IdentityHashMap<>());
            for (COSDictionary d : dictionaries) {
                if (d instanceof COSStream && "Form".equals(d.getNameAsString(COSName.SUBTYPE))) appearances.add((COSStream)d);
                // Tiling patterns have their own resource dictionary. Scanning their
                // text once is sufficient for glyph selection, independent of tiling.
                if (d instanceof COSStream && d.getInt(COSName.PATTERN_TYPE, 0) == 1) appearances.add((COSStream)d);
                COSDictionary ap = d.getCOSDictionary(COSName.AP);
                if (ap != null) for (COSBase raw : ap.getValues()) {
                    COSBase v = resolve(raw);
                    if (v instanceof COSStream) appearances.add((COSStream)v);
                    else if (v instanceof COSDictionary) for (COSBase state : ((COSDictionary)v).getValues()) {
                        COSBase s = resolve(state); if (s instanceof COSStream) appearances.add((COSStream)s);
                    }
                }
            }
            for (COSStream stream : appearances) {
                if (stream.getCOSDictionary(COSName.RESOURCES) == null) {
                    if (invokedForms.contains(stream)) continue; // Already scanned in its real inherited context.
                    // Empty/off appearances need no font resources. Text or resource
                    // invocations in an unvisited context cannot establish usage.
                    for (Object token : new org.apache.pdfbox.pdfparser.PDFStreamParser(bytes(stream)).parse())
                        if (token instanceof Operator && Set.of("Tf", "Tj", "TJ", "'", "\"", "Do", "gs", "scn", "SCN").contains(((Operator)token).getName())) {
                            usageComplete = false; cidUsageComplete = false;
                        }
                    continue;
                }
                new UsageScanner(page).scan(new PDFormXObject(stream), page);
            }
        } catch (IOException | RuntimeException e) { usageComplete = false; cidUsageComplete = false; }
        finally {
            for (var entry : streamTypes.entrySet()) {
                entry.getKey().setItem(COSName.TYPE, entry.getValue()[0]);
                entry.getKey().setItem(COSName.SUBTYPE, entry.getValue()[1]);
            }
        }
    }
    private final class UsageScanner extends PDFGraphicsStreamEngine {
        private final Set<COSStream> active = Collections.newSetFromMap(new IdentityHashMap<>());
        private Point2D point = new Point2D.Float();
        UsageScanner(PDPage page) { super(page); }
        void scan(PDFormXObject form, PDPage page) throws IOException { active.add(form.getCOSObject()); try { processChildStream(form, page); } finally { active.remove(form.getCOSObject()); } }
        @Override protected void processOperator(Operator operator, List<COSBase> arguments) throws IOException {
            if (++scannedOperators > 2000000) throw new IOException("Font usage operator limit exceeded");
            if (operator.getName().equals("Tf") && (arguments.size() != 2 || !(arguments.get(0) instanceof COSName) || getResources() == null || getResources().getFont((COSName)arguments.get(0)) == null))
                throw new IOException("Unresolved font usage resource");
            super.processOperator(operator, arguments);
        }
        @Override protected void operatorException(Operator operator, List<COSBase> arguments, IOException error) throws IOException { throw error; }
        @Override public void beginMarkedContentSequence(COSName tag, COSDictionary properties) {
            if (properties != null && properties.containsKey(COSName.ACTUAL_TEXT)) replacementTextPresent = true;
            super.beginMarkedContentSequence(tag, properties);
        }
        @Override protected void showGlyph(Matrix m, PDFont font, int code, Vector displacement) throws IOException {
            if (++scannedGlyphs > 2000000) throw new IOException("Glyph scan limit exceeded");
            uses.computeIfAbsent(font.getCOSObject(), ignored -> new TreeSet<>()).add(code);
        }
        @Override public void showForm(PDFormXObject form) throws IOException {
            if (active.size() >= 64 || !active.add(form.getCOSObject())) throw new IOException("Recursive form XObject");
            invokedForms.add(form.getCOSObject());
            try { super.showForm(form); } finally { active.remove(form.getCOSObject()); }
        }
        @Override public void showTransparencyGroup(PDTransparencyGroup group) throws IOException {
            if (active.size() >= 64 || !active.add(group.getCOSObject())) throw new IOException("Recursive transparency group");
            invokedForms.add(group.getCOSObject());
            try { super.showTransparencyGroup(group); } finally { active.remove(group.getCOSObject()); }
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
    private static String outline(PDVectorFont font, int code) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        var path = font.getPath(code); if (path == null) throw new IOException("Missing glyph outline");
        var iterator = path.getPathIterator(null); float[] values = new float[6];
        while (!iterator.isDone()) {
            int kind = iterator.currentSegment(values), count = switch (kind) { case PathIterator.SEG_MOVETO, PathIterator.SEG_LINETO -> 2; case PathIterator.SEG_QUADTO -> 4; case PathIterator.SEG_CUBICTO -> 6; default -> 0; };
            digest.update((byte)kind);
            for (int i = 0; i < count; i++) {
                if (!Float.isFinite(values[i])) throw new IOException("Invalid glyph outline coordinate");
                int bits = Float.floatToIntBits(values[i]);
                digest.update(new byte[]{(byte)(bits >>> 24), (byte)(bits >>> 16), (byte)(bits >>> 8), (byte)bits});
            }
            iterator.next();
        }
        return HexFormat.of().formatHex(digest.digest());
    }
    private static boolean sameVector(Vector a, Vector b) {
        return Float.isFinite(a.getX()) && Float.isFinite(a.getY()) && a.getX() == b.getX() && a.getY() == b.getY();
    }
    private static boolean usableUnicode(int cp) {
        int type = Character.getType(cp);
        return Character.isValidCodePoint(cp) && type != Character.UNASSIGNED && type != Character.CONTROL &&
            type != Character.FORMAT && type != Character.PRIVATE_USE && type != Character.SURROGATE;
    }
    private static int validateTrueTypeTables(TrueTypeFont ttf) throws IOException {
        int count = ttf.getNumberOfGlyphs();
        var glyf = ttf.getTableMap().get("glyf"); var loca = ttf.getIndexToLocation();
        if (count < 1 || count > 65535 || glyf == null || loca == null || ttf.getHorizontalMetrics() == null || ttf.getUnitsPerEm() < 16 || ttf.getUnitsPerEm() > 16384)
            throw new IOException("Unsupported TrueType glyph tables");
        long[] offsets = loca.getOffsets();
        if (offsets.length != count + 1) throw new IOException("Incomplete TrueType glyph offsets");
        long previous = 0;
        for (long offset : offsets) { if (offset < previous || offset > glyf.getLength()) throw new IOException("Invalid TrueType glyph offsets"); previous = offset; }
        return count;
    }
    private record GlyphUnicode(String text, String evidence) {}
    private static GlyphUnicode glyphUnicode(TrueTypeFont ttf, PDVectorFont font, int code, int gid) throws Exception {
        // Audited geometric fingerprint: Unicode WG2 N4363 Annex A, Wingdings
        // index 118 -> U+2756. No font name or PDF code is treated as Unicode.
        String shape = outline(font, code); int advance = ttf.getAdvanceWidth(gid);
        Integer fingerprint = ttf.getUnitsPerEm() == 2048 && advance == 1825 &&
            shape.equals("f328c16311f42d7aae4d83d5626acfb9fb0885c9513c2ee9dc1507c6038cf9df") ? 0x2756 : null;
        Set<Integer> unicode = new TreeSet<>();
        if (ttf.getCmap() != null) for (var cmap : ttf.getCmap().getCmaps()) {
            int platform = cmap.getPlatformId(), id = cmap.getPlatformEncodingId();
            if (!(platform == 0 && Set.of(0, 1, 2, 3, 4, 6).contains(id) || platform == 3 && (id == 1 || id == 10))) continue;
            List<Integer> values = cmap.getCharCodes(gid);
            if (values != null) for (int value : values) {
                if (!usableUnicode(value)) throw new IOException("Private, invalid or non-text Unicode cmap evidence at code " + code);
                unicode.add(value);
            }
        }
        if (unicode.size() > 1 || fingerprint != null && !unicode.isEmpty() && !unicode.contains(fingerprint))
            throw new IOException("Ambiguous or conflicting glyph-to-Unicode evidence at code " + code);
        Integer cp = fingerprint != null ? fingerprint : unicode.stream().findFirst().orElse(null);
        if (cp == null) throw new IOException("No verified Unicode identity for used glyph at code " + code);
        return new GlyphUnicode(new String(Character.toChars(cp)), code + ":" + gid + ":" + cp + ":" + advance + ":" + shape +
            ":" + (fingerprint == null ? "embedded-unicode-cmap" : "wg2-n4363-1118") + "\n");
    }
    private static PDFont unicodeFont(COSDictionary dictionary) throws IOException {
        if ("TrueType".equals(dictionary.getNameAsString(COSName.SUBTYPE))) return new PDTrueTypeFont(dictionary);
        return new PDType0Font(dictionary);
    }
    private static int gid(PDFont font, int code) throws IOException {
        return font instanceof PDType0Font ? ((PDType0Font)font).codeToGID(code) : ((PDTrueTypeFont)font).codeToGID(code);
    }
    private void inspectUnicode(COSDictionary dictionary) throws Exception {
        String rule = "verified-invalid-unicode", subtype = dictionary.getNameAsString(COSName.SUBTYPE, "");
        Set<Integer> codes = uses.getOrDefault(dictionary, Set.of());
        if (unicodeDiagnostics.size() >= 256) throw new IOException("Unicode font diagnostic limit exceeded");
        Map<String, Object> diagnostic = new LinkedHashMap<>(); List<Map<String, Object>> codeDiagnostics = new ArrayList<>();
        diagnostic.put("target", ref(dictionary)); diagnostic.put("usedCodeCount", codes.size()); diagnostic.put("usageComplete", cidUsageComplete);
        diagnostic.put("codes", codeDiagnostics); diagnostic.put("repaired", false); unicodeDiagnostics.add(diagnostic);
        int width = subtype.equals("Type0") ? 2 : 1;
        ToUnicodeMap source = ToUnicodeMap.inspect(dictionary, width);
        String state = source.state, reason = source.reason;
        COSBase encoding = dictionary.getDictionaryObject(COSName.ENCODING);
        boolean supported = subtype.equals("TrueType") || subtype.equals("Type0") &&
            (COSName.IDENTITY_H.equals(encoding) || COSName.IDENTITY_V.equals(encoding));
        TreeMap<Integer, String> expected = new TreeMap<>(); StringBuilder evidence = new StringBuilder();
        PDFont before = null; byte[] program = null; String evidenceError = "Unsupported font encoding or program";
        if (codes.size() > 4096 || (unicodeCodeCount += codes.size()) > 32768) {
            diagnostic.put("state", "unsupported"); diagnostic.put("reason", "Unicode code diagnostic limit exceeded");
            record(rule, dictionary, "review", "Unicode code diagnostic limit exceeded"); return;
        }
        if (supported && !codes.isEmpty()) try {
            before = unicodeFont(dictionary);
            if (!before.isEmbedded() || before.isDamaged() || before.getFontDescriptor() == null || before.getFontDescriptor().getFontFile2() == null)
                throw new IOException("Requires an undamaged embedded TrueType program");
            program = bytes(before.getFontDescriptor().getFontFile2().getCOSObject());
            try (TrueTypeFont ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(program))) {
                int count = validateTrueTypeTables(ttf);
                if (ttf.getTableMap().containsKey("fvar")) throw new IOException("Variable program requires separate qualification");
                for (int code : codes) {
                    int glyph = gid(before, code);
                    if (code < 0 || code >= (width == 1 ? 256 : 65536) || glyph <= 0 || glyph >= count) throw new IOException("Invalid used glyph at code " + code);
                    GlyphUnicode proof = glyphUnicode(ttf, (PDVectorFont)before, code, glyph);
                    expected.put(code, proof.text); evidence.append(proof.evidence);
                }
                evidenceError = "";
            }
        } catch (IOException | IllegalArgumentException e) { evidenceError = e.getMessage(); }
        boolean conflict = source.state.equals("contradictory"), missing = false;
        for (int code : codes) {
            Map<String, Object> entry = new LinkedHashMap<>(); entry.put("code", code);
            String mapped = source.mappings.get(code), verified = expected.get(code);
            if (mapped != null) entry.put("mapped", mapped);
            if (verified != null) entry.put("expected", verified);
            if (source.problems.containsKey(code)) { entry.put("state", source.state.equals("contradictory") ? "contradictory" : "malformed"); entry.put("reason", source.problems.get(code)); }
            else if (mapped == null) { entry.put("state", source.state.equals("valid") ? "missing" : source.state); missing = true; }
            else if (verified != null && !mapped.equals(verified)) { entry.put("state", "contradictory"); entry.put("reason", "Authored Unicode differs from independent glyph evidence; intent requires review"); conflict = true; }
            else entry.put("state", verified == null ? "unverified" : "verified");
            codeDiagnostics.add(entry);
        }
        if (conflict) { state = "contradictory"; reason = "Conflicting authored mappings are retained for review"; }
        else if (state.equals("valid") && missing) { state = "incomplete"; reason = "Used codes are absent from the direct ToUnicode map"; }
        diagnostic.put("state", state); diagnostic.put("reason", reason);
        if (state.equals("valid")) return;
        if (conflict || !source.rebuildAllowed || !evidenceError.isEmpty() || codes.isEmpty() || !cidUsageComplete || dynamicFonts.contains(dictionary) || replacementTextPresent) {
            record(rule, dictionary, "review", !evidenceError.isEmpty() ? reason + "; " + evidenceError : reason + "; requires complete observed evidence outside editable defaults and authored ActualText"); return;
        }
        // Retain every valid authored entry, including codes not currently painted.
        // Invalid unused entries cannot be reconstructed from observed glyph evidence.
        if (!codes.containsAll(source.problems.keySet())) { record(rule, dictionary, "review", "Invalid unused mappings need separate evidence"); return; }
        TreeMap<Integer, String> mappings = new TreeMap<>(source.mappings); mappings.putAll(expected);
        StringBuilder content = new StringBuilder("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /VerifiedUnicode def\n/CMapType 2 def\n1 begincodespacerange\n");
        content.append(width == 1 ? "<00> <FF>\n" : "<0000> <FFFF>\n").append("endcodespacerange\n");
        for (var entry : mappings.entrySet()) content.append("1 beginbfchar\n<").append(String.format(Locale.ROOT, width == 1 ? "%02X" : "%04X", entry.getKey()))
            .append("> <").append(HexFormat.of().formatHex(entry.getValue().getBytes(StandardCharsets.UTF_16BE))).append(">\nendbfchar\n");
        content.append("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        COSStream map = stream(content.toString().getBytes(StandardCharsets.US_ASCII), true);
        COSDictionary proposed = new COSDictionary(dictionary); proposed.setItem(COSName.TO_UNICODE, map); PDFont after = unicodeFont(proposed);
        for (int code : codes) if (!expected.get(code).equals(after.toUnicode(code)) || gid(before, code) != gid(after, code) ||
            !Float.isFinite(before.getWidth(code)) || before.getWidth(code) != after.getWidth(code) || !sameVector(before.getDisplacement(code), after.getDisplacement(code)) ||
            before.isVertical() && !sameVector(before.getPositionVector(code), after.getPositionVector(code)) ||
            !outline((PDVectorFont)before, code).equals(outline((PDVectorFont)after, code))) {
            record(rule, dictionary, "review", "Proposed Unicode changes used glyph selection or geometry"); return;
        }
        dictionary.setItem(COSName.TO_UNICODE, map); diagnostic.put("repaired", true);
        record(rule, dictionary, "apply", "Rebuilt " + state + " ToUnicode; " + codes.size() + " verified used codes; retained " + source.mappings.size() +
            " valid authored mappings; program sha256:" + hash(program) + "; glyph evidence sha256:" + hash(evidence.toString().getBytes(StandardCharsets.UTF_8)));
    }
    private void repairSymbolUnicode(COSDictionary dictionary) throws Exception {
        // Existing maps (including empty or malformed streams) belong to a separate repair.
        if (dictionary.containsKey(COSName.TO_UNICODE)) return;
        String rule = "verified-symbol-unicode";
        Set<Integer> codes = uses.getOrDefault(dictionary, Set.of());
        if (!cidUsageComplete || codes.isEmpty() || dynamicFonts.contains(dictionary) || replacementTextPresent) {
            record(rule, dictionary, "review", "Requires complete observed usage, no editable default, and no authored replacement text; qualify before tagging"); return;
        }
        COSBase encoding = dictionary.getDictionaryObject(COSName.ENCODING);
        COSArray descendants = dictionary.getCOSArray(COSName.DESCENDANT_FONTS);
        if ((!COSName.IDENTITY_H.equals(encoding) && !COSName.IDENTITY_V.equals(encoding)) || descendants == null || descendants.size() != 1) {
            record(rule, dictionary, "review", "Requires a two-byte Identity-H/V encoding and one embedded TrueType descendant"); return;
        }
        COSBase raw = resolve(descendants.get(0));
        COSDictionary cid = raw instanceof COSDictionary ? (COSDictionary)raw : null;
        COSDictionary descriptor = cid == null ? null : cid.getCOSDictionary(COSName.FONT_DESC);
        COSStream program = descriptor == null ? null : descriptor.getCOSStream(COSName.FONT_FILE2);
        if (cid == null || !"CIDFontType2".equals(cid.getNameAsString(COSName.SUBTYPE)) || program == null ||
            descriptor.containsKey(COSName.FONT_FILE) || descriptor.containsKey(COSName.FONT_FILE3) ||
            (descriptor.getInt(COSName.FLAGS, 0) & 36) != 4 || !COSName.IDENTITY.equals(cid.getDictionaryObject(COSName.CID_TO_GID_MAP))) {
            record(rule, dictionary, "review", "Requires symbolic embedded FontFile2 with explicit Identity CIDToGIDMap"); return;
        }
        byte[] data = bytes(program); TreeMap<Integer, String> mappings = new TreeMap<>(); StringBuilder evidence = new StringBuilder();
        COSStream map;
        try (TrueTypeFont ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(data))) {
            PDType0Font before = new PDType0Font(dictionary);
            int glyphCount = validateTrueTypeTables(ttf);
            if (!before.isEmbedded() || before.isDamaged() || ttf.getGlyph() == null)
                throw new IOException("Unsupported or damaged embedded TrueType program");
            for (int code : codes) {
                int gid = before.codeToGID(code);
                if (code < 1 || code > 65535 || gid < 1 || gid >= glyphCount || before.codeToCID(code) != gid)
                    throw new IOException("Invalid observed code/CID/GID at code " + code);
                GlyphUnicode proof = glyphUnicode(ttf, before, code, gid);
                mappings.put(code, proof.text); evidence.append(proof.evidence);
            }
            StringBuilder s = new StringBuilder("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /VerifiedSymbolUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
            for (var entry : mappings.entrySet()) s.append("1 beginbfchar\n<").append(String.format(Locale.ROOT, "%04X", entry.getKey())).append("> <")
                .append(HexFormat.of().formatHex(entry.getValue().getBytes(StandardCharsets.UTF_16BE))).append(">\nendbfchar\n");
            s.append("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
            map = stream(s.toString().getBytes(StandardCharsets.US_ASCII), true);
            COSDictionary proposed = new COSDictionary(dictionary); proposed.setItem(COSName.TO_UNICODE, map);
            PDType0Font after = new PDType0Font(proposed);
            for (int code : codes) if (!mappings.get(code).equals(after.toUnicode(code)) || before.codeToGID(code) != after.codeToGID(code) ||
                !Float.isFinite(before.getWidth(code)) || before.getWidth(code) != after.getWidth(code) ||
                !sameVector(before.getDisplacement(code), after.getDisplacement(code)) ||
                before.isVertical() && !sameVector(before.getPositionVector(code), after.getPositionVector(code)) || !outline(before, code).equals(outline(after, code)))
                throw new IOException("Proposed Unicode map changed glyph selection or geometry");
        } catch (IOException | IllegalArgumentException error) { record(rule, dictionary, "review", error.getMessage()); return; }
        dictionary.setItem(COSName.TO_UNICODE, map);
        record(rule, dictionary, "apply", mappings.size() + " observed codes; exact glyph-to-Unicode evidence sha256:" + hash(evidence.toString().getBytes(StandardCharsets.UTF_8)) +
            "; unchanged program sha256:" + hash(data) + "; mappings " + mappings.entrySet().stream().map(e -> e.getKey() + "=U+" + Integer.toHexString(e.getValue().codePointAt(0)).toUpperCase(Locale.ROOT)).toList());
    }
    private void repairMissingCidMap(COSDictionary dictionary) throws Exception {
        if (dictionary.containsKey(COSName.CID_TO_GID_MAP)) return; // Existing maps, including malformed ones, require a different repair.
        String rule = "embedded-truetype-missing-cidmap";
        COSDictionary descriptor = dictionary.getCOSDictionary(COSName.FONT_DESC);
        COSStream program = descriptor == null ? null : descriptor.getCOSStream(COSName.FONT_FILE2);
        if (!cidUsageComplete || program == null || descriptor.containsKey(COSName.FONT_FILE) || descriptor.containsKey(COSName.FONT_FILE3)) {
            record(rule, dictionary, "review", "Requires complete supported usage and one embedded FontFile2 program"); return;
        }
        List<COSDictionary> parents = dictionaries.stream().filter(d -> "Type0".equals(d.getNameAsString(COSName.SUBTYPE)) &&
            d.getCOSArray(COSName.DESCENDANT_FONTS) != null && d.getCOSArray(COSName.DESCENDANT_FONTS).toList().stream().anyMatch(raw -> resolve(raw) == dictionary)).toList();
        if (parents.isEmpty()) { record(rule, dictionary, "review", "No Type0 parent identifies this descendant"); return; }
        byte[] data = bytes(program);
        var evidence = new StringBuilder(); int codeCount = 0, glyphCount;
        try (TrueTypeFont ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(data))) {
            glyphCount = validateTrueTypeTables(ttf);
            for (COSDictionary parent : parents) {
                if (parent.getCOSArray(COSName.DESCENDANT_FONTS).size() != 1) throw new IOException("Ambiguous descendant fonts");
                PDType0Font before = new PDType0Font(parent);
                COSDictionary proposed = new COSDictionary(dictionary); proposed.setItem(COSName.CID_TO_GID_MAP, COSName.IDENTITY);
                COSArray descendants = new COSArray(); descendants.add(proposed);
                COSDictionary parentCopy = new COSDictionary(parent); parentCopy.setItem(COSName.DESCENDANT_FONTS, descendants);
                PDType0Font after = new PDType0Font(parentCopy);
                if (!before.isEmbedded() || before.isDamaged() || !after.isEmbedded() || after.isDamaged() || !(before.getDescendantFont() instanceof PDCIDFontType2))
                    throw new IOException("Embedded TrueType program did not parse without fallback");
                evidence.append(ref(parent)).append('\n');
                for (int code : uses.getOrDefault(parent, Set.of())) {
                    int cid = before.codeToCID(code), gid = before.codeToGID(code);
                    if (cid <= 0 || cid >= glyphCount || gid != cid || after.codeToCID(code) != cid || after.codeToGID(code) != gid ||
                        !Float.isFinite(before.getWidth(code)) || before.getWidth(code) != after.getWidth(code) ||
                        !sameVector(before.getDisplacement(code), after.getDisplacement(code)) ||
                        before.isVertical() && !sameVector(before.getPositionVector(code), after.getPositionVector(code)) ||
                        !Objects.equals(before.toUnicode(code), after.toUnicode(code)))
                        throw new IOException("Used code/CID/GID or advance is not preserved at code " + code);
                    String shape = outline(before, code);
                    if (!shape.equals(outline(after, code))) throw new IOException("Used glyph outline changed");
                    evidence.append(code).append(':').append(cid).append(':').append(gid).append(':').append(ttf.getAdvanceWidth(gid))
                        .append(':').append(before.getWidth(code)).append(':').append(before.toUnicode(code)).append(':').append(shape).append('\n');
                    codeCount++;
                }
            }
        } catch (IOException | IllegalArgumentException error) { record(rule, dictionary, "review", error.getMessage()); return; }
        if (codeCount == 0) { record(rule, dictionary, "review", "No observed used codes establish a mapping repair"); return; }
        dictionary.setItem(COSName.CID_TO_GID_MAP, COSName.IDENTITY);
        record(rule, dictionary, "apply", "Explicit Identity; " + codeCount + " used codes across " + parents.size() + " parents; " + glyphCount +
            " TrueType glyphs; code/CID/GID/advance/Unicode/outline sha256:" + hash(evidence.toString().getBytes(StandardCharsets.UTF_8)) + "; unchanged program sha256:" + hash(data));
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
        boolean repairUnicode = args.length > 0 && "--repair-unicode".equals(args[args.length - 1]);
        if (repairUnicode) args = Arrays.copyOf(args, args.length - 1);
        if ((args.length != 4 && (args.length < 8 || (args.length - 5) % 3 != 0)) || !Set.of("repair", "verify").contains(args[0])) throw new IOException("Usage: repair|verify source candidate font-dir [source-hash font-ref program-path program-hash ...]");
        Path source = Path.of(args[1]), target = Path.of(args[2]), fonts = Path.of(args[3]);
        if (source.toAbsolutePath().normalize().equals(target.toAbsolutePath().normalize())) throw new IOException("Output must differ from source");
        if (args[0].equals("repair") && Files.exists(target)) throw new IOException("Refusing to overwrite existing output");
        List<Donor> donors = new ArrayList<>(); Set<String> targets = new HashSet<>(); long total = 0;
        if (args.length > 4) {
            if (!fileHash(source).equals(args[4])) throw new IOException("Stale font donor source hash");
            if ((args.length - 5) / 3 > 32) throw new IOException("Font donor count limit exceeded");
            for (int i = 5; i < args.length; i += 3) {
                if (!targets.add(args[i])) throw new IOException("Duplicate font donor target");
                Path file = Path.of(args[i + 1]); long size = Files.size(file);
                if (size < 12 || size > MAX_STREAM || (total += size) > 2L * MAX_STREAM) throw new IOException("Font donor program size limit exceeded");
                byte[] program;
                try (InputStream in = Files.newInputStream(file)) { program = in.readNBytes(MAX_STREAM + 1); }
                if (program.length != size || !hash(program).equals(args[i + 2])) throw new IOException("Font donor program hash mismatch");
                donors.add(new Donor(args[i], args[i + 2], program));
            }
        }
        try (PDDocument doc = Loader.loadPDF(source.toFile())) {
            QualifiedFontRepairs repairs = new QualifiedFontRepairs(doc, fonts, donors, repairUnicode); repairs.apply();
            Map<String, Object> verification;
            if (args[0].equals("verify")) verification = SavedObjectVerifier.verify(doc, target);
            else {
                Path temp = Files.createTempFile(target.toAbsolutePath().getParent(), ".font-repair-", ".pdf");
                try {
                    if (repairs.ledger.stream().noneMatch(r -> r.get("decision").equals("apply"))) Files.copy(source, temp, StandardCopyOption.REPLACE_EXISTING);
                    else try (OutputStream out = Files.newOutputStream(temp)) { doc.saveIncremental(out); }
                    // Rebuild the expectation from source; save may assign new indirect keys in doc.
                    try (PDDocument original = Loader.loadPDF(source.toFile())) {
                        QualifiedFontRepairs replay = new QualifiedFontRepairs(original, fonts, donors, repairUnicode); replay.apply(); verification = SavedObjectVerifier.verify(original, temp);
                    }
                    if (!verification.get("status").equals("pass")) throw new IOException(verification.get("reason").toString());
                    Files.move(temp, target);
                } finally { Files.deleteIfExists(temp); }
            }
            Map<String, Object> report = new LinkedHashMap<>(); report.put("repairLedger", repairs.ledger); report.put("verification", verification);
            if (repairUnicode) report.put("unicodeDiagnostics", repairs.unicodeDiagnostics);
            System.out.println(QualifiedStructureRepairs.json(report));
        }
    }
}
