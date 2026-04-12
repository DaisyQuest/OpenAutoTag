import java.awt.image.BufferedImage;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.imageio.ImageIO;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;

public class PdfOcrRenderCli {
    private static class VariantSpec {
        final String name;
        final int dpi;
        final ImageType imageType;
        final String preprocessing;

        VariantSpec(String name, int dpi, ImageType imageType, String preprocessing) {
            this.name = name;
            this.dpi = dpi;
            this.imageType = imageType;
            this.preprocessing = preprocessing;
        }
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String pdfPath = requireOption(options, "--pdf");
        String outputDir = requireOption(options, "--output-dir");
        Set<Integer> pageNumbers = parsePageNumbers(requireOption(options, "--pages"));
        List<VariantSpec> variants = parseVariants(requireOption(options, "--variants"));

        File directory = new File(outputDir);
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("Unable to create OCR render output directory: " + outputDir);
        }

        try (PDDocument document = Loader.loadPDF(new File(pdfPath))) {
            PDFRenderer renderer = new PDFRenderer(document);
            List<Map<String, Object>> pageResults = new ArrayList<>();

            for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex += 1) {
                int pageNumber = pageIndex + 1;
                if (!pageNumbers.contains(pageNumber)) {
                    continue;
                }

                PDPage page = document.getPage(pageIndex);
                Map<String, Object> pageResult = new LinkedHashMap<>();
                pageResult.put("pageNumber", pageNumber);
                pageResult.put("pdfWidth", round(page.getCropBox().getWidth()));
                pageResult.put("pdfHeight", round(page.getCropBox().getHeight()));

                List<Map<String, Object>> variantResults = new ArrayList<>();
                for (VariantSpec variant : variants) {
                    BufferedImage image = renderer.renderImageWithDPI(pageIndex, variant.dpi, variant.imageType);
                    File imageFile = new File(directory, String.format("page-%03d-%s.png", pageNumber, variant.name));
                    ImageIO.write(image, "PNG", imageFile);

                    Map<String, Object> variantResult = new LinkedHashMap<>();
                    variantResult.put("name", variant.name);
                    variantResult.put("dpi", variant.dpi);
                    variantResult.put("imageType", variant.imageType.name());
                    variantResult.put("preprocessing", variant.preprocessing);
                    variantResult.put("imagePath", imageFile.getAbsolutePath());
                    variantResult.put("imageWidth", image.getWidth());
                    variantResult.put("imageHeight", image.getHeight());
                    variantResults.add(variantResult);
                }

                pageResult.put("variants", variantResults);
                pageResults.add(pageResult);
            }

            Map<String, Object> output = new LinkedHashMap<>();
            output.put("status", "completed");
            output.put("pdfPath", new File(pdfPath).getAbsolutePath());
            output.put("pages", pageResults);
            System.out.println(toJson(output));
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

    private static Set<Integer> parsePageNumbers(String raw) {
        Set<Integer> pageNumbers = new LinkedHashSet<>();
        for (String token : raw.split(",")) {
            String trimmed = token.trim();
            if (!trimmed.isEmpty()) {
                pageNumbers.add(Integer.parseInt(trimmed));
            }
        }

        if (pageNumbers.isEmpty()) {
            throw new IllegalArgumentException("At least one page number is required for OCR rendering.");
        }

        return pageNumbers;
    }

    private static List<VariantSpec> parseVariants(String raw) {
        List<VariantSpec> variants = new ArrayList<>();

        for (String token : raw.split(",")) {
            String trimmed = token.trim();
            if (trimmed.isEmpty()) {
                continue;
            }

            String[] parts = trimmed.split(":");
            if (parts.length != 3) {
                throw new IllegalArgumentException("Invalid OCR variant: " + trimmed);
            }

            String name = parts[0];
            int dpi = Integer.parseInt(parts[1]);
            ImageType imageType = ImageType.valueOf(parts[2]);
            String preprocessing = imageType == ImageType.BINARY ? "binary" : "grayscale";
            variants.add(new VariantSpec(name, dpi, imageType, preprocessing));
        }

        if (variants.isEmpty()) {
            throw new IllegalArgumentException("At least one OCR variant is required.");
        }

        return variants;
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
