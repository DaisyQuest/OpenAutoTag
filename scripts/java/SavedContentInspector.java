import java.io.*;
import java.util.*;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

/** Read saved paint independently of the structure tree and writer's tag plan. */
final class SavedContentInspector {
    private static final int MAX_BYTES = 64 * 1024 * 1024, MAX_DEPTH = 128;
    private final Map<String, Item> items = new LinkedHashMap<>();
    private final List<String> issues;
    final List<COSDictionary> scopes = new ArrayList<>();
    private final Set<COSDictionary> seenScopes = Collections.newSetFromMap(new IdentityHashMap<>());
    private final Set<COSDictionary> active = Collections.newSetFromMap(new IdentityHashMap<>());
    private long totalBytes, operations, glyphs;
    private final List<Map<String, Object>> textRuns = new ArrayList<>();
    private final List<Map<String, Object>> replacements = new ArrayList<>();
    private int pageGlyphs;
    private final List<Map<String,Object>> imageRuns=new ArrayList<>();
    private final Map<COSStream,String> imageHashes=new IdentityHashMap<>(),imageAppearances=new IdentityHashMap<>();
    private final Map<Integer,PDPage> pageObjects=new HashMap<>();


    private static final class Item {
        final String key;
        final Set<Integer> declarations = new HashSet<>();
        int glyphs, meaningful, unknown, graphics;
        Item(String key) { this.key = key; }
        Map<String, Object> json() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("contentRef", key); result.put("sequenceCount", declarations.size()); result.put("glyphCount", glyphs);
            result.put("meaningfulGlyphCount", meaningful); result.put("unknownGlyphCount", unknown); result.put("graphicsCount", graphics);
            return result;
        }
    }
    private record Frame(Item item, boolean artifact, Map<String, Object> replacement) {}
    private static final class State {
        PDFont font; java.awt.geom.AffineTransform matrix;
        State(PDFont font,java.awt.geom.AffineTransform matrix) {this.font=font;this.matrix=new java.awt.geom.AffineTransform(matrix);}
    }

    SavedContentInspector(PDDocument document, List<String> issues) throws IOException {
        this.issues = issues;
        int pageNumber = 0;
        for (PDPage page : document.getPages()) {
            pageGlyphs = 0;pageObjects.put(pageNumber+1,page);
            scope(page.getCOSObject());
            try (InputStream in = page.getContents()) {
                scan(read(in), page.getResources(), ++pageNumber, null, "page", new ArrayList<>(), null, new java.awt.geom.AffineTransform(), 0);
            }
        }
        for (Item item : items.values()) if (item.declarations.size() != 1)
            issues.add("DUPLICATE_MARKED_CONTENT_SEQUENCE:" + item.key);
        GlyphPositions positions = new GlyphPositions(); positions.writeText(document, Writer.nullWriter());
        for (Map<String, Object> run : textRuns) {
            List<List<Double>> page = positions.pages.getOrDefault((Integer)run.get("pageNumber"), List.of());
            int start = (Integer)run.get("glyphStart"), end = (Integer)run.get("glyphEnd");
            if (end > page.size()) throw new IOException("Independent glyph-position count mismatch");
            run.put("positions", new ArrayList<>(page.subList(start, end)));
            List<Integer> modes=positions.modes.getOrDefault((Integer)run.get("pageNumber"),List.of());
            Set<Integer> used=new HashSet<>(modes.subList(start,end));
            if(used.size()>1)throw new IOException("Text rendering mode changed within a text operator");
            if(!used.isEmpty())run.put("renderingMode",used.iterator().next());
        }
        for (var entry : positions.pages.entrySet()) {
            int counted = textRuns.stream().filter(r -> entry.getKey().equals(r.get("pageNumber"))).mapToInt(r -> (Integer)r.get("glyphEnd") - (Integer)r.get("glyphStart")).sum();
            if (counted != entry.getValue().size()) throw new IOException("Independent glyph-position count mismatch");
        }
    }

    /** Use the actual PDFStreamEngine text rendering matrix, bypassing the
     * legacy TextPosition heuristics and ActualText substitution entirely. */
    private static final class GlyphPositions extends org.apache.pdfbox.text.PDFTextStripper {
        final Map<Integer, List<List<Double>>> pages = new LinkedHashMap<>();
        final Map<Integer, List<Integer>> modes = new LinkedHashMap<>();
        int pageNumber, count;
        GlyphPositions() throws IOException { super(); addOperator(new org.apache.pdfbox.contentstream.operator.text.SetTextRenderingMode(this)); }
        @Override public void processPage(PDPage page) throws IOException {
            pages.put(++pageNumber, new ArrayList<>()); modes.put(pageNumber,new ArrayList<>()); super.processPage(page);
        }
        @Override protected void showGlyph(org.apache.pdfbox.util.Matrix matrix, PDFont font, int code, org.apache.pdfbox.util.Vector displacement) throws IOException {
            if (++count > 2000000) throw new IOException("Glyph-position limit exceeded");
            List<Double> values = Arrays.asList((double)matrix.getScaleX(), (double)matrix.getShearY(), (double)matrix.getShearX(),
                (double)matrix.getScaleY(), (double)matrix.getTranslateX(), (double)matrix.getTranslateY(), (double)displacement.getX(), (double)displacement.getY());
            if (values.stream().anyMatch(v -> !Double.isFinite(v))) throw new IOException("Nonfinite saved glyph position");
            pages.get(pageNumber).add(values);
            modes.get(pageNumber).add(getGraphicsState().getTextState().getRenderingMode().intValue());
        }
    }

    List<Map<String, Object>> json() { return items.values().stream().map(Item::json).toList(); }
    List<Map<String,Object>> imageRuns() {return imageRuns;}
    List<Map<String, Object>> textRuns() { return textRuns; }
    List<Map<String, Object>> replacements() { return replacements; }
    private void scope(COSDictionary dict) { if (seenScopes.add(dict)) scopes.add(dict); }
    boolean contains(String key) { return items.containsKey(key); }
    static String key(int page, COSBase stream, int mcid) {
        return "page:" + page + ":stream:" + (stream == null ? "page" : ref(stream)) + ":mcid:" + mcid;
    }
    private static String ref(COSBase object) {
        return object == null || object.getKey() == null ? "direct" : object.getKey().getNumber() + " " + object.getKey().getGeneration() + " R";
    }
    private byte[] read(InputStream in) throws IOException {
        byte[] bytes = in.readNBytes(MAX_BYTES + 1);
        totalBytes += bytes.length;
        if (bytes.length > MAX_BYTES || totalBytes > 256L * 1024 * 1024) throw new IOException("Saved content byte limit exceeded");
        return bytes;
    }
    private void scan(byte[] bytes, PDResources resources, int page, COSStream stream, String origin,
        List<Frame> inherited, PDFont inheritedFont, java.awt.geom.AffineTransform inheritedMatrix, int depth) throws IOException {
        if (depth > MAX_DEPTH) throw new IOException("Saved content invocation depth exceeded");
        List<Frame> frames = new ArrayList<>(inherited);
        int base = frames.size(), index = 0;
        Deque<State> states = new ArrayDeque<>(); State state = new State(inheritedFont,inheritedMatrix);
        PDFStreamParser parser = new PDFStreamParser(bytes);
        List<COSBase> args = new ArrayList<>(); Object token;
        while ((token = parser.parseNextToken()) != null) {
            if (!(token instanceof Operator)) {
                if (args.size() >= 32768) throw new IOException("Saved content operand limit exceeded");
                args.add((COSBase) token); continue;
            }
            if (++operations > 2000000) throw new IOException("Saved content operation limit exceeded");
            String op = ((Operator) token).getName(); index++;
            switch (op) {
                case "BDC", "BMC" -> {
                    if (frames.size() >= MAX_DEPTH) throw new IOException("Saved marked-content depth exceeded");
                    if (args.size() != ("BDC".equals(op) ? 2 : 1) || !(args.get(0) instanceof COSName)) {
                        issues.add("INVALID_MARKED_CONTENT_OPERANDS:page:" + page); frames.add(new Frame(null, false, null)); break;
                    }
                    String tag = !args.isEmpty() && args.get(0) instanceof COSName ? ((COSName)args.get(0)).getName() : "";
                    COSBase properties = args.size() > 1 ? args.get(1) : null;
                    if (properties instanceof COSName && resources != null) {
                        var property = resources.getProperties((COSName)properties);
                        properties = property == null ? null : property.getCOSObject();
                    }
                    Item item = null;
                    if (properties instanceof COSDictionary && ((COSDictionary)properties).containsKey(COSName.MCID)) {
                        COSBase raw = ((COSDictionary)properties).getDictionaryObject(COSName.MCID);
                        if (!(raw instanceof COSInteger) || ((COSInteger)raw).longValue() < 0 || ((COSInteger)raw).longValue() > Integer.MAX_VALUE)
                            issues.add("INVALID_MARKED_CONTENT_ID:page:" + page);
                        else {
                            String key = key(page, stream, ((COSInteger)raw).intValue());
                            if (!items.containsKey(key) && items.size() >= 100000) throw new IOException("Saved content sequence limit exceeded");
                            item = items.computeIfAbsent(key, Item::new); item.declarations.add(index);
                        }
                    } else if ("BDC".equals(op) && !(properties instanceof COSDictionary)) issues.add("UNRESOLVED_MARKED_CONTENT_PROPERTIES:page:" + page);
                    Map<String, Object> replacement = null;
                    if (properties instanceof COSDictionary && ((COSDictionary)properties).getDictionaryObject(COSName.ACTUAL_TEXT) instanceof COSString) {
                        replacement = new LinkedHashMap<>(); replacement.put("pageNumber", page);
                        replacement.put("glyphStart", pageGlyphs); replacement.put("glyphEnd", pageGlyphs);
                        replacement.put("text", ((COSDictionary)properties).getString(COSName.ACTUAL_TEXT));
                        replacement.put("outermost", frames.stream().noneMatch(f -> f.replacement != null));
                        if (replacements.size() >= 100000) throw new IOException("Saved replacement scope limit exceeded");
                        replacements.add(replacement);
                    }
                    frames.add(new Frame(item, "Artifact".equals(tag), replacement));
                }
                case "EMC" -> {
                    if (frames.size() <= base) issues.add("UNBALANCED_MARKED_CONTENT:page:" + page);
                    else { Frame closed = frames.remove(frames.size() - 1); if (closed.replacement != null) closed.replacement.put("glyphEnd", pageGlyphs); }
                }
                case "q" -> { if (states.size() >= MAX_DEPTH) throw new IOException("Saved graphics-state depth exceeded"); states.push(new State(state.font,state.matrix)); }
                case "Q" -> { if (!states.isEmpty()) state = states.pop(); }
                case "cm" -> {
                    if(args.size()!=6 || args.stream().anyMatch(a->!(a instanceof COSNumber)))throw new IOException("Invalid saved transformation");
                    double[] values=args.stream().mapToDouble(a->((COSNumber)a).floatValue()).toArray();
                    if(Arrays.stream(values).anyMatch(v->!Double.isFinite(v)))throw new IOException("Nonfinite saved transformation");
                    state.matrix.concatenate(new java.awt.geom.AffineTransform(values));
                }
                case "Tf" -> {
                    state.font = resources != null && args.size() == 2 && args.get(0) instanceof COSName ? resources.getFont((COSName)args.get(0)) : null;
                }
                case "gs" -> {
                    if (resources != null && args.size() == 1 && args.get(0) instanceof COSName) {
                        var gs = resources.getExtGState((COSName)args.get(0));
                        if (gs != null && gs.getFontSetting() != null) state.font = gs.getFontSetting().getFont();
                    }
                }
                case "Tj", "'", "\"", "TJ" -> {
                    List<Item> owners = owners(frames);
                    if (!args.isEmpty()) {
                        Map<String, Object> run = new LinkedHashMap<>();
                        run.put("pageNumber", page); run.put("streamOrigin", origin); run.put("operatorIndex", index - 1);
                        run.put("glyphStart", pageGlyphs); run.put("owners", owners.stream().map(i -> i.key).toList());
                        run.put("artifact", frames.stream().anyMatch(Frame::artifact));
                        run.put("fontName", state.font == null ? "" : state.font.getName());
                        run.put("fontEmbedded", state.font != null && state.font.isEmbedded());
                        List<List<Object>> decoded = new ArrayList<>(); boolean[] programs={true};text(args.get(args.size()-1), state.font, owners, decoded, programs);
                        run.put("glyphProgramsPresent",programs[0]);
                        run.put("glyphs", decoded); run.put("glyphEnd", pageGlyphs);
                        if (textRuns.size() >= 100000) throw new IOException("Saved text run limit exceeded");
                        textRuns.add(run);
                    }
                }
                case "Do" -> {
                    PDXObject object = resources != null && args.size() == 1 && args.get(0) instanceof COSName ? resources.getXObject((COSName)args.get(0)) : null;
                    if (object instanceof PDFormXObject) {
                        PDFormXObject form = (PDFormXObject)object; COSStream dict = form.getCOSObject(); scope(dict);
                        if (!active.add(dict)) throw new IOException("Cyclic saved Form invocation");
                        try (InputStream in = dict.createInputStream()) {
                            var formMatrix=new java.awt.geom.AffineTransform(state.matrix);formMatrix.concatenate(form.getMatrix().createAffineTransform());
                            scan(read(in), form.getResources() == null ? resources : form.getResources(), page, dict, origin + "/" + (index - 1), frames, state.font, formMatrix, depth + 1);
                        } finally { active.remove(dict); }
                    } else if (object instanceof PDImageXObject image) {
                        graphics(frames);image(image,frames,page,origin,index-1,state.matrix);
                    }
                }
                case "BI", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh" -> graphics(frames);
                default -> { }
            }
            args.clear();
        }
        if (frames.size() != base) issues.add("UNBALANCED_MARKED_CONTENT:page:" + page);
    }
    private void image(PDImageXObject image,List<Frame> frames,int page,String origin,int index,java.awt.geom.AffineTransform matrix) throws IOException {
        if(imageRuns.size()>=100000)throw new IOException("Saved image occurrence limit exceeded");
        String hash=imageHashes.get(image.getCOSObject());
        if(hash==null)try(InputStream in=image.getCOSObject().createRawInputStream()) {
            byte[] bytes=read(in);
            try {hash=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));}
            catch(java.security.NoSuchAlgorithmException e){throw new IOException(e);}
            imageHashes.put(image.getCOSObject(),hash);
        }
        String appearance=imageAppearances.get(image.getCOSObject());
        if(appearance==null) {
            try {appearance=PreservationInspector.fingerprint(image.getCOSObject(),Set.of("StructParent"));}
            catch(Exception e){throw new IOException("Cannot inspect image presentation",e);}
            imageAppearances.put(image.getCOSObject(),appearance);
        }
        PDPage p=pageObjects.get(page);var crop=p.getCropBox();double u=p.getUserUnit();
        double minX=Double.POSITIVE_INFINITY,minY=minX,maxX=Double.NEGATIVE_INFINITY,maxY=maxX;
        for(int x=0;x<=1;x++)for(int y=0;y<=1;y++) {
            var point=matrix.transform(new java.awt.geom.Point2D.Double(x,y),null);
            double px=point.getX()-crop.getLowerLeftX(),py=point.getY()-crop.getLowerLeftY(),dx,dy;
            switch(p.getRotation()) {
                case 0 -> {dx=px;dy=crop.getHeight()-py;}
                case 90 -> {dx=py;dy=px;}
                case 180 -> {dx=crop.getWidth()-px;dy=py;}
                case 270 -> {dx=crop.getHeight()-py;dy=crop.getWidth()-px;}
                default -> throw new IOException("Unsupported saved image rotation");
            }
            dx*=u;dy*=u;if(!Double.isFinite(dx)||!Double.isFinite(dy))throw new IOException("Nonfinite saved image geometry");
            minX=Math.min(minX,dx);maxX=Math.max(maxX,dx);minY=Math.min(minY,dy);maxY=Math.max(maxY,dy);
        }
        Map<String,Object> run=new LinkedHashMap<>();run.put("pageNumber",page);run.put("streamOrigin",origin);run.put("operatorIndex",index);
        run.put("imageSha256",hash);run.put("appearanceHash",appearance);run.put("width",image.getWidth());run.put("height",image.getHeight());run.put("bitsPerComponent",image.getBitsPerComponent());
        double[] transform=new double[6];matrix.getMatrix(transform);run.put("matrix",Arrays.stream(transform).boxed().toList());
        run.put("bbox",List.of(minX,minY,maxX-minX,maxY-minY));run.put("owners",owners(frames).stream().map(i->i.key).toList());
        run.put("artifact",frames.stream().anyMatch(Frame::artifact));imageRuns.add(run);
    }
    private static List<Item> owners(List<Frame> frames) {
        // Artifact paint cannot make a nested or enclosing real-content tag nonempty.
        if (frames.stream().anyMatch(Frame::artifact)) return List.of();
        return frames.stream().map(Frame::item).filter(Objects::nonNull).distinct().toList();
    }
    private static void graphics(List<Frame> frames) { for (Item owner : owners(frames)) owner.graphics++; }
    private void text(COSBase value, PDFont font, List<Item> owners, List<List<Object>> decoded, boolean[] programs) throws IOException {
        if (value instanceof COSArray) { for (COSBase child : (COSArray)value) if (child instanceof COSString) text(child, font, owners, decoded, programs); return; }
        if (!(value instanceof COSString)) return;
        ByteArrayInputStream bytes = new ByteArrayInputStream(((COSString)value).getBytes());
        while (bytes.available() > 0) {
            if (++glyphs > 2000000) throw new IOException("Saved content glyph limit exceeded");
            int before = bytes.available(), code = font == null ? bytes.read() : font.readCode(bytes);
            if (bytes.available() >= before) throw new IOException("Saved font decoder made no progress");
            String unicode = font == null ? null : font.toUnicode(code);
            try { programs[0] &= font instanceof PDVectorFont && ((PDVectorFont)font).hasGlyph(code); }
            catch(IOException | IllegalArgumentException unavailable) { programs[0]=false; }
            decoded.add(Arrays.asList(code, unicode == null ? "" : unicode)); pageGlyphs++;
            boolean unknown = unicode == null || unicode.isEmpty() || unicode.indexOf('\ufffd') >= 0;
            boolean meaningful = !unknown && unicode.codePoints().anyMatch(c -> !Character.isWhitespace(c) && !Character.isSpaceChar(c) && !Character.isISOControl(c) && Character.getType(c) != Character.FORMAT);
            for (Item owner : owners) { owner.glyphs++; if (meaningful) owner.meaningful++; if (unknown) owner.unknown++; }
        }
    }
}
