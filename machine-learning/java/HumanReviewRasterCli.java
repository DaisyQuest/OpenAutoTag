import java.awt.image.BufferedImage;
import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.imageio.ImageIO;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;

public class HumanReviewRasterCli {
    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String pdfPath = requireOption(options, "--pdf");
        String outputPath = requireOption(options, "--output");
        int pageNumber = Integer.parseInt(options.getOrDefault("--page", "1"));
        int dpi = Integer.parseInt(options.getOrDefault("--dpi", "144"));

        File outputFile = new File(outputPath);
        File outputDir = outputFile.getParentFile();
        if (outputDir != null && !outputDir.exists() && !outputDir.mkdirs()) {
            throw new IllegalStateException("Unable to create raster output directory: " + outputDir.getAbsolutePath());
        }

        try (PDDocument document = Loader.loadPDF(new File(pdfPath))) {
            int pageIndex = Math.max(0, Math.min(document.getNumberOfPages() - 1, pageNumber - 1));
            PDPage page = document.getPage(pageIndex);
            PDFRenderer renderer = new PDFRenderer(document);
            BufferedImage image = renderer.renderImageWithDPI(pageIndex, dpi, ImageType.RGB);
            ImageIO.write(image, "PNG", outputFile);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("status", "completed");
            result.put("pdfPath", new File(pdfPath).getAbsolutePath());
            result.put("pageNumber", pageIndex + 1);
            result.put("dpi", dpi);
            result.put("pdfWidth", round(page.getCropBox().getWidth()));
            result.put("pdfHeight", round(page.getCropBox().getHeight()));
            result.put("imagePath", outputFile.getAbsolutePath());
            result.put("imageWidth", image.getWidth());
            result.put("imageHeight", image.getHeight());
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

    private static float round(float value) {
        return Math.round(value * 1000f) / 1000f;
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
                    if (character < 0x20) {
                        builder.append(String.format("\\u%04x", (int) character));
                    } else {
                        builder.append(character);
                    }
            }
        }
        return builder.toString();
    }
}
