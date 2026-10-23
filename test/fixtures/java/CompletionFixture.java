import java.io.File;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.PDType0Font;

/** Embedded-font source with a known, complete two-paragraph content oracle. */
class CompletionFixture {
    public static void main(String[] args) throws Exception {
        try (PDDocument doc = new PDDocument()) {
            PDPage page = new PDPage(); doc.addPage(page);
            var font = PDType0Font.load(doc, new File(args[1]));
            try (var content = new PDPageContentStream(doc, page)) {
                String[] lines = { "First paragraph for accessibility review.", "Second paragraph must remain available." };
                for (int i = 0; i < lines.length; i++) {
                    content.beginText(); content.setFont(font, 12); content.newLineAtOffset(72, 720 - i * 60);
                    content.showText(lines[i]); content.endText();
                }
            }
            doc.save(args[0]);
        }
    }
}
