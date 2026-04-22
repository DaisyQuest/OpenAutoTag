package buildeverything.servlet;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * CLI adapter for the spec's headless mode. It preserves module isolation by
 * invoking the Node orchestrator as a process and consuming only file paths and
 * JSON artifacts.
 */
public final class PerfectStudioHeadlessRunner {
    private final CommandExecutor executor;
    private final Path repoRoot;

    public PerfectStudioHeadlessRunner(Path repoRoot, CommandExecutor executor) {
        this.repoRoot = Objects.requireNonNull(repoRoot, "repoRoot").toAbsolutePath().normalize();
        this.executor = Objects.requireNonNull(executor, "executor");
    }

    public HeadlessResult run(HeadlessOptions options, Appendable stdout, Appendable stderr)
            throws IOException, InterruptedException {
        Objects.requireNonNull(options, "options");
        Path input = options.inputPdf().toAbsolutePath().normalize();
        Path output = options.outputPdf().toAbsolutePath().normalize();
        Path outputDir = options.outputDir() == null
                ? Files.createTempDirectory("perfect-studio-headless-")
                : options.outputDir().toAbsolutePath().normalize();

        if (!Files.isRegularFile(input)) {
            throw new IOException("Input PDF not found: " + input);
        }

        Files.createDirectories(outputDir);
        Path outputParent = output.getParent();
        if (outputParent != null) {
            Files.createDirectories(outputParent);
        }

        StringBuilder capturedStdout = new StringBuilder();
        StringBuilder capturedStderr = new StringBuilder();
        List<String> command = List.of(
                "node",
                repoRoot.resolve("orchestrator").resolve("pipeline-runner.js").toString(),
                "--pdf",
                input.toString(),
                "--output-dir",
                outputDir.toString());
        int exitCode = executor.run(command, repoRoot, tee(stdout, capturedStdout), tee(stderr, capturedStderr));
        String stdoutText = capturedStdout.toString();
        Map<String, Object> orchestratorSnapshot = parseJsonObject(stdoutText, "orchestrator stdout", true);
        if (exitCode != 0) {
            throw new IOException("Headless pipeline failed with exit code " + exitCode
                    + appendDetail(capturedStderr));
        }

        Path resolvedOutputDir = resolveOutputDir(orchestratorSnapshot, stdoutText, outputDir);
        if (orchestratorSnapshot != null) {
            String status = stringValue(orchestratorSnapshot.get("status"));
            if (status != null && !"completed".equalsIgnoreCase(status)) {
                throw new IOException("Headless pipeline reported status " + status
                        + appendDetail(capturedStdout));
            }
        }

        Path generatedPdf = resolveArtifactPath(orchestratorSnapshot, stdoutText, resolvedOutputDir, "taggedPdf", "06-tagged.pdf");
        if (!Files.isRegularFile(generatedPdf)) {
            throw new IOException("Headless pipeline did not emit a tagged PDF artifact"
                    + appendDetail(capturedStdout));
        }

        ValidationReport validationReport = readValidationReport(
                resolveArtifactPath(orchestratorSnapshot, stdoutText, resolvedOutputDir, "validationReport", "07-validation-report.json"));

        if (!validationReport.compliant) {
            throw new IOException("Validation report is noncompliant: " + validationReport.summary);
        }

        Files.copy(generatedPdf, output, StandardCopyOption.REPLACE_EXISTING);

        return new HeadlessResult(input, output, resolvedOutputDir, generatedPdf, validationReport.path, Instant.now());
    }

    public static HeadlessOptions parseArgs(String[] args) {
        boolean headless = false;
        Path input = null;
        Path output = null;
        Path outputDir = null;
        for (int index = 0; index < args.length; index += 1) {
            String token = args[index];
            switch (token) {
                case "--headless" -> headless = true;
                case "-i", "--input" -> input = Path.of(requireValue(args, ++index, token));
                case "-o", "--output" -> output = Path.of(requireValue(args, ++index, token));
                case "--output-dir" -> outputDir = Path.of(requireValue(args, ++index, token));
                default -> {
                    if (token.startsWith("-")) {
                        throw new IllegalArgumentException("Unknown argument: " + token);
                    }
                }
            }
        }
        if (!headless || input == null || output == null) {
            throw new IllegalArgumentException("Usage: PerfectStudioSwingApp --headless -i <input.pdf> -o <output.pdf> [--output-dir <dir>]");
        }
        return new HeadlessOptions(input, output, outputDir);
    }

