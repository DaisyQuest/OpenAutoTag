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
    private record Frame(Item item, boolean artifact) {}
    private static final class State { PDFont font; State(PDFont font) { this.font = font; } }

    SavedContentInspector(PDDocument document, List<String> issues) throws IOException {
        this.issues = issues;
        int pageNumber = 0;
        for (PDPage page : document.getPages()) {
            scope(page.getCOSObject());
            try (InputStream in = page.getContents()) {
                scan(read(in), page.getResources(), ++pageNumber, null, new ArrayList<>(), null, 0);
            }
        }
        for (Item item : items.values()) if (item.declarations.size() != 1)
            issues.add("DUPLICATE_MARKED_CONTENT_SEQUENCE:" + item.key);
    }

    List<Map<String, Object>> json() { return items.values().stream().map(Item::json).toList(); }
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
    private void scan(byte[] bytes, PDResources resources, int page, COSStream stream,
        List<Frame> inherited, PDFont inheritedFont, int depth) throws IOException {
        if (depth > MAX_DEPTH) throw new IOException("Saved content invocation depth exceeded");
        List<Frame> frames = new ArrayList<>(inherited);
        int base = frames.size(), index = 0;
        Deque<State> states = new ArrayDeque<>(); State state = new State(inheritedFont);
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
                        issues.add("INVALID_MARKED_CONTENT_OPERANDS:page:" + page); frames.add(new Frame(null, false)); break;
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
                    frames.add(new Frame(item, "Artifact".equals(tag)));
                }
                case "EMC" -> {
                    if (frames.size() <= base) issues.add("UNBALANCED_MARKED_CONTENT:page:" + page);
                    else frames.remove(frames.size() - 1);
                }
                case "q" -> { if (states.size() >= MAX_DEPTH) throw new IOException("Saved graphics-state depth exceeded"); states.push(new State(state.font)); }
                case "Q" -> { if (!states.isEmpty()) state = states.pop(); }
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
                    if (!owners.isEmpty() && !args.isEmpty()) text(args.get(args.size()-1), state.font, owners);
                }
                case "Do" -> {
                    PDXObject object = resources != null && args.size() == 1 && args.get(0) instanceof COSName ? resources.getXObject((COSName)args.get(0)) : null;
                    if (object instanceof PDFormXObject) {
                        PDFormXObject form = (PDFormXObject)object; COSStream dict = form.getCOSObject(); scope(dict);
                        if (!active.add(dict)) throw new IOException("Cyclic saved Form invocation");
                        try (InputStream in = dict.createInputStream()) {
                            scan(read(in), form.getResources() == null ? resources : form.getResources(), page, dict, frames, state.font, depth + 1);
                        } finally { active.remove(dict); }
                    } else if (object instanceof PDImageXObject) graphics(frames);
                }
                case "BI", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh" -> graphics(frames);
                default -> { }
            }
            args.clear();
        }
        if (frames.size() != base) issues.add("UNBALANCED_MARKED_CONTENT:page:" + page);
    }
    private static List<Item> owners(List<Frame> frames) {
        // Artifact paint cannot make a nested or enclosing real-content tag nonempty.
        if (frames.stream().anyMatch(Frame::artifact)) return List.of();
        return frames.stream().map(Frame::item).filter(Objects::nonNull).distinct().toList();
    }
    private static void graphics(List<Frame> frames) { for (Item owner : owners(frames)) owner.graphics++; }
    private void text(COSBase value, PDFont font, List<Item> owners) throws IOException {
        if (value instanceof COSArray) { for (COSBase child : (COSArray)value) if (child instanceof COSString) text(child, font, owners); return; }
        if (!(value instanceof COSString)) return;
        ByteArrayInputStream bytes = new ByteArrayInputStream(((COSString)value).getBytes());
        while (bytes.available() > 0) {
            if (++glyphs > 2000000) throw new IOException("Saved content glyph limit exceeded");
            int before = bytes.available(), code = font == null ? bytes.read() : font.readCode(bytes);
            if (bytes.available() >= before) throw new IOException("Saved font decoder made no progress");
            String unicode = font == null ? null : font.toUnicode(code);
            boolean unknown = unicode == null || unicode.isEmpty() || unicode.indexOf('\ufffd') >= 0;
            boolean meaningful = !unknown && unicode.codePoints().anyMatch(c -> !Character.isWhitespace(c) && !Character.isSpaceChar(c) && !Character.isISOControl(c) && Character.getType(c) != Character.FORMAT);
            for (Item owner : owners) { owner.glyphs++; if (meaningful) owner.meaningful++; if (unknown) owner.unknown++; }
        }
    }
}
