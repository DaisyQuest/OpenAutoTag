package buildeverything.servlet;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.DefaultComboBoxModel;
import javax.swing.DefaultListModel;
import javax.swing.DropMode;
import javax.swing.Icon;
import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JLayeredPane;
import javax.swing.JList;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JProgressBar;
import javax.swing.JScrollPane;
import javax.swing.JSplitPane;
import javax.swing.JTabbedPane;
import javax.swing.JTable;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.JToolBar;
import javax.swing.JTree;
import javax.swing.ListSelectionModel;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.SwingWorker;
import javax.swing.Timer;
import javax.swing.TransferHandler;
import javax.swing.UIManager;
import javax.swing.border.EmptyBorder;
import javax.swing.filechooser.FileNameExtensionFilter;
import javax.swing.table.DefaultTableModel;
import javax.swing.tree.DefaultMutableTreeNode;
import javax.swing.tree.DefaultTreeModel;
import javax.swing.tree.TreeCellRenderer;
import javax.swing.tree.TreePath;
import java.awt.AlphaComposite;
import java.awt.BasicStroke;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GraphicsConfiguration;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.GridLayout;
import java.awt.Image;
import java.awt.Insets;
import java.awt.RenderingHints;
import java.awt.Stroke;
import java.awt.Transparency;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.awt.datatransfer.Transferable;
import java.awt.event.ActionEvent;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseMotionAdapter;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.awt.image.VolatileImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Dark-mode Swing studio for structural PDF tagging and validation triage.
 */
public final class PerfectStudioSwingApp extends JFrame {
    private static final Color BACKGROUND = new Color(0x1E1E1E);
    private static final Color SURFACE = new Color(0x252526);
    private static final Color TOOLBAR = new Color(0x333333);
    private static final Color BORDER = new Color(0x3E3E42);
    private static final Color ACCENT = new Color(0x0078D4);
    private static final Color TEXT = new Color(0xCCCCCC);
    private static final Color MUTED = new Color(0x808080);
    private static final Color ERROR = new Color(0xF44336);
    private static final Color PASS = new Color(0x4CAF50);
    private static final int LEFT_WIDTH = 300;
    private static final int RIGHT_WIDTH = 350;

    private final Path repoRoot;
    private final TagSchemaRules schemaRules;
    private final PerfectStudioArtifactHydrator artifactHydrator;
    private final JTree tagTree = new JTree();
    private final DefaultListModel<StudioTag> readingOrderModel = new DefaultListModel<>();
    private final JList<StudioTag> readingOrderList = new JList<>(readingOrderModel);
    private final DefaultTableModel validationModel = new DefaultTableModel(
            new Object[]{"Severity", "Code", "Description", "Page", "Remediation"}, 0);
    private final JTable validationTable = new JTable(validationModel) {
        @Override
        public boolean isCellEditable(int row, int column) {
            return false;
        }
    };
    private final JLabel statusMessage = new JLabel("Ready");
    private final JLabel statsMessage = new JLabel("Page 1 / 1  |  Total Tags: 0");
    private final JProgressBar loadingBar = new JProgressBar();
    private final PdfCanvasPanel canvasPanel = new PdfCanvasPanel();
    private final JTextField titleField = new JTextField();
    private final JTextArea actualTextArea = new JTextArea();
    private final JTextArea alternateTextArea = new JTextArea();
    private final JComboBox<String> typeCombo = new JComboBox<>();
    private final JComboBox<String> languageCombo = new JComboBox<>(new String[]{"en-US", "es", "fr", "de", "ja", "zh-Hans"});
    private final JTextField xField = new JTextField();
    private final JTextField yField = new JTextField();
    private final JTextField wField = new JTextField();
    private final JTextField hField = new JTextField();

    private File selectedFile;
    private StudioTag documentRoot = StudioTag.sampleDocument();
    private HydratedDocument currentHydration;
    private List<StudioValidationIssue> currentValidationIssues = List.of();
    private boolean syncingSelection;

    public PerfectStudioSwingApp(Path repoRoot) {
        super("OpenAutoTag Perfect Studio");
        this.repoRoot = repoRoot.toAbsolutePath().normalize();
        this.schemaRules = loadSchemaRules(this.repoRoot);
        this.artifactHydrator = new PerfectStudioArtifactHydrator(this.repoRoot);
        setDefaultCloseOperation(EXIT_ON_CLOSE);
        setMinimumSize(new Dimension(1024, 768));
        setPreferredSize(new Dimension(1440, 900));
        buildUi();
        installSampleDocument();
        pack();
        setLocationRelativeTo(null);
    }

    private void buildUi() {
        StudioTheme.install();
        JPanel root = new JPanel(new BorderLayout());
        root.setBackground(BACKGROUND);
        root.add(buildNorth(), BorderLayout.NORTH);
        root.add(buildWorkspace(), BorderLayout.CENTER);
        root.add(buildStatusBar(), BorderLayout.SOUTH);
        setContentPane(root);
        setJMenuBar(buildMenuBar());
    }

    private JPanel buildNorth() {
        JPanel north = new JPanel(new BorderLayout());
        north.setBackground(TOOLBAR);
        north.add(buildToolbar(), BorderLayout.CENTER);
        return north;
    }

    private JMenuBar buildMenuBar() {
        JMenuBar bar = new JMenuBar();
        bar.setBackground(TOOLBAR);
        bar.setBorder(BorderFactory.createEmptyBorder());
        for (String label : List.of("File", "Edit", "View", "Tags", "Validation", "Window", "Help")) {
            JMenu menu = new JMenu(label);
            menu.setForeground(TEXT);
            if ("File".equals(label)) {
                JMenuItem open = new JMenuItem("Open");
                open.addActionListener(this::openPdf);
                menu.add(open);
            }
            if ("Validation".equals(label)) {
                JMenuItem validate = new JMenuItem("Run Compliance Check");
                validate.addActionListener(this::runValidation);
                menu.add(validate);
            }
            bar.add(menu);
        }
        return bar;
    }