    public static Path discoverRepoRoot() {
        return TagSchemaRules.resolveRepoRoot(Path.of("").toAbsolutePath());
    }

    public static String toJson(HeadlessResult result) {
        return "{\n"
                + "  \"status\": \"completed\",\n"
                + "  \"input\": " + quote(result.inputPdf().toString()) + ",\n"
                + "  \"output\": " + quote(result.outputPdf().toString()) + ",\n"
                + "  \"completedAt\": " + quote(result.completedAt().toString()) + ",\n"
                + "  \"artifacts\": {\n"
                + "    \"outputDir\": " + quote(result.outputDir().toString()) + ",\n"
                + "    \"taggedPdf\": " + quote(result.generatedPdf().toString()) + ",\n"
                + "    \"validationReport\": " + quote(result.validationReport().toString()) + "\n"
                + "  }\n"
                + "}";
    }

    private static String quote(String value) {
        StringBuilder builder = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index += 1) {
            char ch = value.charAt(index);
            switch (ch) {
                case '\\' -> builder.append("\\\\");
                case '"' -> builder.append("\\\"");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> builder.append(ch);
            }
        }
        return builder.append('"').toString();
    }

    private static String requireValue(String[] args, int index, String flag) {
        if (index >= args.length || args[index].startsWith("-")) {
            throw new IllegalArgumentException(flag + " requires a value");
        }
        return args[index];
    }

    public interface CommandExecutor {
        int run(List<String> command, Path workingDirectory, Appendable stdout, Appendable stderr)
                throws IOException, InterruptedException;
    }

    public static final class ProcessCommandExecutor implements CommandExecutor {
        @Override
        public int run(List<String> command, Path workingDirectory, Appendable stdout, Appendable stderr)
                throws IOException, InterruptedException {
            ProcessBuilder builder = new ProcessBuilder(new ArrayList<>(command));
            builder.directory(workingDirectory.toFile());
            Process process = builder.start();
            Thread outThread = stream(process.inputReader(StandardCharsets.UTF_8), stdout);
            Thread errThread = stream(process.errorReader(StandardCharsets.UTF_8), stderr);
            int exitCode = process.waitFor();
            outThread.join();
            errThread.join();
            return exitCode;
        }

        private static Thread stream(BufferedReader reader, Appendable target) {
            Thread thread = new Thread(() -> {
                try (reader) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        target.append(line).append(System.lineSeparator());
                    }
                } catch (IOException ignored) {
                    // The process exit code carries the actionable failure.
                }
            }, "perfect-studio-process-stream");
            thread.setDaemon(true);
            thread.start();
            return thread;
        }
    }

    private static Appendable tee(Appendable primary, Appendable secondary) {
        Appendable left = primary == null ? nullAppendable() : primary;
        Appendable right = secondary == null ? nullAppendable() : secondary;
        if (left == right) {
            return left;
        }
        return new Appendable() {
            @Override
            public Appendable append(CharSequence csq) throws IOException {
                left.append(csq);
                right.append(csq);
                return this;
            }

            @Override
            public Appendable append(CharSequence csq, int start, int end) throws IOException {
                left.append(csq, start, end);
                right.append(csq, start, end);
                return this;
            }

            @Override
            public Appendable append(char c) throws IOException {
                left.append(c);
                right.append(c);
                return this;
            }
        };
    }

    private static Appendable nullAppendable() {
        return new Appendable() {
            @Override
            public Appendable append(CharSequence csq) {
                return this;
            }

            @Override
            public Appendable append(CharSequence csq, int start, int end) {
                return this;
            }

            @Override
            public Appendable append(char c) {
                return this;
            }
        };
    }

    private static Map<String, Object> parseJsonObject(String text, String label, boolean allowBlank) throws IOException {
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isEmpty()) {
            if (allowBlank) {
                return null;
            }
            throw new IOException(label + " was empty");
        }
        Object parsed;
        try {
            parsed = JsonSupport.parse(trimmed);
        } catch (IOException error) {
            if (allowBlank) {
                return null;
            }
            throw new IOException("Unable to parse " + label + ": " + error.getMessage(), error);
        }
        if (!(parsed instanceof Map<?, ?> map)) {
            if (allowBlank) {
                return null;
            }
            throw new IOException(label + " did not contain a JSON object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) map;
        return result;
    }

    private static Path resolveOutputDir(Map<String, Object> orchestratorSnapshot, String stdoutText, Path fallbackOutputDir) {
        Map<String, Object> input = nestedObject(orchestratorSnapshot, "input");
        String outputDir = stringValue(input == null ? null : input.get("outputDir"));
        if (outputDir == null) {
            outputDir = extractJsonStringValue(stdoutText, "outputDir");
        }
        if (outputDir == null || outputDir.isBlank()) {
            return fallbackOutputDir;
        }
        return resolvePath(outputDir, fallbackOutputDir);
    }

    private static Path resolveArtifactPath(Map<String, Object> orchestratorSnapshot, String stdoutText, Path outputDir, String artifactKey, String fallbackFileName)
            throws IOException {
        Map<String, Object> artifacts = nestedObject(orchestratorSnapshot, "artifacts");
        String candidate = stringValue(artifacts == null ? null : artifacts.get(artifactKey));
        if (candidate == null && orchestratorSnapshot != null) {
            candidate = stringValue(orchestratorSnapshot.get(artifactKey));
        }
        if (candidate == null) {
            candidate = extractJsonStringValue(stdoutText, artifactKey);
        }
        if (candidate != null && !candidate.isBlank()) {
            Path resolved = resolvePath(candidate, outputDir);
            if (Files.isRegularFile(resolved)) {
                return resolved;
            }
        }
        Path fallback = outputDir.resolve(fallbackFileName).normalize();
        if (Files.isRegularFile(fallback)) {
            return fallback;
        }
        if (candidate != null && !candidate.isBlank()) {
            throw new IOException("Artifact " + artifactKey + " not found at " + resolvePath(candidate, outputDir)
                    + " or fallback " + fallback);
        }
        throw new IOException("Artifact " + artifactKey + " not found. Expected " + fallback);
    }

    private static Path resolvePath(String value, Path baseDir) {
        Path path = Path.of(value);
        if (path.isAbsolute()) {
            return path.toAbsolutePath().normalize();
        }
        return baseDir.resolve(path).toAbsolutePath().normalize();
    }

    private static ValidationReport readValidationReport(Path reportPath) throws IOException {
        if (!Files.isRegularFile(reportPath)) {
            throw new IOException("Validation report not found: " + reportPath);
        }
        String content = Files.readString(reportPath, StandardCharsets.UTF_8);
        Map<String, Object> report;
        try {
            report = parseJsonObject(content, "validation report", false);
        } catch (IOException error) {
            throw new IOException("Malformed validation report at " + reportPath + ": " + error.getMessage(), error);
        }
        if (report == null) {
            throw new IOException("Malformed validation report at " + reportPath + ": empty or unreadable");
        }

        String status = stringValue(report.get("status"));
        if (status == null) {
            throw new IOException("Malformed validation report at " + reportPath + ": missing status");
        }
        if (!"completed".equalsIgnoreCase(status)) {
            throw new IOException("Validation report is noncompliant at " + reportPath + ": status=" + status);
        }

        Boolean isCompliant = booleanValue(report.get("isCompliant"));
        Map<String, Object> overall = nestedObject(report, "overall");
        String overallStatus = overall == null ? null : stringValue(overall.get("status"));
        List<String> errorFindings = collectErrorFindings(report.get("findings"));

        if (isCompliant == null || overallStatus == null) {
            throw new IOException("Malformed validation report at " + reportPath
                    + ": missing compliance summary fields");
        }

        boolean compliant = isCompliant && "pass".equalsIgnoreCase(overallStatus) && errorFindings.isEmpty();
        String summary = "status=" + status
                + ", overall=" + overallStatus
                + ", isCompliant=" + isCompliant
                + (errorFindings.isEmpty() ? "" : ", errors=" + errorFindings);
        if (!compliant) {
            return new ValidationReport(reportPath, false, summary);
        }
        return new ValidationReport(reportPath, true, summary);
    }

    private static List<String> collectErrorFindings(Object findingsValue) throws IOException {
        List<Object> findings = listValue(findingsValue, "findings");
        if (findings == null) {
            throw new IOException("Malformed validation report: findings must be an array");
        }
        List<String> errors = new ArrayList<>();
        for (Object finding : findings) {
            Map<String, Object> findingObject = objectValue(finding, "finding");
            if (findingObject == null) {
                throw new IOException("Malformed validation report: finding entries must be objects");
            }
            String severity = stringValue(findingObject.get("severity"));
            if (severity != null && "error".equalsIgnoreCase(severity)) {
                String code = stringValue(findingObject.get("code"));
                String message = stringValue(findingObject.get("message"));
                if (message == null) {
                    message = stringValue(findingObject.get("description"));
                }
                errors.add((code == null ? "VALIDATION_ERROR" : code) + ": " + (message == null ? "Validation error" : message));
            }
        }
        return errors;
    }

    private static Map<String, Object> objectValue(Object value, String label) {
        if (value instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> result = (Map<String, Object>) map;
            return result;
        }
        return null;
    }

    private static Map<String, Object> nestedObject(Map<String, Object> parent, String key) {
        if (parent == null) {
            return null;
        }
        return objectValue(parent.get(key), key);
    }

    private static List<Object> listValue(Object value, String label) {
        if (value instanceof List<?> list) {
            @SuppressWarnings("unchecked")
            List<Object> result = (List<Object>) list;
            return result;
        }
        return null;
    }

    private static String stringValue(Object value) {
        return value instanceof String string ? string : null;
    }

    private static String extractJsonStringValue(String text, String key) {
        if (text == null || text.isBlank() || key == null || key.isBlank()) {
            return null;
        }
        String pattern = "\"" + java.util.regex.Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"";
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.DOTALL).matcher(text);
        if (!matcher.find()) {
            return null;
        }
        return unescapeJsonString(matcher.group(1));
    }

    private static String unescapeJsonString(String value) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < value.length(); index += 1) {
            char ch = value.charAt(index);
            if (ch != '\\') {
                builder.append(ch);
                continue;
            }
            if (index + 1 >= value.length()) {
                break;
            }
            char escaped = value.charAt(++index);
            switch (escaped) {
                case '"', '\\', '/' -> builder.append(escaped);
                case 'b' -> builder.append('\b');
                case 'f' -> builder.append('\f');
                case 'n' -> builder.append('\n');
                case 'r' -> builder.append('\r');
                case 't' -> builder.append('\t');
                case 'u' -> {
                    if (index + 4 <= value.length() - 1) {
                        int parsed = Integer.parseInt(value.substring(index + 1, index + 5), 16);
                        builder.append((char) parsed);
                        index += 4;
                    }
                }
                default -> builder.append(escaped);
            }
        }
        return builder.toString();
    }

    private static Boolean booleanValue(Object value) {
        return value instanceof Boolean bool ? bool : null;
    }

    private static String appendDetail(Appendable appendable) {
        if (appendable instanceof CharSequence sequence) {
            String text = sequence.toString().trim();
            if (!text.isEmpty()) {
                return ": " + text;
            }
        }
        return "";
    }

    private record ValidationReport(Path path, boolean compliant, String summary) {}

    public record HeadlessOptions(Path inputPdf, Path outputPdf, Path outputDir) {}

    public record HeadlessResult(
            Path inputPdf,
            Path outputPdf,
            Path outputDir,
            Path generatedPdf,
            Path validationReport,
            Instant completedAt) {}
}
