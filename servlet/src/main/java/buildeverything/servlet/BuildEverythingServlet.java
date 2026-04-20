package buildeverything.servlet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.ServletConfig;
import jakarta.servlet.ServletException;
import jakarta.servlet.annotation.MultipartConfig;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.Part;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@MultipartConfig(fileSizeThreshold = 0)
public class BuildEverythingServlet extends HttpServlet {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final byte[] PDF_SIGNATURE = "%PDF-".getBytes(StandardCharsets.US_ASCII);
    private static final Pattern ARTIFACT_PATH = Pattern.compile("^/jobs/([^/]+)/artifacts/([^/]+)$");
    private static final Pattern JOB_PATH = Pattern.compile("^/jobs/([^/]+)$");
    private static final Pattern BATCH_PATH = Pattern.compile("^/batches/([^/]+)$");
    private static final Map<String, String> CONTENT_TYPES = Map.of(
        ".html", "text/html; charset=utf-8",
        ".css", "text/css; charset=utf-8",
        ".js", "application/javascript; charset=utf-8",
        ".json", "application/json; charset=utf-8",
        ".pdf", "application/pdf"
    );
    private static final String APP_NAME = "openautotag";
    private static final ExecutorService PROCESS_IO_EXECUTOR = Executors.newCachedThreadPool(Thread.ofVirtual().factory());
    private static final Map<String, WorkloadDefinition> WORKLOADS = createWorkloadDefinitions();

    private final ConcurrentMap<String, ObjectNode> jobs = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, BatchRecord> batches = new ConcurrentHashMap<>();
    private volatile ExecutorService queueExecutor;
    private volatile Config config;

    @Override
    public void init(ServletConfig servletConfig) throws ServletException {
        super.init(servletConfig);
        config = Config.from(servletConfig);
        queueExecutor = Executors.newSingleThreadExecutor((runnable) -> {
            Thread thread = new Thread(runnable, "buildeverything-servlet-queue");
            thread.setDaemon(true);
            return thread;
        });
    }

    @Override
    public void destroy() {
        if (queueExecutor != null) {
            queueExecutor.shutdownNow();
        }
        super.destroy();
    }

    @Override
    protected void service(HttpServletRequest request, HttpServletResponse response) throws ServletException, IOException {
        try {
            dispatch(request, response);
        } catch (HttpStatusException exception) {
            writeError(response, exception.statusCode(), exception.getMessage());
        } catch (Exception exception) {
            writeError(response, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, exception.getMessage());
        }
    }

    private void dispatch(HttpServletRequest request, HttpServletResponse response) throws Exception {
        String method = request.getMethod().toUpperCase(Locale.ROOT);
        String path = normalizePath(request);

        if ("GET".equals(method) && "/favicon.ico".equals(path)) {
            response.setStatus(HttpServletResponse.SC_NO_CONTENT);
            return;
        }

        if ("GET".equals(method) && "/health".equals(path)) {
            handleHealth(response);
            return;
        }

        if ("GET".equals(method) && "/workloads".equals(path)) {
            handleWorkloads(response);
            return;
        }

        if ("POST".equals(method) && "/process-pdf".equals(path)) {
            handleProcessPdf(request, response);
            return;
        }

        if ("POST".equals(method) && "/process-pdf-url".equals(path)) {
            handleProcessPdfUrl(request, response);
            return;
        }

        if ("POST".equals(method) && "/process-pdf-upload".equals(path)) {
            handleProcessPdfUpload(request, response);
            return;
        }

        Matcher artifactMatcher = ARTIFACT_PATH.matcher(path);
        if ("GET".equals(method) && artifactMatcher.matches()) {
            handleArtifact(response, decodePathSegment(artifactMatcher.group(1)), decodePathSegment(artifactMatcher.group(2)));
            return;
        }

        Matcher batchMatcher = BATCH_PATH.matcher(path);
        if ("GET".equals(method) && batchMatcher.matches()) {
            handleBatch(response, decodePathSegment(batchMatcher.group(1)));
            return;
        }

        Matcher jobMatcher = JOB_PATH.matcher(path);
        if ("GET".equals(method) && jobMatcher.matches()) {
            handleJob(response, decodePathSegment(jobMatcher.group(1)));
            return;
        }

        if ("GET".equals(method) && serveStaticAsset(response, path)) {
            return;
        }

        if ("GET".equals(method) && "/difftool".equals(path)) {
            if (serveStaticAsset(response, "/difftool.html")) {
                return;
            }
        }

        writeError(response, HttpServletResponse.SC_NOT_FOUND, "Not found");
    }

    private void handleHealth(HttpServletResponse response) throws IOException {
        Files.createDirectories(config.runtimeRoot());
        Files.createDirectories(config.jobsRoot());
        Files.createDirectories(config.uploadRoot());

        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("ok", true);

        ObjectNode runtime = payload.putObject("runtime");
        runtime.put("root", config.runtimeRoot().toString());
        runtime.put("jobsRoot", config.jobsRoot().toString());
        runtime.put("uploadRoot", config.uploadRoot().toString());
        runtime.put("azureAppService", isAzureAppServiceRuntime());
        putTextOrNull(runtime, "home", trimToNull(System.getenv("HOME")));
        putTextOrNull(runtime, "runFromPackage", trimToNull(System.getenv("WEBSITE_RUN_FROM_PACKAGE")));

        writeJson(response, HttpServletResponse.SC_OK, payload);
    }

    private void handleWorkloads(HttpServletResponse response) throws IOException {
        ArrayNode workloads = MAPPER.createArrayNode();
        for (WorkloadDefinition definition : WORKLOADS.values()) {
            workloads.add(publicWorkload(definition));
        }

        ObjectNode payload = MAPPER.createObjectNode();
        payload.set("workloads", workloads);
        writeJson(response, HttpServletResponse.SC_OK, payload);
    }

    private void handleProcessPdf(HttpServletRequest request, HttpServletResponse response) throws Exception {
        ObjectNode body = readJsonBody(request);
        String filePath = requiredText(body, "filePath");
        String outputDir = text(body, "outputDir");
        WorkloadDefinition workload = workloadForId(text(body, "workloadId"));
        ObjectNode options = objectValue(body.get("options"));

        ObjectNode metadata = MAPPER.createObjectNode();
        metadata.put("inputMode", "path");

        ObjectNode job = enqueueJob(Paths.get(filePath).toAbsolutePath().normalize(), outputDir, workload, options, metadata);
        writeJson(response, HttpServletResponse.SC_ACCEPTED, buildJobResponse(job));
    }

    private void handleProcessPdfUrl(HttpServletRequest request, HttpServletResponse response) throws Exception {
        ObjectNode body = readJsonBody(request);
        String fileUrl = requiredText(body, "fileUrl");
        String outputDir = text(body, "outputDir");
        WorkloadDefinition workload = workloadForId(text(body, "workloadId"));
        ObjectNode options = objectValue(body.get("options"));

        DownloadedFile remotePdf = downloadRemotePdf(fileUrl);

        ObjectNode metadata = MAPPER.createObjectNode();
        metadata.put("inputMode", "url");
        metadata.put("sourceUrl", remotePdf.sourceUrl());
        metadata.put("sourceFileName", remotePdf.fileName());
        if (!Objects.equals(remotePdf.sourceUrl(), remotePdf.finalUrl())) {
            metadata.put("resolvedUrl", remotePdf.finalUrl());
        }

        ObjectNode job = enqueueJob(remotePdf.absolutePath(), outputDir, workload, options, metadata);
        writeJson(response, HttpServletResponse.SC_ACCEPTED, buildJobResponse(job));
    }

