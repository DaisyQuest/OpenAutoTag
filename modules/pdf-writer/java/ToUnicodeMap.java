import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfparser.PDFStreamParser;

/** Bounded, non-executing inspection of the supported ToUnicode CMap syntax.
 * Unlike PDFont.toUnicode, this never supplies fallback mappings. */
final class ToUnicodeMap {
    static final int MAX_BYTES = 4 * 1024 * 1024, MAX_ENTRIES = 65536;
    final TreeMap<Integer, String> mappings = new TreeMap<>();
    final TreeMap<Integer, String> problems = new TreeMap<>();
    final List<int[]> spaces = new ArrayList<>();
    final Set<Integer> seen = new HashSet<>();
    String state = "valid", reason = "Direct ToUnicode syntax inspected";
    boolean rebuildAllowed = true;
    private final int width;
    private int definitions;
    private ToUnicodeMap(int width) { this.width = width; }

    static ToUnicodeMap inspect(COSDictionary font, int width) {
        ToUnicodeMap result = new ToUnicodeMap(width);
        COSBase raw = font.getDictionaryObject(COSName.TO_UNICODE);
        if (!font.containsKey(COSName.TO_UNICODE)) { result.state = "absent"; result.reason = "No ToUnicode entry"; return result; }
        if (raw == null || raw instanceof COSNull) { result.state = "malformed"; result.reason = "Null ToUnicode entry"; return result; }
        if (!(raw instanceof COSStream)) { result.state = "unsupported"; result.reason = "ToUnicode is not a stream"; result.rebuildAllowed = false; return result; }
        try {
            COSStream stream = (COSStream)raw;
            if (stream.containsKey(COSName.getPDFName("UseCMap"))) throw new Unsupported("Inherited UseCMap requires separate inspection");
            byte[] bytes;
            try (InputStream in = stream.createInputStream()) { bytes = in.readNBytes(MAX_BYTES + 1); }
            if (bytes.length > MAX_BYTES) throw new Unsupported("ToUnicode byte limit exceeded");
            if (bytes.length == 0) { result.state = "malformed"; result.reason = "Empty ToUnicode stream"; return result; }
            List<Object> tokens = new ArrayList<>();
            PDFStreamParser parser = new PDFStreamParser(bytes); Object token;
            while ((token = parser.parseNextToken()) != null) {
                if (tokens.size() >= 200000) throw new Unsupported("ToUnicode token limit exceeded");
                tokens.add(token);
            }
            result.parse(tokens);
        } catch (Unsupported e) { result.state = "unsupported"; result.reason = e.getMessage(); result.rebuildAllowed = false; }
        catch (IOException | IllegalArgumentException e) { result.state = "malformed"; result.reason = e.getMessage(); result.rebuildAllowed = false; }
        return result;
    }
    private static final class Unsupported extends IOException { Unsupported(String message) { super(message); } }
    private static String op(Object value) { return value instanceof Operator ? ((Operator)value).getName() : ""; }
    private static byte[] string(Object value) throws IOException {
        if (!(value instanceof COSString)) throw new IOException("Expected a CMap byte string");
        return ((COSString)value).getBytes();
    }
    private int code(Object value) throws IOException {
        byte[] bytes = string(value);
        if (bytes.length != width) throw new Unsupported("Source code width differs from supported font encoding");
        int code = 0; for (byte b : bytes) code = code * 256 + (b & 255); return code;
    }
    private void put(int code, byte[] bytes) throws IOException {
        if (bytes.length > 512) throw new Unsupported("ToUnicode destination exceeds the 512-byte limit");
        if (++definitions > MAX_ENTRIES) throw new Unsupported("ToUnicode mapping limit exceeded");
        // Adobe CMap specification: succeeding code mappings supersede earlier
        // mappings. Overlapping codespaces, in contrast, are not allowed.
        seen.add(code); mappings.remove(code); problems.remove(code);
        try {
            if (bytes.length == 0 || bytes.length % 2 != 0) throw new CharacterCodingException();
            String value = StandardCharsets.UTF_16BE.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            mappings.put(code, value);
        } catch (CharacterCodingException e) { problems.put(code, "Destination is not a nonempty well-formed UTF-16BE sequence"); }
    }
    private boolean contains(int[] range, int code) {
        for (int shift = 0; shift < width * 8; shift += 8) {
            int b = (code >>> shift) & 255;
            if (b < ((range[0] >>> shift) & 255) || b > ((range[1] >>> shift) & 255)) return false;
        }
        return true;
    }
    private boolean overlaps(int[] range, int first, int last) {
        for (int shift = 0; shift < width * 8; shift += 8)
            if (((first >>> shift) & 255) > ((range[1] >>> shift) & 255) || ((last >>> shift) & 255) < ((range[0] >>> shift) & 255)) return false;
        return true;
    }
    private void parse(List<Object> tokens) throws IOException {
        boolean began = false, ended = false, type = false;
        for (int i = 0; i < tokens.size(); i++) {
            Object value = tokens.get(i); String operation = op(value);
            if (COSName.getPDFName("CMapType").equals(value)) {
                if (type || i + 2 >= tokens.size() || !(tokens.get(i + 1) instanceof COSInteger) ||
                    ((COSInteger)tokens.get(i + 1)).intValue() != 2 || !op(tokens.get(i + 2)).equals("def")) throw new IOException("Invalid CMapType declaration");
                type = true;
            }
            if (operation.equals("begincmap")) { if (began) throw new IOException("Repeated begincmap"); began = true; }
            else if (operation.equals("endcmap")) { if (!began || ended) throw new IOException("Unexpected endcmap"); ended = true; }
            else if (Set.of("begincodespacerange", "beginbfchar", "beginbfrange").contains(operation)) {
                if (!began || ended || i == 0 || !(tokens.get(i - 1) instanceof COSInteger)) throw new IOException("Invalid mapping block");
                long count = ((COSInteger)tokens.get(i - 1)).longValue();
                if (count < 1 || count > 100) throw new IOException("CMap block count must be between 1 and 100");
                for (int row = 0; row < count; row++) {
                    int operands = operation.equals("beginbfrange") ? 3 : 2;
                    if (i + operands >= tokens.size()) throw new IOException("Truncated mapping block");
                    int first = code(tokens.get(++i)); Object second = tokens.get(++i);
                    if (operation.equals("beginbfchar")) put(first, string(second));
                    else {
                        int last = code(second);
                        if (last < first) throw new IOException("Reversed source-code range");
                        if (operation.equals("begincodespacerange")) {
                            for (int shift = 0; shift < width * 8; shift += 8) if (((first >>> shift) & 255) > ((last >>> shift) & 255)) throw new IOException("Invalid multidimensional codespace");
                            for (int[] range : spaces) if (overlaps(range, first, last)) throw new IOException("Overlapping codespace ranges");
                            spaces.add(new int[]{first, last});
                        } else {
                            Object destination = tokens.get(++i);
                            if (destination instanceof COSArray) {
                                COSArray array = (COSArray)destination;
                                if (array.size() != last - first + 1) throw new IOException("bfrange array length mismatch");
                                for (int c = first; c <= last; c++) put(c, string(array.getObject(c - first)));
                            } else {
                                byte[] initial = string(destination);
                                // A ToUnicode scalar bfrange increments only its final byte.
                                if (initial.length == 0 || (initial[initial.length - 1] & 255) + last - first > 255) throw new IOException("bfrange destination would overflow its final byte");
                                for (int c = first; c <= last; c++) { byte[] next = initial.clone(); next[next.length - 1] += c - first; put(c, next); }
                            }
                        }
                    }
                }
                if (++i >= tokens.size() || !op(tokens.get(i)).equals(operation.replaceFirst("begin", "end"))) throw new IOException("Mapping block count or terminator mismatch");
            } else if (!operation.isEmpty() && !(ended && operation.equals("CMapName")) && !Set.of("begin", "end", "dict", "dup", "def", "findresource", "currentdict", "defineresource", "pop", "readonly").contains(operation))
                throw new Unsupported("Unsupported CMap operation: " + operation);
        }
        if (!began || !ended || !type || spaces.isEmpty()) throw new IOException("Missing CMap boundary, type or codespace");
        for (int code : seen) if (spaces.stream().noneMatch(r -> contains(r, code))) throw new IOException("Mapping outside codespace at code " + code);
        if (!problems.isEmpty()) { state = "malformed"; reason = "Invalid Unicode destinations"; }
    }
}
