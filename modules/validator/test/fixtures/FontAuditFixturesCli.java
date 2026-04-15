import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;

/**
 * Test-only fixture generator. Writes deterministic PDFs to a target path.
 * Subcommands:
 *   incomplete-tounicode --output <path>   -- embedded TTF whose /ToUnicode covers ~70% of used codes
 *   clean-embedded       --output <path>   -- embedded subset TTF with full /ToUnicode
 *   da-missing-font      --output <path>   -- form field /DA references a font absent from /AcroForm/DR/Font
 */
public class FontAuditFixturesCli {
    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            throw new IllegalArgumentException(
                "Usage: java FontAuditFixturesCli <incomplete-tounicode|clean-embedded|da-missing-font> --output <path>");
        }
        String subcommand = args[0];
        String output = null;
        for (int i = 1; i < args.length; i++) {
            if ("--output".equals(args[i]) && i + 1 < args.length) {
                output = args[i + 1];
            }
        }
        if (output == null) {
            throw new IllegalArgumentException("--output <path> required");
        }
        File outFile = new File(output);
        outFile.getParentFile().mkdirs();

        switch (subcommand) {
            case "clean-embedded":
                writeCleanEmbedded(outFile);
                break;
            case "incomplete-tounicode":
                writeIncompleteToUnicode(outFile);
                break;
            case "da-missing-font":
                writeDaMissingFont(outFile);
                break;
            default:
                throw new IllegalArgumentException("Unknown subcommand: " + subcommand);
        }
    }

    /** Use PDFBox Standard 14 program loaded as a Type0 subset (full embed + ToUnicode). */
    private static void writeCleanEmbedded(File output) throws IOException {
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage();
            document.addPage(page);
            PDFont font = loadHelveticaAsType0(document);
            try (PDPageContentStream cs = new PDPageContentStream(document, page)) {
                cs.beginText();
                cs.setFont(font, 18f);
                cs.newLineAtOffset(72, 720);
                cs.showText("Clean embedded subset");
                cs.endText();
            }
            document.save(output);
        }
    }

    /** Embed a Type0 subset, then surgically replace its /ToUnicode CMap with a partial one. */
    private static void writeIncompleteToUnicode(File output) throws IOException {
        // Phase 1: write a normal embedded subset PDF that uses many letters.
        File tempPdf = File.createTempFile("font-audit-incomp-", ".pdf");
        try {
            try (PDDocument document = new PDDocument()) {
                PDPage page = new PDPage();
                document.addPage(page);
                PDFont font = loadHelveticaAsType0(document);
                String text = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
                try (PDPageContentStream cs = new PDPageContentStream(document, page)) {
                    cs.beginText();
                    cs.setFont(font, 12f);
                    cs.newLineAtOffset(36, 720);
                    cs.showText(text);
                    cs.endText();
                }
                document.save(tempPdf);
            }

            // Phase 2: reopen, locate the embedded font, replace its /ToUnicode stream.
            try (PDDocument document = org.apache.pdfbox.Loader.loadPDF(tempPdf)) {
                PDPage page = document.getPage(0);
                PDResources resources = page.getResources();
                boolean replaced = false;
                for (COSName name : resources.getFontNames()) {
                    PDFont font = resources.getFont(name);
                    if (font == null) continue;
                    COSDictionary fontDict = font.getCOSObject();
                    if (fontDict.getDictionaryObject(COSName.TO_UNICODE) == null) continue;
                    byte[] partialCMap = buildPartialIdentityHCMap();
                    COSStream replacement = document.getDocument().createCOSStream();
                    try (java.io.OutputStream out = replacement.createOutputStream()) {
                        out.write(partialCMap);
                    }
                    fontDict.setItem(COSName.TO_UNICODE, replacement);
                    replaced = true;
                }
                // Type0 font's /ToUnicode lives on the parent (Type0) dictionary, which we just
                // rewrote. The descendant CIDFont can also carry its own mapping; that's OK.
                if (!replaced) {
                    throw new IOException("Could not find a /ToUnicode entry to overwrite.");
                }
                document.save(output);
            }
        } finally {
            tempPdf.delete();
        }
    }

    /** Build an /AcroForm with a /DR fontless and a text field /DA referencing a missing font. */
    private static void writeDaMissingFont(File output) throws IOException {
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage();
            document.addPage(page);

            PDAcroForm acroForm = new PDAcroForm(document);
            document.getDocumentCatalog().setAcroForm(acroForm);

            // DR/Font is empty (no /Helv). Field DA references /Helv which is missing.
            PDResources dr = new PDResources();
            acroForm.setDefaultResources(dr);

            PDTextField field = new PDTextField(acroForm);
            field.setPartialName("MissingFontField");
            // Reference a font alias guaranteed to be absent from any auto-populated DR.
            field.getCOSObject().setString(COSName.DA, "/F-NotPresent 12 Tf 0 g");
            acroForm.getFields().add(field);

            document.save(output);
        }
    }

    private static PDFont loadHelveticaAsType0(PDDocument document) throws IOException {
        // PDFBox 3 ships the Standard 14 font programs (LiberationSans for Helvetica) so we can
        // wrap them as a fully embedded Type0 subset for testing.
        InputStream stream = PDType1Font.class.getResourceAsStream(
            "/org/apache/pdfbox/resources/ttf/LiberationSans-Regular.ttf");
        if (stream == null) {
            // Fall back to whatever PDFBox bundles for Helvetica.
            stream = PDType1Font.class.getResourceAsStream(
                "/org/apache/pdfbox/resources/afm/Helvetica.afm");
            if (stream == null) {
                throw new IOException("PDFBox bundled Standard 14 TTF not found.");
            }
        }
        try (InputStream in = stream) {
            return PDType0Font.load(document, in, true);
        }
    }

    /**
     * Produce a CMap that only maps a tiny handful of CIDs to Unicode, so coverage falls
     * well below the 0.95 threshold once the content stream uses many glyphs.
     */
    private static byte[] buildPartialIdentityHCMap() {
        String cmap =
            "/CIDInit /ProcSet findresource begin\n"
            + "12 dict begin\n"
            + "begincmap\n"
            + "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            + "/CMapName /Adobe-Identity-UCS def\n"
            + "/CMapType 2 def\n"
            + "1 begincodespacerange\n"
            + "<0000> <FFFF>\n"
            + "endcodespacerange\n"
            + "3 beginbfchar\n"
            + "<0001> <0041>\n"
            + "<0002> <0042>\n"
            + "<0003> <0043>\n"
            + "endbfchar\n"
            + "endcmap\n"
            + "CMapName currentdict /CMap defineresource pop\n"
            + "end\nend\n";
        return cmap.getBytes(StandardCharsets.US_ASCII);
    }
}
