import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;

public class AcademicHellPdfFixtureCli {
    private static final float PAGE_WIDTH = 612f;
    private static final float PAGE_HEIGHT = 792f;
    private static final PDRectangle PAGE_SIZE = new PDRectangle(PAGE_WIDTH, PAGE_HEIGHT);

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String outputPath = requireOption(options, "--output");

        try (PDDocument document = new PDDocument()) {
            PDFont regular = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
            PDFont bold = new PDType1Font(Standard14Fonts.FontName.HELVETICA_BOLD);

            addTheoremColumnsPage(document, regular, bold);
            addBorderlessDualTablesPage(document, regular, bold);
            addNotationTrapPage(document, regular, bold);

            File outputFile = new File(outputPath);
            File parent = outputFile.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IllegalStateException("Unable to create output directory for academic hell fixture.");
            }
            document.save(outputFile);
        }
    }

    private static void addTheoremColumnsPage(PDDocument document, PDFont regular, PDFont bold) throws Exception {
        PDPage page = new PDPage(PAGE_SIZE);
        document.addPage(page);

        try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
            drawText(stream, bold, 21f, 72f, 742f, "Academic Columns");

            drawText(stream, bold, 19f, 72f, 672f, "Lemma A. Stability");
            drawText(stream, regular, 12f, 72f, 620f, "T is coercive on V.");
            drawText(stream, regular, 12f, 72f, 568f, "Then ||u_n|| <= C exp(t).");
            drawText(stream, regular, 12f, 72f, 516f, "Residual stays bounded.");

            drawText(stream, bold, 19f, 432f, 706f, "Remark B. Failure");
            drawText(stream, regular, 12f, 432f, 654f, "Take q_n = 2^n.");
            drawText(stream, regular, 12f, 432f, 602f, "Bound fails without coercivity.");
            drawText(stream, regular, 12f, 432f, 550f, "Right column remains second.");
        }
    }

    private static void addBorderlessDualTablesPage(PDDocument document, PDFont regular, PDFont bold) throws Exception {
        PDPage page = new PDPage(PAGE_SIZE);
        document.addPage(page);

        try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
            drawText(stream, bold, 18f, 72f, 742f, "Borderless Results");

            drawText(stream, bold, 12f, 72f, 690f, "Method");
            drawText(stream, bold, 12f, 244f, 690f, "Error");
            drawText(stream, bold, 12f, 394f, 690f, "Bound");

            drawText(stream, regular, 12f, 72f, 662f, "Fourier");
            drawText(stream, regular, 12f, 244f, 662f, "0.120");
            drawText(stream, regular, 12f, 394f, 662f, "0.200");

            drawText(stream, regular, 12f, 72f, 636f, "Wavelet");
            drawText(stream, regular, 12f, 244f, 636f, "0.081");
            drawText(stream, regular, 12f, 394f, 636f, "0.180");

            drawText(stream, regular, 12f, 72f, 610f, "Spline");
            drawText(stream, regular, 12f, 244f, 610f, "0.053");
            drawText(stream, regular, 12f, 394f, 610f, "0.110");

            drawText(stream, bold, 12f, 72f, 500f, "Dataset");
            drawText(stream, bold, 12f, 244f, 500f, "Samples");
            drawText(stream, bold, 12f, 394f, 500f, "Variance");

            drawText(stream, regular, 12f, 72f, 472f, "Spectral-A");
            drawText(stream, regular, 12f, 244f, 472f, "128");
            drawText(stream, regular, 12f, 394f, 472f, "0.031");

            drawText(stream, regular, 12f, 72f, 446f, "Spectral-B");
            drawText(stream, regular, 12f, 244f, 446f, "256");
            drawText(stream, regular, 12f, 394f, 446f, "0.018");

            drawText(stream, regular, 12f, 72f, 420f, "Spectral-C");
            drawText(stream, regular, 12f, 244f, 420f, "512");
            drawText(stream, regular, 12f, 394f, 420f, "0.011");

            drawText(stream, regular, 12f, 72f, 352f, "Interpretation paragraph below both borderless tables.");
        }
    }

    private static void addNotationTrapPage(PDDocument document, PDFont regular, PDFont bold) throws Exception {
        PDPage page = new PDPage(PAGE_SIZE);
        document.addPage(page);

        String[][] notationPairs = new String[][] {
            { "lambda_n", "principal eigenvalue" },
            { "mu_n", "stability factor" },
            { "theta_n", "time-step weight" },
            { "rho_n", "spectral radius" }
        };

        try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
            drawText(stream, bold, 18f, 72f, 742f, "Notation Glossary");
            drawText(stream, regular, 12f, 72f, 714f, "This page aligns symbols and meanings but must not become a table.");

            for (int index = 0; index < notationPairs.length; index += 1) {
                float y = 670f - index * 30f;
                float symbolX = 72f + index * 16f;
                float meaningX = 236f + index * 24f;
                drawText(stream, regular, 12f, symbolX, y, notationPairs[index][0]);
                drawText(stream, regular, 12f, meaningX, y, notationPairs[index][1]);
            }

            drawText(stream, regular, 12f, 72f, 518f, "These rows are notation prose, not headers plus cells.");
            drawText(stream, regular, 12f, 72f, 474f, "1. Establish compactness.");
            drawText(stream, regular, 12f, 72f, 448f, "2. Apply discrete Gronwall.");
        }
    }

    private static void drawText(PDPageContentStream stream, PDFont font, float fontSize, float x, float y, String text) throws Exception {
        stream.beginText();
        stream.setFont(font, fontSize);
        stream.newLineAtOffset(x, y);
        stream.showText(text);
        stream.endText();
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
}