    private JToolBar buildToolbar() {
        JToolBar toolbar = new JToolBar();
        toolbar.setFloatable(false);
        toolbar.setPreferredSize(new Dimension(100, 48));
        toolbar.setBackground(TOOLBAR);
        toolbar.setBorder(new EmptyBorder(8, 12, 8, 12));
        addToolButton(toolbar, "Open", "open", this::openPdf);
        addToolButton(toolbar, "Save", "save", (_event) -> setStatus("Save queued for current contract model."));
        addToolButton(toolbar, "Export", "export", (_event) -> setStatus("Export queued for current tagged PDF."));
        toolbar.addSeparator(new Dimension(16, 24));
        addToolButton(toolbar, "Undo", "undo", (_event) -> setStatus("Undo stack is empty."));
        addToolButton(toolbar, "Redo", "redo", (_event) -> setStatus("Redo stack is empty."));
        toolbar.addSeparator(new Dimension(16, 24));
        addToolButton(toolbar, "Add Tag", "add", (_event) -> setStatus("Add Tag tool enabled."));
        addToolButton(toolbar, "Auto-Tag", "wand", (_event) -> openDocumentAsync());
        addToolButton(toolbar, "Edit Properties", "properties", (_event) -> alternateTextArea.requestFocusInWindow());
        toolbar.addSeparator(new Dimension(16, 24));
        addToolButton(toolbar, "Run Compliance Check", "validate", this::runValidation);
        Box.Filler glue = new Box.Filler(new Dimension(1, 1), new Dimension(1, 1), new Dimension(Integer.MAX_VALUE, 1));
        toolbar.add(glue);
        loadingBar.setIndeterminate(true);
        loadingBar.setVisible(false);
        loadingBar.setPreferredSize(new Dimension(150, 18));
        toolbar.add(loadingBar);
        return toolbar;
    }

    private void addToolButton(JToolBar toolbar, String label, String icon, java.awt.event.ActionListener action) {
        JButton button = new JButton(new StudioIcon(icon, 16, ACCENT));
        button.setToolTipText(label);
        button.setPreferredSize(new Dimension(32, 32));
        button.setMinimumSize(new Dimension(32, 32));
        button.setMaximumSize(new Dimension(32, 32));
        button.setFocusPainted(false);
        button.setBorder(BorderFactory.createEmptyBorder());
        button.setBackground(TOOLBAR);
        button.setForeground(TEXT);
        button.addActionListener(action);
        toolbar.add(button);
    }

    private JSplitPane buildWorkspace() {
        JSplitPane rightSplit = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, buildCanvasWorkspace(), buildRightPanel());
        rightSplit.setResizeWeight(1.0);
        rightSplit.setDividerLocation(1440 - LEFT_WIDTH - RIGHT_WIDTH);
        styleSplitPane(rightSplit);

