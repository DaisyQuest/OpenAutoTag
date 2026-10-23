import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;

/** Real Type0 font codes with authored multi-character ToUnicode mappings. */
public class NativeGlyphBoundaryProbe {
    static String hex(byte[] bytes) { return HexFormat.of().formatHex(bytes); }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
    static COSString str(PDFont font, String text) throws Exception { return new COSString(font.encode(text)); }
    static byte[] bytes(COSBase value) throws Exception {
        var out = new ByteArrayOutputStream();
        if (value instanceof COSString s) out.write(s.getBytes());
        else if (value instanceof COSArray a) for (COSBase part : a) if (part instanceof COSString s) out.write(s.getBytes());
        return out.toByteArray();
    }
    public static void main(String[] args) throws Exception {
        try (var doc = new PDDocument(); var input = new FileInputStream(args[0])) {
            var original = PDType0Font.load(doc, input, false);
            var dictionary = new COSDictionary(original.getCOSObject());
            var cmap = new PDStream(doc);
            StringBuilder map = new StringBuilder("/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" +
                "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Boundary def /CMapType 2 def\n" +
                "1 begincodespacerange <0000> <ffff> endcodespacerange\n");
            var mappings = new LinkedHashMap<String,String>();
            mappings.put("\ufb01", "fi"); mappings.put("\u00e9", "e\u0301");
            for (String c : List.of(".", " ", "b", "o", "d", "y")) mappings.put(c, c);
            map.append(mappings.size()).append(" beginbfchar\n");
            for (var entry : mappings.entrySet()) map.append('<').append(hex(original.encode(entry.getKey()))).append("> <")
                .append(hex(entry.getValue().getBytes(StandardCharsets.UTF_16BE))).append(">\n");
            map.append("endbfchar endcmap CMapName currentdict /CMap defineresource pop end end");
            try (var out = cmap.createOutputStream()) { out.write(map.toString().getBytes(StandardCharsets.US_ASCII)); }
            dictionary.setItem(COSName.TO_UNICODE, cmap); var font = new PDType0Font(dictionary);
            COSString source = str(original, "\ufb01.\u00e9 body"); byte[] untouched = source.getBytes().clone();
            for (String marker : List.of("fi", "fi.", "fi.e\u0301", "fi.e\u0301 body")) {
                var split = NativeContentStreamRewriter.splitTextPrefix(font, source, marker);
                check(split != null, "Exact Unicode boundary rejected: " + marker);
                var joined = new ByteArrayOutputStream(); joined.write(bytes(split.prefix)); joined.write(bytes(split.remainder));
                check(Arrays.equals(untouched, joined.toByteArray()), "Glyph bytes changed");
            }
            for (String marker : List.of("f", "fi.e", "fi.e\u0301 bodies", "\ufb01", "", "x".repeat(129)))
                check(NativeContentStreamRewriter.splitTextPrefix(font, source, marker) == null, "Unproven or inside-glyph boundary accepted");
            check(Arrays.equals(untouched, source.getBytes()), "Source operand mutated");
            var array = new COSArray(); array.add(str(original, "\ufb01")); array.add(COSInteger.get(-12));
            array.add(str(original, ".\u00e9")); array.add(COSInteger.get(5)); array.add(str(original, " body"));
            var split = NativeContentStreamRewriter.splitTextPrefix(font, array, "fi.e\u0301");
            check(split != null && ((COSArray)split.prefix).size() == 3 && ((COSArray)split.remainder).size() == 2, "Array boundary changed");
            check(((COSArray)split.prefix).getObject(1) == array.getObject(1) && ((COSArray)split.remainder).getObject(0) == array.getObject(3), "Adjustment changed");
            check(NativeContentStreamRewriter.splitTextPrefix(null, source, "fi") == null, "Missing font accepted");
            check(NativeContentStreamRewriter.splitTextPrefix(font, COSNull.NULL, "fi") == null, "Invalid operand accepted");
            var invalid = new COSArray(); invalid.add(COSNull.NULL);
            check(NativeContentStreamRewriter.splitTextPrefix(font, invalid, "fi") == null, "Invalid array member accepted");
            var huge = new COSArray(); for (int i=0; i<4097; i++) huge.add(COSInteger.ZERO);
            check(NativeContentStreamRewriter.splitTextPrefix(font, huge, "fi") == null, "Array bound ignored");
            check(NativeContentStreamRewriter.splitTextPrefix(font, new COSString(new byte[1048577]), "fi") == null, "Byte bound ignored");
            check(NativeContentStreamRewriter.splitTextPrefix(font, new COSString(new byte[]{(byte)255,(byte)255}), "fi") == null, "Unknown mapping accepted");
            System.out.println("Multibyte codes, ligatures, combining sequences, adjustments, source immutability and rejection bounds verified");
        }
    }
}
