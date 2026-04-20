package buildeverything.servlet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import javax.swing.border.TitledBorder;
import javax.swing.filechooser.FileNameExtensionFilter;
import javax.swing.table.DefaultTableCellRenderer;
import javax.swing.table.DefaultTableModel;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Java Swing GUI for the PDF Accessibility Diff Tool.
 *
 * <p>Provides a desktop interface for selecting a source PDF and a competitor PDF,
 * choosing a writer mode (Auto/Native/Raster), and invoking the diff engine
 * via the REST API. Results are shown in a tabbed, colour-coded comparison panel.</p>
 *
 * <p>Launch: {@code java -cp ... buildeverything.servlet.DiffToolSwingApp [serverUrl]}</p>
 */
public final class DiffToolSwingApp extends JFrame {

    /* ── Brand colours (matching CSS vars) ─────────────────────────── */

    private static final Color PAPER       = new Color(0xF6, 0xF1, 0xE8);
    private static final Color PAPER_DEEP  = new Color(0xE9, 0xDF, 0xD0);
    private static final Color INK         = new Color(0x13, 0x26, 0x28);
    private static final Color MUTED       = new Color(0x58, 0x70, 0x72);
    private static final Color SIGNAL      = new Color(0x0B, 0x7A, 0x75);
    private static final Color SIGNAL_DEEP = new Color(0x06, 0x4F, 0x4C);
    private static final Color WARM        = new Color(0xCA, 0x6B, 0x2F);
    private static final Color DANGER      = new Color(0xA4, 0x3C, 0x2D);
    private static final Color WHITE       = new Color(0xFF, 0xFA, 0xF1);

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DEFAULT_SERVER = "http://localhost:3001";

    /* ── State ─────────────────────────────────────────────────────── */

    private File sourceFile;
    private File competitorFile;
    private String serverUrl;

    /* ── UI refs ────────────────────────────────────────────────────── */

    private final JLabel sourceLabel = new JLabel("No file selected");
    private final JLabel competitorLabel = new JLabel("No file selected");
    private final JComboBox<String> modeCombo = new JComboBox<>(new String[]{"auto", "native", "raster"});
    private final JButton compareButton = new JButton("\uD83D\uDD0D  Run Comparison");
    private final JTabbedPane resultTabs = new JTabbedPane();
    private final JLabel statusLabel = new JLabel(" ");
    private final JProgressBar progressBar = new JProgressBar();

    /* ── Constructor ────────────────────────────────────────────────── */

    public DiffToolSwingApp(String serverUrl) {
        super("PDF Accessibility Diff Tool");
        this.serverUrl = serverUrl != null ? serverUrl : DEFAULT_SERVER;
        setDefaultCloseOperation(EXIT_ON_CLOSE);
        setMinimumSize(new Dimension(900, 680));
        setPreferredSize(new Dimension(1050, 740));
        getContentPane().setBackground(PAPER);
        buildUI();
        pack();
        setLocationRelativeTo(null);
    }

    /* ── Layout ─────────────────────────────────────────────────────── */

    private void buildUI() {
        JPanel root = new JPanel(new BorderLayout(12, 12));
        root.setBackground(PAPER);
        root.setBorder(new EmptyBorder(16, 20, 16, 20));

        root.add(buildHeader(), BorderLayout.NORTH);
        root.add(buildCenter(), BorderLayout.CENTER);
        root.add(buildFooter(), BorderLayout.SOUTH);

        setContentPane(root);
    }

    private JPanel buildHeader() {
        JPanel header = new JPanel(new BorderLayout());
        header.setOpaque(false);

        JLabel title = new JLabel("\uD83D\uDEE1\uFE0F  PDF Accessibility Diff Tool");
        title.setFont(new Font("Serif", Font.BOLD, 22));
        title.setForeground(INK);

        JLabel subtitle = new JLabel("Compare accessibility quality across PDF documents");
        subtitle.setForeground(MUTED);
        subtitle.setFont(subtitle.getFont().deriveFont(Font.PLAIN, 13f));

        JPanel text = new JPanel(new GridLayout(2, 1, 0, 2));
        text.setOpaque(false);
        text.add(title);
        text.add(subtitle);

        header.add(text, BorderLayout.CENTER);
        return header;
    }

