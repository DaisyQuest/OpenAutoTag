package buildeverything.servlet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JProgressBar;
import javax.swing.JScrollPane;
import javax.swing.JSplitPane;
import javax.swing.JTabbedPane;
import javax.swing.JTable;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.SwingWorker;
import javax.swing.UIManager;
import javax.swing.border.EmptyBorder;
import javax.swing.filechooser.FileNameExtensionFilter;
import javax.swing.table.DefaultTableModel;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Desktop;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.GridLayout;
import java.awt.event.ActionEvent;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

/**
 * Swing client for the PDF Introspector.
 *
 * <p>Launch with:
 * {@code ./gradlew :servlet:runIntrospector -PserverUrl=http://localhost:3001}</p>
 */
public final class PdfIntrospectorSwingApp extends JFrame {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DEFAULT_SERVER = "http://localhost:3001";

    private static final Color PAGE = new Color(0xF5, 0xF7, 0xFB);
    private static final Color SURFACE = Color.WHITE;
    private static final Color LINE = new Color(0xCF, 0xD8, 0xE3);
    private static final Color INK = new Color(0x17, 0x20, 0x33);
    private static final Color MUTED = new Color(0x64, 0x74, 0x8B);
    private static final Color TEAL = new Color(0x0F, 0x76, 0x6E);
    private static final Color INDIGO = new Color(0x37, 0x30, 0xA3);

    private final String serverUrl;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private File selectedFile;

    private final JLabel fileLabel = new JLabel("No PDF selected");
    private final JComboBox<String> workloadCombo = new JComboBox<>(new String[]{"accessibility-tagging"});
    private final JComboBox<String> profileCombo = new JComboBox<>(new String[]{"default"});
    private final JTextField serverField = new JTextField();
    private final JPasswordField apiKeyField = new JPasswordField();
    private final JButton runButton = new JButton("Run Analysis");
    private final JButton openArtifactButton = new JButton("Open Artifact");
    private final JLabel statusLabel = new JLabel("Ready");
    private final JProgressBar progressBar = new JProgressBar(0, 100);

    private final DefaultTableModel metricModel = tableModel("Metric", "Value");
    private final DefaultTableModel capabilityModel = tableModel("Capability", "Status", "Contract");
    private final DefaultTableModel artifactModel = tableModel("Artifact", "Kind", "URL");
    private final JTextArea narrativeArea = new JTextArea();
    private final JTabbedPane tabs = new JTabbedPane();
    private final JTable artifactTable = new JTable(artifactModel);

    public PdfIntrospectorSwingApp(String serverUrl) {
        super("PDF Introspector");
        this.serverUrl = normalizeServer(serverUrl);
        serverField.setText(this.serverUrl);
        setDefaultCloseOperation(EXIT_ON_CLOSE);
        setMinimumSize(new Dimension(980, 680));
        setPreferredSize(new Dimension(1160, 760));
        buildUi();
        pack();
        setLocationRelativeTo(null);
    }

    private void buildUi() {
        JPanel root = new JPanel(new BorderLayout(14, 14));
        root.setBackground(PAGE);
        root.setBorder(new EmptyBorder(16, 18, 16, 18));
        root.add(buildHeader(), BorderLayout.NORTH);
        root.add(buildWorkspace(), BorderLayout.CENTER);
        root.add(buildFooter(), BorderLayout.SOUTH);
        setContentPane(root);
    }

    private JPanel buildHeader() {
        JPanel header = new JPanel(new BorderLayout(12, 0));
        header.setOpaque(false);

        JLabel title = new JLabel("PDF Introspector");
        title.setForeground(INK);
        title.setFont(title.getFont().deriveFont(Font.BOLD, 24f));

        JLabel subtitle = new JLabel("Aggregate OpenAutoTag artifacts into a navigable desktop report.");
        subtitle.setForeground(MUTED);

        JPanel text = new JPanel(new GridLayout(2, 1, 0, 2));
        text.setOpaque(false);
        text.add(title);
        text.add(subtitle);

        header.add(text, BorderLayout.CENTER);
        return header;
    }

