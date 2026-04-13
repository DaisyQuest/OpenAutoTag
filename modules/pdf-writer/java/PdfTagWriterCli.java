import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Calendar;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;
import java.util.TreeMap;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNull;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDPageContentStream.AppendMode;
import org.apache.pdfbox.pdmodel.common.COSObjectable;
import org.apache.pdfbox.pdmodel.common.PDMetadata;
import org.apache.pdfbox.pdmodel.common.PDNumberTreeNode;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkInfo;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDParentTreeValue;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureNode;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
import org.apache.pdfbox.pdmodel.documentinterchange.taggedpdf.PDTableAttributeObject;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.graphics.state.RenderingMode;
import org.apache.pdfbox.pdmodel.interactive.viewerpreferences.PDViewerPreferences;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;

public class PdfTagWriterCli {
    private static final String DOCUMENT_AUTHOR = "PDF Accessibility Engine";
    private static final String DOCUMENT_SUBJECT = "Tagged PDF output";
    private static final String DOCUMENT_PRODUCER = "PDF Accessibility Engine";

    private static class Instruction {
        String id;
        String parentId;
        String type;
        int pageNumber;
        float x;
        float y;
        float width;
        float height;
        int rowSpan;
        int columnSpan;
        int tableRowIndex;
        int tableColumnIndex;
        String tableSection;
        String scope;
        String text;
    }

    private static class RedactionInstruction {
        int pageNumber;
        float x;
        float y;
        float width;
        float height;
    }

    private static class PageState {
        int pageKey;
        int nextMCID;
        COSArray parentArray = new COSArray();
        PDPageContentStream contentStream;
        PDPage page;
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String pdfPath = requireOption(options, "--pdf");
        String instructionsPath = requireOption(options, "--instructions");
        String outputPath = requireOption(options, "--output");
        String title = options.getOrDefault("--title", "Tagged PDF");
        String language = options.getOrDefault("--language", "en-US");
        String redactionsPath = options.get("--redactions");

        List<Instruction> instructions = readInstructions(instructionsPath);
        Map<Integer, List<RedactionInstruction>> redactionsByPage =
            redactionsPath == null || redactionsPath.isBlank() ? Map.of() : readRedactions(redactionsPath);

        try (PDDocument sourceDocument = Loader.loadPDF(new File(pdfPath)); PDDocument outputDocument = new PDDocument()) {
            List<PDPage> outputPages = clonePagesAsArtifactImages(sourceDocument, outputDocument, redactionsByPage);
            PDDocumentCatalog catalog = outputDocument.getDocumentCatalog();
            applyMetadata(outputDocument, catalog, title, language);
            PDFont overlayFont = loadOverlayFont();

            PDStructureTreeRoot structureTreeRoot = new PDStructureTreeRoot();
            catalog.setStructureTreeRoot(structureTreeRoot);

            PDMarkInfo markInfo = new PDMarkInfo();
            markInfo.setMarked(true);
            catalog.setMarkInfo(markInfo);

            Map<String, PDStructureElement> elements = new LinkedHashMap<>();
            Map<Integer, PageState> pageStates = new LinkedHashMap<>();
            int[] nextPageKey = new int[] { 0 };
            int structureElementCount = 0;
            int markedContentCount = 0;
            int tableAttributeCount = 0;

            for (Instruction instruction : instructions) {
                PDStructureNode parentNode;
                if (instruction.parentId == null || instruction.parentId.isEmpty()) {
                    parentNode = structureTreeRoot;
                } else {
                    parentNode = elements.get(instruction.parentId);
                    if (parentNode == null) {
                        throw new IllegalStateException("Missing parent node for instruction " + instruction.id);
                    }
                }

                PDStructureElement element = new PDStructureElement(instruction.type, parentNode);
                if (parentNode instanceof PDStructureTreeRoot) {
                    ((PDStructureTreeRoot) parentNode).appendKid(element);
                } else {
                    ((PDStructureElement) parentNode).appendKid(element);
                }

                if (!instruction.text.isEmpty()) {
                    element.setActualText(instruction.text);
                }

                if (applyTableAttributes(element, instruction)) {
                    tableAttributeCount++;
                }

                elements.put(instruction.id, element);
                structureElementCount++;

                if (instruction.pageNumber > 0 && !instruction.text.isEmpty()) {
                    PDPage page = outputPages.get(instruction.pageNumber - 1);
                    PageState pageState = pageStates.get(instruction.pageNumber);
                    if (pageState == null) {
                        pageState = createPageState(outputDocument, page, nextPageKey[0]++);
                        pageStates.put(instruction.pageNumber, pageState);
                    }

                    int mcid = pageState.nextMCID++;
                    element.setPage(pageState.page);
                    element.appendKid(mcid);
                    setParentArrayValue(pageState.parentArray, mcid, element.getCOSObject());
                    appendInvisibleText(pageState, overlayFont, mcid, instruction);
                    markedContentCount++;
                }
            }

            PDNumberTreeNode parentTree = new PDNumberTreeNode(PDParentTreeValue.class);
            Map<Integer, COSObjectable> numbers = new TreeMap<>();
            for (PageState pageState : pageStates.values()) {
                if (pageState.contentStream != null) {
                    pageState.contentStream.close();
                }
                numbers.put(pageState.pageKey, new PDParentTreeValue(pageState.parentArray));
            }
            parentTree.setNumbers(numbers);
            structureTreeRoot.setParentTree(parentTree);
            structureTreeRoot.setParentTreeNextKey(nextPageKey[0]);

            outputDocument.save(outputPath);

            String json = "{"
                + "\"nativeTaggingApplied\":" + (markedContentCount > 0)
                + ",\"structureElementCount\":" + structureElementCount
                + ",\"markedContentCount\":" + markedContentCount
                + ",\"tableAttributeCount\":" + tableAttributeCount
                + ",\"redactionCount\":" + countRedactions(redactionsByPage)
                + ",\"pageStructParentCount\":" + pageStates.size()
                + ",\"metadataApplied\":true"
                + ",\"reconstructedFromArtifactImages\":true"
                + "}";
            System.out.println(json);
        }
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> options = new LinkedHashMap<>();
        for (int index = 0; index < args.length - 1; index += 2) {
            options.put(args[index], args[index + 1]);
        }
        return options;
    }

