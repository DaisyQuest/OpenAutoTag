import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;

public class PdfSsnRedactorCli {
    private static final float RENDER_DPI = 200f;

    private static final class Instruction {
        final int pageNumber;
        final float x;
        final float y;
        final float width;
        final float height;

        Instruction(int pageNumber, float x, float y, float width, float height) {
            this.pageNumber = pageNumber;
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> parsed = parseArgs(args);
        String pdfPath = parsed.get("--pdf");
        String instructionsPath = parsed.get("--instructions");
        String outputPath = parsed.get("--output");

        if (pdfPath == null || instructionsPath == null || outputPath == null) {
            throw new IllegalArgumentException(
                "Usage: java PdfSsnRedactorCli --pdf <input.pdf> --instructions <instructions.tsv> --output <redacted.pdf>"
            );
        }

        Map<Integer, List<Instruction>> instructionsByPage = readInstructions(instructionsPath);

        try (PDDocument input = Loader.loadPDF(new File(pdfPath)); PDDocument output = new PDDocument()) {
            PDFRenderer renderer = new PDFRenderer(input);
            PDDocumentInformation inputInfo = input.getDocumentInformation();
            if (inputInfo != null) {
                PDDocumentInformation outputInfo = new PDDocumentInformation();
                outputInfo.setTitle(inputInfo.getTitle());
                outputInfo.setAuthor(inputInfo.getAuthor());
                outputInfo.setSubject(inputInfo.getSubject());
                outputInfo.setCreator(inputInfo.getCreator());
                outputInfo.setProducer(inputInfo.getProducer());
                outputInfo.setKeywords(inputInfo.getKeywords());
                output.setDocumentInformation(outputInfo);
            }

            int pagesRedacted = 0;
            int redactionCount = 0;

            for (int pageIndex = 0; pageIndex < input.getNumberOfPages(); pageIndex++) {
                PDPage inputPage = input.getPage(pageIndex);
                PDRectangle mediaBox = inputPage.getMediaBox();
                List<Instruction> pageInstructions = instructionsByPage.getOrDefault(pageIndex + 1, List.of());

                BufferedImage image = renderer.renderImageWithDPI(pageIndex, RENDER_DPI, ImageType.RGB);
                if (!pageInstructions.isEmpty()) {
                    pagesRedacted += 1;
                    redactionCount += pageInstructions.size();
                    applyRedactions(image, mediaBox, pageInstructions);
                }

                PDPage outputPage = new PDPage(new PDRectangle(mediaBox.getWidth(), mediaBox.getHeight()));
                output.addPage(outputPage);

                PDImageXObject pdfImage = LosslessFactory.createFromImage(output, image);
                try (PDPageContentStream contentStream = new PDPageContentStream(output, outputPage)) {
                    contentStream.drawImage(pdfImage, 0, 0, mediaBox.getWidth(), mediaBox.getHeight());
                }
            }

            output.save(outputPath);

            String json = "{"
                + "\"status\":\"completed\","
                + "\"pagesProcessed\":" + input.getNumberOfPages() + ","
                + "\"pagesRedacted\":" + pagesRedacted + ","
                + "\"redactionCount\":" + redactionCount + ","
                + "\"outputMode\":\"raster-redaction\""
                + "}";
            System.out.println(json);
        }
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> values = new HashMap<>();
        for (int index = 0; index < args.length - 1; index += 2) {
            values.put(args[index], args[index + 1]);
        }
        return values;
    }

    private static Map<Integer, List<Instruction>> readInstructions(String instructionsPath) throws IOException {
        Map<Integer, List<Instruction>> instructionsByPage = new HashMap<>();

        try (BufferedReader reader = new BufferedReader(new FileReader(instructionsPath))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }

                String[] parts = line.split("\t");
                if (parts.length < 5) {
                    continue;
                }

                Instruction instruction = new Instruction(
                    Integer.parseInt(parts[0]),
                    Float.parseFloat(parts[1]),
                    Float.parseFloat(parts[2]),
                    Float.parseFloat(parts[3]),
                    Float.parseFloat(parts[4])
                );

                instructionsByPage.computeIfAbsent(instruction.pageNumber, key -> new ArrayList<>()).add(instruction);
            }
        }

        return instructionsByPage;
    }

    private static void applyRedactions(BufferedImage image, PDRectangle mediaBox, List<Instruction> instructions) {
        double scaleX = image.getWidth() / Math.max(mediaBox.getWidth(), 1f);
        double scaleY = image.getHeight() / Math.max(mediaBox.getHeight(), 1f);
        int maxX = Math.max(image.getWidth() - 1, 0);
        int maxY = Math.max(image.getHeight() - 1, 0);

        Graphics2D graphics = image.createGraphics();
        graphics.setColor(Color.BLACK);

        for (Instruction instruction : instructions) {
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

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
