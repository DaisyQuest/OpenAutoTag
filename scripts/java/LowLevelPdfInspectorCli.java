import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageTree;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

public class LowLevelPdfInspectorCli {
    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String pdfPath = requireOption(options, "--pdf");

        try (PDDocument document = Loader.loadPDF(new File(pdfPath))) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("pdfPath", new File(pdfPath).getAbsolutePath());
            result.put("pageCount", document.getNumberOfPages());
            result.put("catalog", inspectCatalog(document));
            result.put("structureTree", inspectStructureTree(document));
            result.put("pages", inspectPages(document));
            System.out.println(toJson(result));
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

    private static Map<String, Object> inspectCatalog(PDDocument document) {
        PDDocumentCatalog catalog = document.getDocumentCatalog();
        PDDocumentInformation info = document.getDocumentInformation();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("version", document.getVersion());
        result.put("hasStructTreeRoot", catalog.getStructureTreeRoot() != null);
        result.put("hasMetadata", catalog.getMetadata() != null);
        result.put("hasMarkInfo", catalog.getMarkInfo() != null);
        result.put("marked", catalog.getMarkInfo() != null && catalog.getMarkInfo().isMarked());
        result.put("language", catalog.getLanguage());
        result.put("title", info.getTitle());
        result.put("author", info.getAuthor());
        result.put("creator", info.getCreator());
        result.put("producer", info.getProducer());
        return result;
    }

    private static Map<String, Object> inspectStructureTree(PDDocument document) {
        Map<String, Object> result = new LinkedHashMap<>();
        PDDocumentCatalog catalog = document.getDocumentCatalog();
        if (catalog.getStructureTreeRoot() == null) {
            result.put("exists", false);
            result.put("typeCounts", new LinkedHashMap<String, Object>());
            result.put("totalTypedNodes", 0);
            result.put("tableAttributeNodeCount", 0);
            result.put("attributeSamples", new ArrayList<Object>());
            return result;
        }

        Map<String, Integer> typeCounts = new TreeMap<>();
        COSDictionary rootDictionary = catalog.getStructureTreeRoot().getCOSObject();
        List<Map<String, Object>> attributeSamples = new ArrayList<>();
        int[] tableAttributeNodeCount = new int[] { 0 };
        walkStructureKid(rootDictionary.getDictionaryObject(COSName.K), typeCounts, attributeSamples, tableAttributeNodeCount);

        int totalTypedNodes = 0;
        for (Integer count : typeCounts.values()) {
            totalTypedNodes += count;
        }

        result.put("exists", true);
        result.put("parentTreeNextKey", rootDictionary.getInt(COSName.PARENT_TREE_NEXT_KEY));
        result.put("typeCounts", typeCounts);
        result.put("totalTypedNodes", totalTypedNodes);
        result.put("tableAttributeNodeCount", tableAttributeNodeCount[0]);
        result.put("attributeSamples", attributeSamples);
        return result;
    }

    private static void walkStructureKid(COSBase kid, Map<String, Integer> typeCounts, List<Map<String, Object>> attributeSamples, int[] tableAttributeNodeCount) {
        COSBase resolved = resolve(kid);
        if (resolved == null) {
            return;
        }

        if (resolved instanceof COSArray) {
            COSArray array = (COSArray) resolved;
            for (int index = 0; index < array.size(); index += 1) {
                walkStructureKid(array.get(index), typeCounts, attributeSamples, tableAttributeNodeCount);
            }
            return;
        }

        if (resolved instanceof COSDictionary) {
            COSDictionary dictionary = (COSDictionary) resolved;
            String structureType = dictionary.getNameAsString(COSName.S);
            if (structureType != null) {
                typeCounts.put(structureType, typeCounts.getOrDefault(structureType, 0) + 1);
                inspectStructureAttributes(dictionary, structureType, attributeSamples, tableAttributeNodeCount);
            }
            walkStructureKid(dictionary.getDictionaryObject(COSName.K), typeCounts, attributeSamples, tableAttributeNodeCount);
        }
    }

