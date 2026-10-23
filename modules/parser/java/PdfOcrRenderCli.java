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
                float unit = page.getUserUnit();
                if (!Float.isFinite(unit) || unit <= 0 || !Float.isFinite(page.getCropBox().getWidth()) ||
                    !Float.isFinite(page.getCropBox().getHeight()) || page.getCropBox().getWidth() <= 0 || page.getCropBox().getHeight() <= 0)
                    throw new IllegalArgumentException("Invalid OCR page geometry");
                Map<String, Object> pageResult = new LinkedHashMap<>();
                pageResult.put("pageNumber", pageNumber);
                pageResult.put("coordinateSpace", "crop-display-points");
                boolean sideways = page.getRotation() == 90 || page.getRotation() == 270;
                pageResult.put("pdfWidth", (double)(sideways ? page.getCropBox().getHeight() : page.getCropBox().getWidth()) * unit);
                pageResult.put("pdfHeight", (double)(sideways ? page.getCropBox().getWidth() : page.getCropBox().getHeight()) * unit);

                List<Map<String, Object>> variantResults = new ArrayList<>();
                for (VariantSpec variant : variants) {
                    // PDFRenderer scales raw user units; include UserUnit to
                    // render at the requested physical DPI exactly once.
                    float scale = variant.dpi / 72f * unit;
                    double width = Math.max(1, Math.floor(page.getCropBox().getWidth() * scale));
                    double height = Math.max(1, Math.floor(page.getCropBox().getHeight() * scale));
                    if (!Float.isFinite(scale) || width > 32768 || height > 32768 || width * height > 40000000)
                        throw new IllegalArgumentException("OCR render exceeds 40 million pixels or 32768 pixels per side");
                    BufferedImage image = renderer.renderImage(pageIndex, scale, variant.imageType);
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
                    double pointsPerPixel = unit / (double)scale;
                    variantResult.put("pixelToDisplay", List.of(pointsPerPixel, 0, 0, pointsPerPixel, 0, 0));
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
            if (!name.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}") || dpi < 36 || dpi > 1200 ||
                variants.stream().anyMatch(v -> v.name.equals(name)))
                throw new IllegalArgumentException("Invalid or duplicate OCR render variant");
            String preprocessing = imageType == ImageType.BINARY ? "binary" : "grayscale";
            variants.add(new VariantSpec(name, dpi, imageType, preprocessing));
        }

        if (variants.isEmpty()) {
            throw new IllegalArgumentException("At least one OCR variant is required.");
        }

        return variants;
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
