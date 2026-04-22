package buildeverything.servlet;

import java.awt.geom.Rectangle2D;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Immutable logical tag model used by the Perfect Studio UI helpers.
 */
public final class StudioTag {
    private final String id;
    private final String type;
    private final String label;
    private final int pageNumber;
    private final Rectangle2D.Double pdfBounds;
    private final String actualText;
    private final String alternateText;
    private final boolean validationError;
    private final List<StudioTag> children;

    public StudioTag(
            String id,
            String type,
            String label,
            int pageNumber,
            Rectangle2D.Double pdfBounds,
            String actualText,
            String alternateText,
            boolean validationError,
            List<StudioTag> children) {
        this.id = requireText(id, "id");
        this.type = requireText(type, "type");
        this.label = label == null || label.isBlank() ? type : label;
        this.pageNumber = Math.max(1, pageNumber);
        this.pdfBounds = copyBounds(Objects.requireNonNull(pdfBounds, "pdfBounds"));
        this.actualText = actualText == null ? "" : actualText;
        this.alternateText = alternateText == null ? "" : alternateText;
        this.validationError = validationError;
        this.children = Collections.unmodifiableList(new ArrayList<>(children == null ? List.of() : children));
    }

    public StudioTag(String id, String type, String label, int pageNumber, Rectangle2D.Double pdfBounds) {
        this(id, type, label, pageNumber, pdfBounds, "", "", false, List.of());
    }

    public String id() {
        return id;
    }

    public String type() {
        return type;
    }

    public String label() {
        return label;
    }

    public int pageNumber() {
        return pageNumber;
    }

    public Rectangle2D.Double pdfBounds() {
        return copyBounds(pdfBounds);
    }

    public String actualText() {
        return actualText;
    }

    public String alternateText() {
        return alternateText;
    }

    public boolean validationError() {
        return validationError;
    }

    public List<StudioTag> children() {
        return children;
    }

    public String displayName() {
        String suffix = label.equals(type) ? "" : " - " + label;
        return "<" + type + ">" + suffix;
    }

    public List<StudioTag> flatten() {
        List<StudioTag> flattened = new ArrayList<>();
        appendFlattened(this, flattened);
        return flattened;
    }

    public static StudioTag sampleDocument() {
        StudioTag heading = new StudioTag(
                "h1-1",
                "H1",
                "Autonics TK Series",
                1,
                new Rectangle2D.Double(72, 705, 350, 30),
                "Autonics TK Series",
                "",
                false,
                List.of());
        StudioTag paragraph = new StudioTag(
                "p-1",
                "P",
                "Temperature controller overview",
                1,
                new Rectangle2D.Double(72, 640, 420, 54),
                "Temperature controller overview and operating notes.",
                "",
                false,
                List.of());
        StudioTag figure = new StudioTag(
                "fig-1",
                "Figure",
                "Control panel diagram",
                1,
                new Rectangle2D.Double(92, 420, 210, 140),
                "",
                "",
                true,
                List.of());
        StudioTag tableCell = new StudioTag(
                "td-1",
                "TD",
                "Value",
                1,
                new Rectangle2D.Double(350, 360, 120, 28),
                "Value",
                "",
                false,
                List.of());
        StudioTag row = new StudioTag(
                "tr-1",
                "TR",
                "Specification row",
                1,
                new Rectangle2D.Double(330, 360, 260, 28),
                "",
                "",
                false,
                List.of(tableCell));
        StudioTag table = new StudioTag(
                "table-1",
                "Table",
                "Model specifications",
                1,
                new Rectangle2D.Double(330, 330, 260, 120),
                "",
                "",
                false,
                List.of(row));
        StudioTag section = new StudioTag(
                "sect-1",
                "Sect",
                "Page 1 structure",
                1,
                new Rectangle2D.Double(48, 300, 560, 455),
                "",
                "",
                false,
                List.of(heading, paragraph, figure, table));
        return new StudioTag(
                "doc-1",
                "Document",
                "Autonics-TK-manual.pdf",
                1,
                new Rectangle2D.Double(0, 0, 612, 792),
                "",
                "",
                false,
                List.of(section));
    }

    private static void appendFlattened(StudioTag tag, List<StudioTag> flattened) {
        flattened.add(tag);
        for (StudioTag child : tag.children) {
            appendFlattened(child, flattened);
        }
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }

    private static Rectangle2D.Double copyBounds(Rectangle2D.Double bounds) {
        return new Rectangle2D.Double(bounds.x, bounds.y, bounds.width, bounds.height);
    }
}
