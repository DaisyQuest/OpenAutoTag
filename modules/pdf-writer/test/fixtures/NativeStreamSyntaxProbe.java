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
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDTrueTypeFont;
import org.apache.pdfbox.pdmodel.font.encoding.WinAnsiEncoding;
import org.apache.pdfbox.rendering.PDFRenderer;

/** Exercise valid operands the former handwritten serializer corrupted. */
public class NativeStreamSyntaxProbe {
    static List<byte[]> operations(PDPage page) throws Exception {
        var result = new ArrayList<byte[]>();
        var operands = new ArrayList<Object>();
        for (Object token : new PDFStreamParser(page).parse()) {
            if (!(token instanceof Operator)) { operands.add(token); continue; }
            Operator op = (Operator) token;
            if (!Set.of("BMC", "BDC", "EMC").contains(op.getName())) {
                var bytes = new ByteArrayOutputStream();
                var writer = new ContentStreamWriter(bytes);
                writer.writeTokens(operands);
                if ("BI".equals(op.getName())) {
                    // This fixture has one unfiltered RGB pixel. Whitespace
                    // separating its three data bytes from EI is not image data.
                    byte[] data = op.getImageData();
                    if (data == null || data.length < 3) throw new AssertionError("Lost inline image");
                    for (int i = 3; i < data.length; i++) if (data[i] != 10 && data[i] != 13 && data[i] != 32)
                        throw new AssertionError("Unexpected inline-image payload");
                    writer.writeToken(op.getImageParameters()); bytes.write(Arrays.copyOf(data, 3));
                } else writer.writeToken(op);
                result.add(bytes.toByteArray());
            }
            operands.clear();
        }
        if (!operands.isEmpty()) throw new AssertionError("Trailing operands");
        return result;
    }
    public static void main(String[] args) throws Exception {
        if (args[0].startsWith("create")) {
            try (var doc = new PDDocument()) {
                var page = new PDPage(PDRectangle.LETTER); doc.addPage(page);
                boolean unembedded = "create-unembedded".equals(args[0]);
                PDFont font = unembedded ? PDTrueTypeFont.load(doc, new File(args[2]), WinAnsiEncoding.INSTANCE)
                    : PDType0Font.load(doc, new File(args[2]));
                try (var stream = new PDPageContentStream(doc, page)) {
                    stream.beginText(); stream.setFont(font, 12); stream.setCharacterSpacing(.00001f);
                    stream.newLineAtOffset(72, 700); stream.showText("Preserve tiny spacing and inline images"); stream.endText();
                }
                COSName original = page.getResources().getFontNames().iterator().next();
                page.getResources().put(COSName.getPDFName("F odd/#"), font);
                page.getResources().getCOSObject().getCOSDictionary(COSName.FONT).removeItem(original);
                if (unembedded) {
                    font.getCOSObject().setName(COSName.BASE_FONT, "ArialNarrow");
                    font.getFontDescriptor().getCOSObject().setName(COSName.FONT_NAME, "ArialNarrow");
                    font.getFontDescriptor().getCOSObject().removeItem(COSName.FONT_FILE2);
                }
                String text;
                try (var in = page.getContents()) { text = new String(in.readAllBytes(), StandardCharsets.ISO_8859_1); }
                text = text.replace("/" + original.getName() + " ", "/F#20odd#2F#23 ");
                var bytes = new ByteArrayOutputStream();
                bytes.write(("/Probe#20properties << /Flag true /Big 4294967297 /Other /Name#20with#23hash " +
                    "/Values [0.00001 -0.00001 3000000000.25 false null] >> DP\n" + text +
                    "\nq 30 0 0 20 72 650 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID\n").getBytes(StandardCharsets.ISO_8859_1));
                bytes.write(new byte[]{(byte)255, 0, 0}); bytes.write("\nEI Q\n".getBytes(StandardCharsets.US_ASCII));
                var stream = new PDStream(doc);
                try (var out = stream.createOutputStream(COSName.FLATE_DECODE)) { out.write(bytes.toByteArray()); }
                page.setContents(stream); doc.save(args[1]);
            }
            return;
        }
        try (var a = Loader.loadPDF(new File(args[0])); var b = Loader.loadPDF(new File(args[1]))) {
            for (COSName name : a.getPage(0).getResources().getFontNames()) {
                var x = a.getPage(0).getResources().getFont(name); var y = b.getPage(0).getResources().getFont(name);
                if (!Objects.equals(x.getName(), y.getName()) || x.isEmbedded() != y.isEmbedded())
                    throw new AssertionError("Unqualified font replacement: " + x.getName() + " -> " + y.getName());
            }
            var left = operations(a.getPage(0)); var right = operations(b.getPage(0));
            if (left.size() != right.size()) throw new AssertionError("Changed operator count: " + left.size() + " -> " + right.size());
            for (int i = 0; i < left.size(); i++) if (!Arrays.equals(left.get(i), right.get(i)))
                throw new AssertionError("Changed operand or inline-image data at operation " + i);
            var x = new PDFRenderer(a).renderImageWithDPI(0, 150);
            var y = new PDFRenderer(b).renderImageWithDPI(0, 150);
            if (x.getWidth() != y.getWidth() || x.getHeight() != y.getHeight()) throw new AssertionError("Changed dimensions");
            for (int row = 0; row < x.getHeight(); row++) for (int col = 0; col < x.getWidth(); col++)
                if (x.getRGB(col, row) != y.getRGB(col, row)) throw new AssertionError("Changed pixels");
            System.out.println("All operands, inline-image bytes and 150 DPI pixels preserved");
        }
    }
}
