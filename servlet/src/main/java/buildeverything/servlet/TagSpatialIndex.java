package buildeverything.servlet;

import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Page-scoped QuadTree for sub-linear hit testing of tag bounding boxes.
 */
public final class TagSpatialIndex {
    private static final int MAX_DEPTH = 8;
    private static final int SPLIT_THRESHOLD = 8;

    private final Map<Integer, QuadNode> pages = new HashMap<>();

    public void rebuild(Collection<StudioTag> tags) {
        pages.clear();
        Map<Integer, List<StudioTag>> byPage = new HashMap<>();
        for (StudioTag tag : tags) {
            byPage.computeIfAbsent(tag.pageNumber(), (_page) -> new ArrayList<>()).add(tag);
        }

        for (Map.Entry<Integer, List<StudioTag>> entry : byPage.entrySet()) {
            Rectangle2D.Double bounds = union(entry.getValue());
            QuadNode root = new QuadNode(bounds, 0);
            for (StudioTag tag : entry.getValue()) {
                root.insert(tag);
            }
            pages.put(entry.getKey(), root);
        }
    }

    public Optional<StudioTag> hitTest(int pageNumber, Point2D pdfPoint) {
        QuadNode root = pages.get(pageNumber);
        if (root == null) {
            return Optional.empty();
        }
        List<StudioTag> hits = new ArrayList<>();
        root.query(pdfPoint, hits);
        return hits.stream()
                .filter((tag) -> tag.pdfBounds().contains(pdfPoint))
                .min(Comparator.comparingDouble((tag) -> area(tag.pdfBounds())));
    }

    public Optional<HandleHit> hitHandle(int pageNumber, Point2D pdfPoint, double tolerancePoints) {
        return hitTest(pageNumber, pdfPoint).flatMap((tag) -> {
            Rectangle2D.Double box = tag.pdfBounds();
            List<HandleHit> handles = List.of(
                    new HandleHit(tag, "nw", new Point2D.Double(box.x, box.y + box.height)),
                    new HandleHit(tag, "n", new Point2D.Double(box.x + box.width / 2.0, box.y + box.height)),
                    new HandleHit(tag, "ne", new Point2D.Double(box.x + box.width, box.y + box.height)),
                    new HandleHit(tag, "e", new Point2D.Double(box.x + box.width, box.y + box.height / 2.0)),
                    new HandleHit(tag, "se", new Point2D.Double(box.x + box.width, box.y)),
                    new HandleHit(tag, "s", new Point2D.Double(box.x + box.width / 2.0, box.y)),
                    new HandleHit(tag, "sw", new Point2D.Double(box.x, box.y)),
                    new HandleHit(tag, "w", new Point2D.Double(box.x, box.y + box.height / 2.0)));
            return handles.stream()
                    .filter((handle) -> handle.point().distance(pdfPoint) <= tolerancePoints)
                    .min(Comparator.comparingDouble((handle) -> handle.point().distance(pdfPoint)));
        });
    }

    public record HandleHit(StudioTag tag, String handle, Point2D.Double point) {}

    private static Rectangle2D.Double union(List<StudioTag> tags) {
        Rectangle2D.Double bounds = new Rectangle2D.Double(0, 0, 1, 1);
        boolean initialized = false;
        for (StudioTag tag : tags) {
            Rectangle2D.Double tagBounds = tag.pdfBounds();
            if (!initialized) {
                bounds = tagBounds;
                initialized = true;
                continue;
            }
            Rectangle2D.union(bounds, tagBounds, bounds);
        }
        return new Rectangle2D.Double(bounds.x - 1, bounds.y - 1, bounds.width + 2, bounds.height + 2);
    }

    private static double area(Rectangle2D rectangle) {
        return rectangle.getWidth() * rectangle.getHeight();
    }

    private static final class QuadNode {
        private final Rectangle2D.Double bounds;
        private final int depth;
        private final List<StudioTag> entries = new ArrayList<>();
        private QuadNode[] children;

        private QuadNode(Rectangle2D.Double bounds, int depth) {
            this.bounds = bounds;
            this.depth = depth;
        }

        private void insert(StudioTag tag) {
            if (children != null) {
                QuadNode child = childContaining(tag.pdfBounds());
                if (child != null) {
                    child.insert(tag);
                    return;
                }
            }

            entries.add(tag);
            if (entries.size() > SPLIT_THRESHOLD && depth < MAX_DEPTH) {
                split();
            }
        }

        private void query(Point2D point, List<StudioTag> hits) {
            if (!bounds.contains(point)) {
                return;
            }
            hits.addAll(entries);
            if (children == null) {
                return;
            }
            for (QuadNode child : children) {
                child.query(point, hits);
            }
        }

        private void split() {
            if (children != null) {
                return;
            }
            double halfW = bounds.width / 2.0;
            double halfH = bounds.height / 2.0;
            children = new QuadNode[] {
                    new QuadNode(new Rectangle2D.Double(bounds.x, bounds.y, halfW, halfH), depth + 1),
                    new QuadNode(new Rectangle2D.Double(bounds.x + halfW, bounds.y, halfW, halfH), depth + 1),
                    new QuadNode(new Rectangle2D.Double(bounds.x, bounds.y + halfH, halfW, halfH), depth + 1),
                    new QuadNode(new Rectangle2D.Double(bounds.x + halfW, bounds.y + halfH, halfW, halfH), depth + 1)
            };

            List<StudioTag> retained = new ArrayList<>();
            for (StudioTag entry : entries) {
                QuadNode child = childContaining(entry.pdfBounds());
                if (child == null) {
                    retained.add(entry);
                    continue;
                }
                child.insert(entry);
            }
            entries.clear();
            entries.addAll(retained);
        }

        private QuadNode childContaining(Rectangle2D rectangle) {
            if (children == null) {
                return null;
            }
            for (QuadNode child : children) {
                if (child.bounds.contains(rectangle)) {
                    return child;
                }
            }
            return null;
        }
    }
}
