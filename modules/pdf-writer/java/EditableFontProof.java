import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.awt.geom.*;
import java.awt.image.BufferedImage;
import org.apache.fontbox.ttf.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;

/** Bounded, opt-in QA copies. Qualification applies only to the exact requested text. */
public final class EditableFontProof {
    private static final int MAX_STREAM = 32 * 1024 * 1024;
    private static COSName n(String name) { return COSName.getPDFName(name); }
    private static String ref(COSBase value) { return value.getKey() == null ? "direct" : value.getKey().getNumber()+" "+value.getKey().getGeneration()+" R"; }
    private static String hash(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    private static void require(boolean value, String reason) throws IOException { if (!value) throw new IOException(reason); }
    private static byte[] bytes(COSStream stream) throws IOException {
        try (InputStream in = stream.createInputStream()) {
            byte[] data = in.readNBytes(MAX_STREAM + 1);
            require(data.length <= MAX_STREAM, "Decoded stream limit exceeded"); return data;
        }
    }
    private static byte[] program(PDFont font) throws IOException {
        require(font instanceof PDTrueTypeFont || font instanceof PDType0Font && ((PDType0Font)font).getDescendantFont() instanceof PDCIDFontType2,
            "Font is outside supported TrueType scope");
        require(font.isEmbedded() && !font.isDamaged() && !font.isVertical(), "Font must be embedded, undamaged and horizontal");
        require(font.getFontDescriptor() != null && font.getFontDescriptor().getFontFile2() != null, "Missing embedded TrueType program");
        return bytes(font.getFontDescriptor().getFontFile2().getCOSObject());
    }
    private static int gid(PDFont font, int code) throws IOException { return font instanceof PDType0Font ? ((PDType0Font)font).codeToGID(code) : ((PDTrueTypeFont)font).codeToGID(code); }

    // Validate parent chains before PDFBox's inherited-property/name accessors recurse.
    private static List<PDField> fields(PDAcroForm form) throws IOException {
        require(form != null, "Missing saved AcroForm");
        record Node(COSDictionary dictionary, int depth) {}
        ArrayDeque<Node> pending = new ArrayDeque<>(); COSArray roots = form.getCOSObject().getCOSArray(COSName.FIELDS);
        require(roots != null && roots.size() <= 4096, "Missing or excessive field roots");
        for (int i=0;i<roots.size();i++) {
            require(roots.getObject(i) instanceof COSDictionary, "Invalid field root"); pending.add(new Node((COSDictionary)roots.getObject(i),0));
        }
        Set<COSDictionary> rawSeen = Collections.newSetFromMap(new IdentityHashMap<>());
        while (!pending.isEmpty()) {
            Node node=pending.removeFirst(); require(node.depth<64 && rawSeen.size()<8192 && rawSeen.add(node.dictionary), "Cyclic/shared or excessive raw field tree");
            Set<COSDictionary> parents=Collections.newSetFromMap(new IdentityHashMap<>());
            for(COSDictionary d=node.dictionary;d!=null;d=d.getCOSDictionary(COSName.PARENT)) require(parents.size()<64 && parents.add(d), "Cyclic or excessive field parent chain");
            COSArray kids=node.dictionary.getCOSArray(COSName.KIDS);
            if(kids!=null) {
                require(kids.size()+pending.size()<=8192, "Excessive field children");
                for(int i=0;i<kids.size();i++) { require(kids.getObject(i) instanceof COSDictionary, "Invalid field child");pending.add(new Node((COSDictionary)kids.getObject(i),node.depth+1)); }
            }
        }
        List<PDField> result = new ArrayList<>(); Set<COSDictionary> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (PDField field : form.getFieldTree()) {
            require(result.size() < 4096 && seen.add(field.getCOSObject()), "Cyclic/shared or excessive field tree");
            Set<COSDictionary> parents = Collections.newSetFromMap(new IdentityHashMap<>());
            for (COSDictionary d = field.getCOSObject(); d != null; d = d.getCOSDictionary(COSName.PARENT))
                require(parents.size() < 64 && parents.add(d), "Cyclic or excessive field parent chain");
            result.add(field);
        }
        return result;
    }
    private static PDField find(List<PDField> fields, String target) throws IOException {
        List<PDField> found = fields.stream().filter(f -> ref(f.getCOSObject()).equals(target)).toList();
        require(found.size() == 1, "Field reference must resolve uniquely in the AcroForm tree"); return found.get(0);
    }
    private static void noActions(COSDictionary dictionary) throws IOException {
        require(!dictionary.containsKey(COSName.AA) && !dictionary.containsKey(COSName.A), "Field/widget actions require separate behavior review");
    }
    private static PDFont defaultFont(PDTextField field, PDAnnotationWidget widget) throws IOException {
        String da = widget.getCOSObject().getString(COSName.DA, field.getDefaultAppearance());
        require(da != null && da.length() <= 16384, "Missing or excessive default appearance");
        COSName name = null; List<COSBase> args = new ArrayList<>(); int tokens = 0;
        PDFStreamParser parser = new PDFStreamParser(da.getBytes(StandardCharsets.ISO_8859_1)); Object token;
        while ((token = parser.parseNextToken()) != null) {
            require(++tokens <= 2048, "Default appearance token limit exceeded");
            if (token instanceof Operator op) {
                if (op.getName().equals("Tf")) {
                    require(args.size() == 2 && args.get(0) instanceof COSName && args.get(1) instanceof COSNumber, "Malformed default font selection");
                    float size = ((COSNumber)args.get(1)).floatValue(); require(Float.isFinite(size) && size >= 0, "Invalid default font size");
                    name = (COSName)args.get(0);
                }
                args.clear();
            } else args.add((COSBase)token);
        }
        PDResources resources = field.getAcroForm().getDefaultResources();
        require(name != null && resources != null, "Missing default font resources");
        PDFont font = resources.getFont(name); require(font != null, "Default font is unresolved");
        PDAppearanceStream ap = widget.getNormalAppearanceStream();
        if (ap != null && ap.getResources() != null) {
            PDFont other = ap.getResources().getFont(name);
            require(other == null || other.getCOSObject() == font.getCOSObject(), "Ambiguous default and appearance font resource");
        }
        return font;
    }
    private record FontProof(PDFont font, String hash, Map<Integer, Map<String,Object>> characters) {}
    private static FontProof inspect(PDFont font, String value) throws Exception {
        byte[] data = program(font); Map<Integer, Map<String,Object>> characters = new LinkedHashMap<>();
        try (TrueTypeFont ttf = new TTFParser().parseEmbedded(new ByteArrayInputStream(data))) {
            CmapLookup cmap = ttf.getUnicodeCmapLookup();
            require(cmap != null && ttf.getUnitsPerEm() >= 16 && ttf.getUnitsPerEm() <= 16384, "Missing independent embedded Unicode cmap or invalid font units");
            for (int cp : value.codePoints().distinct().toArray()) {
                Map<String,Object> entry = new LinkedHashMap<>(); entry.put("codePoint", cp); characters.put(cp, entry);
                byte[] encoded;
                try { encoded = font.encode(new String(Character.toChars(cp))); }
                catch (IllegalArgumentException ex) { entry.put("status", "unsupported"); entry.put("reason", "Font encoder cannot represent this character"); continue; }
                try {
                    ByteArrayInputStream input = new ByteArrayInputStream(encoded); int code = font.readCode(input), glyph = gid(font, code);
                    require(input.available() == 0 && encoded.length > 0 && glyph > 0 && glyph < ttf.getNumberOfGlyphs(), "Missing or invalid encoded glyph");
                    require(cmap.getGlyphId(cp) == glyph, "Encoded glyph disagrees with embedded Unicode cmap");
                    require(new String(Character.toChars(cp)).equals(font.toUnicode(code)), "Encoded glyph does not round-trip to requested Unicode");
                    float width = font.getWidth(code); require(Float.isFinite(width) && width >= 0, "Invalid glyph advance");
                    entry.put("code", code); entry.put("gid", glyph); entry.put("width", width);
                    entry.put("status", "verified"); entry.put("reason", "Encoder, saved Unicode and embedded cmap agree");
                } catch (IOException | IllegalArgumentException ex) { entry.put("status", "unverified"); entry.put("reason", ex.getMessage()); }
            }
        }
        return new FontProof(font, hash(data), characters);
    }

    /** Reads generated /Tx glyphs, including clipping. It does not trust /V as appearance evidence. */
    private static final class Appearance extends PDFGraphicsStreamEngine {
        private final FontProof proof; private final StringBuilder text = new StringBuilder();
        private final GeneralPath path = new GeneralPath(); private int clip = -1, ops, glyphs, depth, tx;
        private final Deque<Boolean> marked = new ArrayDeque<>();
        private final Map<COSDictionary,String> programHashes = new IdentityHashMap<>();
        Appearance(FontProof proof) { super(new PDPage(new PDRectangle(-100000, -100000, 200000, 200000))); this.proof = proof; }
        void verify(PDAppearanceStream ap, String expected) throws Exception {
            require(ap != null && ap.getBBox() != null && bytes(ap.getCOSObject()).length > 0, "Missing saved widget appearance");
            processPage(getPage()); showForm(new PDFormXObject(ap.getCOSObject()));
            require(marked.isEmpty() && text.toString().equals(expected), "Generated /Tx appearance text differs from requested value");
        }
        @Override protected void processOperator(Operator op, List<COSBase> args) throws IOException {
            require(++ops <= 20000, "Appearance operator limit exceeded");
            String name = op.getName();
            if (name.equals("BMC") || name.equals("BDC")) {
                require(marked.size() < 64, "Appearance marked-content depth exceeded");
                boolean variable = !args.isEmpty() && n("Tx").equals(args.get(0)); marked.push(variable); if (variable) tx++;
            } else if (name.equals("EMC")) { require(!marked.isEmpty(), "Unbalanced appearance marked content"); if (marked.pop()) tx--; }
            super.processOperator(op, args);
        }
        @Override public void showForm(PDFormXObject form) throws IOException {
            require(++depth <= 16, "Appearance form depth exceeded");
            try { bytes(form.getCOSObject()); super.showForm(form); } finally { depth--; }
        }
        @Override protected void showGlyph(Matrix matrix, PDFont font, int code, Vector displacement) throws IOException {
            if (tx == 0) return;
            require(++glyphs <= 1024, "Appearance glyph limit exceeded");
            String unicode = font.toUnicode(code);
            require(unicode != null && unicode.codePointCount(0, unicode.length()) == 1, "Appearance glyph has ambiguous Unicode");
            Map<String,Object> expected = proof.characters.get(unicode.codePointAt(0));
            require(expected != null && expected.get("status").equals("verified"), "Unexpected appearance character");
            try {
                String digest = programHashes.get(font.getCOSObject());
                if (digest == null) { digest = hash(program(font)); programHashes.put(font.getCOSObject(), digest); }
                require(digest.equals(proof.hash), "Appearance used a different font program");
            }
            catch (IOException ex) { throw ex; } catch (Exception ex) { throw new IOException(ex); }
            require(gid(font, code) == (int)expected.get("gid") && Float.compare(font.getWidth(code), ((Number)expected.get("width")).floatValue()) == 0,
                "Appearance glyph or advance differs from qualification");
            var state = getGraphicsState();
            require(state.getTextState().getRenderingMode().isFill() && state.getNonStrokeAlphaConstant() == 1 && state.getSoftMask() == null,
                "Invisible or unsupported appearance text painting");
            AffineTransform transform = matrix.createAffineTransform(); transform.concatenate(font.getFontMatrix().createAffineTransform());
            require(Double.isFinite(transform.getDeterminant()) && Math.abs(transform.getDeterminant()) > 1e-12, "Degenerate glyph transform");
            GeneralPath outline = font instanceof PDType0Font ? ((PDType0Font)font).getNormalizedPath(code) : ((PDTrueTypeFont)font).getNormalizedPath(code);
            Area painted = new Area(transform.createTransformedShape(outline));
            require(!painted.isEmpty() || Character.isSpaceChar(unicode.codePointAt(0)), "Non-space character has no visible outline");
            painted.subtract(state.getCurrentClippingPath()); require(painted.isEmpty(), "Sample glyph is clipped by the widget appearance");
            text.append(unicode);
        }
        @Override public void appendRectangle(Point2D a,Point2D b,Point2D c,Point2D d){path.moveTo(a.getX(),a.getY());path.lineTo(b.getX(),b.getY());path.lineTo(c.getX(),c.getY());path.lineTo(d.getX(),d.getY());path.closePath();}
        @Override public void drawImage(PDImage image) throws IOException { require(tx == 0, "Image inside variable text scope"); }
        @Override public void clip(int rule){clip=rule;}
        @Override public void moveTo(float x,float y){path.moveTo(x,y);}
        @Override public void lineTo(float x,float y){path.lineTo(x,y);}
        @Override public void curveTo(float a,float b,float c,float d,float e,float f){path.curveTo(a,b,c,d,e,f);}
        @Override public Point2D getCurrentPoint(){return path.getCurrentPoint();}
        @Override public void closePath(){path.closePath();}
        @Override public void endPath(){if(clip>=0){path.setWindingRule(clip);getGraphicsState().intersectClippingPath(path);clip=-1;}path.reset();}
        @Override public void strokePath(){endPath();}
        @Override public void fillPath(int rule){endPath();}
        @Override public void fillAndStrokePath(int rule){endPath();}
        @Override public void shadingFill(COSName name) throws IOException { require(tx == 0, "Shading inside variable text scope"); }
    }
    private static List<String> formState(List<PDField> fields, PDField target) throws Exception {
        List<String> state = new ArrayList<>();
        for (PDField f : fields) {
            state.add(f.getFullyQualifiedName()+"\0"+f.getFieldFlags()+"\0"+(f == target ? "<sample>" : f.getValueAsString()));
            for (PDAnnotationWidget w : f.getWidgets()) {
                state.add(String.valueOf(w.getRectangle())+" "+w.getAnnotationFlags());
                if (f != target) { PDAppearanceStream ap = w.getNormalAppearanceStream(); state.add(ap == null ? "absent" : hash(bytes(ap.getCOSObject()))); }
            }
        }
        return state;
    }
    private static Map<Integer,String> pixels(PDDocument doc, Set<Integer> pages) throws Exception {
        Map<Integer,String> result = new LinkedHashMap<>(); PDFRenderer renderer = new PDFRenderer(doc); long total = 0;
        for (int index : pages) {
            PDRectangle box = doc.getPage(index).getCropBox(); double width = box.getWidth(), height = box.getHeight();
            require(Double.isFinite(width) && Double.isFinite(height) && width > 0 && height > 0 && width <= 10000 && height <= 10000 &&
                (total += (long)Math.ceil(width)* (long)Math.ceil(height)) <= 16000000, "Probe rendering size limit exceeded");
            BufferedImage image = renderer.renderImageWithDPI(index, 72); MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update((image.getWidth()+"x"+image.getHeight()).getBytes(StandardCharsets.US_ASCII));
            byte[] row = new byte[image.getWidth()*4];
            for (int y=0;y<image.getHeight();y++) { for (int x=0;x<image.getWidth();x++) { int rgb=image.getRGB(x,y); for(int b=0;b<4;b++)row[x*4+b]=(byte)(rgb>>>(b*8)); } digest.update(row); }
            result.put(index, HexFormat.of().formatHex(digest.digest())); image.flush();
        }
        return result;
    }
    private static Map<String,Object> sample(Path source, Path output, String reference, String value, int index) throws Exception {
        Map<String,Object> result = new LinkedHashMap<>(); List<Map<String,Object>> widgets = new ArrayList<>();
        result.put("fieldRef", reference); result.put("value", value); result.put("widgets", widgets); result.put("status", "review_required");
        Path probe = output.resolve("sample-"+index+".pdf");
        try (PDDocument doc = Loader.loadPDF(source.toFile())) {
            require(!doc.isEncrypted(), "Encrypted forms require separate review");
            PDAcroForm form = doc.getDocumentCatalog().getAcroForm(null);
            require(form != null && !form.hasXFA() && !form.getNeedAppearances(), "Missing AcroForm, XFA or NeedAppearances requires review");
            require(!form.getCOSObject().containsKey(COSName.CO), "Calculation order requires behavior review");
            List<PDField> all = fields(form);
            require(all.stream().noneMatch(f -> f instanceof PDSignatureField && f.getCOSObject().getDictionaryObject(COSName.V) != null), "Signed forms require separate review");
            PDField found = find(all, reference);
            result.put("fieldName", found.getFullyQualifiedName());
            require(found instanceof PDTextField, "Sample target must be a text field"); PDTextField field = (PDTextField)found;
            require(!field.isReadOnly() && !field.isPassword() && !field.isRichText() && !field.isFileSelect(), "Unsupported text field behavior");
            require(value.codePoints().noneMatch(cp -> Character.isISOControl(cp) || Character.getType(cp) == Character.FORMAT || cp == 0x2028 || cp == 0x2029),
                "Sample contains control, formatting or line-break characters requiring layout review");
            require(field.getMaxLen() <= 0 || value.length() <= field.getMaxLen(), "Sample exceeds field MaxLen");
            for (COSDictionary d=field.getCOSObject();d!=null;d=d.getCOSDictionary(COSName.PARENT)) noActions(d);
            List<PDAnnotationWidget> controls = field.getWidgets(); require(!controls.isEmpty() && controls.size() <= 8, "Widget count outside qualification limits");
            List<FontProof> fonts = new ArrayList<>(); Set<Integer> pages = new LinkedHashSet<>();
            for (PDAnnotationWidget widget : controls) {
                noActions(widget.getCOSObject()); PDRectangle rect = widget.getRectangle();
                require(rect != null && Float.isFinite(rect.getWidth()) && Float.isFinite(rect.getHeight()) && rect.getWidth()>0 && rect.getHeight()>0 &&
                    !widget.isHidden() && !widget.isInvisible() && !widget.isNoView(), "Widget is hidden or has invalid geometry");
                int owner=-1,count=0;
                require(doc.getNumberOfPages() <= 512, "Page count exceeds probe limit");
                for(int p=0;p<doc.getNumberOfPages();p++) for(PDAnnotation a:doc.getPage(p).getAnnotations()) if(a.getCOSObject()==widget.getCOSObject()){owner=p;count++;}
                require(count==1, "Widget must belong to exactly one page annotation array"); pages.add(owner);
                FontProof proof = inspect(defaultFont(field,widget),value); fonts.add(proof);
                widgets.add(Map.of("widgetRef",ref(widget.getCOSObject()),"fontName",proof.font.getName(),"programHash",proof.hash,"characters",new ArrayList<>(proof.characters.values())));
            }
            require(fonts.stream().allMatch(f -> f.characters.values().stream().allMatch(c -> c.get("status").equals("verified"))), "One or more requested characters are unsupported or unverified");
            List<String> before = formState(all,field);
            field.setValue(value);
            require(value.equals(field.getValue()), "Filled value does not match sample");
            require(before.equals(formState(all,field)), "Filling changed another field or widget geometry/flags");
            for(int i=0;i<controls.size();i++) new Appearance(fonts.get(i)).verify(controls.get(i).getNormalAppearanceStream(),value);
            List<String> appearances = new ArrayList<>();
            for(PDAnnotationWidget widget:controls) appearances.add(hash(bytes(widget.getNormalAppearanceStream().getCOSObject())));
            doc.save(probe.toFile());
            // Rendering can synthesize missing Link appearances in memory. Save
            // first so those unrelated renderer side effects never enter the QA PDF.
            Map<Integer,String> filledPixels = pixels(doc,pages);
            try(PDDocument reopened=Loader.loadPDF(probe.toFile())) {
                PDAcroForm savedForm=reopened.getDocumentCatalog().getAcroForm(null); List<PDField> savedFields=fields(savedForm);
                // A full QA save can renumber objects: use the original traversal position after checking field inventory.
                PDTextField saved=(PDTextField)savedFields.get(all.indexOf(field));
                require(before.equals(formState(savedFields,saved)) && value.equals(saved.getValue()), "Saved field values, geometry or flags changed");
                require(saved.getWidgets().size()==controls.size(), "Saved widget count changed");
                for(int i=0;i<controls.size();i++) {
                    require(hash(program(defaultFont(saved,saved.getWidgets().get(i)))).equals(fonts.get(i).hash), "Saved editable default font changed");
                    PDAppearanceStream ap=saved.getWidgets().get(i).getNormalAppearanceStream();
                    require(ap!=null && hash(bytes(ap.getCOSObject())).equals(appearances.get(i)), "Saved appearance bytes changed");
                    new Appearance(fonts.get(i)).verify(ap,value);
                }
                require(filledPixels.equals(pixels(reopened,pages)), "Saved/reopened appearance pixels differ");
            }
            result.put("status","verified"); result.put("reason","Exact sample survived fill/save/reopen with verified glyphs, unclipped /Tx text and equal PDFBox page pixels");
            result.put("probeFile",probe.getFileName().toString());result.put("probeHash",hash(Files.readAllBytes(probe)));result.put("savedPixelsMatch",true);
        } catch (IOException | IllegalArgumentException | ClassCastException | IndexOutOfBoundsException ex) {
            result.put("reason", ex.getMessage()==null?ex.getClass().getSimpleName():ex.getMessage());
            Files.deleteIfExists(probe);
        }
        return result;
    }
    public static void main(String[] args) throws Exception {
        require(args.length==4,"Expected source, output directory, sample transport and source hash");
        Path source=Path.of(args[0]),output=Path.of(args[1]);
        require(hash(Files.readAllBytes(source)).equals(args[3]),"Source hash changed before qualification");
        List<String> lines=Files.readAllLines(Path.of(args[2]),StandardCharsets.UTF_8); require(!lines.isEmpty()&&lines.size()<=16,"Sample count limit exceeded");
        List<Map<String,Object>> samples=new ArrayList<>();int i=0;
        for(String line:lines){String[] pair=line.split("\t",-1);require(pair.length==2,"Invalid sample transport");samples.add(sample(source,output,pair[0],new String(Base64.getDecoder().decode(pair[1]),StandardCharsets.UTF_8),++i));}
        require(hash(Files.readAllBytes(source)).equals(args[3]),"Source changed during qualification");
        // stdout can otherwise use the Windows console code page and corrupt sample Unicode.
        System.out.write((QualifiedStructureRepairs.json(Map.of("status",samples.stream().allMatch(s->s.get("status").equals("verified"))?"verified":"review_required","samples",samples))+"\n").getBytes(StandardCharsets.UTF_8));
    }
}
