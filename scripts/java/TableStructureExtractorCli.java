import java.awt.geom.Point2D;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;

public class TableStructureExtractorCli {
    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String pdfPath = requireOption(options, "--pdf");

        try (PDDocument document = Loader.loadPDF(new File(pdfPath))) {
            Map<String, Object> result = new LinkedHashMap<>();
            List<Map<String, Object>> pages = new ArrayList<>();

            int pageNumber = 1;
            for (PDPage page : document.getPages()) {
                GeometryCollector collector = new GeometryCollector(page);
                collector.processPage(page);
                pages.add(collector.toPageResult(pageNumber));
                pageNumber += 1;
            }

            result.put("pdfPath", new File(pdfPath).getAbsolutePath());
            result.put("pageCount", document.getNumberOfPages());
            result.put("pages", pages);
            System.out.println(toJson(result));
        }
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> options = new LinkedHashMap<>();
        for (int index = 0; index < args.length - 1; index += 2) {
            options.put(args[index], args[index + 1]);
        }
        return options;
    }

    private static String requireOption(Map<String, String> options, String name) {
        String value = options.get(name);
        if (value == null || value.isEmpty()) {
            throw new IllegalArgumentException("Missing required option " + name);
        }
        return value;
    }

    private static class LineSegment {
        double x1;
        double y1;
        double x2;
        double y2;
        double lineWidth;
        String orientation;
    }

    private static class GeometryCollector extends PDFGraphicsStreamEngine {
        private final PDPage page;
        private final List<LineSegment> strokedSegments = new ArrayList<>();
        private final List<LineSegment> currentPathSegments = new ArrayList<>();
        private Point2D currentPoint;
        private Point2D subpathStart;

        GeometryCollector(PDPage page) {
            super(page);
            this.page = page;
        }

        @Override
        public void appendRectangle(Point2D p0, Point2D p1, Point2D p2, Point2D p3) {
            addSegment(p0, p1);
            addSegment(p1, p2);
            addSegment(p2, p3);
            addSegment(p3, p0);
            currentPoint = p0;
            subpathStart = p0;
        }

        @Override
        public void drawImage(PDImage image) {
        }

        @Override
        public void clip(int windingRule) {
        }

        @Override
        public void moveTo(float x, float y) {
            currentPoint = new Point2D.Float(x, y);
            subpathStart = currentPoint;
        }

        @Override
        public void lineTo(float x, float y) {
            Point2D nextPoint = new Point2D.Float(x, y);
            addSegment(currentPoint, nextPoint);
            currentPoint = nextPoint;
        }

        @Override
        public void curveTo(float x1, float y1, float x2, float y2, float x3, float y3) {
            currentPoint = new Point2D.Float(x3, y3);
        }

        @Override
        public Point2D getCurrentPoint() {
            return currentPoint;
        }

        @Override
        public void closePath() {
            if (currentPoint != null && subpathStart != null) {
                addSegment(currentPoint, subpathStart);
                currentPoint = subpathStart;
            }
        }

        @Override
        public void endPath() {
            clearCurrentPath();
        }

        @Override
        public void strokePath() {
            flushCurrentPath();
        }

        @Override
        public void fillPath(int windingRule) {
            clearCurrentPath();
        }

        @Override
        public void fillAndStrokePath(int windingRule) {
            flushCurrentPath();
        }

        @Override
        public void shadingFill(COSName shadingName) {
        }

        private void addSegment(Point2D start, Point2D end) {
            if (start == null || end == null) {
                return;
            }

            LineSegment segment = new LineSegment();
            segment.x1 = start.getX();
            segment.y1 = start.getY();
            segment.x2 = end.getX();
            segment.y2 = end.getY();
            segment.lineWidth = getGraphicsState().getLineWidth();

            double dx = Math.abs(segment.x2 - segment.x1);
            double dy = Math.abs(segment.y2 - segment.y1);

            if (dx <= 0.75 && dy > 0.75) {
                segment.orientation = "vertical";
            } else if (dy <= 0.75 && dx > 0.75) {
                segment.orientation = "horizontal";
            } else {
                segment.orientation = "other";
            }

            currentPathSegments.add(segment);
        }

        private void flushCurrentPath() {
            for (LineSegment segment : currentPathSegments) {
                if (!"other".equals(segment.orientation)) {
                    strokedSegments.add(segment);
                }
            }
            clearCurrentPath();
        }

        private void clearCurrentPath() {
            currentPathSegments.clear();
            currentPoint = null;
            subpathStart = null;
        }

        Map<String, Object> toPageResult(int pageNumber) {
            Map<String, Object> result = new LinkedHashMap<>();
            List<Map<String, Object>> segments = new ArrayList<>();
            int horizontalCount = 0;
            int verticalCount = 0;

            for (LineSegment segment : strokedSegments) {
                if ("horizontal".equals(segment.orientation)) {
                    horizontalCount += 1;
                } else if ("vertical".equals(segment.orientation)) {
                    verticalCount += 1;
                }

                Map<String, Object> segmentResult = new LinkedHashMap<>();
                segmentResult.put("orientation", segment.orientation);
                segmentResult.put("x1", round(segment.x1));
                segmentResult.put("y1", round(segment.y1));
                segmentResult.put("x2", round(segment.x2));
                segmentResult.put("y2", round(segment.y2));
                segmentResult.put("lineWidth", round(segment.lineWidth));
                segmentResult.put("length", round(length(segment)));
                segments.add(segmentResult);
            }

            result.put("pageNumber", pageNumber);
            result.put("width", round(page.getMediaBox().getWidth()));
            result.put("height", round(page.getMediaBox().getHeight()));
            result.put("segments", segments);

            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("strokedSegmentCount", strokedSegments.size());
            summary.put("horizontalSegmentCount", horizontalCount);
            summary.put("verticalSegmentCount", verticalCount);
            result.put("summary", summary);
            return result;
        }

        private double length(LineSegment segment) {
            return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
        }

        private double round(double value) {
            return Math.round(value * 1000d) / 1000d;
        }
    }

    private static String toJson(Object value) {
        if (value == null) {
            return "null";
        }

        if (value instanceof String) {
            return "\"" + escapeJson((String) value) + "\"";
        }

        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }

        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) value;
            StringBuilder builder = new StringBuilder();
            builder.append("{");
            boolean first = true;
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                if (!first) {
                    builder.append(",");
                }
                first = false;
                builder.append(toJson(entry.getKey()));
                builder.append(":");
                builder.append(toJson(entry.getValue()));
            }
            builder.append("}");
            return builder.toString();
        }

        if (value instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) value;
            StringBuilder builder = new StringBuilder();
            builder.append("[");
            for (int index = 0; index < list.size(); index += 1) {
                if (index > 0) {
                    builder.append(",");
                }
                builder.append(toJson(list.get(index)));
            }
            builder.append("]");
            return builder.toString();
        }

        return toJson(String.valueOf(value));
    }

    private static String escapeJson(String value) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
                case '\\':
                    builder.append("\\\\");
                    break;
                case '"':
                    builder.append("\\\"");
                    break;
                case '\b':
                    builder.append("\\b");
                    break;
                case '\f':
                    builder.append("\\f");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (character < 32) {
                        builder.append(String.format("\\u%04x", (int) character));
                    } else {
                        builder.append(character);
                    }
            }
        }
        return builder.toString();
    }
}