    private static String requireOption(Map<String, String> options, String name) {
        String value = options.get(name);
        if (value == null || value.isEmpty()) {
            throw new IllegalArgumentException("Missing required option " + name);
        }
        return value;
    }

    private static List<Instruction> readInstructions(String instructionsPath) throws Exception {
        List<Instruction> instructions = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new FileReader(instructionsPath, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }

                String[] parts = line.split("\t", -1);
                if (parts.length != 15) {
                    throw new IllegalArgumentException("Invalid instruction line: " + line);
                }

                Instruction instruction = new Instruction();
                instruction.id = parts[0];
                instruction.parentId = parts[1];
                instruction.type = parts[2];
                instruction.pageNumber = parseInt(parts[3]);
                instruction.x = parseFloat(parts[4]);
                instruction.y = parseFloat(parts[5]);
                instruction.width = parseFloat(parts[6]);
                instruction.height = parseFloat(parts[7]);
                instruction.rowSpan = parseInt(parts[8]);
                instruction.columnSpan = parseInt(parts[9]);
                instruction.tableRowIndex = parseInt(parts[10]);
                instruction.tableColumnIndex = parseInt(parts[11]);
                instruction.tableSection = parts[12];
                instruction.scope = parts[13];
                instruction.text = new String(Base64.getDecoder().decode(parts[14]), StandardCharsets.UTF_8);
                instructions.add(instruction);
            }
        }
        return instructions;
    }

    private static boolean applyTableAttributes(PDStructureElement element, Instruction instruction) {
        if (!"TH".equals(instruction.type) && !"TD".equals(instruction.type)) {
            return false;
        }

        PDTableAttributeObject attributes = new PDTableAttributeObject();
        boolean applied = false;

        if (instruction.rowSpan > 1) {
            attributes.setRowSpan(instruction.rowSpan);
            applied = true;
        }

        if (instruction.columnSpan > 1) {
            attributes.setColSpan(instruction.columnSpan);
            applied = true;
        }

        if ("TH".equals(instruction.type)) {
            String scope = normalizeScope(instruction.scope);
            if (!scope.isEmpty()) {
                attributes.setScope(scope);
                applied = true;
            }
        }

        if (applied) {
            element.addAttribute(attributes);
        }

        return applied;
    }

    private static int countRedactions(Map<Integer, List<RedactionInstruction>> redactionsByPage) {
        int count = 0;
        for (List<RedactionInstruction> pageRedactions : redactionsByPage.values()) {
            count += pageRedactions.size();
        }
        return count;
    }

    private static String normalizeScope(String scope) {
        if (scope == null || scope.isBlank()) {
            return "";
        }

        String normalized = scope.trim().toLowerCase();
        switch (normalized) {
            case "row":
                return PDTableAttributeObject.SCOPE_ROW;
            case "column":
                return PDTableAttributeObject.SCOPE_COLUMN;
            case "both":
                return PDTableAttributeObject.SCOPE_BOTH;
            default:
                return "";
        }
    }

    private static Map<Integer, List<RedactionInstruction>> readRedactions(String redactionsPath) throws Exception {
        Map<Integer, List<RedactionInstruction>> redactionsByPage = new LinkedHashMap<>();

        try (BufferedReader reader = new BufferedReader(new FileReader(redactionsPath, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }

                String[] parts = line.split("\t", -1);
                if (parts.length != 5) {
                    throw new IllegalArgumentException("Invalid redaction line: " + line);
                }

                RedactionInstruction instruction = new RedactionInstruction();
                instruction.pageNumber = parseInt(parts[0]);
                instruction.x = parseFloat(parts[1]);
                instruction.y = parseFloat(parts[2]);
                instruction.width = parseFloat(parts[3]);
                instruction.height = parseFloat(parts[4]);

                redactionsByPage.computeIfAbsent(instruction.pageNumber, key -> new ArrayList<>()).add(instruction);
            }
        }

        return redactionsByPage;
    }

    private static int parseInt(String value) {
        return value == null || value.isEmpty() ? 0 : Integer.parseInt(value);
    }

    private static float parseFloat(String value) {
        return value == null || value.isEmpty() ? 0f : Float.parseFloat(value);
    }

    private static PDFont loadOverlayFont() {
        return new PDType1Font(Standard14Fonts.FontName.HELVETICA);
    }

    private static List<PDPage> clonePagesAsArtifactImages(
        PDDocument sourceDocument,
        PDDocument outputDocument,
        Map<Integer, List<RedactionInstruction>> redactionsByPage
    ) throws Exception {
        PDFRenderer renderer = new PDFRenderer(sourceDocument);
        List<PDPage> outputPages = new ArrayList<>();

        for (int pageIndex = 0; pageIndex < sourceDocument.getNumberOfPages(); pageIndex++) {
            PDPage sourcePage = sourceDocument.getPage(pageIndex);
            PDPage outputPage = new PDPage(sourcePage.getMediaBox());
            outputPage.setCropBox(sourcePage.getCropBox());
            outputPage.setRotation(sourcePage.getRotation());
            outputPage.getCOSObject().setItem(COSName.getPDFName("Tabs"), COSName.S);
            outputDocument.addPage(outputPage);
            outputPages.add(outputPage);

            BufferedImage renderedPage = renderer.renderImageWithDPI(pageIndex, 144, ImageType.RGB);
            applyRedactions(renderedPage, sourcePage, redactionsByPage.getOrDefault(pageIndex + 1, List.of()));
            PDImageXObject image = LosslessFactory.createFromImage(outputDocument, renderedPage);
            try (PDPageContentStream stream = new PDPageContentStream(outputDocument, outputPage)) {
                stream.beginMarkedContent(COSName.ARTIFACT);
                stream.drawImage(image, 0, 0, outputPage.getMediaBox().getWidth(), outputPage.getMediaBox().getHeight());
                stream.endMarkedContent();
            }
        }

        return outputPages;
    }

    private static void applyRedactions(BufferedImage image, PDPage sourcePage, List<RedactionInstruction> redactions) {
        if (redactions == null || redactions.isEmpty()) {
            return;
        }

        float pageWidth = Math.max(sourcePage.getMediaBox().getWidth(), 1f);
        float pageHeight = Math.max(sourcePage.getMediaBox().getHeight(), 1f);
        double scaleX = image.getWidth() / pageWidth;
        double scaleY = image.getHeight() / pageHeight;
        int maxX = Math.max(image.getWidth() - 1, 0);
        int maxY = Math.max(image.getHeight() - 1, 0);
        java.awt.Graphics2D graphics = image.createGraphics();
        graphics.setColor(java.awt.Color.BLACK);

        for (RedactionInstruction instruction : redactions) {
            int x = clamp((int) Math.floor(instruction.x * scaleX), 0, maxX);
            int y = clamp((int) Math.floor(instruction.y * scaleY), 0, maxY);
            int remainingWidth = image.getWidth() - x;
            int remainingHeight = image.getHeight() - y;

            if (remainingWidth <= 0 || remainingHeight <= 0) {
                continue;
            }

            int width = clamp((int) Math.ceil(instruction.width * scaleX), 1, remainingWidth);
            int height = clamp((int) Math.ceil(instruction.height * scaleY), 1, remainingHeight);
            graphics.fillRect(x, y, width, height);
        }

        graphics.dispose();
    }

    private static void applyMetadata(PDDocument document, PDDocumentCatalog catalog, String title, String language) throws Exception {
        document.setVersion(1.7f);
        Instant metadataTimestamp = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Calendar metadataCalendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        metadataCalendar.setTimeInMillis(metadataTimestamp.toEpochMilli());

        PDDocumentInformation information = document.getDocumentInformation();
        information.setTitle(title);
        information.setAuthor(DOCUMENT_AUTHOR);
        information.setCreator(DOCUMENT_PRODUCER);
        information.setProducer(DOCUMENT_PRODUCER);
        information.setSubject(DOCUMENT_SUBJECT);
        information.setCreationDate((Calendar) metadataCalendar.clone());
        information.setModificationDate((Calendar) metadataCalendar.clone());

        catalog.setLanguage(language);

        PDViewerPreferences viewerPreferences = catalog.getViewerPreferences();
        if (viewerPreferences == null) {
            viewerPreferences = new PDViewerPreferences();
        }
        viewerPreferences.setDisplayDocTitle(true);
        catalog.setViewerPreferences(viewerPreferences);

        PDMetadata metadata = new PDMetadata(document);
        metadata.importXMPMetadata(buildXmp(title, language, metadataTimestamp).getBytes(StandardCharsets.UTF_8));
        catalog.setMetadata(metadata);
    }

    private static String buildXmp(String title, String language, Instant metadataTimestamp) {
        String escapedTitle = escapeXml(title);
        String escapedLanguage = escapeXml(language);
        String escapedAuthor = escapeXml(DOCUMENT_AUTHOR);
        String escapedSubject = escapeXml(DOCUMENT_SUBJECT);
        String escapedProducer = escapeXml(DOCUMENT_PRODUCER);
        String timestamp = metadataTimestamp.toString();
        StringBuilder xml = new StringBuilder();
        xml.append("<?xpacket begin=\"?\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n");
        xml.append("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"PDF Accessibility Engine\">\n");
        xml.append("  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n");
        xml.append("    <rdf:Description rdf:about=\"\"\n");
        xml.append("      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n");
        xml.append("      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n");
        xml.append("      xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\"\n");
        xml.append("      xmlns:pdfaExtension=\"http://www.aiim.org/pdfa/ns/extension/\"\n");
        xml.append("      xmlns:pdfaSchema=\"http://www.aiim.org/pdfa/ns/schema#\"\n");
        xml.append("      xmlns:pdfaProperty=\"http://www.aiim.org/pdfa/ns/property#\"\n");
        xml.append("      xmlns:pdfuaid=\"http://www.aiim.org/pdfua/ns/id/\">\n");
        xml.append("      <dc:title>\n");
        xml.append("        <rdf:Alt>\n");
        xml.append("          <rdf:li xml:lang=\"x-default\">").append(escapedTitle).append("</rdf:li>\n");
        xml.append("        </rdf:Alt>\n");
        xml.append("      </dc:title>\n");
        xml.append("      <dc:description>\n");
        xml.append("        <rdf:Alt>\n");
        xml.append("          <rdf:li xml:lang=\"x-default\">").append(escapedSubject).append("</rdf:li>\n");
        xml.append("        </rdf:Alt>\n");
        xml.append("      </dc:description>\n");
        xml.append("      <dc:creator>\n");
        xml.append("        <rdf:Seq>\n");
        xml.append("          <rdf:li>").append(escapedAuthor).append("</rdf:li>\n");
        xml.append("        </rdf:Seq>\n");
        xml.append("      </dc:creator>\n");
        xml.append("      <dc:language>\n");
        xml.append("        <rdf:Bag>\n");
        xml.append("          <rdf:li>").append(escapedLanguage).append("</rdf:li>\n");
        xml.append("        </rdf:Bag>\n");
        xml.append("      </dc:language>\n");
        xml.append("      <xmp:CreatorTool>PDF Accessibility Engine</xmp:CreatorTool>\n");
        xml.append("      <xmp:CreateDate>").append(timestamp).append("</xmp:CreateDate>\n");
        xml.append("      <xmp:ModifyDate>").append(timestamp).append("</xmp:ModifyDate>\n");
        xml.append("      <pdf:Producer>").append(escapedProducer).append("</pdf:Producer>\n");
        xml.append("      <pdfaExtension:schemas>\n");
        xml.append("        <rdf:Bag>\n");
        xml.append("          <rdf:li>\n");
        xml.append("            <rdf:Description>\n");
        xml.append("              <pdfaSchema:schema>PDF/UA ID Schema</pdfaSchema:schema>\n");
        xml.append("              <pdfaSchema:namespaceURI>http://www.aiim.org/pdfua/ns/id/</pdfaSchema:namespaceURI>\n");
        xml.append("              <pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>\n");
        xml.append("              <pdfaSchema:property>\n");
        xml.append("                <rdf:Seq>\n");
        xml.append("                  <rdf:li>\n");
        xml.append("                    <rdf:Description>\n");
        xml.append("                      <pdfaProperty:name>part</pdfaProperty:name>\n");
        xml.append("                      <pdfaProperty:valueType>Integer</pdfaProperty:valueType>\n");
        xml.append("                      <pdfaProperty:category>internal</pdfaProperty:category>\n");
        xml.append("                      <pdfaProperty:description>Part of PDF/UA standard</pdfaProperty:description>\n");
        xml.append("                    </rdf:Description>\n");
        xml.append("                  </rdf:li>\n");
        xml.append("                  <rdf:li>\n");
        xml.append("                    <rdf:Description>\n");
        xml.append("                      <pdfaProperty:name>amd</pdfaProperty:name>\n");
        xml.append("                      <pdfaProperty:valueType>Text</pdfaProperty:valueType>\n");
        xml.append("                      <pdfaProperty:category>internal</pdfaProperty:category>\n");
        xml.append("                      <pdfaProperty:description>Optional PDF/UA amendment identifier</pdfaProperty:description>\n");
        xml.append("                    </rdf:Description>\n");
        xml.append("                  </rdf:li>\n");
        xml.append("                  <rdf:li>\n");
        xml.append("                    <rdf:Description>\n");
        xml.append("                      <pdfaProperty:name>corr</pdfaProperty:name>\n");
        xml.append("                      <pdfaProperty:valueType>Text</pdfaProperty:valueType>\n");
        xml.append("                      <pdfaProperty:category>internal</pdfaProperty:category>\n");
        xml.append("                      <pdfaProperty:description>Optional PDF/UA corrigenda identifier</pdfaProperty:description>\n");
        xml.append("                    </rdf:Description>\n");
        xml.append("                  </rdf:li>\n");
        xml.append("                </rdf:Seq>\n");
        xml.append("              </pdfaSchema:property>\n");
        xml.append("            </rdf:Description>\n");
        xml.append("          </rdf:li>\n");
        xml.append("        </rdf:Bag>\n");
        xml.append("      </pdfaExtension:schemas>\n");
        xml.append("      <pdfuaid:part>1</pdfuaid:part>\n");
        xml.append("    </rdf:Description>\n");
        xml.append("  </rdf:RDF>\n");
        xml.append("</x:xmpmeta>\n");
        xml.append("<?xpacket end=\"w\"?>");
        return xml.toString();
    }

    private static String escapeXml(String value) {
        return value
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&apos;");
    }

    private static PageState createPageState(PDDocument document, PDPage page, int pageKey) throws Exception {
        PageState state = new PageState();
        state.page = page;
        state.pageKey = pageKey;
        state.contentStream = new PDPageContentStream(document, page, AppendMode.APPEND, true, true);
        page.setStructParents(pageKey);
        page.getCOSObject().setItem(COSName.getPDFName("Tabs"), COSName.S);
        return state;
    }

    private static void setParentArrayValue(COSArray parentArray, int index, COSBase value) {
        while (parentArray.size() <= index) {
            parentArray.add(COSNull.NULL);
        }
        parentArray.set(index, value);
    }

    private static void appendInvisibleText(PageState pageState, PDFont overlayFont, int mcid, Instruction instruction) throws Exception {
        float pageHeight = pageState.page.getMediaBox().getHeight();
        float x = instruction.x;
        float y = Math.max(0f, pageHeight - instruction.y - instruction.height);
        float fontSize = Math.max(6f, instruction.height > 0f ? instruction.height : 10f);
        String safeText = sanitizeOverlayText(overlayFont, instruction.text);

        if (safeText.isEmpty()) {
            safeText = "?";
        }

        pageState.contentStream.saveGraphicsState();
        pageState.contentStream.beginMarkedContent(COSName.getPDFName("Span"), mcid);
        pageState.contentStream.beginText();
        pageState.contentStream.setFont(overlayFont, fontSize);
        pageState.contentStream.setRenderingMode(RenderingMode.NEITHER);
        pageState.contentStream.newLineAtOffset(x, y);
        pageState.contentStream.showText(safeText);
        pageState.contentStream.endText();
        pageState.contentStream.endMarkedContent();
        pageState.contentStream.restoreGraphicsState();
    }

    private static String sanitizeOverlayText(PDFont font, String value) {
        StringBuilder sanitized = new StringBuilder();
        for (int index = 0; index < value.length();) {
            int codePoint = value.codePointAt(index);
            index += Character.charCount(codePoint);

            if (codePoint < 32 && codePoint != '\n' && codePoint != '\r' && codePoint != '\t') {
                continue;
            }

            String original = new String(Character.toChars(codePoint));
            if (canEncode(font, original)) {
                sanitized.append(original);
                continue;
            }

            String fallback = fallbackTextForCodePoint(codePoint);
            if (!fallback.isEmpty() && canEncode(font, fallback)) {
                sanitized.append(fallback);
                continue;
            }

            String normalized = normalizeToAscii(original);
            if (!normalized.isEmpty() && canEncode(font, normalized)) {
                sanitized.append(normalized);
                continue;
            }

            if (Character.isWhitespace(codePoint)) {
                sanitized.append(' ');
                continue;
            }

            sanitized.append('?');
        }
        return sanitized.toString();
    }

    private static boolean canEncode(PDFont font, String value) {
        try {
            font.encode(value);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private static String normalizeToAscii(String value) {
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFKD);
        StringBuilder ascii = new StringBuilder();
        for (int index = 0; index < normalized.length(); index += 1) {
            char character = normalized.charAt(index);
            if (Character.getType(character) == Character.NON_SPACING_MARK) {
                continue;
            }
            if (character >= 32 && character <= 126) {
                ascii.append(character);
            }
        }
        return ascii.toString();
    }

    private static String fallbackTextForCodePoint(int codePoint) {
        switch (codePoint) {
            case 0x00A0:
                return " ";
            case 0x2010:
            case 0x2011:
            case 0x2012:
            case 0x2013:
            case 0x2014:
            case 0x2212:
                return "-";
            case 0x2018:
            case 0x2019:
            case 0x2032:
                return "'";
            case 0x201C:
            case 0x201D:
            case 0x2033:
                return "\"";
            case 0x2022:
                return "*";
            case 0x2026:
                return "...";
            case 0x00D7:
                return "x";
            case 0x2211:
                return "sum";
            case 0x220F:
                return "product";
            case 0x222B:
                return "integral";
            case 0x221A:
                return "sqrt";
            case 0x221E:
                return "infinity";
            case 0x2260:
                return "!=";
            case 0x2264:
                return "<=";
            case 0x2265:
                return ">=";
            case 0x0394:
                return "Delta";
            case 0x03A3:
                return "Sigma";
            case 0x03A9:
                return "Omega";
            case 0x03B1:
                return "alpha";
            case 0x03B2:
                return "beta";
            case 0x03B3:
                return "gamma";
            case 0x03C0:
                return "pi";
            case 0x266D:
                return "flat";
            case 0x266E:
                return "natural";
            case 0x266F:
                return "sharp";
            default:
                return "";
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