    private static void inspectStructureAttributes(
        COSDictionary dictionary,
        String structureType,
        List<Map<String, Object>> attributeSamples,
        int[] tableAttributeNodeCount
    ) {
        List<COSDictionary> attributeDictionaries = new ArrayList<>();
        collectAttributeDictionaries(dictionary.getDictionaryObject(COSName.A), attributeDictionaries);

        for (COSDictionary attributeDictionary : attributeDictionaries) {
            if (!"Table".equals(attributeDictionary.getNameAsString(COSName.O))) {
                continue;
            }

            tableAttributeNodeCount[0] += 1;

            if (attributeSamples.size() >= 12) {
                continue;
            }

            Map<String, Object> sample = new LinkedHashMap<>();
            sample.put("structureType", structureType);
            sample.put("rowSpan", attributeDictionary.getInt("RowSpan", 1));
            sample.put("colSpan", attributeDictionary.getInt("ColSpan", 1));
            sample.put("scope", attributeDictionary.getNameAsString("Scope"));
            sample.put("summary", attributeDictionary.getString("Summary"));
            attributeSamples.add(sample);
        }
    }

    private static void collectAttributeDictionaries(COSBase attributeBase, List<COSDictionary> results) {
        COSBase resolved = resolve(attributeBase);
        if (resolved == null) {
            return;
        }

        if (resolved instanceof COSDictionary) {
            results.add((COSDictionary) resolved);
            return;
        }

        if (resolved instanceof COSArray) {
            COSArray array = (COSArray) resolved;
            for (int index = 0; index < array.size(); index += 1) {
                collectAttributeDictionaries(array.get(index), results);
            }
        }
    }

    private static List<Map<String, Object>> inspectPages(PDDocument document) throws Exception {
        List<Map<String, Object>> pages = new ArrayList<>();
        PDPageTree pageTree = document.getPages();

        int index = 0;
        for (PDPage page : pageTree) {
            Map<String, Object> pageInfo = new LinkedHashMap<>();
            pageInfo.put("pageNumber", index + 1);
            pageInfo.put("structParents", page.getCOSObject().getInt(COSName.STRUCT_PARENTS, -1));
            pageInfo.put("resources", inspectResources(page));
            pageInfo.put("contentStreams", countContentStreams(page));
            pageInfo.put("operators", inspectOperators(page));
            pages.add(pageInfo);
            index += 1;
        }

        return pages;
    }

    private static Map<String, Object> inspectResources(PDPage page) throws Exception {
        Map<String, Object> result = new LinkedHashMap<>();
        PDResources resources = page.getResources();
        List<Map<String, Object>> fonts = new ArrayList<>();
        List<Map<String, Object>> xObjects = new ArrayList<>();

        if (resources != null) {
            for (COSName fontName : resources.getFontNames()) {
                Map<String, Object> font = new LinkedHashMap<>();
                font.put("name", fontName.getName());
                font.put("baseFont", resources.getFont(fontName).getName());
                fonts.add(font);
            }

            for (COSName xObjectName : resources.getXObjectNames()) {
                PDXObject xObject = resources.getXObject(xObjectName);
                Map<String, Object> xObjectInfo = new LinkedHashMap<>();
                xObjectInfo.put("name", xObjectName.getName());
                xObjectInfo.put("className", xObject.getClass().getSimpleName());
                xObjectInfo.put("subtype", xObject.getCOSObject().getNameAsString(COSName.SUBTYPE));
                xObjectInfo.put("isImage", xObject instanceof PDImageXObject);
                xObjects.add(xObjectInfo);
            }
        }

        int imageXObjectCount = 0;
        for (Map<String, Object> xObject : xObjects) {
            if (Boolean.TRUE.equals(xObject.get("isImage"))) {
                imageXObjectCount += 1;
            }
        }

        result.put("fonts", fonts);
        result.put("fontCount", fonts.size());
        result.put("xObjects", xObjects);
        result.put("xObjectCount", xObjects.size());
        result.put("imageXObjectCount", imageXObjectCount);
        return result;
    }

