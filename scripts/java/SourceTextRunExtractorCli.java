import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;

public class SourceTextRunExtractorCli {
    private static class RunCollector extends PDFTextStripper {
        private final List<Map<String, Object>> runs = new ArrayList<>();
        private int globalSequence = 0;
        private int pageSequence = 0;

        RunCollector() throws Exception {
            setSortByPosition(false);
            setSuppressDuplicateOverlappingText(false);
        }

        @Override
        protected void startPage(org.apache.pdfbox.pdmodel.PDPage page) throws java.io.IOException {
            super.startPage(page);
            pageSequence = 0;
        }

        @Override
        protected void writeString(String text, List<TextPosition> textPositions) throws java.io.IOException {
            if (text == null || text.trim().isEmpty() || textPositions == null || textPositions.isEmpty()) {
                return;
            }

            float minX = Float.MAX_VALUE;
            float minY = Float.MAX_VALUE;
            float maxX = Float.MIN_VALUE;
            float maxY = Float.MIN_VALUE;
            float fontSizeTotal = 0f;

            for (TextPosition position : textPositions) {
                float x = position.getXDirAdj();
                float yA = position.getYDirAdj();
                float yB = position.getYDirAdj() - position.getHeightDir();
                float top = Math.min(yA, yB);
                float bottom = Math.max(yA, yB);
                float right = x + position.getWidthDirAdj();

                minX = Math.min(minX, x);
                minY = Math.min(minY, top);
                maxX = Math.max(maxX, right);
                maxY = Math.max(maxY, bottom);
                fontSizeTotal += position.getFontSizeInPt();
            }

            TextPosition first = textPositions.get(0);
            Map<String, Object> run = new LinkedHashMap<>();
            run.put("id", "r-" + getCurrentPageNo() + "-" + (pageSequence + 1));
            run.put("pageNumber", getCurrentPageNo());
            run.put("globalSequence", globalSequence);
            run.put("pageSequence", pageSequence);
            run.put("text", text);
            run.put("normalizedText", normalizeText(text));
            run.put("bbox", bbox(minX, minY, maxX - minX, maxY - minY));
            run.put("fontName", first.getFont().getName());
            run.put("fontSize", round(fontSizeTotal / textPositions.size()));
            run.put("glyphCount", textPositions.size());
            runs.add(run);

            globalSequence += 1;
            pageSequence += 1;
        }

        List<Map<String, Object>> getRuns() {
            return runs;
        }
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String pdfPath = requireOption(options, "--pdf");

        try (PDDocument document = Loader.loadPDF(new File(pdfPath))) {
            RunCollector collector = new RunCollector();
            collector.getText(document);

            Map<String, Object> output = new LinkedHashMap<>();
            output.put("status", "completed");
            output.put("pdfPath", new File(pdfPath).getAbsolutePath());
            output.put("pageCount", document.getNumberOfPages());
            output.put("runs", collector.getRuns());
            System.out.println(toJson(output));
        }
    }

    private static List<Float> bbox(float x, float y, float width, float height) {
        List<Float> bbox = new ArrayList<>();
        bbox.add(round(x));
        bbox.add(round(y));
        bbox.add(round(width));
        bbox.add(round(height));
        return bbox;
    }

    private static float round(float value) {
        return Math.round(value * 1000f) / 1000f;
    }

    private static String normalizeText(String value) {
        return value.replaceAll("\\s+", " ").trim();
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
