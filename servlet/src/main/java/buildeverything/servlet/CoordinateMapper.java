package buildeverything.servlet;

import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;

/**
 * Converts PDF point-space boxes, whose origin is bottom-left, into Swing
 * viewport pixel-space boxes, whose origin is top-left.
 */
public final class CoordinateMapper {
    private final double pageWidthPoints;
    private final double pageHeightPoints;
    private final double zoom;
    private final double paddingX;
    private final double paddingY;
    private final double scrollX;
    private final double scrollY;
    private final double deviceScaleFactor;

    public CoordinateMapper(
            double pageWidthPoints,
            double pageHeightPoints,
            double zoom,
            double paddingX,
            double paddingY,
            double scrollX,
            double scrollY,
            double deviceScaleFactor) {
        this.pageWidthPoints = positive(pageWidthPoints, "pageWidthPoints");
        this.pageHeightPoints = positive(pageHeightPoints, "pageHeightPoints");
        this.zoom = positive(zoom, "zoom");
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.scrollX = scrollX;
        this.scrollY = scrollY;
        this.deviceScaleFactor = positive(deviceScaleFactor, "deviceScaleFactor");
    }

    public Rectangle2D.Double toScreen(Rectangle2D.Double pdfBox) {
        double scale = scale();
        double x = paddingX + pdfBox.x * scale - scrollX;
        double y = paddingY + (pageHeightPoints - pdfBox.y - pdfBox.height) * scale - scrollY;
        return new Rectangle2D.Double(x, y, pdfBox.width * scale, pdfBox.height * scale);
    }

    public Rectangle2D.Double toPdf(Rectangle2D.Double screenBox) {
        double scale = scale();
        double x = (screenBox.x + scrollX - paddingX) / scale;
        double height = screenBox.height / scale;
        double y = pageHeightPoints - ((screenBox.y + scrollY - paddingY) / scale) - height;
        return new Rectangle2D.Double(x, y, screenBox.width / scale, height);
    }

    public Point2D.Double toPdf(Point2D screenPoint) {
        double scale = scale();
        double x = (screenPoint.getX() + scrollX - paddingX) / scale;
        double y = pageHeightPoints - ((screenPoint.getY() + scrollY - paddingY) / scale);
        return new Point2D.Double(x, y);
    }

    public double pageWidthPixels() {
        return pageWidthPoints * scale();
    }

    public double pageHeightPixels() {
        return pageHeightPoints * scale();
    }

    public double scale() {
        return zoom * deviceScaleFactor;
    }

    private static double positive(double value, String name) {
        if (!Double.isFinite(value) || value <= 0) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return value;
    }
}
