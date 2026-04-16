import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSDocument;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNull;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSObjectKey;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.io.RandomAccessReadBufferedFile;
import org.apache.pdfbox.pdfparser.PDFParser;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;

public class PdfRepairCli {

    private static final int TAIL_SCAN_SIZE = 4096;

    // -- Report building helpers --

    private final List<Map<String, Object>> repairs = new ArrayList<>();
    private int issuesFound = 0;
    private int issuesRepaired = 0;
    private int issuesUnrepairable = 0;
    private boolean anyRepairApplied = false;

    private void addRepair(String type, String severity, String description,
                           boolean repaired, Map<String, Object> details) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("type", type);
        entry.put("severity", severity);
        entry.put("description", description);
        entry.put("repaired", repaired);
        entry.put("details", details);
        repairs.add(entry);
        if ("error".equals(severity) || "warning".equals(severity)) {
            issuesFound++;
            if (repaired) {
                issuesRepaired++;
                anyRepairApplied = true;
            } else {
                issuesUnrepairable++;
            }
        }
    }

    // -- 1. repairXrefTable --

    private PDDocument repairXrefTable(File inputFile) {
        Map<String, Object> details = new LinkedHashMap<>();
        boolean originalXrefValid = false;
        boolean repaired = false;
        int objectsFound = 0;
        PDDocument doc = null;

        // First try: normal load
        try {
            doc = Loader.loadPDF(inputFile);
            originalXrefValid = true;
            objectsFound = countObjects(doc);
            details.put("repaired", false);
            details.put("objectsFound", objectsFound);
            details.put("originalXrefValid", true);
            addRepair("xref-table", "info", "Cross-reference table is valid", false, details);
            return doc;
        } catch (Exception e) {
            // Normal load failed
        }

        // Second try: lenient parsing via PDFParser
        try {
            RandomAccessReadBufferedFile raf = new RandomAccessReadBufferedFile(inputFile);
            PDFParser parser = new PDFParser(raf);
            doc = parser.parse();
            objectsFound = countObjects(doc);
            repaired = true;

            // Also scan raw bytes for N 0 obj patterns
            int rawObjectCount = countRawObjects(inputFile);
            details.put("repaired", true);
            details.put("objectsFound", objectsFound);
            details.put("rawObjectPatterns", rawObjectCount);
            details.put("originalXrefValid", false);
            addRepair("xref-table", "error",
                    "Cross-reference table was corrupt; recovered " + objectsFound + " objects via lenient parsing",
                    true, details);
            return doc;
        } catch (Exception e2) {
            // Even lenient parsing failed - try raw object scan for reporting
            int rawObjectCount = 0;
            try {
                rawObjectCount = countRawObjects(inputFile);
            } catch (Exception ignored) { }
            details.put("repaired", false);
            details.put("objectsFound", rawObjectCount);
            details.put("originalXrefValid", false);
            details.put("error", e2.getMessage());
            addRepair("xref-table", "error",
                    "Cross-reference table is corrupt and could not be repaired: " + e2.getMessage(),
                    false, details);
            return null;
        }
    }

    /**
     * Collect all indirect objects from the COSDocument via the xref table.
     */
    private List<COSObject> getAllObjects(COSDocument cosDoc) {
        List<COSObject> objects = new ArrayList<>();
        Map<COSObjectKey, Long> xrefTable = cosDoc.getXrefTable();
        if (xrefTable != null) {
            for (COSObjectKey key : xrefTable.keySet()) {
                try {
                    COSObject obj = cosDoc.getObjectFromPool(key);
                    if (obj != null) {
                        objects.add(obj);
                    }
                } catch (Exception e) {
                    // Skip unresolvable objects
                }
            }
        }
        return objects;
    }

    private int countObjects(PDDocument doc) {
        try {
            COSDocument cosDoc = doc.getDocument();
            return getAllObjects(cosDoc).size();
        } catch (Exception e) {
            return 0;
        }
    }

    private int countRawObjects(File file) throws IOException {
        byte[] bytes = Files.readAllBytes(file.toPath());
        String content = new String(bytes, StandardCharsets.ISO_8859_1);
        Pattern pattern = Pattern.compile("\\d+\\s+0\\s+obj");
        Matcher matcher = pattern.matcher(content);
        int count = 0;
        while (matcher.find()) count++;
        return count;
    }

    // -- 2. repairStreamLengths --

    private void repairStreamLengths(PDDocument doc) {
        Map<String, Object> details = new LinkedHashMap<>();
        List<Map<String, Object>> mismatches = new ArrayList<>();
        boolean repaired = false;

        try {
            COSDocument cosDoc = doc.getDocument();
            List<COSObject> objects = getAllObjects(cosDoc);
            for (COSObject obj : objects) {
                COSBase base = obj.getObject();
                if (!(base instanceof COSStream)) continue;
                COSStream stream = (COSStream) base;
                try {
                    long declaredLength = 0;
                    COSBase lengthBase = stream.getDictionaryObject(COSName.LENGTH);
                    if (lengthBase instanceof COSNumber) {
                        declaredLength = ((COSNumber) lengthBase).longValue();
                    }

                    long actualLength = 0;
                    try (InputStream is = stream.createRawInputStream()) {
                        byte[] buf = new byte[8192];
                        int read;
                        while ((read = is.read(buf)) != -1) {
                            actualLength += read;
                        }
                    }

                    if (declaredLength != actualLength && actualLength > 0) {
                        Map<String, Object> mismatch = new LinkedHashMap<>();
                        mismatch.put("objectId", obj.getObjectNumber());
                        mismatch.put("declaredLength", declaredLength);
                        mismatch.put("actualLength", actualLength);
                        mismatches.add(mismatch);

                        stream.setLong(COSName.LENGTH, actualLength);
                        repaired = true;
                    }
                } catch (Exception e) {
                    // Stream might be unreadable; skip
                }
            }
        } catch (Exception e) {
            details.put("error", e.getMessage());
        }

        details.put("repaired", repaired);
        details.put("mismatches", mismatches);

        if (repaired) {
            addRepair("stream-length", "warning",
                    "Fixed " + mismatches.size() + " stream length mismatch(es)",
                    true, details);
        } else {
            addRepair("stream-length", "info",
                    "All stream lengths are consistent", false, details);
        }
    }

    // -- 3. repairFlateStreams --

    private void repairFlateStreams(PDDocument doc) {
        Map<String, Object> details = new LinkedHashMap<>();
        int corruptStreams = 0;
        int recoveredStreams = 0;
        int irrecoverableStreams = 0;
        boolean repaired = false;

        try {
            COSDocument cosDoc = doc.getDocument();
            List<COSObject> objects = getAllObjects(cosDoc);
            for (COSObject obj : objects) {
                COSBase base = obj.getObject();
                if (!(base instanceof COSStream)) continue;
                COSStream stream = (COSStream) base;

                // Check if filter is FlateDecode
                COSBase filterBase = stream.getDictionaryObject(COSName.FILTER);
                boolean isFlate = false;
                if (COSName.FLATE_DECODE.equals(filterBase)) {
                    isFlate = true;
                } else if (filterBase instanceof COSArray) {
                    COSArray arr = (COSArray) filterBase;
                    for (int i = 0; i < arr.size(); i++) {
                        if (COSName.FLATE_DECODE.equals(arr.get(i))) {
                            isFlate = true;
                            break;
                        }
                    }
                }
                if (!isFlate) continue;

                // Try to decode
                try (InputStream is = stream.createInputStream()) {
                    byte[] buf = new byte[8192];
                    while (is.read(buf) != -1) { /* drain */ }
                } catch (Exception e) {
                    corruptStreams++;
                    // Try partial inflation
                    boolean recovered = tryPartialInflation(stream);
                    if (recovered) {
                        recoveredStreams++;
                        repaired = true;
                    } else {
                        irrecoverableStreams++;
                    }
                }
            }
        } catch (Exception e) {
            details.put("error", e.getMessage());
        }

        details.put("repaired", repaired);
        details.put("corruptStreams", corruptStreams);
        details.put("recoveredStreams", recoveredStreams);
        details.put("irrecoverableStreams", irrecoverableStreams);

        if (corruptStreams > 0) {
            String severity = irrecoverableStreams > 0 ? "error" : "warning";
            addRepair("flate-stream", severity,
                    corruptStreams + " corrupt FlateDecode stream(s) found; " +
                    recoveredStreams + " recovered, " + irrecoverableStreams + " irrecoverable",
                    repaired, details);
        } else {
            addRepair("flate-stream", "info",
                    "All FlateDecode streams are valid", false, details);
        }
    }

    private boolean tryPartialInflation(COSStream stream) {
        try {
            byte[] rawBytes;
            try (InputStream rawIs = stream.createRawInputStream()) {
                rawBytes = readAllBytes(rawIs);
            }

            Inflater inflater = new Inflater();
            inflater.setInput(rawBytes);
            ByteArrayOutputStream recovered = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            try {
                while (!inflater.finished()) {
                    int count = inflater.inflate(buf);
                    if (count == 0 && inflater.needsInput()) break;
                    recovered.write(buf, 0, count);
                }
            } catch (DataFormatException e) {
                // Partial data is in 'recovered'
            } finally {
                inflater.end();
            }

            byte[] recoveredBytes = recovered.toByteArray();
            if (recoveredBytes.length == 0) return false;

            // Replace stream content: remove filter and write raw recovered data
            try (OutputStream os = stream.createRawOutputStream()) {
                os.write(recoveredBytes);
            }
            stream.removeItem(COSName.FILTER);
            stream.setLong(COSName.LENGTH, recoveredBytes.length);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // -- 4. repairFonts --

    private void repairFonts(PDDocument doc) {
        Map<String, Object> details = new LinkedHashMap<>();
        int scanned = 0;
        int healthy = 0;
        int damaged = 0;
        int missingToUnicode = 0;
        int missingDescriptor = 0;

        try {
            for (PDPage page : doc.getPages()) {
                PDResources resources = page.getResources();
                if (resources == null) continue;

                for (COSName fontName : resources.getFontNames()) {
                    scanned++;
                    try {
                        PDFont font = resources.getFont(fontName);
                        if (font == null) {
                            damaged++;
                            continue;
                        }

                        boolean fontHealthy = true;

                        // Check FontDescriptor
                        PDFontDescriptor descriptor = font.getFontDescriptor();
                        if (descriptor == null) {
                            missingDescriptor++;
                            fontHealthy = false;
                        } else {
                            // Check FontFile presence
                            try {
                                boolean hasFontFile = descriptor.getFontFile() != null
                                        || descriptor.getFontFile2() != null
                                        || descriptor.getFontFile3() != null;
                                if (!hasFontFile) {
                                    // Type1 standard fonts may lack embedded files - that's ok
                                    // but for others it's a sign of damage
                                }
                            } catch (Exception e) {
                                damaged++;
                                fontHealthy = false;
                            }
                        }

                        // Check ToUnicode CMap
                        try {
                            COSBase toUnicode = font.getCOSObject().getDictionaryObject(COSName.TO_UNICODE);
                            if (toUnicode == null) {
                                missingToUnicode++;
                                fontHealthy = false;
                            }
                        } catch (Exception e) {
                            damaged++;
                            fontHealthy = false;
                        }

                        if (fontHealthy) healthy++;
                    } catch (Exception e) {
                        damaged++;
                    }
                }
            }
        } catch (Exception e) {
            details.put("error", e.getMessage());
        }

        details.put("scanned", scanned);
        details.put("healthy", healthy);
        details.put("damaged", damaged);
        details.put("missingToUnicode", missingToUnicode);
        details.put("missingDescriptor", missingDescriptor);

        if (damaged > 0) {
            addRepair("fonts", "warning",
                    damaged + " damaged font(s) found out of " + scanned + " scanned",
                    false, details);
        } else if (missingToUnicode > 0 || missingDescriptor > 0) {
            addRepair("fonts", "info",
                    scanned + " font(s) scanned; " + missingToUnicode + " missing ToUnicode, "
                    + missingDescriptor + " missing descriptor",
                    false, details);
        } else {
            addRepair("fonts", "info",
                    "All " + scanned + " font(s) are healthy", false, details);
        }
    }

    // -- 5. repairDanglingReferences --

    private void repairDanglingReferences(PDDocument doc) {
        Map<String, Object> details = new LinkedHashMap<>();
        int totalReferences = 0;
        int dangling = 0;
        int nullified = 0;
        boolean repaired = false;

        try {
            COSDocument cosDoc = doc.getDocument();
            List<COSObject> allObjects = getAllObjects(cosDoc);

            // Build set of existing object keys
            Set<Long> existingKeys = new HashSet<>();
            for (COSObject obj : allObjects) {
                existingKeys.add(obj.getObjectNumber());
            }

            // Walk all objects checking for indirect references
            for (COSObject obj : allObjects) {
                COSBase base = obj.getObject();
                if (base instanceof COSDictionary) {
                    COSDictionary dict = (COSDictionary) base;
                    List<COSName> keysToNullify = new ArrayList<>();
                    for (COSName key : dict.keySet()) {
                        COSBase val = dict.getItem(key);
                        if (val instanceof COSObject) {
                            totalReferences++;
                            COSObject ref = (COSObject) val;
                            if (!existingKeys.contains(ref.getObjectNumber())) {
                                dangling++;
                                keysToNullify.add(key);
                            }
                        }
                    }
                    for (COSName key : keysToNullify) {
                        dict.setItem(key, COSNull.NULL);
                        nullified++;
                        repaired = true;
                    }
                } else if (base instanceof COSArray) {
                    COSArray arr = (COSArray) base;
                    for (int i = 0; i < arr.size(); i++) {
                        COSBase val = arr.get(i);
                        if (val instanceof COSObject) {
                            totalReferences++;
                            COSObject ref = (COSObject) val;
                            if (!existingKeys.contains(ref.getObjectNumber())) {
                                dangling++;
                                arr.set(i, COSNull.NULL);
                                nullified++;
                                repaired = true;
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            details.put("error", e.getMessage());
        }

        details.put("totalReferences", totalReferences);
        details.put("dangling", dangling);
        details.put("nullified", nullified);

        if (dangling > 0) {
            addRepair("dangling-references", "error",
                    "Found " + dangling + " dangling reference(s); nullified " + nullified,
                    repaired, details);
        } else {
            addRepair("dangling-references", "info",
                    "No dangling references found among " + totalReferences + " indirect references",
                    false, details);
        }
    }

    // -- 6. repairHeaderTrailer --

    private void repairHeaderTrailer(File inputFile, PDDocument doc) {
        Map<String, Object> details = new LinkedHashMap<>();
        boolean headerValid = false;
        boolean trailerValid = false;
        boolean startxrefValid = false;
        List<String> repairsApplied = new ArrayList<>();
        boolean repaired = false;

        try {
            byte[] fileBytes = Files.readAllBytes(inputFile.toPath());
            String content = new String(fileBytes, StandardCharsets.ISO_8859_1);

            // Check header
            headerValid = content.startsWith("%PDF-");
            if (!headerValid) {
                repairsApplied.add("header-missing");
            }

            // Check trailer: %%EOF near end
            int tailStart = Math.max(0, fileBytes.length - TAIL_SCAN_SIZE);
            String tail = content.substring(tailStart);
            trailerValid = tail.contains("%%EOF");
            if (!trailerValid) {
                repairsApplied.add("eof-marker-missing");
            }

            // Check startxref
            Pattern startxrefPattern = Pattern.compile("startxref\\s+(\\d+)");
            Matcher m = startxrefPattern.matcher(tail);
            if (m.find()) {
                long xrefOffset = Long.parseLong(m.group(1));
                if (xrefOffset >= 0 && xrefOffset < fileBytes.length) {
                    // Check if offset points to xref or xref stream
                    String atOffset = content.substring((int) Math.min(xrefOffset, content.length() - 1));
                    startxrefValid = atOffset.startsWith("xref") || atOffset.matches("^\\d+\\s+\\d+\\s+obj.*");
                }
            }
            if (!startxrefValid) {
                repairsApplied.add("startxref-invalid");
            }

            repaired = !repairsApplied.isEmpty();
        } catch (Exception e) {
            details.put("error", e.getMessage());
        }

        details.put("headerValid", headerValid);
        details.put("trailerValid", trailerValid);
        details.put("startxrefValid", startxrefValid);
        details.put("repairsApplied", repairsApplied);

        if (repaired) {
            addRepair("header-trailer", "error",
                    "Header/trailer issues detected: " + String.join(", ", repairsApplied),
                    false, details);
        } else {
            addRepair("header-trailer", "info",
                    "PDF header, trailer, and startxref are valid", false, details);
        }
    }

    // -- 7. consolidateIncrementalUpdates --

    private void consolidateIncrementalUpdates(File inputFile, PDDocument doc, File outputFile) {
        Map<String, Object> details = new LinkedHashMap<>();
        boolean consolidated = false;
        int revisionCount = 0;
        long sizeBefore = inputFile.length();
        long sizeAfter = sizeBefore;

        try {
            byte[] fileBytes = Files.readAllBytes(inputFile.toPath());
            String content = new String(fileBytes, StandardCharsets.ISO_8859_1);

            // Count %%EOF markers
            int idx = 0;
            while (true) {
                idx = content.indexOf("%%EOF", idx);
                if (idx == -1) break;
                revisionCount++;
                idx += 5;
            }

            if (revisionCount > 1) {
                // Save a fresh (consolidated) copy - PDFBox naturally merges all revisions
                // when saving via doc.save()
                doc.save(outputFile);
                sizeAfter = outputFile.length();
                consolidated = true;
            }
        } catch (Exception e) {
            details.put("error", e.getMessage());
        }

        details.put("revisionCount", revisionCount);
        details.put("consolidated", consolidated);
        details.put("sizeBefore", sizeBefore);
        details.put("sizeAfter", sizeAfter);

        if (consolidated) {
            addRepair("incremental-updates", "warning",
                    "Consolidated " + revisionCount + " revisions into single revision (" +
                    sizeBefore + " -> " + sizeAfter + " bytes)",
                    true, details);
        } else {
            addRepair("incremental-updates", "info",
                    "Single revision PDF, no consolidation needed",
                    false, details);
        }
    }

    // -- 8. repairTruncation --

    private void repairTruncation(File inputFile) {
        Map<String, Object> details = new LinkedHashMap<>();
        boolean truncated = false;
        long truncationOffset = -1;
        long totalFileSize = inputFile.length();
        int salvageableObjects = 0;

        try {
            byte[] fileBytes = Files.readAllBytes(inputFile.toPath());
            String content = new String(fileBytes, StandardCharsets.ISO_8859_1);

            // Check for %%EOF
            boolean hasEof = false;
            int tailStart = Math.max(0, content.length() - TAIL_SCAN_SIZE);
            String tail = content.substring(tailStart);
            hasEof = tail.contains("%%EOF");

            if (!hasEof) {
                truncated = true;
                truncationOffset = totalFileSize;
            }

            // Check if last object is complete (has matching endobj/endstream)
            int lastObjStart = content.lastIndexOf(" 0 obj");
            if (lastObjStart != -1) {
                String afterLastObj = content.substring(lastObjStart);
                boolean hasEndObj = afterLastObj.contains("endobj");
                if (!hasEndObj) {
                    truncated = true;
                    truncationOffset = lastObjStart + content.substring(0, lastObjStart).lastIndexOf('\n') + 1;
                }
            }

            // Count salvageable objects (complete objects with both obj and endobj)
            Pattern objPattern = Pattern.compile("(\\d+)\\s+0\\s+obj");
            Matcher m = objPattern.matcher(content);
            while (m.find()) {
                int start = m.start();
                int endObjPos = content.indexOf("endobj", start);
                if (endObjPos != -1) {
                    salvageableObjects++;
                }
            }
        } catch (Exception e) {
            details.put("error", e.getMessage());
        }

        details.put("truncated", truncated);
        details.put("truncationOffset", truncationOffset);
        details.put("totalFileSize", totalFileSize);
        details.put("salvageableObjects", salvageableObjects);

        if (truncated) {
            addRepair("truncation", "error",
                    "PDF appears truncated at offset " + truncationOffset +
                    "; " + salvageableObjects + " salvageable object(s)",
                    false, details);
        } else {
            addRepair("truncation", "info",
                    "PDF is not truncated; " + salvageableObjects + " complete objects",
                    false, details);
        }
    }

    // -- Utility --

    private static byte[] readAllBytes(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int read;
        while ((read = is.read(buf)) != -1) {
            baos.write(buf, 0, read);
        }
        return baos.toByteArray();
    }

    // -- JSON builder (minimal, no dependencies) --

    private static String toJson(Object obj) {
        if (obj == null) return "null";
        if (obj instanceof Boolean || obj instanceof Number) return obj.toString();
        if (obj instanceof String) return "\"" + escapeJson((String) obj) + "\"";
        if (obj instanceof List) {
            List<?> list = (List<?>) obj;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append(toJson(list.get(i)));
            }
            sb.append("]");
            return sb.toString();
        }
        if (obj instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) obj;
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) sb.append(",");
                first = false;
                sb.append("\"" + escapeJson(e.getKey().toString()) + "\":" + toJson(e.getValue()));
            }
            sb.append("}");
            return sb.toString();
        }
        return "\"" + escapeJson(obj.toString()) + "\"";
    }

    private static String escapeJson(String s) {
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    private static String prettyJson(Object obj) {
        return prettyJson(obj, 0);
    }

    private static String prettyJson(Object obj, int indent) {
        String pad = " ".repeat(indent);
        String padInner = " ".repeat(indent + 2);

        if (obj == null) return "null";
        if (obj instanceof Boolean || obj instanceof Number) return obj.toString();
        if (obj instanceof String) return "\"" + escapeJson((String) obj) + "\"";
        if (obj instanceof List) {
            List<?> list = (List<?>) obj;
            if (list.isEmpty()) return "[]";
            StringBuilder sb = new StringBuilder("[\n");
            for (int i = 0; i < list.size(); i++) {
                sb.append(padInner).append(prettyJson(list.get(i), indent + 2));
                if (i < list.size() - 1) sb.append(",");
                sb.append("\n");
            }
            sb.append(pad).append("]");
            return sb.toString();
        }
        if (obj instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) obj;
            if (map.isEmpty()) return "{}";
            StringBuilder sb = new StringBuilder("{\n");
            int i = 0;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                sb.append(padInner)
                  .append("\"").append(escapeJson(e.getKey().toString())).append("\": ")
                  .append(prettyJson(e.getValue(), indent + 2));
                if (i < map.size() - 1) sb.append(",");
                sb.append("\n");
                i++;
            }
            sb.append(pad).append("}");
            return sb.toString();
        }
        return "\"" + escapeJson(obj.toString()) + "\"";
    }

    // -- Corruption score --

    private double computeCorruptionScore() {
        if (repairs.isEmpty()) return 0.0;
        double score = 0.0;
        for (Map<String, Object> r : repairs) {
            String severity = (String) r.get("severity");
            boolean repaired = (Boolean) r.get("repaired");
            if ("error".equals(severity)) {
                score += repaired ? 0.10 : 0.25;
            } else if ("warning".equals(severity)) {
                score += repaired ? 0.03 : 0.07;
            }
        }
        return Math.min(1.0, score);
    }

    // -- Main entry --

    public static void main(String[] args) {
        String inputPath = null;
        String outputPath = null;
        String reportPath = null;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--pdf":
                    if (i + 1 < args.length) inputPath = args[++i];
                    break;
                case "--output":
                    if (i + 1 < args.length) outputPath = args[++i];
                    break;
                case "--report":
                    if (i + 1 < args.length) reportPath = args[++i];
                    break;
            }
        }

        if (inputPath == null || outputPath == null) {
            System.err.println("Usage: java PdfRepairCli --pdf <input.pdf> --output <repaired.pdf> [--report <report.json>]");
            System.exit(1);
        }

        File inputFile = new File(inputPath);
        if (!inputFile.exists()) {
            System.err.println("Error: Input file not found: " + inputPath);
            System.exit(1);
        }

        PdfRepairCli cli = new PdfRepairCli();
        cli.run(inputFile, new File(outputPath), reportPath);
    }

    private void run(File inputFile, File outputFile, String reportPath) {
        long fileSize = inputFile.length();

        // 1. Attempt to load the PDF (xref repair)
        PDDocument doc = null;
        try {
            doc = repairXrefTable(inputFile);
        } catch (Exception e) {
            // Already handled inside repairXrefTable
        }

        // 6. Header/Trailer repair (works on raw bytes, independent of doc load)
        try {
            repairHeaderTrailer(inputFile, doc);
        } catch (Exception e) {
            addRepair("header-trailer", "error",
                    "Header/trailer check failed: " + e.getMessage(), false, new LinkedHashMap<>());
        }

        // 8. Truncation check (works on raw bytes)
        try {
            repairTruncation(inputFile);
        } catch (Exception e) {
            addRepair("truncation", "error",
                    "Truncation check failed: " + e.getMessage(), false, new LinkedHashMap<>());
        }

        // Repairs that require a loaded document
        if (doc != null) {
            // 2. Stream lengths
            try {
                repairStreamLengths(doc);
            } catch (Exception e) {
                addRepair("stream-length", "error",
                        "Stream length check failed: " + e.getMessage(), false, new LinkedHashMap<>());
            }

            // 3. Flate streams
            try {
                repairFlateStreams(doc);
            } catch (Exception e) {
                addRepair("flate-stream", "error",
                        "FlateDecode check failed: " + e.getMessage(), false, new LinkedHashMap<>());
            }

            // 4. Fonts
            try {
                repairFonts(doc);
            } catch (Exception e) {
                addRepair("fonts", "error",
                        "Font check failed: " + e.getMessage(), false, new LinkedHashMap<>());
            }

            // 5. Dangling references
            try {
                repairDanglingReferences(doc);
            } catch (Exception e) {
                addRepair("dangling-references", "error",
                        "Dangling references check failed: " + e.getMessage(), false, new LinkedHashMap<>());
            }

            // 7. Consolidate incremental updates
            try {
                consolidateIncrementalUpdates(inputFile, doc, outputFile);
            } catch (Exception e) {
                addRepair("incremental-updates", "error",
                        "Incremental update consolidation failed: " + e.getMessage(), false, new LinkedHashMap<>());
            }

            // Save repaired PDF if any repairs were applied
            if (anyRepairApplied) {
                try {
                    // consolidateIncrementalUpdates may have already saved; check if output exists
                    if (!outputFile.exists()) {
                        doc.save(outputFile);
                    }
                } catch (Exception e) {
                    System.err.println("Warning: Could not save repaired PDF: " + e.getMessage());
                }
            }

            try {
                doc.close();
            } catch (Exception e) {
                // ignore
            }
        } else {
            // Document couldn't be loaded at all
            addRepair("stream-length", "error",
                    "Skipped: document could not be loaded", false, new LinkedHashMap<>());
            addRepair("flate-stream", "error",
                    "Skipped: document could not be loaded", false, new LinkedHashMap<>());
            addRepair("fonts", "error",
                    "Skipped: document could not be loaded", false, new LinkedHashMap<>());
            addRepair("dangling-references", "error",
                    "Skipped: document could not be loaded", false, new LinkedHashMap<>());
            addRepair("incremental-updates", "error",
                    "Skipped: document could not be loaded", false, new LinkedHashMap<>());
        }

        // Build overall report
        String overallStatus;
        if (issuesFound == 0) {
            overallStatus = "clean";
        } else if (issuesUnrepairable == 0) {
            overallStatus = "repaired";
        } else if (issuesRepaired > 0) {
            overallStatus = "partially-repaired";
        } else {
            overallStatus = "unrepairable";
        }

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("totalChecks", 8);
        summary.put("issuesFound", issuesFound);
        summary.put("issuesRepaired", issuesRepaired);
        summary.put("issuesUnrepairable", issuesUnrepairable);
        summary.put("overallStatus", overallStatus);

        Map<String, Object> report = new LinkedHashMap<>();
        report.put("inputPath", inputFile.getAbsolutePath());
        report.put("outputPath", anyRepairApplied ? outputFile.getAbsolutePath() : null);
        report.put("fileSize", fileSize);
        report.put("corruptionScore", Math.round(computeCorruptionScore() * 100.0) / 100.0);
        report.put("repairs", repairs);
        report.put("summary", summary);

        String jsonOutput = prettyJson(report);
        System.out.println(jsonOutput);

        // Write report file if requested
        if (reportPath != null) {
            try {
                Files.write(new File(reportPath).toPath(), jsonOutput.getBytes(StandardCharsets.UTF_8));
            } catch (Exception e) {
                System.err.println("Warning: Could not write report file: " + e.getMessage());
            }
        }
    }
}