    private static int countContentStreams(PDPage page) {
        COSBase contents = resolve(page.getCOSObject().getDictionaryObject(COSName.CONTENTS));
        if (contents instanceof COSArray) {
            return ((COSArray) contents).size();
        }
        return contents == null ? 0 : 1;
    }

    private static Map<String, Object> inspectOperators(PDPage page) throws Exception {
        Map<String, Integer> operatorCounts = new TreeMap<>();
        List<Map<String, Object>> textSamples = new ArrayList<>();
        List<Map<String, Object>> markedContentSamples = new ArrayList<>();
        List<Map<String, Object>> drawSamples = new ArrayList<>();

        String currentFont = null;
        PDFont currentFontObject = null;
        float currentFontSize = 0f;
        int textOperatorCount = 0;
        int markedContentOperatorCount = 0;
        int artifactMarkedContentCount = 0;
        int imageDrawCount = 0;

        PDFStreamParser parser = new PDFStreamParser(page);
        List<Object> tokens = parser.parse();
        List<Object> operands = new ArrayList<>();

        for (Object token : tokens) {
            if (!(token instanceof Operator)) {
                operands.add(token);
                continue;
            }

            Operator operator = (Operator) token;
            String name = operator.getName();
            operatorCounts.put(name, operatorCounts.getOrDefault(name, 0) + 1);

            if ("Tf".equals(name) && operands.size() >= 2 && operands.get(0) instanceof COSName && operands.get(1) instanceof COSNumber) {
                currentFont = ((COSName) operands.get(0)).getName();
                currentFontObject = page.getResources() == null ? null : page.getResources().getFont((COSName) operands.get(0));
                currentFontSize = ((COSNumber) operands.get(1)).floatValue();
            }

            if ("Tj".equals(name) || "TJ".equals(name) || "'".equals(name) || "\"".equals(name)) {
                textOperatorCount += 1;
                if (textSamples.size() < 8) {
                    String text = extractText(operands, name, currentFontObject);
                    Map<String, Object> sample = new LinkedHashMap<>();
                    sample.put("operator", name);
                    sample.put("font", currentFont);
                    sample.put("fontSize", currentFontSize);
                    sample.put("text", text);
                    textSamples.add(sample);
                }
            }

            if ("BMC".equals(name) || "BDC".equals(name)) {
                markedContentOperatorCount += 1;
                String tag = extractMarkedContentTag(operands);
                if ("Artifact".equals(tag)) {
                    artifactMarkedContentCount += 1;
                }
                if (markedContentSamples.size() < 8) {
                    Map<String, Object> sample = new LinkedHashMap<>();
                    sample.put("operator", name);
                    sample.put("tag", tag);
                    markedContentSamples.add(sample);
                }
            }

            if ("Do".equals(name)) {
                imageDrawCount += 1;
                if (drawSamples.size() < 8) {
                    Map<String, Object> sample = new LinkedHashMap<>();
                    sample.put("operator", name);
                    sample.put("xObject", operands.size() >= 1 && operands.get(0) instanceof COSName ? ((COSName) operands.get(0)).getName() : "");
                    drawSamples.add(sample);
                }
            }

            operands.clear();
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("operatorCounts", operatorCounts);
        result.put("hasTextOperators", textOperatorCount > 0);
        result.put("textOperatorCount", textOperatorCount);
        result.put("hasMarkedContentOperators", markedContentOperatorCount > 0);
        result.put("markedContentOperatorCount", markedContentOperatorCount);
        result.put("artifactMarkedContentCount", artifactMarkedContentCount);
        result.put("imageDrawCount", imageDrawCount);
        result.put("textSamples", textSamples);
        result.put("markedContentSamples", markedContentSamples);
        result.put("drawSamples", drawSamples);
        return result;
    }

    private static COSBase resolve(COSBase value) {
        if (value instanceof COSObject) {
            return ((COSObject) value).getObject();
        }
        return value;
    }

    private static String extractMarkedContentTag(List<Object> operands) {
        if (operands.isEmpty()) {
            return "";
        }

        Object first = operands.get(0);
        if (first instanceof COSName) {
            return ((COSName) first).getName();
        }

        return String.valueOf(first);
    }

    private static String extractText(List<Object> operands, String operator, PDFont font) {
        if ("Tj".equals(operator) || "'".equals(operator)) {
            for (Object operand : operands) {
                if (operand instanceof COSString) {
                    return sanitizeText(decodeCosString((COSString) operand, font));
                }
            }
            return "";
        }

        if ("\"".equals(operator)) {
            for (int index = operands.size() - 1; index >= 0; index -= 1) {
                if (operands.get(index) instanceof COSString) {
                    return sanitizeText(decodeCosString((COSString) operands.get(index), font));
                }
            }
            return "";
        }

        if ("TJ".equals(operator)) {
            for (Object operand : operands) {
                if (operand instanceof COSArray) {
                    StringBuilder builder = new StringBuilder();
                    COSArray array = (COSArray) operand;
                    for (int index = 0; index < array.size(); index += 1) {
                        COSBase item = resolve(array.get(index));
                        if (item instanceof COSString) {
                            builder.append(decodeCosString((COSString) item, font));
                        }
                    }
                    return sanitizeText(builder.toString());
                }
            }
        }

        return "";
    }

    private static String decodeCosString(COSString value, PDFont font) {
        if (font == null) {
            return value.getString();
        }

        StringBuilder decoded = new StringBuilder();
        try (ByteArrayInputStream input = new ByteArrayInputStream(value.getBytes())) {
            while (input.available() > 0) {
                int code = font.readCode(input);
                String unicode = font.toUnicode(code);
                if (unicode != null) {
                    decoded.append(unicode);
                    continue;
                }

                if (code >= 32 && code <= 126) {
                    decoded.append((char) code);
                }
            }
        } catch (IOException error) {
            return value.getString();
        }

        return decoded.length() > 0 ? decoded.toString() : value.getString();
    }

    private static String sanitizeText(String value) {
        StringBuilder sanitized = new StringBuilder();
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character >= 32 || character == '\n' || character == '\r' || character == '\t') {
                sanitized.append(character);
            }
        }
        return sanitized.toString();
    }

    private static String toJson(Object value) {
        if (value == null) {
            return "null";
        }

        if (value instanceof String) {
            return "\"" + escapeJson((String) value) + "\"";
        }

        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }

        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) value;
            StringBuilder builder = new StringBuilder();
            builder.append("{");
            boolean first = true;
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                if (!first) {
                    builder.append(",");
                }
                first = false;
                builder.append(toJson(entry.getKey()));
                builder.append(":");
                builder.append(toJson(entry.getValue()));
            }
            builder.append("}");
            return builder.toString();
        }

        if (value instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) value;
            StringBuilder builder = new StringBuilder();
            builder.append("[");
            for (int index = 0; index < list.size(); index += 1) {
                if (index > 0) {
                    builder.append(",");
                }
                builder.append(toJson(list.get(index)));
            }
            builder.append("]");
            return builder.toString();
        }

        return toJson(String.valueOf(value));
    }

    private static String escapeJson(String value) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
                case '\\':
                    builder.append("\\\\");
                    break;
                case '"':
                    builder.append("\\\"");
                    break;
                case '\b':
                    builder.append("\\b");
                    break;
                case '\f':
                    builder.append("\\f");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (character < 32) {
                        builder.append(String.format("\\u%04x", (int) character));
                    } else {
                        builder.append(character);
                    }
            }
        }
        return builder.toString();
    }
}
