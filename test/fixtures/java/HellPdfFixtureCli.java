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

public class HellPdfFixtureCli {
    private static final float PAGE_WIDTH = 612f;
    private static final float PAGE_HEIGHT = 792f;
    private static final PDRectangle PAGE_SIZE = new PDRectangle(PAGE_WIDTH, PAGE_HEIGHT);

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String outputPath = requireOption(options, "--output");

        try (PDDocument document = new PDDocument()) {
            PDFont regular = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
            PDFont bold = new PDType1Font(Standard14Fonts.FontName.HELVETICA_BOLD);

            addColumnPressurePage(document, regular, bold);
            addRuledTablePage(document, regular, bold);
            addFalseTablePage(document, regular, bold);

            File outputFile = new File(outputPath);
            File parent = outputFile.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IllegalStateException("Unable to create output directory for hell fixture.");
            }
            document.save(outputFile);
        }
    }

    private static void addColumnPressurePage(PDDocument document, PDFont regular, PDFont bold) throws Exception {
        PDPage page = new PDPage(PAGE_SIZE);
        document.addPage(page);

        String[] leftLines = new String[] {
            "- L alpha: f(x)=x^2+1.",
            "- L beta: g(t)=sin(t)+3.",
            "- L gamma: h(n)=2*n+5.",
            "- L delta: limit(k)=42."
        };
        String[] rightLines = new String[] {
            "- R alpha: area=pi*r^2.",
            "- R beta: slope=dy/dx.",
            "- R gamma: integral[0,1]=0.5.",
            "- R delta: matrix rank=2."
        };

        try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
            drawText(stream, bold, 22f, 72f, 742f, "Hell Matrix Report");

            for (int index = 0; index < leftLines.length; index += 1) {
                float y = 690f - index * 34f - (float) Math.round(Math.sin((index + 1) * 0.75d) * 2d);
                float x = 72f + (float) Math.round(Math.cos((index + 1) * 0.55d) * 3d);
                drawText(stream, regular, 12f, x, y, leftLines[index]);
            }

            for (int index = 0; index < rightLines.length; index += 1) {
                float y = 720f - index * 37f - (float) Math.round(Math.cos((index + 1) * 0.68d) * 2d);
                float x = 452f + (float) Math.round(Math.sin((index + 1) * 0.61d) * 3d);
                drawText(stream, regular, 12f, x, y, rightLines[index]);
            }
        }
    }

    private static void addRuledTablePage(PDDocument document, PDFont regular, PDFont bold) throws Exception {
        PDPage page = new PDPage(PAGE_SIZE);
        document.addPage(page);

        float tableLeft = 72f;
        float tableTop = 720f;
        float tableWidth = 468f;
        double[] columnWeights = new double[] { Math.sqrt(2d), 1d, 1d };
        float[] rowHeights = new float[] { 30f, 24f, 24f, 24f, 24f };
        float[] x = buildColumnBoundaries(tableLeft, tableWidth, columnWeights);
        float[] y = buildRowBoundaries(tableTop, rowHeights);

        try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
            drawText(stream, bold, 18f, 72f, 748f, "Ruled Table Gauntlet");

            for (int rowIndex = 0; rowIndex < y.length; rowIndex += 1) {
                float gapStart = 0f;
                float gapEnd = 0f;
                if (rowIndex == 3) {
                    float gapCenter = x[2] + (float) Math.round(Math.sin(2.2d) * 7d);
                    gapStart = gapCenter - 6f;
                    gapEnd = gapCenter + 6f;
                }
                drawBrokenHorizontal(stream, tableLeft, tableLeft + tableWidth, y[rowIndex], gapStart, gapEnd);
            }

            drawVertical(stream, x[0], y[0], y[y.length - 1]);
            drawVertical(stream, x[x.length - 1], y[0], y[y.length - 1]);

            for (int index = 1; index < x.length - 1; index += 1) {
                float gapCenter = y[3] + (y[2] - y[3]) / 2f + (float) Math.round(Math.cos((index + 1) * 1.3d) * 2d);
                drawBrokenVertical(stream, x[index], y[1], y[y.length - 1], gapCenter - 4f, gapCenter + 4f);
            }

            drawCenteredText(stream, bold, 14f, x[0], x[x.length - 1], y[1] + 9f, "Weighted Revenue Matrix");

            drawCenteredText(stream, bold, 12f, x[0], x[1], y[2] + 7f, "Region");
            drawCenteredText(stream, bold, 12f, x[1], x[2], y[2] + 7f, "Quarter One");
            drawCenteredText(stream, bold, 12f, x[2], x[3], y[2] + 7f, "Quarter Two");

            drawCenteredText(stream, regular, 12f, x[0], x[1], y[3] + 7f, "North");
            drawCenteredText(stream, regular, 12f, x[1], x[2], y[3] + 7f, "120");
            drawCenteredText(stream, regular, 12f, x[2], x[3], y[3] + 7f, "128");

            drawCenteredText(stream, regular, 12f, x[0], x[1], y[4] + 7f, "South");
            drawCenteredText(stream, regular, 12f, x[1], x[2], y[4] + 7f, "098");
            drawCenteredText(stream, regular, 12f, x[2], x[3], y[4] + 7f, "101");

            drawCenteredText(stream, regular, 12f, x[0], x[1], y[5] + 7f, "Delta");
            drawCenteredText(stream, regular, 12f, x[1], x[2], y[5] + 7f, "+22");
            drawCenteredText(stream, regular, 12f, x[2], x[3], y[5] + 7f, "+27");

            drawText(stream, regular, 12f, 72f, y[y.length - 1] - 42f, "Post-table theorem: this paragraph must stay outside the ruled grid.");
        }
    }

    private static void addFalseTablePage(PDDocument document, PDFont regular, PDFont bold) throws Exception {
        PDPage page = new PDPage(PAGE_SIZE);
        document.addPage(page);

        String[][] alignedPairs = new String[][] {
            { "Composer", "Ada Lovelace" },
            { "Venue", "Albany Hall" },
            { "Duration", "47 minutes" }
        };

        try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
            drawText(stream, bold, 18f, 72f, 742f, "Alignment Trap");
            drawText(stream, regular, 12f, 72f, 716f, "This page aligns prose like a table but intentionally lacks a header band.");

            for (int index = 0; index < alignedPairs.length; index += 1) {
                float y = 676f - index * 26f - (float) Math.round(Math.sin((index + 1) * 0.84d) * 2d);
                float labelX = 72f + index * 18f + (float) Math.round(Math.cos((index + 1) * 0.51d) * 3d);
                float valueX = 236f + index * 28f + (float) Math.round(Math.sin((index + 1) * 0.73d) * 4d);
                drawText(stream, regular, 12f, labelX, y, alignedPairs[index][0]);
                drawText(stream, regular, 12f, valueX, y, alignedPairs[index][1]);
            }

            drawText(stream, regular, 12f, 72f, 566f, "Aligned prose must remain paragraph text instead of collapsing into a table.");
            drawText(stream, regular, 12f, 72f, 520f, "1. Verify false table rejection.");
            drawText(stream, regular, 12f, 72f, 496f, "2. Preserve ordered list semantics.");
        }
    }

    private static float[] buildColumnBoundaries(float left, float totalWidth, double[] weights) {
        float[] boundaries = new float[weights.length + 1];
        boundaries[0] = left;

        double totalWeight = 0d;
        for (double weight : weights) {
            totalWeight += weight;
        }

        float position = left;
        for (int index = 0; index < weights.length; index += 1) {
            float width = (float) Math.round((weights[index] / totalWeight) * totalWidth);
            if (index == weights.length - 1) {
                position = left + totalWidth;
            } else {
                position += width;
            }
            boundaries[index + 1] = position;
        }

        return boundaries;
    }

    private static float[] buildRowBoundaries(float top, float[] rowHeights) {
        float[] boundaries = new float[rowHeights.length + 1];
        boundaries[0] = top;
        float position = top;
        for (int index = 0; index < rowHeights.length; index += 1) {
            position -= rowHeights[index];
            boundaries[index + 1] = position;
        }
        return boundaries;
    }

    private static void drawText(PDPageContentStream stream, PDFont font, float fontSize, float x, float y, String text) throws Exception {
        stream.beginText();
        stream.setFont(font, fontSize);
        stream.newLineAtOffset(x, y);
        stream.showText(text);
        stream.endText();
    }

    private static void drawCenteredText(
        PDPageContentStream stream,
        PDFont font,
        float fontSize,
        float left,
        float right,
        float baselineY,
        String text
    ) throws Exception {
        float textWidth = font.getStringWidth(text) / 1000f * fontSize;
        float x = left + ((right - left) - textWidth) / 2f;
        drawText(stream, font, fontSize, x, baselineY, text);
    }

    private static void drawVertical(PDPageContentStream stream, float x, float topY, float bottomY) throws Exception {
        stream.moveTo(x, topY);
        stream.lineTo(x, bottomY);
        stream.stroke();
    }

    private static void drawBrokenVertical(
        PDPageContentStream stream,
        float x,
        float topY,
        float bottomY,
        float gapTop,
        float gapBottom
    ) throws Exception {
        if (gapTop <= bottomY || gapBottom >= topY || gapTop >= gapBottom) {
            drawVertical(stream, x, topY, bottomY);
            return;
        }

        stream.moveTo(x, topY);
        stream.lineTo(x, gapBottom);
        stream.stroke();

        stream.moveTo(x, gapTop);
        stream.lineTo(x, bottomY);
        stream.stroke();
    }

    private static void drawBrokenHorizontal(
        PDPageContentStream stream,
        float leftX,
        float rightX,
        float y,
        float gapStart,
        float gapEnd
    ) throws Exception {
        if (gapStart <= leftX || gapEnd >= rightX || gapStart >= gapEnd) {
            stream.moveTo(leftX, y);
            stream.lineTo(rightX, y);
            stream.stroke();
            return;
        }

        stream.moveTo(leftX, y);
        stream.lineTo(gapStart, y);
        stream.stroke();

        stream.moveTo(gapEnd, y);
        stream.lineTo(rightX, y);
        stream.stroke();
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
