package buildeverything.servlet;

import java.util.List;
import java.util.Objects;

public record StudioValidationIssue(
        String severity,
        String code,
        String description,
        int pageNumber,
        String remediation,
        List<String> targetTagIds) {
    public StudioValidationIssue {
        severity = normalize(severity, "info");
        code = normalize(code, "UNKNOWN");
        description = description == null ? "" : description;
        pageNumber = Math.max(1, pageNumber);
        remediation = remediation == null ? "" : remediation;
        targetTagIds = List.copyOf(targetTagIds == null ? List.of() : targetTagIds);
    }

    public boolean affectsTag(String tagId) {
        return tagId != null && targetTagIds.contains(tagId);
    }

    private static String normalize(String value, String fallback) {
        String text = Objects.toString(value, "").trim();
        return text.isEmpty() ? fallback : text;
    }
}