    private JSplitPane buildCenter() {
        JSplitPane split = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, buildSidebar(), buildResults());
        split.setDividerLocation(320);
        split.setBackground(PAPER);
        split.setBorder(null);
        return split;
    }

    private JPanel buildSidebar() {
        JPanel sidebar = new JPanel();
        sidebar.setLayout(new BoxLayout(sidebar, BoxLayout.Y_AXIS));
        sidebar.setBackground(PAPER);

        sidebar.add(buildFileCard("① Source Document", sourceLabel, this::pickSource));
        sidebar.add(Box.createVerticalStrut(10));
        sidebar.add(buildFileCard("② Competitor Document", competitorLabel, this::pickCompetitor));
        sidebar.add(Box.createVerticalStrut(10));
        sidebar.add(buildModeCard());
        sidebar.add(Box.createVerticalStrut(14));
        sidebar.add(buildCompareButton());
        sidebar.add(Box.createVerticalGlue());
        return sidebar;
    }

    private JPanel buildFileCard(String title, JLabel label, Runnable browseAction) {
        JPanel card = new JPanel(new BorderLayout(6, 6));
        card.setBackground(WHITE);
        card.setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(PAPER_DEEP),
                new EmptyBorder(10, 12, 10, 12)));
        card.setMaximumSize(new Dimension(Integer.MAX_VALUE, 90));

        JLabel heading = new JLabel(title);
        heading.setFont(heading.getFont().deriveFont(Font.BOLD, 13f));
        heading.setForeground(INK);

        label.setForeground(MUTED);
        label.setFont(label.getFont().deriveFont(Font.PLAIN, 11f));

        JButton browse = new JButton("Browse…");
        browse.setFocusPainted(false);
        browse.setFont(browse.getFont().deriveFont(11f));
        browse.addActionListener((_e) -> browseAction.run());

        JPanel top = new JPanel(new BorderLayout());
        top.setOpaque(false);
        top.add(heading, BorderLayout.WEST);
        top.add(browse, BorderLayout.EAST);

        card.add(top, BorderLayout.NORTH);
        card.add(label, BorderLayout.CENTER);
        return card;
    }

    private JPanel buildModeCard() {
        JPanel card = new JPanel(new BorderLayout(6, 6));
        card.setBackground(WHITE);
        card.setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(PAPER_DEEP),
                new EmptyBorder(10, 12, 10, 12)));
        card.setMaximumSize(new Dimension(Integer.MAX_VALUE, 80));

        JLabel heading = new JLabel("Writer Mode");
        heading.setFont(heading.getFont().deriveFont(Font.BOLD, 13f));
        heading.setForeground(INK);

        modeCombo.setSelectedItem("auto");
        modeCombo.setFont(modeCombo.getFont().deriveFont(12f));

        card.add(heading, BorderLayout.NORTH);
        card.add(modeCombo, BorderLayout.CENTER);
        return card;
    }

    private JPanel buildCompareButton() {
        JPanel wrapper = new JPanel(new FlowLayout(FlowLayout.CENTER));
        wrapper.setOpaque(false);
        wrapper.setMaximumSize(new Dimension(Integer.MAX_VALUE, 48));

        compareButton.setBackground(SIGNAL);
        compareButton.setForeground(Color.WHITE);
        compareButton.setFocusPainted(false);
        compareButton.setFont(compareButton.getFont().deriveFont(Font.BOLD, 14f));
        compareButton.setPreferredSize(new Dimension(280, 38));
        compareButton.addActionListener(this::onCompare);
        compareButton.setEnabled(false);

        wrapper.add(compareButton);
        return wrapper;
    }

    private JPanel buildResults() {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(PAPER);
        panel.setBorder(new EmptyBorder(0, 8, 0, 0));

        resultTabs.setBackground(PAPER);
        resultTabs.setFont(resultTabs.getFont().deriveFont(12f));
        panel.add(resultTabs, BorderLayout.CENTER);

        // initial empty placeholder
        JLabel empty = new JLabel("<html><center><br><br><br><span style='font-size:28px'>📊</span><br>" +
                "<b>Upload documents to compare</b><br>" +
                "<span style='color:#587072'>Select source and competitor PDFs, then click Run Comparison.</span></center></html>");
        empty.setHorizontalAlignment(SwingConstants.CENTER);
        resultTabs.addTab("Overview", empty);

        return panel;
    }

    private JPanel buildFooter() {
        JPanel footer = new JPanel(new BorderLayout(8, 0));
        footer.setOpaque(false);

        statusLabel.setForeground(MUTED);
        statusLabel.setFont(statusLabel.getFont().deriveFont(11f));

        progressBar.setIndeterminate(false);
        progressBar.setStringPainted(true);
        progressBar.setPreferredSize(new Dimension(200, 18));
        progressBar.setVisible(false);

        footer.add(statusLabel, BorderLayout.CENTER);
        footer.add(progressBar, BorderLayout.EAST);
        return footer;
    }

    /* ── File chooser ──────────────────────────────────────────────── */

    private void pickSource() {
        File file = pickPdf("Select Source PDF");
        if (file != null) {
            sourceFile = file;
            sourceLabel.setText(file.getName());
            sourceLabel.setForeground(SIGNAL_DEEP);
            updateButtonState();
        }
    }

    private void pickCompetitor() {
        File file = pickPdf("Select Competitor PDF");
        if (file != null) {
            competitorFile = file;
            competitorLabel.setText(file.getName());
            competitorLabel.setForeground(WARM);
            updateButtonState();
        }
    }

    private File pickPdf(String title) {
        JFileChooser chooser = new JFileChooser();
        chooser.setDialogTitle(title);
        chooser.setFileFilter(new FileNameExtensionFilter("PDF Documents", "pdf"));
        return chooser.showOpenDialog(this) == JFileChooser.APPROVE_OPTION ? chooser.getSelectedFile() : null;
    }

    private void updateButtonState() {
        compareButton.setEnabled(sourceFile != null && competitorFile != null);
    }

    /* ── Comparison ────────────────────────────────────────────────── */

    private void onCompare(ActionEvent _event) {
        if (sourceFile == null || competitorFile == null) return;

        compareButton.setEnabled(false);
        progressBar.setVisible(true);
        progressBar.setIndeterminate(true);
        statusLabel.setText("Running comparison…");

        String mode = (String) modeCombo.getSelectedItem();

        new SwingWorker<JsonNode, Void>() {
            @Override
            protected JsonNode doInBackground() throws Exception {
                return callCompareApi(sourceFile.toPath(), competitorFile.toPath(), mode);
            }

            @Override
            protected void done() {
                progressBar.setVisible(false);
                progressBar.setIndeterminate(false);
                compareButton.setEnabled(true);
                try {
                    JsonNode report = get();
                    statusLabel.setText("Comparison complete.");
                    renderResults(report);
                } catch (Exception ex) {
                    statusLabel.setText("Error: " + ex.getMessage());
                    JOptionPane.showMessageDialog(DiffToolSwingApp.this,
                            "Comparison failed:\n" + ex.getMessage(),
                            "Error", JOptionPane.ERROR_MESSAGE);
                }
            }
        }.execute();
    }

    private JsonNode callCompareApi(Path source, Path competitor, String mode) throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        String boundary = "----DiffToolBoundary" + System.currentTimeMillis();
        byte[] body = buildMultipartBody(boundary, source, competitor, mode);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(serverUrl + "/api/difftool/compare"))
                .timeout(Duration.ofMinutes(5))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new IOException("Server returned " + response.statusCode() + ": " + response.body());
        }

        return MAPPER.readTree(response.body());
    }

    private byte[] buildMultipartBody(String boundary, Path source, Path competitor, String mode) throws IOException {
        var parts = new java.io.ByteArrayOutputStream();

        appendFilePart(parts, boundary, "sourcePdf", source);
        appendFilePart(parts, boundary, "competitorPdf", competitor);
        appendFieldPart(parts, boundary, "writerMode", mode);

        parts.write(("--" + boundary + "--\r\n").getBytes());
        return parts.toByteArray();
    }

    private void appendFilePart(java.io.ByteArrayOutputStream out, String boundary, String name, Path file) throws IOException {
        String header = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + name + "\"; filename=\"" + file.getFileName() + "\"\r\n"
                + "Content-Type: application/pdf\r\n\r\n";
        out.write(header.getBytes());
        out.write(Files.readAllBytes(file));
        out.write("\r\n".getBytes());
    }

    private void appendFieldPart(java.io.ByteArrayOutputStream out, String boundary, String name, String value) throws IOException {
        String header = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n";
        out.write(header.getBytes());
        out.write(value.getBytes());
        out.write("\r\n".getBytes());
    }

    /* ── Result rendering ──────────────────────────────────────────── */

    private void renderResults(JsonNode report) {
        resultTabs.removeAll();

        // Overall tab
        resultTabs.addTab("🏆 Overview", buildOverviewPanel(report));

        // Per-category tabs
        ArrayNode categories = (ArrayNode) report.path("categories");
        if (categories != null) {
            for (JsonNode cat : categories) {
                String icon = cat.path("icon").asText("");
                String label = cat.path("label").asText("Category");
                resultTabs.addTab(icon + " " + label, buildCategoryPanel(cat, report));
            }
        }

        resultTabs.setSelectedIndex(0);
    }

    private JPanel buildOverviewPanel(JsonNode report) {
        JPanel panel = new JPanel(new BorderLayout(12, 12));
        panel.setBackground(PAPER);
        panel.setBorder(new EmptyBorder(16, 16, 16, 16));

        // Winner banner
        String winnerId = report.path("overallWinner").asText("");
        JsonNode winnerDoc = null;
        for (JsonNode doc : report.path("documents")) {
            if (doc.path("id").asText("").equals(winnerId)) {
                winnerDoc = doc;
                break;
            }
        }

        JPanel bannerPanel = new JPanel(new BorderLayout(10, 0));
        bannerPanel.setBackground(new Color(0x0B, 0x7A, 0x75, 20));
        bannerPanel.setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(new Color(0x0B, 0x7A, 0x75, 50)),
                new EmptyBorder(14, 16, 14, 16)));

        JLabel trophy = new JLabel("🏆");
        trophy.setFont(trophy.getFont().deriveFont(32f));

        String winnerName = winnerDoc != null ? winnerDoc.path("label").asText("Unknown") : "No winner";
        double score = report.path("overallScores").path(winnerId).asDouble(0);
        JLabel winnerText = new JLabel("<html><b style='font-size:14px'>" + htmlEscape(winnerName) + "</b><br>" +
                "<span style='color:#587072'>Overall score: " + String.format("%.0f%%", score * 100) + "</span></html>");
        winnerText.setForeground(INK);

        bannerPanel.add(trophy, BorderLayout.WEST);
        bannerPanel.add(winnerText, BorderLayout.CENTER);

        // Summary table
        String[] columns = {"Category", "Winner", "Best Score"};
        DefaultTableModel model = new DefaultTableModel(columns, 0) {
            @Override public boolean isCellEditable(int r, int c) { return false; }
        };

        for (JsonNode cat : report.path("categories")) {
            String catLabel = cat.path("icon").asText("") + " " + cat.path("label").asText("");
            String catWinner = cat.path("winner").asText("");
            if (catWinner.isEmpty() && cat.has("tied") && cat.path("tied").isArray()) {
                catWinner = "Tied";
            }
            String bestLabel = "";
            for (JsonNode doc : report.path("documents")) {
                if (doc.path("id").asText("").equals(catWinner)) {
                    bestLabel = doc.path("label").asText(catWinner);
                    break;
                }
            }
            if (bestLabel.isEmpty()) bestLabel = catWinner;
            double bestScore = 0;
            for (JsonNode entry : cat.path("entries")) {
                bestScore = Math.max(bestScore, entry.path("score").asDouble(0));
            }
            model.addRow(new Object[]{catLabel, bestLabel, String.format("%.1f%%", bestScore * 100)});
        }

        JTable table = new JTable(model);
        table.setFont(table.getFont().deriveFont(12f));
        table.setRowHeight(28);
        table.setBackground(WHITE);
        table.setGridColor(PAPER_DEEP);
        table.getTableHeader().setBackground(PAPER_DEEP);
        table.getTableHeader().setFont(table.getTableHeader().getFont().deriveFont(Font.BOLD, 12f));

        // Colour-code the Winner column
        table.getColumnModel().getColumn(1).setCellRenderer(new DefaultTableCellRenderer() {
            @Override
            public Component getTableCellRendererComponent(JTable t, Object v, boolean sel, boolean foc, int r, int c) {
                Component comp = super.getTableCellRendererComponent(t, v, sel, foc, r, c);
                if (!sel) {
                    String text = String.valueOf(v);
                    if (text.contains("AutoTag")) comp.setForeground(SIGNAL_DEEP);
                    else if (text.equals("Tied")) comp.setForeground(WARM);
                    else comp.setForeground(INK);
                }
                return comp;
            }
        });

        panel.add(bannerPanel, BorderLayout.NORTH);
        panel.add(new JScrollPane(table), BorderLayout.CENTER);
        return panel;
    }

    private JPanel buildCategoryPanel(JsonNode category, JsonNode report) {
        JPanel panel = new JPanel(new BorderLayout(12, 12));
        panel.setBackground(PAPER);
        panel.setBorder(new EmptyBorder(16, 16, 16, 16));

        // Description
        JLabel desc = new JLabel("<html><b>" + htmlEscape(category.path("label").asText("")) + "</b><br>"
                + "<span style='color:#587072'>" + htmlEscape(category.path("description").asText("")) + "</span></html>");
        desc.setBorder(new EmptyBorder(0, 0, 10, 0));

        // Score bars (using table)
        String[] columns = {"Document", "Score", "Bar"};
        DefaultTableModel model = new DefaultTableModel(columns, 0) {
            @Override public boolean isCellEditable(int r, int c) { return false; }
        };

        for (JsonNode entry : category.path("entries")) {
            String label = entry.path("label").asText("?");
            double score = entry.path("score").asDouble(0);
            model.addRow(new Object[]{label, String.format("%.1f%%", score * 100), score});
        }

        JTable table = new JTable(model);
        table.setFont(table.getFont().deriveFont(12f));
        table.setRowHeight(30);
        table.setBackground(WHITE);
        table.setGridColor(PAPER_DEEP);
        table.getTableHeader().setBackground(PAPER_DEEP);
        table.getTableHeader().setFont(table.getTableHeader().getFont().deriveFont(Font.BOLD, 12f));

        // Custom renderer for score bar
        table.getColumnModel().getColumn(2).setCellRenderer(new ScoreBarRenderer());
        table.getColumnModel().getColumn(2).setPreferredWidth(300);

        panel.add(desc, BorderLayout.NORTH);
        panel.add(new JScrollPane(table), BorderLayout.CENTER);
        return panel;
    }

    /* ── Score bar renderer ────────────────────────────────────────── */

    private static class ScoreBarRenderer extends DefaultTableCellRenderer {
        @Override
        public Component getTableCellRendererComponent(JTable table, Object value, boolean selected, boolean focused, int row, int col) {
            double score = value instanceof Number n ? n.doubleValue() : 0;
            return new JPanel() {
                @Override
                protected void paintComponent(Graphics g) {
                    super.paintComponent(g);
                    Graphics2D g2 = (Graphics2D) g;
                    g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

                    int w = getWidth() - 8;
                    int h = 14;
                    int y = (getHeight() - h) / 2;
                    int x = 4;

                    // Track
                    g2.setColor(PAPER_DEEP);
                    g2.fillRoundRect(x, y, w, h, 7, 7);

                    // Fill
                    int fillW = (int) (w * score);
                    GradientPaint gp = new GradientPaint(x, y, SIGNAL, x + fillW, y, SIGNAL_DEEP);
                    g2.setPaint(gp);
                    g2.fillRoundRect(x, y, fillW, h, 7, 7);
                }

                {
                    setOpaque(true);
                    setBackground(selected ? table.getSelectionBackground() : WHITE);
                }
            };
        }
    }

    /* ── Utilities ─────────────────────────────────────────────────── */

    private static String htmlEscape(String text) {
        if (text == null) return "";
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    /* ── Main ──────────────────────────────────────────────────────── */

    public static void main(String[] args) {
        String server = args.length > 0 ? args[0] : DEFAULT_SERVER;

        SwingUtilities.invokeLater(() -> {
            try {
                UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
            } catch (Exception ignored) {}

            new DiffToolSwingApp(server).setVisible(true);
        });
    }
}
