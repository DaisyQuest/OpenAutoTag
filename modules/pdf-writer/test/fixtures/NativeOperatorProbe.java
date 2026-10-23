import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.rendering.PDFRenderer;

/** Independent lexical oracle: no PDFStreamEngine operator dispatch. */
public class NativeOperatorProbe {
    static final Set<String> TEXT = Set.of("Tj", "TJ", "'", "\"");
    static COSString encoded(PDFont font, String text) throws Exception { return new COSString(font.encode(text)); }
    static void emit(ContentStreamWriter out, String op, Object... operands) throws Exception {
        out.writeTokens(Arrays.asList(operands)); out.writeToken(Operator.getOperator(op));
    }
    static String decode(PDFont font, COSBase value) throws Exception {
        var text = new StringBuilder();
        if (value instanceof COSString s) {
            var input = new ByteArrayInputStream(s.getBytes());
            while (input.available() > 0) text.append(font.toUnicode(font.readCode(input)));
        } else if (value instanceof COSArray a) {
            for (COSBase item : a) if (item instanceof COSString) text.append(decode(font, item));
        }
        return text.toString();
    }
    public static void main(String[] args) throws Exception {
        System.setOut(new PrintStream(System.out, true, StandardCharsets.UTF_8));
        if ("create-lists".equals(args[0])) {
            try (var doc = new PDDocument(); var input = new FileInputStream(args[2])) {
                var font = PDType0Font.load(doc, input, false);
                var page = new PDPage(PDRectangle.LETTER); doc.addPage(page);
                var resources = new PDResources(); resources.put(COSName.getPDFName("F"), font); page.setResources(resources);
                var stream = new PDStream(doc);
                try (var bytes = stream.createOutputStream()) {
                    var out = new ContentStreamWriter(bytes);
                    emit(out, "BT"); emit(out, "Tf", COSName.getPDFName("F"), COSInteger.get(12));
                    emit(out, "Td", COSInteger.get(72), COSInteger.get(720));
                    emit(out, "Tj", encoded(font, "1.")); emit(out, "Tj", encoded(font, " First"));
                    emit(out, "Td", COSInteger.ZERO, COSInteger.get(-30));
                    var array = new COSArray(); array.add(COSInteger.get(20)); array.add(encoded(font, "i")); array.add(COSInteger.get(-40));
                    array.add(encoded(font, "v")); array.add(COSInteger.get(30)); array.add(encoded(font, ". Second")); array.add(COSInteger.get(10));
                    emit(out, "TJ", array);
                    emit(out, "Td", COSInteger.ZERO, COSInteger.get(-30));
                    array = new COSArray(); array.add(COSInteger.get(10)); array.add(encoded(font, "2.")); array.add(COSInteger.get(-8));
                    array.add(new COSString(new byte[0])); array.add(COSInteger.get(4));
                    emit(out, "TJ", array); emit(out, "Tj", encoded(font, " Third"));
                    emit(out, "Td", COSInteger.ZERO, COSInteger.get(-30));
                    array = new COSArray(); array.add(encoded(font, "3.")); array.add(COSInteger.get(-30)); array.add(encoded(font, " Fourth"));
                    emit(out, "TJ", array);
                    emit(out, "ET");
                }
                page.setContents(stream); doc.save(args[1]);
            }
            return;
        }
        if ("create".equals(args[0])) {
            try (var doc = new PDDocument(); var input = new FileInputStream(args[2])) {
                // Full embedding allows direct stream construction without losing subset glyphs.
                var font = PDType0Font.load(doc, input, false);
                for (int p = 0; p < 2; p++) {
                    var page = new PDPage(PDRectangle.LETTER); doc.addPage(page);
                    var resources = new PDResources(); resources.put(COSName.getPDFName("F"), font); page.setResources(resources);
                    var first = new PDStream(doc); var second = new PDStream(doc);
                    try (var bytes = first.createOutputStream()) {
                        var out = new ContentStreamWriter(bytes);
                        emit(out, "BT"); emit(out, "Tf", COSName.getPDFName("F"), COSInteger.get(12));
                        emit(out, "Td", COSInteger.get(72), COSInteger.get(720));
                        emit(out, "Tj", encoded(font, "First"));
                        emit(out, "TD", COSInteger.ZERO, COSInteger.get(-24));
                        emit(out, "Tj", encoded(font, "Second"));
                        emit(out, "'", encoded(font, "Quoted"));
                    }
                    try (var bytes = second.createOutputStream()) {
                        var out = new ContentStreamWriter(bytes);
                        emit(out, "\"", COSInteger.get(2), new COSFloat(.2f), encoded(font, "R\u00e9sum\u00e9"));
                        emit(out, "T*" ); emit(out, "Tj", encoded(font, "After"));
                        emit(out, "T*" );
                        var array = new COSArray(); array.add(encoded(font, "Array ")); array.add(COSInteger.get(-15)); array.add(encoded(font, "Text"));
                        emit(out, "TJ", array); emit(out, "ET");
                    }
                    page.setContents(List.of(first, second));
                }
                doc.save(args[1]);
            }
            return;
        }
        if ("pixels".equals(args[0])) {
            try (var left = Loader.loadPDF(new File(args[1])); var right = Loader.loadPDF(new File(args[2]))) {
                if (left.getNumberOfPages() != right.getNumberOfPages()) throw new AssertionError("Page count changed");
                for (int p = 0; p < left.getNumberOfPages(); p++) {
                    var a = new PDFRenderer(left).renderImageWithDPI(p, 150);
                    var b = new PDFRenderer(right).renderImageWithDPI(p, 150);
                    if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) throw new AssertionError("Page size changed");
                    for (int y = 0; y < a.getHeight(); y++) for (int x = 0; x < a.getWidth(); x++)
                        if (a.getRGB(x, y) != b.getRGB(x, y)) throw new AssertionError("Pixels changed on page " + (p+1));
                }
                System.out.println("All pages pixel-identical at 150 DPI");
            }
            return;
        }
        try (var doc = Loader.loadPDF(new File(args[1]))) {
            for (int p = 0; p < doc.getNumberOfPages(); p++) {
                var page = doc.getPage(p); var font = page.getResources().getFont(COSName.getPDFName("F"));
                var operands = new ArrayList<COSBase>(); int index = 0, seq = 0;
                var owners = new ArrayDeque<Integer>();
                for (Object token : new PDFStreamParser(page).parse()) {
                    if (!(token instanceof Operator op)) { operands.add((COSBase)token); continue; }
                    String name = op.getName();
                    if ("BDC".equals(name)) owners.push(((COSDictionary)operands.get(1)).getInt(COSName.MCID, -1));
                    if ("BMC".equals(name)) owners.push(-1);
                    if ("EMC".equals(name)) owners.pop();
                    if (TEXT.contains(name)) {
                        String text = decode(font, operands.get(operands.size() - 1)); String id = "-";
                        if (!owners.isEmpty() && owners.peek() >= 0) {
                            var tree = doc.getDocumentCatalog().getStructureTreeRoot().getParentTree();
                            var refs = (COSArray) tree.getNumbers().get(page.getStructParents()).getCOSObject();
                            id = ((COSDictionary)refs.getObject(owners.peek())).getString(COSName.ID);
                        }
                        System.out.println((p+1) + "\t" + seq++ + "\t" + index + "\t" + name + "\t" + text + "\t" + id);
                    }
                    index++; operands.clear();
                }
            }
        }
    }
}
