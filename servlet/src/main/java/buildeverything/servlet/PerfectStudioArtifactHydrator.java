package buildeverything.servlet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.awt.geom.Rectangle2D;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.LinkedHashSet;
import java.util.Set;

public final class PerfectStudioArtifactHydrator {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final Path repoRoot;
    private final PerfectStudioHeadlessRunner runner;

    public PerfectStudioArtifactHydrator(Path repoRoot) {
        this(repoRoot, new PerfectStudioHeadlessRunner.ProcessCommandExecutor());
    }

    public PerfectStudioArtifactHydrator(Path repoRoot, PerfectStudioHeadlessRunner.CommandExecutor executor) {
        this.repoRoot = Objects.requireNonNull(repoRoot, "repoRoot").toAbsolutePath().normalize();
        this.runner = new PerfectStudioHeadlessRunner(this.repoRoot, Objects.requireNonNull(executor, "executor"));
    }

    public HydratedDocument runAndHydrate(Path inputPdf, Appendable stdout, Appendable stderr)
            throws IOException, InterruptedException {
        Path normalizedInput = Objects.requireNonNull(inputPdf, "inputPdf").toAbsolutePath().normalize();
        String outputName = stripExtension(normalizedInput.getFileName().toString()) + "-tagged.pdf";
        Path outputDir = Files.createTempDirectory("perfect-studio-hydration-");
        Path outputPdf = outputDir.resolve(outputName);
        PerfectStudioHeadlessRunner.HeadlessResult result = runner.run(
                new PerfectStudioHeadlessRunner.HeadlessOptions(normalizedInput, outputPdf, outputDir),
                stdout,
                stderr);
        return hydrate(result);
    }

    public HydratedDocument hydrate(PerfectStudioHeadlessRunner.HeadlessResult result) throws IOException {
        Objects.requireNonNull(result, "result");
        Path tagsPath = result.generatedPdf().resolveSibling(result.generatedPdf().getFileName().toString() + ".tags.json");
        Path semanticPath = result.outputDir().resolve("04-semantic-ordered.json");
        JsonNode tagsManifest = readJson(tagsPath);
        JsonNode semanticOrdered = readJson(semanticPath);
        JsonNode validationReport = Files.isRegularFile(result.validationReport())
                ? readJson(result.validationReport())
                : MAPPER.createObjectNode();

        List<SemanticNode> orderedSemanticNodes = readSemanticNodes(semanticOrdered);
        Map<String, SemanticNode> semanticNodes = new LinkedHashMap<>();
        for (SemanticNode node : orderedSemanticNodes) {
            semanticNodes.put(node.id(), node);
        }
        Map<String, StudioTag> tagBySourceNodeId = new LinkedHashMap<>();
        StudioTag root = buildTagTree(tagsManifest.path("tagging").path("root"), semanticNodes, tagBySourceNodeId);

        List<StudioTag> readingOrderTags = buildReadingOrderTags(orderedSemanticNodes, tagBySourceNodeId, root);
        List<StudioValidationIssue> issues = ValidationRemediationCatalog.buildIssues(validationReport, root);
        int pageCount = inferPageCount(tagsManifest, semanticOrdered, root);
        return new HydratedDocument(result, root, readingOrderTags, issues, pageCount);
    }

    private static JsonNode readJson(Path path) throws IOException {
        if (!Files.isRegularFile(path)) {
            throw new IOException("Missing artifact: " + path);
        }
        return MAPPER.readTree(path.toFile());
    }

    private static int inferPageCount(JsonNode tagsManifest, JsonNode semanticOrdered, StudioTag root) {
        int manifestPages = Math.max(
                tagsManifest.path("summary").path("pagesNative").asInt(1),
                tagsManifest.path("summary").path("pagesRaster").asInt(0));
        int semanticPages = semanticOrdered.path("nodes").isArray()
                ? semanticOrdered.path("nodes").findValuesAsText("pageNumber").stream()
                        .mapToInt(PerfectStudioArtifactHydrator::parseInt)
                        .max()
                        .orElse(1)
                : 1;
        int modelPages = root.flatten().stream().mapToInt(StudioTag::pageNumber).max().orElse(1);
        return Math.max(Math.max(manifestPages, semanticPages), modelPages);
    }

    private static int parseInt(String value) {
        try {
            return Integer.parseInt(value);
        } catch (Exception ignored) {
            return 1;
        }
    }