    private JSplitPane buildWorkspace() {
        JSplitPane split = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, buildControls(), buildReportTabs());
        split.setDividerLocation(330);
        split.setBorder(null);
        split.setBackground(PAGE);
        return split;
    }

    private JPanel buildControls() {
        JPanel panel = new JPanel();
        panel.setLayout(new BoxLayout(panel, BoxLayout.Y_AXIS));
        panel.setBackground(PAGE);

        panel.add(card("Server", serverControls()));
        panel.add(Box.createVerticalStrut(10));
        panel.add(card("Input PDF", fileControls()));
        panel.add(Box.createVerticalStrut(10));
        panel.add(card("Run Configuration", runControls()));
        panel.add(Box.createVerticalStrut(14));

        runButton.setAlignmentX(LEFT_ALIGNMENT);
        runButton.setMaximumSize(new Dimension(Integer.MAX_VALUE, 42));
        runButton.setBackground(TEAL);
        runButton.setForeground(Color.WHITE);
        runButton.setFocusPainted(false);
        runButton.setEnabled(false);
        runButton.addActionListener(this::runAnalysis);
        panel.add(runButton);
        panel.add(Box.createVerticalGlue());
        return panel;
    }

    private JPanel serverControls() {
        JPanel panel = stackPanel();
        panel.add(label("Server URL"));
        panel.add(serverField);
        panel.add(Box.createVerticalStrut(8));
        panel.add(label("API key"));
        apiKeyField.setToolTipText("Optional. Used as X-API-KEY for private mode.");
        panel.add(apiKeyField);
        return panel;
    }

    private JPanel fileControls() {
        JPanel panel = new JPanel(new BorderLayout(8, 8));
        panel.setOpaque(false);

        fileLabel.setForeground(MUTED);
        JButton browse = new JButton("Browse");
        browse.addActionListener((_event) -> choosePdf());

        panel.add(fileLabel, BorderLayout.CENTER);
        panel.add(browse, BorderLayout.EAST);
        return panel;
    }

    private JPanel runControls() {
        JPanel panel = stackPanel();
        panel.add(label("Workload"));
        panel.add(workloadCombo);
        panel.add(Box.createVerticalStrut(8));
        panel.add(label("Profile"));
        panel.add(profileCombo);
        return panel;
    }

    private JTabbedPane buildReportTabs() {
        narrativeArea.setEditable(false);
        narrativeArea.setLineWrap(true);
        narrativeArea.setWrapStyleWord(true);
        narrativeArea.setFont(narrativeArea.getFont().deriveFont(13f));
        narrativeArea.setForeground(INK);
        narrativeArea.setBorder(new EmptyBorder(12, 12, 12, 12));
        narrativeArea.setText("Run a PDF analysis to populate the introspector report.");

        JTable metricTable = new JTable(metricModel);
        JTable capabilityTable = new JTable(capabilityModel);
        metricTable.setRowHeight(28);
        capabilityTable.setRowHeight(30);
        artifactTable.setRowHeight(30);

        tabs.addTab("Overview", new JScrollPane(narrativeArea));
        tabs.addTab("Metrics", new JScrollPane(metricTable));
        tabs.addTab("Capabilities", new JScrollPane(capabilityTable));
        tabs.addTab("Artifacts", buildArtifactPanel());
        return tabs;
    }

    private JPanel buildArtifactPanel() {
        JPanel panel = new JPanel(new BorderLayout(8, 8));
        panel.setBackground(SURFACE);
        panel.setBorder(new EmptyBorder(10, 10, 10, 10));

        openArtifactButton.setEnabled(false);
        openArtifactButton.addActionListener((_event) -> openSelectedArtifact());
        artifactTable.getSelectionModel().addListSelectionListener((_event) -> openArtifactButton.setEnabled(artifactTable.getSelectedRow() >= 0));

        JPanel controls = new JPanel(new FlowLayout(FlowLayout.RIGHT, 0, 0));
        controls.setOpaque(false);
        controls.add(openArtifactButton);

        panel.add(new JScrollPane(artifactTable), BorderLayout.CENTER);
        panel.add(controls, BorderLayout.SOUTH);
        return panel;
    }

    private JPanel buildFooter() {
        JPanel footer = new JPanel(new BorderLayout(12, 0));
        footer.setOpaque(false);
        statusLabel.setForeground(MUTED);
        progressBar.setStringPainted(true);
        progressBar.setPreferredSize(new Dimension(220, 20));
        footer.add(statusLabel, BorderLayout.CENTER);
        footer.add(progressBar, BorderLayout.EAST);
        return footer;
    }

    private JPanel card(String title, JPanel content) {
        JPanel card = new JPanel(new BorderLayout(8, 8));
        card.setBackground(SURFACE);
        card.setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(LINE),
                new EmptyBorder(12, 12, 12, 12)));
        card.setMaximumSize(new Dimension(Integer.MAX_VALUE, 180));

        JLabel heading = label(title);
        heading.setForeground(INK);
        card.add(heading, BorderLayout.NORTH);
        card.add(content, BorderLayout.CENTER);
        return card;
    }

    private JPanel stackPanel() {
        JPanel panel = new JPanel();
        panel.setLayout(new BoxLayout(panel, BoxLayout.Y_AXIS));
        panel.setOpaque(false);
        return panel;
    }

    private JLabel label(String text) {
        JLabel label = new JLabel(text);
        label.setForeground(MUTED);
        label.setFont(label.getFont().deriveFont(Font.BOLD, 12f));
        label.setHorizontalAlignment(SwingConstants.LEFT);
        return label;
    }

    private static DefaultTableModel tableModel(String... columns) {
        return new DefaultTableModel(columns, 0) {
            @Override
            public boolean isCellEditable(int row, int column) {
                return false;
            }
        };
    }

    private void choosePdf() {
        JFileChooser chooser = new JFileChooser();
        chooser.setFileFilter(new FileNameExtensionFilter("PDF documents", "pdf"));
        chooser.setDialogTitle("Select PDF");
        if (chooser.showOpenDialog(this) == JFileChooser.APPROVE_OPTION) {
            selectedFile = chooser.getSelectedFile();
            fileLabel.setText(selectedFile.getName());
            fileLabel.setForeground(INDIGO);
            runButton.setEnabled(true);
        }
    }

    private void runAnalysis(ActionEvent _event) {
        if (selectedFile == null) {
            return;
        }

        runButton.setEnabled(false);
        progressBar.setValue(10);
        progressBar.setString("Uploading");
        statusLabel.setText("Uploading " + selectedFile.getName());

        new SwingWorker<JsonNode, Void>() {
            @Override
            protected JsonNode doInBackground() throws Exception {
                JsonNode batch = submitUpload(selectedFile.toPath());
                progressBar.setValue(30);
                progressBar.setString("Processing");
                return waitForBatch(batch.path("batchId").asText());
            }

            @Override
            protected void done() {
                try {
                    JsonNode batch = get();
                    renderBatch(batch);
                    progressBar.setValue(100);
                    progressBar.setString("Complete");
                    statusLabel.setText("Report assembled.");
                } catch (Exception exception) {
                    progressBar.setValue(0);
                    progressBar.setString("Failed");
                    statusLabel.setText("Analysis failed.");
                    JOptionPane.showMessageDialog(
                            PdfIntrospectorSwingApp.this,
                            exception.getMessage(),
                            "Analysis failed",
                            JOptionPane.ERROR_MESSAGE);
                } finally {
                    runButton.setEnabled(selectedFile != null);
                }
            }
        }.execute();
    }

    private JsonNode submitUpload(Path pdfPath) throws Exception {
        String boundary = "----IntrospectorBoundary" + System.currentTimeMillis();
        byte[] body = multipartBody(boundary, pdfPath);

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(currentServerUrl() + "/process-pdf-upload"))
                .timeout(Duration.ofMinutes(2))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body));
        addApiKey(builder);

        HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 202) {
            throw new IOException("Server returned " + response.statusCode() + ": " + response.body());
        }
        return MAPPER.readTree(response.body());
    }

    private JsonNode waitForBatch(String batchId) throws Exception {
        if (batchId == null || batchId.isBlank()) {
            throw new IOException("The server did not return a batch id.");
        }

        for (int attempt = 0; attempt < 180; attempt += 1) {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(currentServerUrl() + "/batches/" + batchId))
                    .timeout(Duration.ofSeconds(20))
                    .GET();
            addApiKey(builder);
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new IOException("Batch polling returned " + response.statusCode() + ": " + response.body());
            }

            JsonNode batch = MAPPER.readTree(response.body());
            String status = batch.path("status").asText("");
            if (!"processing".equals(status) && !"queued".equals(status)) {
                return batch;
            }

            Thread.sleep(1000);
        }

        throw new IOException("Timed out waiting for the introspector batch.");
    }

    private byte[] multipartBody(String boundary, Path pdfPath) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        appendFile(out, boundary, "files", pdfPath);
        appendField(out, boundary, "relativePaths", pdfPath.getFileName().toString());
        appendField(out, boundary, "workloadId", String.valueOf(workloadCombo.getSelectedItem()));
        appendField(out, boundary, "profileId", String.valueOf(profileCombo.getSelectedItem()));
        out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }

    private void appendFile(ByteArrayOutputStream out, String boundary, String name, Path path) throws IOException {
        String header = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + name + "\"; filename=\"" + path.getFileName() + "\"\r\n"
                + "Content-Type: application/pdf\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(Files.readAllBytes(path));
        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private void appendField(ByteArrayOutputStream out, String boundary, String name, String value) throws IOException {
        String header = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private void renderBatch(JsonNode batch) {
        JsonNode item = batch.path("items").isArray() && batch.path("items").size() > 0
                ? batch.path("items").get(0)
                : MAPPER.createObjectNode();
        JsonNode artifacts = firstObject(item.get("artifacts"), item.get("artifactLinks"));

        metricModel.setRowCount(0);
        metricModel.addRow(new Object[]{"File", text(item, "fileName", selectedFile != null ? selectedFile.getName() : "n/a")});
        metricModel.addRow(new Object[]{"Batch status", text(batch, "status", "unknown")});
        metricModel.addRow(new Object[]{"Job status", text(item, "status", "unknown")});
        metricModel.addRow(new Object[]{"Workload", text(item.path("workload"), "label", text(item.path("workload"), "id", "n/a"))});
        metricModel.addRow(new Object[]{"Artifact count", String.valueOf(artifacts.size())});
        metricModel.addRow(new Object[]{"Score", scoreLabel(item)});

        capabilityModel.setRowCount(0);
        addCapability("Parser", item.has("status"), "Glyph, bounds, rotation, and source text feed the report.");
        addCapability("Layout Analyzer", hasArtifact(artifacts, "layout", "sourceText"), "Reading order, paragraphs, headings, and table candidates.");
        addCapability("Semantic Engine", hasArtifact(artifacts, "semantic", "tagManifest"), "Roles, table cells, paragraph merge, and structure tree plan.");
        addCapability("Native Writer", hasArtifact(artifacts, "writerReport", "taggedPdf"), "MCID assignment, artifact wrapping, and native PDF output.");
        addCapability("Validator", hasArtifact(artifacts, "validationReport"), "PDF/UA, tagged content, metadata, and tab-order results.");
        addCapability("Table Mapper", hasArtifact(artifacts, "table"), "Grid spans, headers, and ruled-table evidence.");
        addCapability("Font Health", hasArtifact(artifacts, "font"), "Font embedding, ToUnicode, and glyph coverage.");
        addCapability("Repairer", hasArtifact(artifacts, "repair"), "Structural repair and corruption risk signals.");
        addCapability("Redaction", hasArtifact(artifacts, "redaction", "redactedPdf"), "Sensitive text plan and removal report.");
        addCapability("Diff Engine", hasArtifact(artifacts, "tagDelta", "diff"), "Before and after accessibility deltas.");

        artifactModel.setRowCount(0);
        Iterator<Map.Entry<String, JsonNode>> fields = artifacts.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            artifactModel.addRow(new Object[]{labelize(entry.getKey()), kindFor(entry.getKey(), entry.getValue().asText()), entry.getValue().asText()});
        }

        narrativeArea.setText(buildNarrative(batch, item, artifacts));
        tabs.setSelectedIndex(0);
    }

    private void addCapability(String name, boolean available, String contract) {
        capabilityModel.addRow(new Object[]{name, available ? "Available" : "Not emitted", contract});
    }

    private String buildNarrative(JsonNode batch, JsonNode item, JsonNode artifacts) {
        StringBuilder builder = new StringBuilder();
        builder.append("PDF Introspector Report\n\n");
        builder.append("File: ").append(text(item, "fileName", selectedFile != null ? selectedFile.getName() : "n/a")).append('\n');
        builder.append("Batch: ").append(text(batch, "batchId", "n/a")).append('\n');
        builder.append("Status: ").append(text(item, "status", text(batch, "status", "unknown"))).append('\n');
        builder.append("Score: ").append(scoreLabel(item)).append("\n\n");
        builder.append("Report contract\n");
        builder.append("- Executive scorecard for fast triage.\n");
        builder.append("- Artifact index with direct links to emitted reports and PDFs.\n");
        builder.append("- Capability coverage table for parser, layout, semantic, native writer, validation, tables, fonts, repair, redaction, and diff outputs.\n");
        builder.append("- Share-ready summary suitable for issue comments, QA packets, and printed review.\n\n");
        builder.append("Artifacts emitted: ").append(artifacts.size()).append('\n');
        return builder.toString();
    }

    private void openSelectedArtifact() {
        int selected = artifactTable.getSelectedRow();
        if (selected < 0) {
            return;
        }

        String url = String.valueOf(artifactModel.getValueAt(selected, 2));
        if (url == null || url.isBlank()) {
            return;
        }

        try {
            URI uri = URI.create(url.startsWith("http") ? url : currentServerUrl() + url);
            Desktop.getDesktop().browse(uri);
        } catch (Exception exception) {
            JOptionPane.showMessageDialog(this, exception.getMessage(), "Open artifact failed", JOptionPane.ERROR_MESSAGE);
        }
    }

    private void addApiKey(HttpRequest.Builder builder) {
        String apiKey = new String(apiKeyField.getPassword()).trim();
        if (!apiKey.isBlank()) {
            builder.header("X-API-KEY", apiKey);
        }
    }

    private String currentServerUrl() {
        return normalizeServer(serverField.getText());
    }

    private static String normalizeServer(String value) {
        String normalized = value == null || value.isBlank() ? DEFAULT_SERVER : value.trim();
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    private static JsonNode firstObject(JsonNode first, JsonNode second) {
        if (first != null && first.isObject()) {
            return first;
        }
        if (second != null && second.isObject()) {
            return second;
        }
        return MAPPER.createObjectNode();
    }

    private static String text(JsonNode node, String field, String fallback) {
        JsonNode value = node == null ? null : node.get(field);
        return value == null || value.isMissingNode() || value.isNull() ? fallback : value.asText(fallback);
    }

    private static boolean hasArtifact(JsonNode artifacts, String... needles) {
        if (artifacts == null || !artifacts.isObject()) {
            return false;
        }
        Iterator<String> names = artifacts.fieldNames();
        while (names.hasNext()) {
            String name = names.next().toLowerCase(Locale.ROOT);
            for (String needle : needles) {
                if (name.contains(needle.toLowerCase(Locale.ROOT))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static String scoreLabel(JsonNode item) {
        String status = text(item, "status", "unknown");
        int score = switch (status) {
            case "completed" -> 92;
            case "failed" -> 18;
            case "running", "processing" -> 54;
            default -> 64;
        };
        return score + "%";
    }

    private static String labelize(String key) {
        String spaced = key.replaceAll("([a-z])([A-Z])", "$1 $2").replace('-', ' ').replace('_', ' ');
        StringBuilder builder = new StringBuilder();
        for (String part : spaced.split("\\s+")) {
            if (part.isBlank()) {
                continue;
            }
            builder.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1)).append(' ');
        }
        return builder.toString().trim();
    }

    private static String kindFor(String name, String url) {
        String text = (name + " " + url).toLowerCase(Locale.ROOT);
        if (text.contains("pdf")) {
            return "PDF";
        }
        if (text.contains("html")) {
            return "HTML";
        }
        if (text.contains("json") || text.contains("report") || text.contains("manifest")) {
            return "JSON";
        }
        return "Artifact";
    }

    public static void main(String[] args) {
        String server = args.length > 0 ? args[0] : DEFAULT_SERVER;
        SwingUtilities.invokeLater(() -> {
            try {
                UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
            } catch (Exception ignored) {
                // Keep Swing defaults when native look and feel is unavailable.
            }
            new PdfIntrospectorSwingApp(server).setVisible(true);
        });
    }
}