    private void handleProcessPdfUpload(HttpServletRequest request, HttpServletResponse response) throws Exception {
        List<Part> parts = new ArrayList<>(request.getParts());
        List<String> relativePaths = new ArrayList<>();
        String workloadId = "accessibility-tagging";

        for (Part part : parts) {
            if ("relativePaths".equals(part.getName())) {
                relativePaths.add(readPartAsString(part));
            } else if ("workloadId".equals(part.getName())) {
                workloadId = readPartAsString(part);
            }
        }

        List<UploadSelection> uploads = new ArrayList<>();
        int fileIndex = 0;
        for (Part part : parts) {
            if (!"files".equals(part.getName())) {
                continue;
            }

            String submittedName = sanitizeSegment(part.getSubmittedFileName(), "document.pdf");
            String relativePath = fileIndex < relativePaths.size() ? relativePaths.get(fileIndex) : submittedName;
            fileIndex += 1;

            if (submittedName.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
                uploads.add(new UploadSelection(part, relativePath));
            }
        }

        if (uploads.isEmpty()) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_REQUEST, "At least one PDF file is required.");
        }

        ObjectNode batch = enqueueUploads(uploads, workloadForId(workloadId));
        writeJson(response, HttpServletResponse.SC_ACCEPTED, batch);
    }

    private void handleArtifact(HttpServletResponse response, String jobId, String artifactName) throws IOException, HttpStatusException {
        ObjectNode job = jobs.get(jobId);
        if (job == null) {
            throw new HttpStatusException(HttpServletResponse.SC_NOT_FOUND, "Artifact not found");
        }

        Path artifactPath = artifactPath(job, artifactName);
        if (artifactPath == null || !Files.exists(artifactPath)) {
            throw new HttpStatusException(HttpServletResponse.SC_NOT_FOUND, "Artifact not found");
        }

        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType(contentTypeFor(artifactPath));
        response.setHeader("Content-Disposition", "attachment; filename=\"" + artifactPath.getFileName() + "\"");

        try (InputStream inputStream = Files.newInputStream(artifactPath);
             OutputStream outputStream = response.getOutputStream()) {
            inputStream.transferTo(outputStream);
        }
    }

    private void handleBatch(HttpServletResponse response, String batchId) throws IOException, HttpStatusException {
        BatchRecord batch = batches.get(batchId);
        if (batch == null) {
            throw new HttpStatusException(HttpServletResponse.SC_NOT_FOUND, "Batch not found");
        }

        writeJson(response, HttpServletResponse.SC_OK, buildBatchSnapshot(batch));
    }

    private void handleJob(HttpServletResponse response, String jobId) throws IOException, HttpStatusException {
        ObjectNode job = jobs.get(jobId);
        if (job == null) {
            throw new HttpStatusException(HttpServletResponse.SC_NOT_FOUND, "Job not found");
        }

        writeJson(response, HttpServletResponse.SC_OK, buildJobResponse(job));
    }

    private ObjectNode enqueueUploads(List<UploadSelection> uploads, WorkloadDefinition workload) throws Exception {
        String batchId = UUID.randomUUID().toString();
        String createdAt = Instant.now().toString();
        Path batchRoot = config.uploadRoot().resolve(batchId).toAbsolutePath().normalize();
        Path uploadDir = batchRoot.resolve("uploads");
        Path outputDir = batchRoot.resolve("jobs");
        List<BatchItemRecord> items = new ArrayList<>();

        for (int index = 0; index < uploads.size(); index += 1) {
            UploadSelection selection = uploads.get(index);
            PersistedUpload persistedUpload = persistUpload(selection.part(), selection.relativePath(), uploadDir);

            ObjectNode metadata = MAPPER.createObjectNode();
            metadata.put("inputMode", "upload");

            ObjectNode job = enqueueJob(
                persistedUpload.absolutePath(),
                outputDir.resolve(makeOutputDirectoryName(persistedUpload.relativePath(), index)).toString(),
                workload,
                MAPPER.createObjectNode(),
                metadata
            );

            items.add(new BatchItemRecord(
                text(job, "jobId"),
                persistedUpload.fileName(),
                persistedUpload.relativePath(),
                workload.id()
            ));
        }

        BatchRecord batch = new BatchRecord(batchId, createdAt, workload.id(), items);
        batches.put(batchId, batch);
        return buildBatchSnapshot(batch);
    }

    private PersistedUpload persistUpload(Part part, String relativePath, Path uploadDir) throws Exception {
        Path uploadRoot = uploadDir.toAbsolutePath().normalize();
        Files.createDirectories(uploadRoot);

        String submittedName = sanitizeSegment(part.getSubmittedFileName(), "document.pdf");
        String safeRelativePath = sanitizeRelativePath(relativePath, submittedName);
        Path targetPath = uploadRoot.resolve(safeRelativePath).normalize();

        if (!targetPath.startsWith(uploadRoot)) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_REQUEST, "Upload path escaped the batch directory.");
        }

        Files.createDirectories(targetPath.getParent());
        try (InputStream inputStream = part.getInputStream();
             OutputStream outputStream = Files.newOutputStream(targetPath, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            inputStream.transferTo(outputStream);
        }

        return new PersistedUpload(targetPath, targetPath.getFileName().toString(), safeRelativePath);
    }

    private ObjectNode enqueueJob(Path filePath, String outputDir, WorkloadDefinition workload, ObjectNode options, ObjectNode metadata) {
        String jobId = UUID.randomUUID().toString();
        String createdAt = Instant.now().toString();
        Path resolvedOutputDir = resolveOutputDir(outputDir, jobId);

        ObjectNode job = MAPPER.createObjectNode();
        job.put("jobId", jobId);
        job.put("status", "queued");
        job.set("workload", publicWorkload(workload));

        ObjectNode input = job.putObject("input");
        mergeObject(input, metadata);
        input.put("filePath", filePath.toString());
        input.put("outputDir", resolvedOutputDir.toString());
        input.put("workloadId", workload.id());
        input.set("options", options.deepCopy());

        job.set("artifacts", MAPPER.createObjectNode());
        job.put("createdAt", createdAt);
        job.put("updatedAt", createdAt);
        jobs.put(jobId, job);

        queueExecutor.submit(() -> executeJob(jobId, filePath, resolvedOutputDir, workload, options.deepCopy(), metadata.deepCopy(), createdAt));
        return job.deepCopy();
    }

    private void executeJob(String jobId, Path filePath, Path outputDir, WorkloadDefinition workload, ObjectNode options, ObjectNode metadata, String createdAt) {
        try {
            updateJobStatus(jobId, "running", null);
            Files.createDirectories(outputDir);

            ProcessResult processResult = runNodeWorkload(filePath, outputDir, workload);
            ObjectNode snapshot = parseProcessSnapshot(processResult, workload);
            snapshot.put("jobId", jobId);
            snapshot.put("createdAt", createdAt);
            snapshot.put("updatedAt", text(snapshot, "updatedAt", Instant.now().toString()));
            snapshot.set("workload", publicWorkload(workload));

            ObjectNode input = objectValue(snapshot.get("input"));
            mergeObject(input, metadata);
            input.put("filePath", filePath.toString());
            input.put("outputDir", outputDir.toString());
            input.put("workloadId", workload.id());
            input.set("options", options.deepCopy());
            snapshot.set("input", input);

            jobs.put(jobId, snapshot);
        } catch (Exception exception) {
            updateJobStatus(jobId, "failed", exception.getMessage());
        }
    }

    private ProcessResult runNodeWorkload(Path filePath, Path outputDir, WorkloadDefinition workload) throws Exception {
        List<String> command = List.of(
            config.nodeExecutable(),
            config.repoRoot().resolve(workload.runnerScript()).toString(),
            "--pdf",
            filePath.toString(),
            "--output-dir",
            outputDir.toString()
        );

        ProcessBuilder processBuilder = new ProcessBuilder(command);
        processBuilder.directory(config.repoRoot().toFile());
        Process process = processBuilder.start();

        CompletableFuture<String> stdoutFuture = CompletableFuture.supplyAsync(() -> readStream(process.getInputStream()), PROCESS_IO_EXECUTOR);
        CompletableFuture<String> stderrFuture = CompletableFuture.supplyAsync(() -> readStream(process.getErrorStream()), PROCESS_IO_EXECUTOR);

        int exitCode = process.waitFor();
        String stdout = stdoutFuture.join();
        String stderr = stderrFuture.join();

        if (exitCode != 0) {
            String message = trimToNull(stderr) != null ? stderr.trim() : trimToNull(stdout) != null ? stdout.trim() : "Node workload failed";
            throw new IOException(message);
        }

        return new ProcessResult(stdout, stderr);
    }

    private ObjectNode parseProcessSnapshot(ProcessResult processResult, WorkloadDefinition workload) throws IOException {
        String stdout = trimToNull(processResult.stdout());
        if (stdout == null) {
            throw new IOException("Node workload did not emit a JSON snapshot.");
        }

        JsonNode root = MAPPER.readTree(stdout);
        if (!(root instanceof ObjectNode objectNode)) {
            throw new IOException("Node workload did not emit an object snapshot.");
        }

        ObjectNode snapshot = objectNode.deepCopy();
        if (!snapshot.has("workload")) {
            snapshot.set("workload", publicWorkload(workload));
        }
        return snapshot;
    }

    private void updateJobStatus(String jobId, String status, String error) {
        jobs.computeIfPresent(jobId, (ignored, existing) -> {
            ObjectNode updated = existing.deepCopy();
            updated.put("status", status);
            updated.put("updatedAt", Instant.now().toString());
            if (trimToNull(error) == null) {
                updated.remove("error");
            } else {
                updated.put("error", error);
            }
            return updated;
        });
    }

    private ObjectNode buildJobResponse(ObjectNode job) throws IOException {
        ObjectNode response = job.deepCopy();
        String jobId = text(response, "jobId");

        response.put("fileName", getJobDisplayName(response));
        response.put("relativePath", getJobDisplayPath(response));
        putTextOrNull(response, "sourceUrl", text(objectValue(response.get("input")), "sourceUrl"));
        response.set("artifactLinks", buildArtifactLinks(jobId, response));

        SummaryPayload summaryPayload = summarizeJob(response);
        response.set("summary", summaryPayload.summary());
        response.set("validation", summaryPayload.validation());
        return response;
    }

    private SummaryPayload summarizeJob(ObjectNode job) throws IOException {
        String workloadId = text(objectValue(job.get("workload")), "id", text(objectValue(job.get("input")), "workloadId", "accessibility-tagging"));
        return switch (workloadId) {
            case "ssn-redaction" -> summarizeRedaction(job);
            case "tag-and-ssn-redact" -> summarizeTaggedRedaction(job);
            default -> summarizeAccessibility(job);
        };
    }

    private SummaryPayload summarizeAccessibility(ObjectNode job) throws IOException {
        JsonNode report = readArtifactJson(job, "validationReport");
        if (report == null || report.isNull()) {
            return SummaryPayload.empty();
        }

        JsonNode tagDeltaReport = readArtifactJson(job, "tagDeltaReport");
        boolean isCompliant = report.path("isCompliant").asBoolean(false);
        int failedRules = report.path("summary").path("failedRules").asInt(0);
        int failedChecks = report.path("summary").path("failedChecks").asInt(0);

        ObjectNode summary = MAPPER.createObjectNode();
        summary.put("kind", "validation");
        summary.put("tone", isCompliant ? "success" : "danger");
        summary.put("label", isCompliant ? "Validation passed" : failedRules + " failed rule" + (failedRules == 1 ? "" : "s"));
        summary.put("detail", isCompliant ? "PDF/UA checks passed." : failedChecks + " failed check" + (failedChecks == 1 ? "" : "s") + ".");
        summary.set("signals", buildAccessibilitySignals(report, tagDeltaReport));
        setNodeOrNull(summary, "metadataDiagnostics", report.get("metadataDiagnostics"));
        setNodeOrNull(summary, "tagDelta", tagDeltaReport == null ? null : tagDeltaReport.get("delta"));

        ObjectNode validation = MAPPER.createObjectNode();
        validation.put("isCompliant", isCompliant);
        validation.put("failedRules", failedRules);
        validation.put("failedChecks", failedChecks);
        validation.set("findingCodes", codesFromFindings(report.path("findings"), 6));
        setNodeOrNull(validation, "metadataDiagnostics", report.get("metadataDiagnostics"));
        setNodeOrNull(validation, "tagDelta", tagDeltaReport == null ? null : tagDeltaReport.get("delta"));
        return new SummaryPayload(summary, validation);
    }

    private SummaryPayload summarizeRedaction(ObjectNode job) throws IOException {
        JsonNode report = readArtifactJson(job, "redactionReport");
        if (report == null || report.isNull()) {
            return SummaryPayload.empty();
        }

        int redactedMatches = report.path("summary").path("redactedMatches").asInt(0);
        int pagesRedacted = report.path("summary").path("pagesRedacted").asInt(0);

        ObjectNode summary = MAPPER.createObjectNode();
        summary.put("kind", "redaction");
        summary.put("tone", redactedMatches > 0 ? "success" : "neutral");
        summary.put("label", redactedMatches > 0 ? redactedMatches + " SSN" + (redactedMatches == 1 ? "" : "s") + " redacted" : "No SSNs found");
        summary.put("detail", redactedMatches > 0 ? pagesRedacted + " page" + (pagesRedacted == 1 ? "" : "s") + " modified." : "Output copied without redactions.");

        ArrayNode signals = MAPPER.createArrayNode();
        for (JsonNode match : iterable(report.path("matches"))) {
            if (signals.size() >= 4) {
                break;
            }
            signals.add("Page " + match.path("pageNumber").asInt() + ": " + match.path("maskedText").asText(""));
        }
        summary.set("signals", signals);

        return new SummaryPayload(summary, NullNode.getInstance());
    }

    private SummaryPayload summarizeTaggedRedaction(ObjectNode job) throws IOException {
        JsonNode redactionReport = readArtifactJson(job, "redactionReport");
        if (redactionReport == null || redactionReport.isNull()) {
            return SummaryPayload.empty();
        }

        JsonNode validationReport = readArtifactJson(job, "validationReport");
        JsonNode tagDeltaReport = readArtifactJson(job, "tagDeltaReport");

        int redactedMatches = redactionReport.path("summary").path("redactedMatches").asInt(0);
        int failedRules = validationReport == null ? 0 : validationReport.path("summary").path("failedRules").asInt(0);
        int failedChecks = validationReport == null ? 0 : validationReport.path("summary").path("failedChecks").asInt(0);
        boolean isCompliant = validationReport != null && validationReport.path("isCompliant").asBoolean(false);

        ObjectNode summary = MAPPER.createObjectNode();
        summary.put("kind", "tagged-redaction");
        summary.put("tone", redactedMatches > 0 ? "success" : isCompliant ? "success" : "danger");
        if (redactedMatches > 0) {
            summary.put("label", redactedMatches + " SSN" + (redactedMatches == 1 ? "" : "s") + " redacted");
            summary.put("detail", "Visible content and accessibility text were masked before validation.");
        } else if (isCompliant) {
            summary.put("label", "Tagged PDF emitted");
            summary.put("detail", "No SSNs were found. Tagged output still completed.");
        } else {
            summary.put("label", failedRules + " failed rule" + (failedRules == 1 ? "" : "s"));
            summary.put("detail", failedChecks + " failed check" + (failedChecks == 1 ? "" : "s") + " after tagging.");
        }

        ArrayNode signals = MAPPER.createArrayNode();
        for (JsonNode match : iterable(redactionReport.path("matches"))) {
            if (signals.size() >= 3) {
                break;
            }
            signals.add("Page " + match.path("pageNumber").asInt() + ": " + match.path("maskedText").asText(""));
        }
        for (JsonNode code : codesFromFindings(validationReport == null ? NullNode.getInstance() : validationReport.path("findings"), 3)) {
            if (signals.size() >= 6) {
                break;
            }
            signals.add(code.asText());
        }
        for (JsonNode signal : buildTagDeltaSignals(tagDeltaReport)) {
            if (signals.size() >= 6) {
                break;
            }
            signals.add(signal.asText());
        }
        summary.set("signals", signals);

        if (validationReport == null) {
            return new SummaryPayload(summary, NullNode.getInstance());
        }

        ObjectNode validation = MAPPER.createObjectNode();
        validation.put("isCompliant", isCompliant);
        validation.put("failedRules", failedRules);
        validation.put("failedChecks", failedChecks);
        validation.set("findingCodes", codesFromFindings(validationReport.path("findings"), 6));
        setNodeOrNull(validation, "metadataDiagnostics", validationReport.get("metadataDiagnostics"));
        setNodeOrNull(validation, "tagDelta", tagDeltaReport == null ? null : tagDeltaReport.get("delta"));
        return new SummaryPayload(summary, validation);
    }

    private JsonNode readArtifactJson(ObjectNode job, String artifactName) throws IOException {
        Path artifactPath = artifactPath(job, artifactName);
        if (artifactPath == null || !Files.exists(artifactPath)) {
            return null;
        }

        try (InputStream inputStream = Files.newInputStream(artifactPath)) {
            return MAPPER.readTree(inputStream);
        }
    }

    private Path artifactPath(ObjectNode job, String artifactName) {
        JsonNode artifactNode = objectValue(job.get("artifacts")).get(artifactName);
        if (artifactNode == null || artifactNode.isNull() || trimToNull(artifactNode.asText()) == null) {
            return null;
        }
        return Paths.get(artifactNode.asText()).toAbsolutePath().normalize();
    }

    private ObjectNode buildArtifactLinks(String jobId, ObjectNode job) {
        ObjectNode links = MAPPER.createObjectNode();
        Iterator<Map.Entry<String, JsonNode>> fields = objectValue(job.get("artifacts")).fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            if (trimToNull(entry.getValue().asText()) != null) {
                links.put(entry.getKey(), "/jobs/" + encodePathSegment(jobId) + "/artifacts/" + encodePathSegment(entry.getKey()));
            }
        }
        return links;
    }

    private ObjectNode buildBatchSnapshot(BatchRecord batch) throws IOException {
        ArrayNode items = MAPPER.createArrayNode();
        Totals totals = new Totals();
        String updatedAt = batch.createdAt();

        for (BatchItemRecord item : batch.items()) {
            ObjectNode itemNode = MAPPER.createObjectNode();
            itemNode.put("jobId", item.jobId());
            itemNode.put("fileName", item.fileName());
            itemNode.put("relativePath", item.relativePath());
            itemNode.set("workload", publicWorkload(workloadForId(item.workloadId())));

            ObjectNode job = jobs.get(item.jobId());
            if (job == null) {
                itemNode.put("status", "missing");
                itemNode.putNull("error");
                itemNode.put("createdAt", batch.createdAt());
                itemNode.put("updatedAt", batch.createdAt());
                itemNode.set("summary", NullNode.getInstance());
                itemNode.set("validation", NullNode.getInstance());
                itemNode.set("artifacts", MAPPER.createObjectNode());
                totals.increment("missing");
            } else {
                SummaryPayload summaryPayload = summarizeJob(job);
                String status = text(job, "status", "missing");
                itemNode.put("status", status);
                putTextOrNull(itemNode, "error", text(job, "error"));
                itemNode.put("createdAt", text(job, "createdAt", batch.createdAt()));
                itemNode.put("updatedAt", text(job, "updatedAt", batch.createdAt()));
                itemNode.set("summary", summaryPayload.summary());
                itemNode.set("validation", summaryPayload.validation());
                itemNode.set("artifacts", buildArtifactLinks(item.jobId(), job));
                updatedAt = laterTimestamp(updatedAt, text(job, "updatedAt", batch.createdAt()));
                totals.increment(status);
            }

            totals.total += 1;
            items.add(itemNode);
        }

        ObjectNode snapshot = MAPPER.createObjectNode();
        snapshot.put("batchId", batch.batchId());
        snapshot.set("workload", publicWorkload(workloadForId(batch.workloadId())));
        snapshot.put("status", batchStatus(totals));
        snapshot.set("totals", totals.toJson());
        snapshot.put("createdAt", batch.createdAt());
        snapshot.put("updatedAt", updatedAt);
        snapshot.set("items", items);
        return snapshot;
    }

    private String batchStatus(Totals totals) {
        if (totals.total == 0) {
            return "empty";
        }
        if (totals.queued > 0 || totals.running > 0) {
            return "processing";
        }
        if (totals.failed > 0 && totals.completed > 0) {
            return "completed_with_failures";
        }
        if (totals.failed > 0) {
            return "failed";
        }
        if (totals.missing > 0) {
            return "incomplete";
        }
        return "completed";
    }

    private boolean serveStaticAsset(HttpServletResponse response, String requestPath) throws IOException {
        String relativePath = "/".equals(requestPath) ? "index.html" : requestPath.replaceFirst("^/+", "");
        if (relativePath.contains("..")) {
            return false;
        }

        byte[] body = loadStaticAsset(relativePath);
        if (body == null) {
            return false;
        }

        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType(contentTypeFor(relativePath));
        response.getOutputStream().write(body);
        return true;
    }

    private byte[] loadStaticAsset(String relativePath) throws IOException {
        try (InputStream inputStream = Thread.currentThread().getContextClassLoader().getResourceAsStream("public/" + relativePath)) {
            if (inputStream != null) {
                return inputStream.readAllBytes();
            }
        }

        Path publicRoot = config.repoRoot().resolve("orchestrator").resolve("public").toAbsolutePath().normalize();
        Path assetPath = publicRoot.resolve(relativePath).normalize();
        if (!assetPath.startsWith(publicRoot) || !Files.exists(assetPath)) {
            return null;
        }

        return Files.readAllBytes(assetPath);
    }

    private DownloadedFile downloadRemotePdf(String fileUrl) throws Exception {
        URI sourceUri = parseRemoteUri(fileUrl);
        if (trimToNull(sourceUri.getUserInfo()) != null) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_REQUEST, "Remote PDF URLs with embedded credentials are not allowed.");
        }

        RemoteResponse headResponse = sendRemoteRequest(sourceUri, "HEAD", true, 0);
        if (headResponse.statusCode() >= 200 && headResponse.statusCode() < 300) {
            assertMaxContentLength(headResponse.headers(), config.remoteDownloadPolicy());
            if (!isPdfMetadata(headResponse.uri(), headResponse.headers())) {
                throw new HttpStatusException(HttpServletResponse.SC_UNSUPPORTED_MEDIA_TYPE, "Remote URL did not look like a PDF during preflight checks.");
            }
        }

        RemoteResponse getResponse = sendRemoteRequest(sourceUri, "GET", false, 0);
        if (getResponse.statusCode() < 200 || getResponse.statusCode() >= 300) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_GATEWAY, "Remote server returned " + getResponse.statusCode() + ".");
        }

        assertMaxContentLength(getResponse.headers(), config.remoteDownloadPolicy());
        if (!isPdfMetadata(getResponse.uri(), getResponse.headers())) {
            throw new HttpStatusException(HttpServletResponse.SC_UNSUPPORTED_MEDIA_TYPE, "Remote URL did not resolve to a PDF.");
        }

        Files.createDirectories(config.remoteDownloadRoot());
        Path downloadDir = config.remoteDownloadRoot().resolve(UUID.randomUUID().toString());
        Files.createDirectories(downloadDir);
        String fileName = buildRemoteFileName(sourceUri, getResponse);
        Path targetPath = downloadDir.resolve(fileName);

        long totalBytes = 0L;
        ByteArrayOutputStream probeBuffer = new ByteArrayOutputStream();
        try (InputStream inputStream = Objects.requireNonNull(getResponse.body(), "Remote response body was empty.");
             OutputStream outputStream = Files.newOutputStream(targetPath, StandardOpenOption.CREATE_NEW)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = inputStream.read(buffer)) != -1) {
                totalBytes += read;
                if (totalBytes > config.remoteDownloadPolicy().maxBytes()) {
                    throw new HttpStatusException(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, "Remote PDF exceeds the " + config.remoteDownloadPolicy().maxBytes() + " byte safety limit.");
                }
                if (probeBuffer.size() < config.remoteDownloadPolicy().probeBytes()) {
                    probeBuffer.write(buffer, 0, Math.min(read, config.remoteDownloadPolicy().probeBytes() - probeBuffer.size()));
                }
                outputStream.write(buffer, 0, read);
            }
        } catch (Exception exception) {
            Files.deleteIfExists(targetPath);
            Files.deleteIfExists(downloadDir);
            throw exception;
        }

        assertPdfSignature(probeBuffer.toByteArray(), config.remoteDownloadPolicy().probeBytes());
        return new DownloadedFile(targetPath.toAbsolutePath().normalize(), fileName, sourceUri.toString(), getResponse.uri().toString());
    }

    private RemoteResponse sendRemoteRequest(URI uri, String method, boolean allowUnsupportedHead, int redirects) throws Exception {
        if (redirects > config.remoteDownloadPolicy().maxRedirects()) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_GATEWAY, "Remote URL redirected more than " + config.remoteDownloadPolicy().maxRedirects() + " times.");
        }

        assertSafeRemoteHost(uri);

        HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
            .timeout(Duration.ofMillis(config.remoteDownloadPolicy().timeoutMs()))
            .header("Accept", "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1");
        if ("HEAD".equals(method)) {
            builder.method("HEAD", HttpRequest.BodyPublishers.noBody());
        } else {
            builder.GET();
        }

        HttpResponse<InputStream> response;
        try {
            response = config.httpClient().send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException exception) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_GATEWAY, "Unable to fetch remote PDF: " + exception.getMessage());
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while fetching remote PDF.", exception);
        }

        if (isRedirect(response.statusCode())) {
            String location = response.headers().firstValue("location").orElse(null);
            closeQuietly(response.body());
            if (trimToNull(location) == null) {
                throw new HttpStatusException(HttpServletResponse.SC_BAD_GATEWAY, "Remote server returned a redirect without a location header.");
            }
            URI redirected = response.uri().resolve(location);
            return sendRemoteRequest(redirected, response.statusCode() == HttpServletResponse.SC_SEE_OTHER ? "GET" : method, allowUnsupportedHead, redirects + 1);
        }

        if ("HEAD".equals(method) && allowUnsupportedHead
            && (response.statusCode() == HttpServletResponse.SC_METHOD_NOT_ALLOWED || response.statusCode() == HttpServletResponse.SC_NOT_IMPLEMENTED)) {
            closeQuietly(response.body());
            return new RemoteResponse(response.uri(), response.statusCode(), response.headers(), null);
        }

        if ("HEAD".equals(method)) {
            closeQuietly(response.body());
            return new RemoteResponse(response.uri(), response.statusCode(), response.headers(), null);
        }

        return new RemoteResponse(response.uri(), response.statusCode(), response.headers(), response.body());
    }

    private void assertSafeRemoteHost(URI uri) throws Exception {
        if (config.remoteDownloadPolicy().allowPrivateHosts()) {
            return;
        }

        String host = trimToNull(uri.getHost());
        if (host == null) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_REQUEST, "Remote URL is missing a hostname.");
        }

        InetAddress[] addresses = InetAddress.getAllByName(host);
        if (addresses.length == 0) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_GATEWAY, "Remote host did not resolve to any IP addresses.");
        }

        for (InetAddress address : addresses) {
            if (address.isAnyLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
                throw new HttpStatusException(HttpServletResponse.SC_FORBIDDEN, "Remote URL host is blocked by download safety policy.");
            }
        }
    }

    private void assertMaxContentLength(HttpHeaders headers, RemoteDownloadPolicy policy) throws HttpStatusException {
        Optional<String> contentLength = headers.firstValue("content-length");
        if (contentLength.isEmpty()) {
            return;
        }

        try {
            long value = Long.parseLong(contentLength.get());
            if (value > policy.maxBytes()) {
                throw new HttpStatusException(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, "Remote PDF exceeds the " + policy.maxBytes() + " byte safety limit.");
            }
        } catch (NumberFormatException ignored) {
            // Ignore malformed content-length values.
        }
    }

    private boolean isPdfMetadata(URI uri, HttpHeaders headers) {
        String decodedPath = decodePathSegment(Optional.ofNullable(uri.getPath()).orElse("")).toLowerCase(Locale.ROOT);
        String disposition = headers.firstValue("content-disposition").orElse("").toLowerCase(Locale.ROOT);
        String contentType = headers.firstValue("content-type").orElse("").toLowerCase(Locale.ROOT);
        return decodedPath.endsWith(".pdf")
            || disposition.contains(".pdf")
            || contentType.contains("application/pdf")
            || contentType.contains("application/x-pdf")
            || contentType.contains("application/octet-stream");
    }

    private String buildRemoteFileName(URI sourceUri, RemoteResponse response) {
        String dispositionName = extractFilenameFromContentDisposition(response.headers().firstValue("content-disposition").orElse(""));
        String fallbackName = fileNameFromUri(response.uri());
        if (trimToNull(fallbackName) == null) {
            fallbackName = fileNameFromUri(sourceUri);
        }
        String candidate = sanitizeSegment(trimToNull(dispositionName) == null ? fallbackName : dispositionName, "remote-document.pdf");
        return candidate.toLowerCase(Locale.ROOT).endsWith(".pdf") ? candidate : candidate + ".pdf";
    }

    private String extractFilenameFromContentDisposition(String headerValue) {
        if (trimToNull(headerValue) == null) {
            return "";
        }

        Matcher encoded = Pattern.compile("filename\\*=UTF-8''([^;]+)", Pattern.CASE_INSENSITIVE).matcher(headerValue);
        if (encoded.find()) {
            return decodePathSegment(encoded.group(1).trim().replaceAll("^\"|\"$", ""));
        }

        Matcher plain = Pattern.compile("filename=\"?([^\";]+)\"?", Pattern.CASE_INSENSITIVE).matcher(headerValue);
        return plain.find() ? plain.group(1).trim() : "";
    }

    private String fileNameFromUri(URI uri) {
        String path = Optional.ofNullable(uri.getPath()).orElse("");
        int lastSlash = path.lastIndexOf('/');
        String candidate = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
        return sanitizeSegment(trimToNull(candidate) == null ? "remote-document.pdf" : candidate, "remote-document.pdf");
    }

    private void assertPdfSignature(byte[] buffer, int probeBytes) throws HttpStatusException {
        int limit = Math.min(buffer.length, probeBytes);
        for (int index = 0; index <= limit - PDF_SIGNATURE.length; index += 1) {
            boolean matches = true;
            for (int offset = 0; offset < PDF_SIGNATURE.length; offset += 1) {
                if (buffer[index + offset] != PDF_SIGNATURE[offset]) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                return;
            }
        }

        throw new HttpStatusException(HttpServletResponse.SC_UNSUPPORTED_MEDIA_TYPE, "Remote file failed PDF signature validation.");
    }

    private Path resolveOutputDir(String outputDir, String jobId) {
        if (trimToNull(outputDir) != null) {
            return Paths.get(outputDir).toAbsolutePath().normalize();
        }
        return config.jobsRoot().resolve(jobId).toAbsolutePath().normalize();
    }

    private void writeJson(HttpServletResponse response, int statusCode, JsonNode payload) throws IOException {
        response.setStatus(statusCode);
        response.setContentType("application/json; charset=utf-8");
        MAPPER.writerWithDefaultPrettyPrinter().writeValue(response.getOutputStream(), payload);
    }

    private void writeError(HttpServletResponse response, int statusCode, String message) throws IOException {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("error", trimToNull(message) == null ? "Unexpected error" : message);
        writeJson(response, statusCode, payload);
    }

    private ObjectNode readJsonBody(HttpServletRequest request) throws IOException {
        byte[] body = request.getInputStream().readAllBytes();
        if (body.length == 0) {
            return MAPPER.createObjectNode();
        }
        JsonNode root = MAPPER.readTree(body);
        return objectValue(root);
    }

    private String readPartAsString(Part part) throws IOException {
        try (InputStream inputStream = part.getInputStream()) {
            return new String(inputStream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String normalizePath(HttpServletRequest request) {
        String requestUri = request.getRequestURI();
        String contextPath = request.getContextPath();
        String path = requestUri.startsWith(contextPath) ? requestUri.substring(contextPath.length()) : requestUri;
        return path.isEmpty() ? "/" : path;
    }

    private static ObjectNode objectValue(JsonNode value) {
        return value instanceof ObjectNode objectNode ? objectNode.deepCopy() : MAPPER.createObjectNode();
    }

    private static String requiredText(ObjectNode node, String fieldName) throws HttpStatusException {
        String value = text(node, fieldName);
        if (trimToNull(value) == null) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_REQUEST, fieldName + " is required");
        }
        return value;
    }

    private static String text(JsonNode node, String fieldName) {
        return text(node, fieldName, null);
    }

    private static String text(JsonNode node, String fieldName, String fallback) {
        if (node == null || node.isNull()) {
            return fallback;
        }
        JsonNode field = node.get(fieldName);
        if (field == null || field.isNull()) {
            return fallback;
        }
        String value = field.asText();
        return trimToNull(value) == null ? fallback : value;
    }

    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String getJobDisplayName(JsonNode job) {
        JsonNode input = objectValue(job.get("input"));
        String sourceFileName = text(input, "sourceFileName");
        if (sourceFileName != null) {
            return sourceFileName;
        }
        String filePath = text(input, "filePath");
        if (filePath != null) {
            return Path.of(filePath).getFileName().toString();
        }
        return "document.pdf";
    }

    private static String getJobDisplayPath(JsonNode job) {
        JsonNode input = objectValue(job.get("input"));
        return text(input, "sourceUrl", text(input, "filePath", getJobDisplayName(job)));
    }

    private static void mergeObject(ObjectNode target, ObjectNode source) {
        Iterator<Map.Entry<String, JsonNode>> fields = source.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            target.set(entry.getKey(), entry.getValue());
        }
    }

    private static void putTextOrNull(ObjectNode target, String fieldName, String value) {
        if (trimToNull(value) == null) {
            target.putNull(fieldName);
        } else {
            target.put(fieldName, value);
        }
    }

    private static void setNodeOrNull(ObjectNode target, String fieldName, JsonNode value) {
        target.set(fieldName, value == null || value.isMissingNode() ? NullNode.getInstance() : value.deepCopy());
    }

    private static ArrayNode buildAccessibilitySignals(JsonNode report, JsonNode tagDeltaReport) {
        ArrayNode signals = MAPPER.createArrayNode();
        for (JsonNode finding : iterable(report.path("findings"))) {
            if (signals.size() >= 6) {
                break;
            }
            signals.add(finding.path("code").asText());
        }
        for (JsonNode signal : buildTagDeltaSignals(tagDeltaReport)) {
            if (signals.size() >= 6) {
                break;
            }
            signals.add(signal.asText());
        }
        return signals;
    }

    private static ArrayNode buildTagDeltaSignals(JsonNode tagDeltaReport) {
        ArrayNode signals = MAPPER.createArrayNode();
        if (tagDeltaReport == null || tagDeltaReport.isNull() || tagDeltaReport.path("delta").isMissingNode()) {
            return signals;
        }

        JsonNode delta = tagDeltaReport.path("delta");
        signals.add("Typed node delta " + delta.path("totalTypedNodesDelta").asInt(0));
        signals.add("Marked content delta " + delta.path("markedContentOperatorCountDelta").asInt(0));
        if (delta.path("tableAttributeNodeCountDelta").asInt(0) != 0) {
            signals.add("Table attr delta " + delta.path("tableAttributeNodeCountDelta").asInt(0));
        }
        if (delta.path("structTreeAdded").asBoolean(false)) {
            signals.add("Struct tree added");
        }
        return signals;
    }

    private static ArrayNode codesFromFindings(JsonNode findings, int limit) {
        ArrayNode codes = MAPPER.createArrayNode();
        for (JsonNode finding : iterable(findings)) {
            if (codes.size() >= limit) {
                break;
            }
            String code = trimToNull(finding.path("code").asText(null));
            if (code != null) {
                codes.add(code);
            }
        }
        return codes;
    }

    private static Iterable<JsonNode> iterable(JsonNode node) {
        List<JsonNode> values = new ArrayList<>();
        if (node != null && node.isArray()) {
            node.forEach(values::add);
        }
        return values;
    }

    private static String laterTimestamp(String first, String second) {
        try {
            Instant firstInstant = Instant.parse(first);
            Instant secondInstant = Instant.parse(second);
            return secondInstant.isAfter(firstInstant) ? second : first;
        } catch (Exception ignored) {
            return trimToNull(second) == null ? first : second;
        }
    }

    private static WorkloadDefinition workloadForId(String workloadId) {
        String key = trimToNull(workloadId);
        return WORKLOADS.getOrDefault(key, WORKLOADS.get("accessibility-tagging"));
    }

    private static ObjectNode publicWorkload(WorkloadDefinition definition) {
        ObjectNode workload = MAPPER.createObjectNode();
        workload.put("id", definition.id());
        workload.put("label", definition.label());
        workload.put("shortLabel", definition.shortLabel());
        workload.put("description", definition.description());
        workload.put("primaryArtifact", definition.primaryArtifact());
        ArrayNode previewArtifacts = workload.putArray("previewArtifacts");
        definition.previewArtifacts().forEach(previewArtifacts::add);
        ArrayNode downloadArtifacts = workload.putArray("downloadArtifacts");
        definition.downloadArtifacts().forEach(downloadArtifacts::add);
        return workload;
    }

    private static URI parseRemoteUri(String value) throws HttpStatusException {
        try {
            URI uri = new URI(value.trim());
            String scheme = Optional.ofNullable(uri.getScheme()).orElse("").toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw new HttpStatusException(HttpServletResponse.SC_BAD_REQUEST, "fileUrl must be an absolute http or https URL.");
            }
            return uri;
        } catch (URISyntaxException exception) {
            throw new HttpStatusException(HttpServletResponse.SC_BAD_REQUEST, "fileUrl must be an absolute http or https URL.");
        }
    }

    private static String sanitizeSegment(String value, String fallback) {
        String cleaned = Optional.ofNullable(value).orElse("")
            .replaceAll("[<>:\"|?*\\x00-\\x1f]", "_")
            .replaceAll("\\s+", " ")
            .trim();
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    private static String sanitizeRelativePath(String relativePath, String fallbackName) {
        String source = Optional.ofNullable(relativePath).orElse(fallbackName).replace('\\', '/');
        String[] segments = Arrays.stream(source.split("/"))
            .filter(segment -> !segment.isBlank())
            .filter(segment -> !".".equals(segment) && !"..".equals(segment))
            .map(segment -> sanitizeSegment(segment, fallbackName))
            .toArray(String[]::new);

        if (segments.length == 0) {
            return sanitizeSegment(fallbackName, "document.pdf");
        }

        return String.join("/", segments);
    }

    private static String makeOutputDirectoryName(String relativePath, int index) {
        String fileName = Path.of(relativePath).getFileName().toString();
        int extensionIndex = fileName.lastIndexOf('.');
        String baseName = extensionIndex > 0 ? fileName.substring(0, extensionIndex) : fileName;
        String slug = baseName.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        return String.format(Locale.ROOT, "%02d-%s", index + 1, slug.isEmpty() ? "document" : slug);
    }

    private static String decodePathSegment(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return value;
        }
    }

    private static String encodePathSegment(String value) {
        return value.replace("%", "%25").replace("/", "%2F");
    }

    private static String contentTypeFor(Path path) {
        return contentTypeFor(path.getFileName().toString());
    }

    private static String contentTypeFor(String fileName) {
        String lower = fileName.toLowerCase(Locale.ROOT);
        for (Map.Entry<String, String> entry : CONTENT_TYPES.entrySet()) {
            if (lower.endsWith(entry.getKey())) {
                return entry.getValue();
            }
        }
        return "application/octet-stream";
    }

    private static boolean isRedirect(int statusCode) {
        return statusCode == HttpServletResponse.SC_MOVED_PERMANENTLY
            || statusCode == HttpServletResponse.SC_MOVED_TEMPORARILY
            || statusCode == HttpServletResponse.SC_SEE_OTHER
            || statusCode == HttpServletResponse.SC_TEMPORARY_REDIRECT
            || statusCode == 308;
    }

    private static String readStream(InputStream stream) {
        try (InputStream inputStream = stream) {
            return new String(inputStream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException exception) {
            throw new CompletionException(exception);
        }
    }

    private static void closeQuietly(InputStream stream) {
        if (stream == null) {
            return;
        }
        try {
            stream.close();
        } catch (IOException ignored) {
            // Ignore close failures on short-lived HTTP streams.
        }
    }

    private static boolean isAzureAppServiceRuntime() {
        return trimToNull(System.getenv("WEBSITE_SITE_NAME")) != null
            || trimToNull(System.getenv("WEBSITE_INSTANCE_ID")) != null
            || trimToNull(System.getenv("WEBSITE_RUN_FROM_PACKAGE")) != null
            || trimToNull(System.getenv("WEBSITES_ENABLE_APP_SERVICE_STORAGE")) != null;
    }

    private static Map<String, WorkloadDefinition> createWorkloadDefinitions() {
        Map<String, WorkloadDefinition> definitions = new LinkedHashMap<>();
        definitions.put("accessibility-tagging", new WorkloadDefinition(
            "accessibility-tagging",
            "Accessibility Tagging",
            "Tagging",
            "Create tagged, validated PDF/UA output with browser-native reports.",
            "validationReport",
            List.of("validationReport", "tagDeltaReport", "writerReport", "tagManifest"),
            List.of("taggedPdf", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"),
            Path.of("orchestrator", "pipeline-runner.js")
        ));
        definitions.put("ssn-redaction", new WorkloadDefinition(
            "ssn-redaction",
            "SSN Redaction",
            "Redaction",
            "Detect and redact likely social security numbers, then emit a redaction report and safe output PDF.",
            "redactionReport",
            List.of("redactionReport"),
            List.of("redactedPdf", "redactionReport"),
            Path.of("orchestrator", "redaction-runner.js")
        ));
        definitions.put("tag-and-ssn-redact", new WorkloadDefinition(
            "tag-and-ssn-redact",
            "Tag + SSN Redaction",
            "Tag + Redact",
            "Tag the PDF, mask SSNs from visible and accessibility content, then validate the final tagged output.",
            "redactionReport",
            List.of("redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"),
            List.of("taggedPdf", "redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"),
            Path.of("orchestrator", "tag-redaction-runner.js")
        ));
        return definitions;
    }

    private record Config(
        Path repoRoot,
        Path runtimeRoot,
        Path jobsRoot,
        Path uploadRoot,
        Path remoteDownloadRoot,
        String nodeExecutable,
        RemoteDownloadPolicy remoteDownloadPolicy,
        HttpClient httpClient
    ) {
        private static Config from(ServletConfig servletConfig) {
            Path repoRoot = detectRepoRoot(readConfigValue(servletConfig, "buildeverything.repoRoot", "BUILD_EVERYTHING_REPO_ROOT"));
            Path runtimeRoot = detectRuntimeRoot(repoRoot, readConfigValue(servletConfig, "buildeverything.runtimeRoot", "PIPELINE_DATA_ROOT"));
            String nodeExecutable = Optional.ofNullable(readConfigValue(servletConfig, "buildeverything.nodeExecutable", "BUILD_EVERYTHING_NODE_PATH"))
                .filter(value -> !value.isBlank())
                .orElse("node");

            RemoteDownloadPolicy policy = new RemoteDownloadPolicy(
                Boolean.parseBoolean(Optional.ofNullable(readConfigValue(servletConfig, "buildeverything.remoteDownload.allowPrivateHosts", "BUILD_EVERYTHING_REMOTE_ALLOW_PRIVATE_HOSTS")).orElse("false")),
                Long.parseLong(Optional.ofNullable(readConfigValue(servletConfig, "buildeverything.remoteDownload.maxBytes", "BUILD_EVERYTHING_REMOTE_MAX_BYTES")).orElse(String.valueOf(50L * 1024L * 1024L))),
                Integer.parseInt(Optional.ofNullable(readConfigValue(servletConfig, "buildeverything.remoteDownload.maxRedirects", "BUILD_EVERYTHING_REMOTE_MAX_REDIRECTS")).orElse("5")),
                Integer.parseInt(Optional.ofNullable(readConfigValue(servletConfig, "buildeverything.remoteDownload.probeBytes", "BUILD_EVERYTHING_REMOTE_PROBE_BYTES")).orElse("1024")),
                Integer.parseInt(Optional.ofNullable(readConfigValue(servletConfig, "buildeverything.remoteDownload.timeoutMs", "BUILD_EVERYTHING_REMOTE_TIMEOUT_MS")).orElse("15000"))
            );

            HttpClient httpClient = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofMillis(policy.timeoutMs()))
                .build();

            return new Config(
                repoRoot,
                runtimeRoot,
                runtimeRoot.resolve("jobs"),
                runtimeRoot.resolve("uploads"),
                runtimeRoot.resolve("uploads").resolve("remote"),
                nodeExecutable,
                policy,
                httpClient
            );
        }

        private static String readConfigValue(ServletConfig servletConfig, String propertyName, String envName) {
            String initParameter = servletConfig.getInitParameter(propertyName);
            if (trimToNull(initParameter) != null) {
                return initParameter;
            }

            String systemProperty = System.getProperty(propertyName);
            if (trimToNull(systemProperty) != null) {
                return systemProperty;
            }

            return System.getenv(envName);
        }

        private static Path detectRepoRoot(String configuredValue) {
            if (trimToNull(configuredValue) != null) {
                return Path.of(configuredValue).toAbsolutePath().normalize();
            }

            Path current = Path.of("").toAbsolutePath().normalize();
            for (Path candidate = current; candidate != null; candidate = candidate.getParent()) {
                if (Files.exists(candidate.resolve("package.json"))
                    && Files.exists(candidate.resolve("orchestrator"))
                    && Files.exists(candidate.resolve("modules"))) {
                    return candidate;
                }
            }

            return current;
        }

        private static Path detectRuntimeRoot(Path repoRoot, String configuredValue) {
            if (trimToNull(configuredValue) != null) {
                return Path.of(configuredValue).toAbsolutePath().normalize();
            }

            String appRuntimeRoot = trimToNull(System.getenv("APP_RUNTIME_ROOT"));
            if (appRuntimeRoot != null) {
                return Path.of(appRuntimeRoot).toAbsolutePath().normalize();
            }

            if (isAzureAppServiceRuntime()) {
                String home = trimToNull(System.getenv("HOME"));
                if (home != null) {
                    return Path.of(home, "data", APP_NAME).toAbsolutePath().normalize();
                }
            }

            return repoRoot.resolve("tmp").toAbsolutePath().normalize();
        }
    }

    private record WorkloadDefinition(
        String id,
        String label,
        String shortLabel,
        String description,
        String primaryArtifact,
        List<String> previewArtifacts,
        List<String> downloadArtifacts,
        Path runnerScript
    ) {
    }

    private record ProcessResult(String stdout, String stderr) {
    }

    private record SummaryPayload(JsonNode summary, JsonNode validation) {
        private static SummaryPayload empty() {
            return new SummaryPayload(NullNode.getInstance(), NullNode.getInstance());
        }
    }

    private record BatchRecord(String batchId, String createdAt, String workloadId, List<BatchItemRecord> items) {
    }

    private record BatchItemRecord(String jobId, String fileName, String relativePath, String workloadId) {
    }

    private record UploadSelection(Part part, String relativePath) {
    }

    private record PersistedUpload(Path absolutePath, String fileName, String relativePath) {
    }

    private record DownloadedFile(Path absolutePath, String fileName, String sourceUrl, String finalUrl) {
    }

    private record RemoteResponse(URI uri, int statusCode, HttpHeaders headers, InputStream body) {
    }

    private record RemoteDownloadPolicy(boolean allowPrivateHosts, long maxBytes, int maxRedirects, int probeBytes, int timeoutMs) {
    }

    private static final class Totals {
        private int total;
        private int queued;
        private int running;
        private int completed;
        private int failed;
        private int missing;

        private void increment(String status) {
            switch (status) {
                case "queued" -> queued += 1;
                case "running" -> running += 1;
                case "completed" -> completed += 1;
                case "failed" -> failed += 1;
                default -> missing += 1;
            }
        }

        private ObjectNode toJson() {
            ObjectNode node = MAPPER.createObjectNode();
            node.put("total", total);
            node.put("queued", queued);
            node.put("running", running);
            node.put("completed", completed);
            node.put("failed", failed);
            node.put("missing", missing);
            return node;
        }
    }

    private static final class HttpStatusException extends Exception {
        private final int statusCode;

        private HttpStatusException(int statusCode, String message) {
            super(message);
            this.statusCode = statusCode;
        }

        private int statusCode() {
            return statusCode;
        }
    }
}