        JSplitPane leftSplit = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, buildLeftPanel(), rightSplit);
        leftSplit.setDividerLocation(LEFT_WIDTH);
        leftSplit.setResizeWeight(0.0);
        styleSplitPane(leftSplit);
        return leftSplit;
    }

    private JPanel buildLeftPanel() {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setPreferredSize(new Dimension(LEFT_WIDTH, 800));
        panel.setMinimumSize(new Dimension(200, 400));
        panel.setMaximumSize(new Dimension(600, Integer.MAX_VALUE));
        panel.setBackground(SURFACE);
        panel.setBorder(BorderFactory.createMatteBorder(0, 0, 0, 1, BORDER));
        tagTree.setBackground(SURFACE);
        tagTree.setForeground(TEXT);
        tagTree.setRowHeight(24);
        tagTree.setCellRenderer(new TagTreeRenderer());
        tagTree.addTreeSelectionListener((_event) -> selectTagFromTree());
        JScrollPane scroll = new JScrollPane(tagTree);
        scroll.setBorder(BorderFactory.createEmptyBorder());
        panel.add(scroll, BorderLayout.CENTER);
        return panel;
    }

    private JComponent buildCanvasWorkspace() {
        CanvasWorkspace workspace = new CanvasWorkspace(canvasPanel);
        workspace.setBackground(BACKGROUND);
        workspace.setMinimumSize(new Dimension(360, 400));
        canvasPanel.setRemediationFocus((tag) -> {
            selectTag(tag);
            alternateTextArea.requestFocusInWindow();
            alternateTextArea.selectAll();
        });
        return workspace;
    }

    private JComponent buildRightPanel() {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setPreferredSize(new Dimension(RIGHT_WIDTH, 800));
        panel.setMinimumSize(new Dimension(250, 400));
        panel.setBackground(SURFACE);
        panel.setBorder(BorderFactory.createMatteBorder(0, 1, 0, 0, BORDER));

        JTabbedPane tabs = new JTabbedPane();
        tabs.setBackground(SURFACE);
        tabs.setForeground(TEXT);
        tabs.addTab("Element Properties", buildPropertiesPanel());
        tabs.addTab("Reading Order", buildReadingOrderPanel());
        tabs.addTab("Compliance Validation", buildValidationPanel());
        panel.add(tabs, BorderLayout.CENTER);
        return panel;
    }

    private JPanel buildPropertiesPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBorder(new EmptyBorder(16, 16, 16, 16));
        panel.setBackground(SURFACE);
        typeCombo.setModel(new DefaultComboBoxModel<>(schemaRules.validTypes().stream().sorted().toArray(String[]::new)));
        actualTextArea.setLineWrap(true);
        actualTextArea.setWrapStyleWord(true);
        alternateTextArea.setLineWrap(true);
        alternateTextArea.setWrapStyleWord(true);
        addFormRow(panel, 0, "Type", typeCombo);
        addFormRow(panel, 1, "Title", titleField);
        addFormRow(panel, 2, "Actual Text", scrollText(actualTextArea));
        addFormRow(panel, 3, "Alternate Text", scrollText(alternateTextArea));
        addFormRow(panel, 4, "Language", languageCombo);

        JPanel bbox = new JPanel(new GridLayout(2, 2, 6, 6));
        bbox.setOpaque(false);
        bbox.add(xField);
        bbox.add(yField);
        bbox.add(wField);
        bbox.add(hField);
        addFormRow(panel, 5, "Bounding Box", bbox);
        return panel;
    }

    private JScrollPane scrollText(JTextArea textArea) {
        textArea.setRows(4);
        JScrollPane pane = new JScrollPane(textArea);
        pane.setPreferredSize(new Dimension(180, 75));
        return pane;
    }

    private void addFormRow(JPanel panel, int row, String label, Component component) {
        JLabel fieldLabel = new JLabel(label);
        fieldLabel.setForeground(TEXT);
        fieldLabel.setFont(fieldLabel.getFont().deriveFont(Font.PLAIN, 12f));
        GridBagConstraints labelConstraints = new GridBagConstraints();
        labelConstraints.gridx = 0;
        labelConstraints.gridy = row;
        labelConstraints.anchor = GridBagConstraints.NORTHWEST;
        labelConstraints.insets = new Insets(0, 0, 10, 10);
        panel.add(fieldLabel, labelConstraints);

        GridBagConstraints fieldConstraints = new GridBagConstraints();
        fieldConstraints.gridx = 1;
        fieldConstraints.gridy = row;
        fieldConstraints.weightx = 1.0;
        fieldConstraints.fill = GridBagConstraints.HORIZONTAL;
        fieldConstraints.insets = new Insets(0, 0, 10, 0);
        panel.add(component, fieldConstraints);
    }

    private JScrollPane buildReadingOrderPanel() {
        readingOrderList.setCellRenderer((list, value, index, selected, focused) -> {
            JLabel label = new JLabel((index + 1) + ". " + value.displayName());
            label.setOpaque(true);
            label.setPreferredSize(new Dimension(250, 32));
            label.setBorder(new EmptyBorder(0, 10, 0, 10));
            label.setBackground(selected ? ACCENT : SURFACE);
            label.setForeground(selected ? Color.WHITE : TEXT);
            return label;
        });
        readingOrderList.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        readingOrderList.addListSelectionListener((_event) -> {
            if (!syncingSelection && !readingOrderList.isSelectionEmpty()) {
                selectTag(readingOrderList.getSelectedValue());
            }
        });
        readingOrderList.setDragEnabled(true);
        readingOrderList.setDropMode(DropMode.INSERT);
        readingOrderList.setTransferHandler(new SchemaGuardedTransferHandler());
        JScrollPane pane = new JScrollPane(readingOrderList);
        pane.setBorder(BorderFactory.createEmptyBorder());
        return pane;
    }

    private JScrollPane buildValidationPanel() {
        validationTable.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        validationTable.setRowHeight(28);
        validationTable.setBackground(SURFACE);
        validationTable.setForeground(TEXT);
        validationTable.setGridColor(BORDER);
        validationTable.getTableHeader().setBackground(TOOLBAR);
        validationTable.getTableHeader().setForeground(TEXT);
        validationTable.getSelectionModel().addListSelectionListener((_event) -> {
            if (!syncingSelection && validationTable.getSelectedRow() >= 0) {
                focusValidationIssue(validationTable.getSelectedRow());
            }
        });
        validationTable.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent event) {
                if (event.getClickCount() == 2 && validationTable.getSelectedRow() >= 0) {
                    focusValidationIssue(validationTable.getSelectedRow());
                }
            }
        });
        JScrollPane pane = new JScrollPane(validationTable);
        pane.setBorder(BorderFactory.createEmptyBorder());
        return pane;
    }

    private JPanel buildStatusBar() {
        JPanel status = new JPanel(new BorderLayout());
        status.setPreferredSize(new Dimension(100, 24));
        status.setBackground(TOOLBAR);
        status.setBorder(new EmptyBorder(0, 8, 0, 8));
        statusMessage.setForeground(Color.WHITE);
        statsMessage.setForeground(Color.WHITE);
        status.add(statusMessage, BorderLayout.WEST);
        status.add(statsMessage, BorderLayout.EAST);
        return status;
    }

    private void styleSplitPane(JSplitPane splitPane) {
        splitPane.setBorder(null);
        splitPane.setDividerSize(4);
        splitPane.setBackground(BACKGROUND);
    }

    private void openPdf(ActionEvent _event) {
        JFileChooser chooser = new JFileChooser(repoRoot.toFile());
        chooser.setFileFilter(new FileNameExtensionFilter("PDF Documents", "pdf"));
        if (chooser.showOpenDialog(this) == JFileChooser.APPROVE_OPTION) {
            selectedFile = chooser.getSelectedFile();
            openDocumentAsync();
        }
    }

    private void openDocumentAsync() {
        if (selectedFile == null) {
            return;
        }
        setBusy(true, "Hydrating PDF artifacts...");
        new SwingWorker<HydratedDocument, Void>() {
            @Override
            protected HydratedDocument doInBackground() throws Exception {
                StringBuilder stdout = new StringBuilder();
                StringBuilder stderr = new StringBuilder();
                return artifactHydrator.runAndHydrate(selectedFile.toPath(), stdout, stderr);
            }

            @Override
            protected void done() {
                String message = null;
                boolean success = false;
                try {
                    installHydratedDocument(get());
                    message = "Document loaded: " + selectedFile.getName();
                    success = true;
                } catch (Exception exception) {
                    showError("Unable to load PDF", exception);
                } finally {
                    loadingBar.setVisible(false);
                    loadingBar.setIndeterminate(false);
                    if (success) {
                        setStatus(message);
                    }
                }
            }
        }.execute();
    }

    private void runValidation(ActionEvent _event) {
        if (selectedFile == null) {
            showError("Validation failed", new IllegalStateException("Open a PDF first."));
            return;
        }
        setBusy(true, "Hydrating validation artifacts...");
        new SwingWorker<HydratedDocument, Void>() {
            @Override
            protected HydratedDocument doInBackground() throws Exception {
                StringBuilder stdout = new StringBuilder();
                StringBuilder stderr = new StringBuilder();
                return artifactHydrator.runAndHydrate(selectedFile.toPath(), stdout, stderr);
            }

            @Override
            protected void done() {
                String message = null;
                boolean success = false;
                try {
                    installHydratedDocument(get());
                    message = "Validation Complete: " + validationModel.getRowCount() + " Issues Found";
                    success = true;
                } catch (Exception exception) {
                    showError("Validation failed", exception);
                } finally {
                    loadingBar.setVisible(false);
                    loadingBar.setIndeterminate(false);
                    if (success) {
                        setStatus(message);
                    }
                }
            }
        }.execute();
    }

    private void renderValidation(List<StudioValidationIssue> issues) {
        currentValidationIssues = List.copyOf(issues);
        validationTable.clearSelection();
        validationModel.setRowCount(0);
        for (StudioValidationIssue issue : issues) {
            validationModel.addRow(new Object[]{issue.severity(), issue.code(), issue.description(), issue.pageNumber(), issue.remediation()});
        }
        canvasPanel.setValidationIssues(issues);
        canvasPanel.repaint();
    }

    private void installHydratedDocument(HydratedDocument hydration) {
        currentHydration = hydration;
        documentRoot = hydration.documentRoot();
        tagTree.setModel(new DefaultTreeModel(toTreeNode(documentRoot)));
        tagTree.expandRow(0);
        tagTree.expandRow(1);
        readingOrderModel.clear();
        List<StudioTag> readingOrderTags = hydration.readingOrderTags().isEmpty() ? documentRoot.flatten() : hydration.readingOrderTags();
        for (StudioTag tag : readingOrderTags) {
            readingOrderModel.addElement(tag);
        }
        List<StudioTag> flattened = documentRoot.flatten();
        canvasPanel.setTags(flattened);
        canvasPanel.setPageCount(hydration.pageCount());
        renderValidation(hydration.validationIssues());
        statsMessage.setText("Page 1 / " + hydration.pageCount() + "  |  Total Tags: " + flattened.size());
        StudioTag initialSelection = firstFocusableTag(readingOrderTags);
        if (initialSelection == null) {
            initialSelection = firstFocusableTag(flattened);
        }
        if (initialSelection != null) {
            selectTag(initialSelection);
        }
    }

    private void installSampleDocument() {
        currentHydration = null;
        documentRoot = StudioTag.sampleDocument();
        tagTree.setModel(new DefaultTreeModel(toTreeNode(documentRoot)));
        tagTree.expandRow(0);
        tagTree.expandRow(1);
        readingOrderModel.clear();
        List<StudioTag> flattened = documentRoot.flatten();
        for (StudioTag tag : flattened) {
            if (!"Document".equals(tag.type()) && !"Sect".equals(tag.type())) {
                readingOrderModel.addElement(tag);
            }
        }
        canvasPanel.setPageCount(1);
        canvasPanel.setTags(flattened);
        renderValidation(List.of());
        statsMessage.setText("Page 1 / 1  |  Total Tags: " + flattened.size());
        StudioTag initialSelection = firstFocusableTag(flattened);
        if (initialSelection != null) {
            selectTag(initialSelection);
        }
    }

    private StudioTag firstFocusableTag(List<StudioTag> tags) {
        for (StudioTag tag : tags) {
            if (!"Document".equals(tag.type()) && !"Sect".equals(tag.type())) {
                return tag;
            }
        }
        return tags.isEmpty() ? null : tags.get(0);
    }

    private DefaultMutableTreeNode toTreeNode(StudioTag tag) {
        DefaultMutableTreeNode node = new DefaultMutableTreeNode(tag);
        for (StudioTag child : tag.children()) {
            node.add(toTreeNode(child));
        }
        return node;
    }

    private void selectTagFromTree() {
        if (syncingSelection) {
            return;
        }
        TreePath path = tagTree.getSelectionPath();
        if (path == null) {
            return;
        }
        Object value = ((DefaultMutableTreeNode) path.getLastPathComponent()).getUserObject();
        if (value instanceof StudioTag tag) {
            selectTag(tag);
        }
    }

    private void selectTag(StudioTag tag) {
        if (tag == null) {
            return;
        }
        syncingSelection = true;
        try {
            canvasPanel.setCurrentPage(tag.pageNumber());
            canvasPanel.setSelectedTag(tag);
            titleField.setText(tag.label());
            typeCombo.setSelectedItem(tag.type());
            actualTextArea.setText(tag.actualText());
            alternateTextArea.setText(tag.alternateText());
            Rectangle2D.Double bounds = tag.pdfBounds();
            xField.setText(String.format(Locale.ROOT, "%.1f", bounds.x));
            yField.setText(String.format(Locale.ROOT, "%.1f", bounds.y));
            wField.setText(String.format(Locale.ROOT, "%.1f", bounds.width));
            hField.setText(String.format(Locale.ROOT, "%.1f", bounds.height));
            selectTreeNode(tag);
            selectReadingOrderTag(tag);
        } finally {
            syncingSelection = false;
        }
        setStatus("Selected " + tag.displayName());
    }

    private void selectTreeNode(StudioTag tag) {
        DefaultMutableTreeNode rootNode = (DefaultMutableTreeNode) tagTree.getModel().getRoot();
        DefaultMutableTreeNode match = findTreeNode(rootNode, tag.id());
        if (match != null) {
            tagTree.setSelectionPath(new TreePath(match.getPath()));
        }
    }

    private void selectReadingOrderTag(StudioTag tag) {
        int index = -1;
        for (int row = 0; row < readingOrderModel.size(); row += 1) {
            if (readingOrderModel.get(row).id().equals(tag.id())) {
                index = row;
                break;
            }
        }
        if (index >= 0) {
            readingOrderList.setSelectedIndex(index);
            readingOrderList.ensureIndexIsVisible(index);
        }
    }

    private void focusValidationIssue(int row) {
        if (row < 0 || row >= currentValidationIssues.size()) {
            return;
        }
        StudioValidationIssue issue = currentValidationIssues.get(row);
        if (!issue.targetTagIds().isEmpty()) {
            StudioTag tag = findTagById(issue.targetTagIds().get(0));
            if (tag != null) {
                selectTag(tag);
                return;
            }
        }
        setStatus(issue.remediation());
    }

    private DefaultMutableTreeNode findTreeNode(DefaultMutableTreeNode node, String tagId) {
        Object userObject = node.getUserObject();
        if (userObject instanceof StudioTag tag && tag.id().equals(tagId)) {
            return node;
        }
        for (int index = 0; index < node.getChildCount(); index += 1) {
            DefaultMutableTreeNode match = findTreeNode((DefaultMutableTreeNode) node.getChildAt(index), tagId);
            if (match != null) {
                return match;
            }
        }
        return null;
    }

    private StudioTag findTagById(String tagId) {
        if (tagId == null) {
            return null;
        }
        for (StudioTag tag : documentRoot.flatten()) {
            if (tag.id().equals(tagId)) {
                return tag;
            }
        }
        return null;
    }

    private void setBusy(boolean busy, String message) {
        loadingBar.setVisible(busy);
        loadingBar.setIndeterminate(busy);
        setStatus(message);
    }

    private void setStatus(String message) {
        statusMessage.setText(message);
        if (statusMessage.getParent() != null) {
            statusMessage.getParent().setBackground(message.contains("Validation Complete") ? ACCENT : TOOLBAR);
        }
    }

    private void showError(String title, Exception exception) {
        setStatus(title + ": " + exception.getMessage());
        JOptionPane.showMessageDialog(this, exception.getMessage(), title, JOptionPane.ERROR_MESSAGE);
    }

    private static TagSchemaRules loadSchemaRules(Path repoRoot) {
        try {
            Path containmentContract = repoRoot.resolve("contracts").resolve("tag-containment.schema.json");
            Path contractPath = Files.isRegularFile(containmentContract)
                    ? containmentContract
                    : TagSchemaRules.defaultContractPath(repoRoot);
            return TagSchemaRules.fromContract(contractPath);
        } catch (Exception exception) {
            throw new IllegalStateException("Unable to load tagging schema rules", exception);
        }
    }

    public static void main(String[] args) {
        if (List.of(args).contains("--headless")) {
            try {
                PerfectStudioHeadlessRunner.HeadlessOptions options = PerfectStudioHeadlessRunner.parseArgs(args);
                PerfectStudioHeadlessRunner runner = new PerfectStudioHeadlessRunner(
                        PerfectStudioHeadlessRunner.discoverRepoRoot(),
                        new PerfectStudioHeadlessRunner.ProcessCommandExecutor());
                PerfectStudioHeadlessRunner.HeadlessResult result = runner.run(options, System.out, System.err);
                System.out.println(PerfectStudioHeadlessRunner.toJson(result));
            } catch (Exception exception) {
                System.err.println(exception.getMessage());
                System.exit(1);
            }
            return;
        }

        SwingUtilities.invokeLater(() -> new PerfectStudioSwingApp(PerfectStudioHeadlessRunner.discoverRepoRoot()).setVisible(true));
    }

    private final class SchemaGuardedTransferHandler extends TransferHandler {
        private int dragSourceIndex = -1;

        @Override
        protected Transferable createTransferable(JComponent component) {
            dragSourceIndex = readingOrderList.getSelectedIndex();
            StudioTag tag = dragSourceIndex >= 0 && dragSourceIndex < readingOrderModel.size()
                    ? readingOrderModel.getElementAt(dragSourceIndex)
                    : null;
            return new StringSelection(tag == null ? "" : tag.id());
        }

        @Override
        public int getSourceActions(JComponent component) {
            return MOVE;
        }

        @Override
        public boolean canImport(TransferSupport support) {
            if (!support.isDrop() || !support.isDataFlavorSupported(DataFlavor.stringFlavor)) {
                return false;
            }
            if (!(support.getDropLocation() instanceof JList.DropLocation dropLocation)) {
                return false;
            }
            if (dragSourceIndex < 0 || dragSourceIndex >= readingOrderModel.size()) {
                return false;
            }
            try {
                StudioTag dragged = readingOrderModel.getElementAt(dragSourceIndex);
                StudioTag target = dropTargetFor(dropLocation.getIndex(), dragSourceIndex);
                if (target == null) {
                    return false;
                }
                boolean allowed = schemaRules.isDropAllowed(target.type(), dragged.type());
                readingOrderList.setToolTipText(allowed ? null : schemaRules.explainDrop(target.type(), dragged.type()));
                return allowed;
            } catch (Exception exception) {
                return false;
            }
        }

        @Override
        public boolean importData(TransferSupport support) {
            if (!canImport(support)) {
                return false;
            }
            JList.DropLocation dropLocation = (JList.DropLocation) support.getDropLocation();
            int targetIndex = dropLocation.getIndex();
            if (dragSourceIndex < 0 || dragSourceIndex >= readingOrderModel.size()) {
                return false;
            }
            StudioTag dragged = readingOrderModel.getElementAt(dragSourceIndex);
            int insertIndex = targetIndex;
            if (dragSourceIndex < insertIndex) {
                insertIndex -= 1;
            }
            if (insertIndex == dragSourceIndex) {
                return true;
            }
            readingOrderModel.remove(dragSourceIndex);
            insertIndex = Math.max(0, Math.min(insertIndex, readingOrderModel.size()));
            readingOrderModel.add(insertIndex, dragged);
            syncingSelection = true;
            try {
                readingOrderList.setSelectedIndex(insertIndex);
                readingOrderList.ensureIndexIsVisible(insertIndex);
            } finally {
                syncingSelection = false;
            }
            selectTag(dragged);
            dragSourceIndex = -1;
            return true;
        }

        @Override
        protected void exportDone(JComponent source, Transferable data, int action) {
            dragSourceIndex = -1;
            readingOrderList.setToolTipText(null);
        }

        private StudioTag dropTargetFor(int dropIndex, int sourceIndex) {
            if (readingOrderModel.isEmpty()) {
                return null;
            }
            if (dropIndex <= 0) {
                return readingOrderModel.getElementAt(0);
            }
            if (dropIndex >= readingOrderModel.size()) {
                return readingOrderModel.getElementAt(readingOrderModel.size() - 1);
            }
            if (dropIndex == sourceIndex || dropIndex == sourceIndex + 1) {
                return readingOrderModel.getElementAt(sourceIndex);
            }
            return readingOrderModel.getElementAt(dropIndex);
        }
    }

    private static final class CanvasWorkspace extends JLayeredPane {
        private final PdfCanvasPanel canvas;
        private final JPanel controls;

        private CanvasWorkspace(PdfCanvasPanel canvas) {
            this.canvas = canvas;
            this.controls = buildZoomControls(canvas);
            add(canvas, Integer.valueOf(0));
            add(controls, Integer.valueOf(1));
        }

        @Override
        public void doLayout() {
            canvas.setBounds(0, 0, getWidth(), getHeight());
            controls.setBounds(Math.max(16, getWidth() - 156), Math.max(16, getHeight() - 56), 140, 40);
        }

        private static JPanel buildZoomControls(PdfCanvasPanel canvas) {
            JPanel panel = new JPanel(new FlowLayout(FlowLayout.CENTER, 8, 5)) {
                @Override
                protected void paintComponent(Graphics graphics) {
                    Graphics2D g2 = (Graphics2D) graphics.create();
                    g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                    g2.setComposite(AlphaComposite.SrcOver.derive(0.82f));
                    g2.setColor(TOOLBAR);
                    g2.fillRoundRect(0, 0, getWidth(), getHeight(), 40, 40);
                    g2.dispose();
                    super.paintComponent(graphics);
                }
            };
            panel.setOpaque(false);
            JButton minus = zoomButton("-");
            JButton plus = zoomButton("+");
            JLabel value = new JLabel("100%");
            value.setForeground(Color.WHITE);
            value.setHorizontalAlignment(SwingConstants.CENTER);
            value.setPreferredSize(new Dimension(52, 28));
            minus.addActionListener((_event) -> {
                canvas.changeZoom(-0.1);
                value.setText(canvas.zoomPercent());
            });
            plus.addActionListener((_event) -> {
                canvas.changeZoom(0.1);
                value.setText(canvas.zoomPercent());
            });
            panel.add(minus);
            panel.add(value);
            panel.add(plus);
            return panel;
        }

        private static JButton zoomButton(String label) {
            JButton button = new JButton(label);
            button.setPreferredSize(new Dimension(30, 28));
            button.setFocusPainted(false);
            button.setForeground(Color.WHITE);
            button.setBackground(TOOLBAR);
            return button;
        }
    }

    private static final class PdfCanvasPanel extends JPanel {
        private final SoftPageImageCache imageCache = new SoftPageImageCache(3);
        private final TagSpatialIndex spatialIndex = new TagSpatialIndex();
        private final Timer resizeDebounce;
        private List<StudioTag> tags = List.of();
        private List<StudioValidationIssue> validationIssues = List.of();
        private StudioTag selectedTag;
        private VolatileImage buffer;
        private double zoom = 1.0;
        private boolean xrayMode;
        private int currentPage = 1;
        private int pageCount = 1;
        private java.util.function.Consumer<StudioTag> remediationFocus = (_tag) -> {};

        private PdfCanvasPanel() {
            setBackground(BACKGROUND);
            setFocusable(true);
            setToolTipText("");
            resizeDebounce = new Timer(200, (_event) -> {
                buffer = null;
                repaint();
            });
            resizeDebounce.setRepeats(false);
            addComponentListener(new ComponentAdapter() {
                @Override
                public void componentResized(ComponentEvent event) {
                    resizeDebounce.restart();
                }
            });
            addMouseMotionListener(new MouseMotionAdapter() {
                @Override
                public void mouseMoved(MouseEvent event) {
                    StudioTag hit = hitTag(event);
                    setCursor(hit == null ? Cursor.getDefaultCursor() : Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                    setToolTipText(hit == null ? null : tooltipFor(hit));
                }
            });
            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent event) {
                    StudioTag hit = hitTag(event);
                    if (hit != null) {
                        selectedTag = hit;
                        repaint();
                    }
                    if (event.getClickCount() == 2 && hit != null && hit.validationError()) {
                        remediationFocus.accept(hit);
                    }
                    requestFocusInWindow();
                }
            });
            addKeyListener(new KeyAdapter() {
                @Override
                public void keyPressed(KeyEvent event) {
                    if (event.getKeyCode() == KeyEvent.VK_SPACE || event.getKeyCode() == KeyEvent.VK_ALT) {
                        xrayMode = true;
                        repaint();
                    }
                }

                @Override
                public void keyReleased(KeyEvent event) {
                    if (event.getKeyCode() == KeyEvent.VK_SPACE || event.getKeyCode() == KeyEvent.VK_ALT) {
                        xrayMode = false;
                        repaint();
                    }
                }
            });
        }

        private void setRemediationFocus(java.util.function.Consumer<StudioTag> remediationFocus) {
            this.remediationFocus = remediationFocus == null ? (_tag) -> {} : remediationFocus;
        }

        private void setTags(List<StudioTag> tags) {
            this.tags = List.copyOf(tags);
            spatialIndex.rebuild(this.tags);
            selectedTag = this.tags.isEmpty() ? null : this.tags.get(0);
            currentPage = selectedTag == null ? 1 : selectedTag.pageNumber();
            imageCache.retainAround(currentPage);
            repaint();
        }

        private void setSelectedTag(StudioTag tag) {
            selectedTag = tag;
            if (tag != null) {
                currentPage = tag.pageNumber();
                imageCache.retainAround(currentPage);
            }
            repaint();
        }

        private void setValidationIssues(List<StudioValidationIssue> validationIssues) {
            this.validationIssues = List.copyOf(validationIssues);
        }

        private void setCurrentPage(int pageNumber) {
            currentPage = Math.max(1, Math.min(pageCount, pageNumber));
            imageCache.retainAround(currentPage);
            repaint();
        }

        private void setPageCount(int pageCount) {
            this.pageCount = Math.max(1, pageCount);
            currentPage = Math.max(1, Math.min(currentPage, this.pageCount));
        }

        private void changeZoom(double delta) {
            zoom = Math.max(0.25, Math.min(3.0, zoom + delta));
            buffer = null;
            repaint();
        }

        private String zoomPercent() {
            return Math.round(zoom * 100) + "%";
        }

        @Override
        protected void paintComponent(Graphics graphics) {
            super.paintComponent(graphics);
            if (getWidth() <= 0 || getHeight() <= 0) {
                return;
            }
            GraphicsConfiguration configuration = getGraphicsConfiguration();
            if (buffer == null || buffer.getWidth() != getWidth() || buffer.getHeight() != getHeight()) {
                buffer = createBuffer(configuration);
            }
            do {
                int validation = buffer.validate(configuration);
                if (validation == VolatileImage.IMAGE_INCOMPATIBLE) {
                    buffer.flush();
                    buffer = createBuffer(configuration);
                }
                Graphics2D g2 = buffer.createGraphics();
                paintScene(g2);
                g2.dispose();
                graphics.drawImage(buffer, 0, 0, null);
            } while (buffer.contentsLost());
        }

        private void paintScene(Graphics2D g2) {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setColor(BACKGROUND);
            g2.fillRect(0, 0, getWidth(), getHeight());
            CoordinateMapper mapper = mapper();
            Rectangle2D.Double page = new Rectangle2D.Double(
                    (getWidth() - mapper.pageWidthPixels()) / 2.0,
                    32,
                    mapper.pageWidthPixels(),
                    mapper.pageHeightPixels());
            g2.setColor(new Color(0, 0, 0, 120));
            g2.fillRect((int) page.x + 6, (int) page.y + 8, (int) page.width, (int) page.height);
            g2.drawImage(pageBackdropFor(currentPage), (int) page.x, (int) page.y, (int) page.width, (int) page.height, null);
            g2.setColor(Color.BLACK);
            g2.draw(page);
            drawOverlays(g2, mapper);
        }

        private VolatileImage createBuffer(GraphicsConfiguration configuration) {
            if (configuration != null) {
                return configuration.createCompatibleVolatileImage(getWidth(), getHeight(), Transparency.TRANSLUCENT);
            }
            return createVolatileImage(getWidth(), getHeight());
        }

        private void drawOverlays(Graphics2D g2, CoordinateMapper mapper) {
            Stroke originalStroke = g2.getStroke();
            if (xrayMode) {
                g2.setComposite(AlphaComposite.SrcOver.derive(0.95f));
            }
            for (StudioTag tag : tags) {
                if (tag.pageNumber() != currentPage || "Document".equals(tag.type())) {
                    continue;
                }
                Rectangle2D.Double rect = mapper.toScreen(tag.pdfBounds());
                Color color = semanticColor(tag.type());
                g2.setColor(new Color(color.getRed(), color.getGreen(), color.getBlue(), xrayMode ? 110 : 28));
                g2.fill(rect);
                g2.setColor(new Color(color.getRed(), color.getGreen(), color.getBlue(), xrayMode ? 255 : 150));
                g2.setStroke(new BasicStroke(tag == selectedTag ? 2f : 1f));
                g2.draw(rect);
                if (tag.validationError() || validationIssues.stream().anyMatch((issue) -> issue.affectsTag(tag.id()))) {
                    drawErrorHatch(g2, rect);
                }
                if (tag == selectedTag) {
                    drawHandles(g2, rect);
                }
            }
            g2.setStroke(originalStroke);
            g2.setComposite(AlphaComposite.SrcOver);
        }

        private void drawErrorHatch(Graphics2D g2, Rectangle2D rect) {
            Graphics2D copy = (Graphics2D) g2.create();
            copy.setClip(rect);
            copy.setColor(new Color(PerfectStudioSwingApp.ERROR.getRed(), PerfectStudioSwingApp.ERROR.getGreen(), PerfectStudioSwingApp.ERROR.getBlue(), 90));
            for (int x = (int) rect.getX() - 80; x < rect.getMaxX() + 80; x += 10) {
                copy.drawLine(x, (int) rect.getMaxY(), x + 80, (int) rect.getY());
            }
            copy.dispose();
        }

        private void drawHandles(Graphics2D g2, Rectangle2D rect) {
            g2.setColor(Color.WHITE);
            double[][] points = {
                    {rect.getX(), rect.getY()},
                    {rect.getCenterX(), rect.getY()},
                    {rect.getMaxX(), rect.getY()},
                    {rect.getMaxX(), rect.getCenterY()},
                    {rect.getMaxX(), rect.getMaxY()},
                    {rect.getCenterX(), rect.getMaxY()},
                    {rect.getX(), rect.getMaxY()},
                    {rect.getX(), rect.getCenterY()}
            };
            for (double[] point : points) {
                g2.fill(new Rectangle2D.Double(point[0] - 3, point[1] - 3, 6, 6));
            }
        }

        private CoordinateMapper mapper() {
            double pageWidth = 612;
            double pageHeight = 792;
            double scale = 1.0;
            GraphicsConfiguration configuration = getGraphicsConfiguration();
            if (configuration != null) {
                scale = configuration.getDefaultTransform().getScaleX();
            }
            double pagePixelWidth = pageWidth * zoom * scale;
            double paddingX = Math.max(16, (getWidth() - pagePixelWidth) / 2.0);
            return new CoordinateMapper(pageWidth, pageHeight, zoom, paddingX, 32, 0, 0, scale);
        }

        private StudioTag hitTag(MouseEvent event) {
            Point2D.Double pdfPoint = mapper().toPdf(event.getPoint());
            return spatialIndex.hitTest(currentPage, pdfPoint).orElse(null);
        }

        private String tooltipFor(StudioTag tag) {
            if (tag.validationError()) {
                return "<html><b>" + tag.displayName() + "</b><br>WCAG 2.1 AA: Figure requires alternate text.</html>";
            }
            return tag.displayName();
        }

        private Color semanticColor(String type) {
            if (type.startsWith("H") || "Title".equals(type)) {
                return ACCENT;
            }
            return switch (type) {
                case "Table", "TR", "TH", "TD" -> new Color(0x9C27B0);
                case "P", "Span" -> new Color(0x43A047);
                case "L", "LI" -> new Color(0xFB8C00);
                case "Figure" -> new Color(0x00ACC1);
                default -> ACCENT;
            };
        }

        private BufferedImage pageBackdropFor(int pageNumber) {
            BufferedImage cached = imageCache.get(pageNumber);
            if (cached != null) {
                return cached;
            }
            BufferedImage image = new BufferedImage(612, 792, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g2 = image.createGraphics();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setColor(Color.WHITE);
            g2.fillRoundRect(0, 0, image.getWidth(), image.getHeight(), 8, 8);
            g2.setColor(new Color(0xE5E5E5));
            for (int y = 48; y < image.getHeight() - 32; y += 64) {
                g2.drawLine(24, y, image.getWidth() - 24, y);
            }
            g2.setColor(new Color(0xB0B0B0));
            g2.drawString("Page " + pageNumber, 24, image.getHeight() - 20);
            g2.dispose();
            imageCache.put(pageNumber, image);
            return image;
        }
    }

    private static final class TagTreeRenderer extends JPanel implements TreeCellRenderer {
        private final JLabel label = new JLabel();
        private StudioTag tag;

        private TagTreeRenderer() {
            super(new BorderLayout());
            setOpaque(true);
            label.setBorder(new EmptyBorder(0, 4, 0, 18));
            add(label, BorderLayout.CENTER);
        }

        @Override
        public Component getTreeCellRendererComponent(
                JTree tree,
                Object value,
                boolean selected,
                boolean expanded,
                boolean leaf,
                int row,
                boolean hasFocus) {
            Object userObject = ((DefaultMutableTreeNode) value).getUserObject();
            tag = userObject instanceof StudioTag studioTag ? studioTag : null;
            label.setText(tag == null ? String.valueOf(userObject) : tag.displayName());
            label.setIcon(new StudioIcon(tag == null ? "tag" : tag.type(), 16, tag == null ? ACCENT : colorFor(tag.type())));
            label.setForeground(selected ? Color.WHITE : TEXT);
            label.setFont(label.getFont().deriveFont(isStructural(tag) ? Font.BOLD : Font.PLAIN, 13f));
            setBackground(selected ? ACCENT : SURFACE);
            return this;
        }

        @Override
        protected void paintComponent(Graphics graphics) {
            super.paintComponent(graphics);
            if (tag == null) {
                return;
            }
            Graphics2D g2 = (Graphics2D) graphics.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setColor(tag.validationError() ? PerfectStudioSwingApp.ERROR : PASS);
            int y = getHeight() / 2 - 3;
            g2.fill(new Ellipse2D.Double(getWidth() - 10, y, 6, 6));
            g2.dispose();
        }

        private static boolean isStructural(StudioTag tag) {
            return tag != null && ("Sect".equals(tag.type()) || "Document".equals(tag.type()));
        }

        private static Color colorFor(String type) {
            if (type == null) {
                return ACCENT;
            }
            if (type.startsWith("H")) {
                return ACCENT;
            }
            return switch (type) {
                case "Figure" -> new Color(0x00ACC1);
                case "Table", "TR", "TH", "TD" -> new Color(0x9C27B0);
                case "P", "Span" -> new Color(0x43A047);
                default -> ACCENT;
            };
        }
    }

    private static final class StudioIcon implements Icon {
        private final String symbol;
        private final int size;
        private final Color color;

        private StudioIcon(String symbol, int size, Color color) {
            this.symbol = symbol == null ? "tag" : symbol;
            this.size = size;
            this.color = color;
        }

        @Override
        public int getIconWidth() {
            return size;
        }

        @Override
        public int getIconHeight() {
            return size;
        }

        @Override
        public void paintIcon(Component component, Graphics graphics, int x, int y) {
            Graphics2D g2 = (Graphics2D) graphics.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setColor(color);
            String normalized = symbol.toLowerCase(Locale.ROOT);
            if (normalized.contains("open")) {
                g2.drawRect(x + 2, y + 5, size - 4, size - 7);
                g2.drawLine(x + 2, y + 5, x + 7, y + 2);
                g2.drawLine(x + 7, y + 2, x + size - 3, y + 2);
            } else if (normalized.contains("save")) {
                g2.drawRect(x + 3, y + 2, size - 6, size - 4);
                g2.fillRect(x + 5, y + size - 6, size - 10, 3);
            } else if (normalized.contains("wand")) {
                g2.drawLine(x + 3, y + size - 3, x + size - 3, y + 3);
                g2.fillOval(x + size - 5, y + 1, 4, 4);
            } else if (normalized.contains("validate")) {
                g2.drawOval(x + 2, y + 2, size - 4, size - 4);
                g2.drawLine(x + 5, y + size / 2, x + size / 2 - 1, y + size - 5);
                g2.drawLine(x + size / 2 - 1, y + size - 5, x + size - 4, y + 5);
            } else if (normalized.contains("undo") || normalized.contains("redo")) {
                int direction = normalized.contains("undo") ? -1 : 1;
                int start = direction < 0 ? x + size - 4 : x + 4;
                int end = direction < 0 ? x + 4 : x + size - 4;
                g2.drawArc(Math.min(start, end), y + 4, size - 8, size - 8, direction < 0 ? 40 : 140, 250);
                g2.drawLine(end, y + size / 2, end + direction * 4, y + size / 2 - 4);
            } else if (normalized.contains("figure")) {
                g2.drawRect(x + 2, y + 3, size - 4, size - 6);
                g2.drawLine(x + 4, y + size - 5, x + size / 2, y + size / 2);
                g2.drawLine(x + size / 2, y + size / 2, x + size - 4, y + size - 5);
            } else if (normalized.contains("table") || normalized.equals("tr") || normalized.equals("td") || normalized.equals("th")) {
                g2.drawRect(x + 2, y + 3, size - 4, size - 6);
                g2.drawLine(x + 2, y + size / 2, x + size - 2, y + size / 2);
                g2.drawLine(x + size / 2, y + 3, x + size / 2, y + size - 3);
            } else {
                g2.drawRoundRect(x + 2, y + 3, size - 4, size - 6, 3, 3);
                g2.drawLine(x + 5, y + 6, x + size - 5, y + 6);
                g2.drawLine(x + 5, y + 10, x + size - 6, y + 10);
            }
            g2.dispose();
        }
    }

    private static final class StudioTheme {
        private static void install() {
            System.setProperty("awt.useSystemAAFontSettings", "on");
            System.setProperty("swing.aatext", "true");
            try {
                Class<?> flatDarkLaf = Class.forName("com.formdev.flatlaf.FlatDarkLaf");
                flatDarkLaf.getMethod("setup").invoke(null);
            } catch (Exception ignored) {
                try {
                    UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
                } catch (Exception ignoredAgain) {
                    // Swing defaults remain usable in minimal JDK-only test environments.
                }
            }
            Font font = new Font("Inter", Font.PLAIN, 13);
            if (!"Inter".equals(font.getFamily())) {
                font = new Font("Roboto", Font.PLAIN, 13);
            }
            UIManager.put("defaultFont", font);
            UIManager.put("Panel.background", SURFACE);
            UIManager.put("MenuBar.background", TOOLBAR);
            UIManager.put("Menu.selectionBackground", new Color(0x444444));
            UIManager.put("ToolTip.background", TOOLBAR);
            UIManager.put("ToolTip.foreground", TEXT);
            UIManager.put("Popup.dropShadowPainted", Boolean.TRUE);
        }
    }
}
