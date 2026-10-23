import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.PDType0Font;

/** Interleaved semantic groups, whitespace, paint and pre-existing markers. */
public class NativeOwnershipProbe {
    public static void main(String[] args) throws Exception {
        if (args[0].startsWith("create")) {
            try (var doc = new PDDocument()) {
                var page = new PDPage(PDRectangle.LETTER); doc.addPage(page);
                var font = PDType0Font.load(doc, new File(args[2]));
                if ("create-list".equals(args[0])) {
                    try (var out = new PDPageContentStream(doc, page)) {
                        out.beginText(); out.setFont(font, 12); out.newLineAtOffset(72, 700);
                        out.showText("1. First"); out.newLineAtOffset(0, -30); out.showText("1. Literal"); out.endText();
                    }
                    doc.save(args[1]); return;
                }
                try (var out = new PDPageContentStream(doc, page)) {
                    out.beginMarkedContent(COSName.getPDFName("OldSource"));
                    out.beginText(); out.setFont(font, 12);
                    out.newLineAtOffset(72, 700); out.showText("Alpha");
                    out.newLineAtOffset(0, -10); out.showText(" ");
                    out.newLineAtOffset(228, -10); out.showText("Beta");
                    out.newLineAtOffset(-228, -10); out.showText("Omega");
                    out.newLineAtOffset(0, -10); out.showText("Unmatched");
                    out.newLineAtOffset(0, -10); out.showText("Last"); out.endText();
                    out.endMarkedContent();
                    out.addRect(72, 620, 20, 10); out.fill();
                }
                var image = new PDStream(doc);
                try (var out = image.createOutputStream()) {
                    out.write("q 12 0 0 12 72 600 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID\n".getBytes(StandardCharsets.US_ASCII));
                    out.write(new byte[]{(byte)255, 0, 0}); out.write("\nEI Q\n".getBytes(StandardCharsets.US_ASCII));
                }
                var contents = new ArrayList<PDStream>(); page.getContentStreams().forEachRemaining(contents::add); contents.add(image); page.setContents(contents);
                doc.save(args[1]);
            }
            return;
        }
        if ("verify-list".equals(args[0])) {
            try (var doc = Loader.loadPDF(new File(args[1]))) {
                var page = doc.getPage(0); var font = page.getResources().getFont(page.getResources().getFontNames().iterator().next());
                var operands = new ArrayList<Object>(); String role = ""; var labels = new StringBuilder(); var body = new StringBuilder();
                for (Object token : new PDFStreamParser(page).parse()) {
                    if (!(token instanceof Operator)) { operands.add(token); continue; }
                    String op = ((Operator)token).getName();
                    if ("BDC".equals(op)) role = ((COSName)operands.get(0)).getName();
                    if ("EMC".equals(op)) role = "";
                    if ("Tj".equals(op)) {
                        var bytes = new ByteArrayInputStream(((COSString)operands.get(0)).getBytes());
                        var text = new StringBuilder(); while (bytes.available() > 0) text.append(font.toUnicode(font.readCode(bytes)));
                        if ("Lbl".equals(role)) labels.append(text); else if ("LBody".equals(role)) body.append(text);
                        else throw new AssertionError("Unowned list content");
                    }
                    operands.clear();
                }
                if (!"1.".contentEquals(labels) || !" First1. Literal".contentEquals(body))
                    throw new AssertionError("List continuation was stolen by label: " + labels + "/" + body);
                System.out.println("Only the first operator supplies the list label");
            }
            return;
        }
        try (var doc = Loader.loadPDF(new File(args[0]))) {
            var stack = new ArrayDeque<String>(); var ids = new HashSet<Integer>();
            var operands = new ArrayList<Object>(); int painted = 0, tagged = 0, artifact = 0;
            for (Object token : new PDFStreamParser(doc.getPage(0)).parse()) {
                if (!(token instanceof Operator)) { operands.add(token); continue; }
                String op = ((Operator)token).getName();
                if ("BDC".equals(op) || "BMC".equals(op)) {
                    if (!stack.isEmpty()) throw new AssertionError("Nested marked content: " + stack);
                    String role = ((COSName)operands.get(0)).getName(); stack.push(role);
                    if ("BDC".equals(op)) {
                        int id = ((COSDictionary)operands.get(1)).getInt(COSName.MCID);
                        if (id < 0 || !ids.add(id)) throw new AssertionError("Invalid or duplicate MCID");
                    }
                } else if ("EMC".equals(op)) {
                    if (stack.isEmpty()) throw new AssertionError("Unbalanced EMC"); stack.pop();
                } else if (Set.of("Tj", "TJ", "'", "\"", "f", "BI").contains(op)) {
                    if (stack.isEmpty()) throw new AssertionError("Unmarked paint: " + op);
                    painted++; if ("Artifact".equals(stack.peek())) artifact++; else tagged++;
                }
                operands.clear();
            }
            if (!stack.isEmpty() || painted != 8 || tagged != 4 || artifact != 4)
                throw new AssertionError("Unexpected ownership: " + painted + "/" + tagged + "/" + artifact + " " + stack);
            System.out.println("Balanced disjoint ownership: 4 tagged text operators, 4 artifact operators");
        }
    }
}
