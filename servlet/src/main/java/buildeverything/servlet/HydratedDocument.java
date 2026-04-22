package buildeverything.servlet;

import java.util.List;
import java.util.Objects;

public record HydratedDocument(
        PerfectStudioHeadlessRunner.HeadlessResult headlessResult,
        StudioTag documentRoot,
        List<StudioTag> readingOrderTags,
        List<StudioValidationIssue> validationIssues,
        int pageCount) {
    public HydratedDocument {
        headlessResult = Objects.requireNonNull(headlessResult, "headlessResult");
        documentRoot = Objects.requireNonNull(documentRoot, "documentRoot");
        readingOrderTags = List.copyOf(readingOrderTags == null ? List.of() : readingOrderTags);
        validationIssues = List.copyOf(validationIssues == null ? List.of() : validationIssues);
        pageCount = Math.max(1, pageCount);
    }
}
