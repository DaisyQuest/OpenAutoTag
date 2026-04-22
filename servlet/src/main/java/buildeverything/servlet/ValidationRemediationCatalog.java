package buildeverything.servlet;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ValidationRemediationCatalog {
    private static final Pattern PAGE_PATTERN = Pattern.compile("pages\\[(\\d+)]");

    private ValidationRemediationCatalog() {
    }

    public static List<StudioValidationIssue> buildIssues(JsonNode validationReport, StudioTag root) {
        List<StudioValidationIssue> issues = new ArrayList<>();
        if (validationReport == null || validationReport.isMissingNode() || validationReport.isNull()) {
            return issues;
        }

        Map<String, List<StudioTag>> tagsByType = new LinkedHashMap<>();
        Map<String, StudioTag> tagsById = new LinkedHashMap<>();
        indexTags(root, tagsByType, tagsById);

        for (JsonNode finding : iterable(validationReport.path("findings"))) {
            issues.add(buildIssue(finding, root, tagsByType, tagsById));
        }
        return issues;
    }

    private static StudioValidationIssue buildIssue(
            JsonNode finding,
            StudioTag root,
            Map<String, List<StudioTag>> tagsByType,
            Map<String, StudioTag> tagsById) {
        String severity = text(finding, "severity", "info");
        String code = text(finding, "code", "UNKNOWN");
        String description = text(finding, "description", "Validation finding reported by the PDF/UA validator.");
        int pageNumber = pageNumberFromFinding(finding);
        List<String> targetTagIds = targetTagIds(finding, root, tagsByType, tagsById);
        String remediation = remediationFor(code, description, finding);
        return new StudioValidationIssue(severity, code, description, pageNumber, remediation, targetTagIds);
    }

    private static List<String> targetTagIds(
            JsonNode finding,
            StudioTag root,
            Map<String, List<StudioTag>> tagsByType,
            Map<String, StudioTag> tagsById) {
        String code = text(finding, "code", "");
        String description = text(finding, "description", "").toLowerCase(Locale.ROOT);
        String object = text(finding, "object", "");
        Set<String> ids = new LinkedHashSet<>();

        if (code.equals("VERAPDF_7_2_8") || object.equals("SETH") || description.contains("th element should be contained in tr element")) {
            addIds(ids, tagsByType.get("TH"));
        }
        if (code.equals("VERAPDF_7_2_9") || object.equals("SETD") || description.contains("td element should be contained in tr element")) {
            addIds(ids, tagsByType.get("TD"));
        }
        if (code.contains("7_18") || description.contains("alternate text") || description.contains("alt text")) {
            addIds(ids, tagsByType.get("Figure"));
        }
        if (code.equals("VERAPDF_7_1_9") || code.equals("VERAPDF_5_1") || description.contains("dc:title") || description.contains("metadata stream")) {
            if (tagsById.containsKey(root.id())) {
                ids.add(root.id());
            }
        }
        if (description.contains("link element") || description.contains("link annot")) {
            addIds(ids, tagsByType.get("Link"));
        }
        if (description.contains("table")) {
            addIds(ids, tagsByType.get("Table"));
            addIds(ids, tagsByType.get("TR"));
        }
        return List.copyOf(ids);
    }

    private static void addIds(Set<String> ids, List<StudioTag> tags) {
        if (tags == null) {
            return;
        }
        for (StudioTag tag : tags) {
            ids.add(tag.id());
        }
    }

    private static String remediationFor(String code, String description, JsonNode finding) {
        String normalized = (code + " " + description).toLowerCase(Locale.ROOT);
        if (normalized.contains("alternate text") || normalized.contains("alt text")) {
            return "Add concise alternate text to the affected Figure element and ensure the figure remains in the logical reading order.";
        }
        if (normalized.contains("contained in tr element")) {
            return "Move the offending TH or TD into a TR, then keep row content inside the table structure.";
        }
        if (normalized.contains("metadata stream") || normalized.contains("dc:title") || normalized.contains("pdf/ua identification")) {
            return "Restore the PDF/UA XMP identification packet and add a clear dc:title value in the document metadata.";
        }
        if (normalized.contains(".notdef glyph")) {
            return "Replace the missing glyph run, or re-embed a font that covers the characters being rendered.";
        }
        if (normalized.contains("font programs")) {
            return "Embed the font program for every rendered font in the PDF.";
        }
        if (normalized.contains("glyph width information")) {
            return "Regenerate the tagged PDF with a consistent embedded font program and matching width data.";
        }
        if (normalized.contains("link")) {
            return "Attach the visible link text or annotation to a proper Link structure element.";
        }
        if (normalized.contains("reading order")) {
            return "Reorder the structure tree or reading-order list so the visual sequence matches the tag sequence.";
        }
        if (normalized.contains("table")) {
            return "Check the table hierarchy and repair missing or misplaced table sections, rows, or cells.";
        }
        return text(finding, "test", "").isEmpty()
                ? "Review the validator context and repair the referenced structure element."
                : "Review the validator test and repair the referenced structure element.";
    }

    private static int pageNumberFromFinding(JsonNode finding) {
        for (JsonNode check : iterable(finding.path("checks"))) {
            String context = text(check, "context", "");
            Matcher matcher = PAGE_PATTERN.matcher(context);
            if (matcher.find()) {
                return Integer.parseInt(matcher.group(1)) + 1;
            }
        }
        return 1;
    }

    private static void indexTags(StudioTag tag, Map<String, List<StudioTag>> tagsByType, Map<String, StudioTag> tagsById) {
        tagsById.put(tag.id(), tag);
        tagsByType.computeIfAbsent(tag.type(), (_key) -> new ArrayList<>()).add(tag);
        for (StudioTag child : tag.children()) {
            indexTags(child, tagsByType, tagsById);
        }
    }

    private static String text(JsonNode node, String fieldName, String fallback) {
        JsonNode field = node.get(fieldName);
        if (field == null || field.isNull()) {
            return fallback;
        }
        String value = field.asText("").trim();
        return value.isEmpty() ? fallback : value;
    }

    private static Iterable<JsonNode> iterable(JsonNode node) {
        List<JsonNode> values = new ArrayList<>();
        if (node != null && node.isArray()) {
            node.forEach(values::add);
        }
        return values;
    }
}