    private static List<SemanticNode> readSemanticNodes(JsonNode semanticOrdered) {
        List<SemanticNode> nodes = new ArrayList<>();
        for (JsonNode node : iterable(semanticOrdered.path("nodes"))) {
            String id = text(node, "id", "");
            if (id.isEmpty()) {
                continue;
            }
            int pageNumber = node.path("pageNumber").asInt(1);
            Rectangle2D.Double bounds = readBounds(node.path("bbox"));
            nodes.add(new SemanticNode(id, pageNumber, bounds, node.path("readingOrder").asInt(Integer.MAX_VALUE)));
        }
        nodes.sort((left, right) -> Integer.compare(left.readingOrder(), right.readingOrder()));
        return nodes;
    }

    private static List<StudioTag> buildReadingOrderTags(
            List<SemanticNode> orderedSemanticNodes,
            Map<String, StudioTag> tagBySourceNodeId,
            StudioTag root) {
        List<StudioTag> orderedTags = new ArrayList<>();
        Set<String> seenTagIds = new LinkedHashSet<>();
        for (SemanticNode node : orderedSemanticNodes) {
            StudioTag tag = tagBySourceNodeId.get(node.id());
            if (tag == null || "Document".equals(tag.type()) || "Sect".equals(tag.type())) {
                continue;
            }
            if (seenTagIds.add(tag.id())) {
                orderedTags.add(tag);
            }
        }
        if (orderedTags.isEmpty()) {
            for (StudioTag tag : root.flatten()) {
                if (!"Document".equals(tag.type()) && !"Sect".equals(tag.type())) {
                    orderedTags.add(tag);
                }
            }
        }
        return orderedTags;
    }

    private static StudioTag buildTagTree(
            JsonNode tagNode,
            Map<String, SemanticNode> semanticNodes,
            Map<String, StudioTag> tagBySourceNodeId) {
        String id = text(tagNode, "id", "tag:unknown");
        String type = text(tagNode, "type", "Span");
        String label = text(tagNode, "label", type);
        String actualText = text(tagNode, "actualText", "");
        String alternateText = text(tagNode, "alternateText", "");
        boolean validationError = tagNode.path("validationError").asBoolean(false);

        List<StudioTag> children = new ArrayList<>();
        for (JsonNode childNode : iterable(tagNode.path("children"))) {
            children.add(buildTagTree(childNode, semanticNodes, tagBySourceNodeId));
        }

        List<SemanticNode> sourceNodes = new ArrayList<>();
        for (JsonNode sourceNodeId : iterable(tagNode.path("sourceNodeIds"))) {
            SemanticNode semanticNode = semanticNodes.get(sourceNodeId.asText());
            if (semanticNode != null) {
                sourceNodes.add(semanticNode);
            }
        }

        Rectangle2D.Double bounds = boundsFor(sourceNodes, children);
        int pageNumber = pageFor(sourceNodes, children);
        StudioTag tag = new StudioTag(id, type, label, pageNumber, bounds, actualText, alternateText, validationError, children);

        for (JsonNode sourceNodeId : iterable(tagNode.path("sourceNodeIds"))) {
            tagBySourceNodeId.put(sourceNodeId.asText(), tag);
        }
        return tag;
    }

    private static Rectangle2D.Double boundsFor(List<SemanticNode> sourceNodes, List<StudioTag> children) {
        Rectangle2D.Double bounds = null;
        for (SemanticNode sourceNode : sourceNodes) {
            bounds = union(bounds, sourceNode.bounds());
        }
        for (StudioTag child : children) {
            bounds = union(bounds, child.pdfBounds());
        }
        return bounds == null ? new Rectangle2D.Double(0, 0, 1, 1) : bounds;
    }

    private static int pageFor(List<SemanticNode> sourceNodes, List<StudioTag> children) {
        int page = Integer.MAX_VALUE;
        for (SemanticNode sourceNode : sourceNodes) {
            page = Math.min(page, sourceNode.pageNumber());
        }
        for (StudioTag child : children) {
            page = Math.min(page, child.pageNumber());
        }
        return page == Integer.MAX_VALUE ? 1 : page;
    }

    private static Rectangle2D.Double union(Rectangle2D.Double left, Rectangle2D.Double right) {
        if (right == null) {
            return left;
        }
        if (left == null) {
            return new Rectangle2D.Double(right.x, right.y, right.width, right.height);
        }
        Rectangle2D.Double bounds = new Rectangle2D.Double();
        Rectangle2D.union(left, right, bounds);
        return bounds;
    }

    private static Rectangle2D.Double readBounds(JsonNode bbox) {
        if (!bbox.isArray() || bbox.size() < 4) {
            return new Rectangle2D.Double(0, 0, 1, 1);
        }
        return new Rectangle2D.Double(
                bbox.path(0).asDouble(0),
                bbox.path(1).asDouble(0),
                bbox.path(2).asDouble(1),
                bbox.path(3).asDouble(1));
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

    private static String stripExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName;
    }

    private record SemanticNode(String id, int pageNumber, Rectangle2D.Double bounds, int readingOrder) {}
}
