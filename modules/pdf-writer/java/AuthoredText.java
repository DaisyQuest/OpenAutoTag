import java.io.IOException;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.*;

/** Source-authored character replacement and abbreviation scopes. No inference. */
final class AuthoredText {
    static final COSName ACTUAL = COSName.getPDFName("ActualText"), EXPANSION = COSName.getPDFName("E");
    static final class Scope {
        final COSDictionary properties;
        final Set<Key> expected = new HashSet<>();
        final Set<Key> seen = new HashSet<>();
        String owner;
        boolean shadowed;
        boolean structural;
        Object contentStream;
        Scope(COSDictionary properties) { this.properties = properties; }
    }
    record Key(COSDictionary page, COSDictionary stream, int mcid) {}
    final List<Scope> scopes = new ArrayList<>();
    private final Map<Key,List<Scope>> byContent = new HashMap<>();
    private final Set<COSBase> visiting = Collections.newSetFromMap(new IdentityHashMap<>());
    private int nodes;

    AuthoredText(PDDocument doc) throws IOException {
        PDStructureTreeRoot root = doc.getDocumentCatalog().getStructureTreeRoot();
        if (root != null) index(root.getCOSObject().getDictionaryObject(COSName.K), null, List.of(), 0);
    }

    Scope read(COSDictionary source) throws IOException {
        if (source == null || (!source.containsKey(ACTUAL) && !source.containsKey(EXPANSION))) return null;
        COSDictionary properties = new COSDictionary();
        for (COSName name : List.of(ACTUAL, EXPANSION)) if (source.containsKey(name)) {
            COSBase value = source.getDictionaryObject(name);
            if (!(value instanceof COSString text) || text.getBytes().length > 1048576)
                throw new IOException("Invalid or excessive authored text property " + name.getName());
            // Empty strings and whitespace are meaningful replacements.
            properties.setItem(name, value);
        }
        if (scopes.size() >= 100000) throw new IOException("Excessive authored text scopes");
        Scope scope = new Scope(properties); scopes.add(scope); return scope;
    }

    private void index(COSBase value, COSDictionary page, List<Scope> ancestors, int depth) throws IOException {
        if (value == null || value instanceof COSNull) return;
        if (++nodes > 1000000 || depth > 256 || !visiting.add(value))
            throw new IOException("Cyclic or excessive source structure for authored text");
        try {
            if (value instanceof COSArray array) {
                for (int i = 0; i < array.size(); i++) index(array.getObject(i), page, ancestors, depth + 1);
            } else if (value instanceof COSInteger number) {
                reference(page, null, number.intValue(), ancestors);
            } else if (value instanceof COSDictionary dict) {
                COSDictionary localPage = dict.getCOSDictionary(COSName.PG);
                if (localPage != null) page = localPage;
                if (COSName.MCR.equals(dict.getCOSName(COSName.TYPE))) {
                    reference(page, dict.getCOSDictionary(COSName.getPDFName("Stm")), dict.getInt(COSName.MCID, -1), ancestors);
                } else if (!COSName.OBJR.equals(dict.getCOSName(COSName.TYPE))) {
                    Scope own = read(dict);
                    if (own != null) own.structural = true;
                    List<Scope> path = append(ancestors, own);
                    index(dict.getDictionaryObject(COSName.K), page, path, depth + 1);
                } else if (!ancestors.isEmpty()) {
                    throw new IOException("Authored text over an object reference requires source-tree preservation");
                }
            }
        } finally { visiting.remove(value); }
    }

    private void reference(COSDictionary page, COSDictionary stream, int mcid, List<Scope> path) throws IOException {
        if (path.isEmpty()) return;
        if (page == null || mcid < 0) throw new IOException("Unresolved authored text content reference");
        Key key = new Key(page, stream, mcid);
        if (byContent.putIfAbsent(key, path) != null) throw new IOException("Duplicate authored text content reference");
        for (Scope scope : path) scope.expected.add(key);
    }

    List<Scope> forContent(COSDictionary page, COSDictionary stream, COSDictionary properties) {
        if (properties == null || !properties.containsKey(COSName.MCID)) return List.of();
        Key key = new Key(page, stream, properties.getInt(COSName.MCID, -1));
        List<Scope> path = byContent.getOrDefault(key, List.of());
        for (Scope scope : path) scope.seen.add(key);
        return path;
    }

    static List<Scope> append(List<Scope> path, Scope own) {
        if (own == null) return path;
        List<Scope> result = new ArrayList<>(path); result.add(own); return result;
    }

    static List<Scope> merge(List<Scope> first, List<Scope> second) {
        if (second.isEmpty()) return first;
        List<Scope> result = new ArrayList<>(first);
        for (Scope scope : second) if (!result.contains(scope)) result.add(scope);
        return result;
    }

    static List<Scope> effective(List<Scope> path) {
        // A structure element's ActualText replaces its entire subtree, even
        // when a physical marked-content wrapper lies outside its MCID.
        List<Scope> ordered = new ArrayList<>();
        for (Scope scope : path) if (scope.structural) ordered.add(scope);
        for (Scope scope : path) if (!scope.structural) ordered.add(scope);
        List<Scope> effective = new ArrayList<>(); boolean replaced = false;
        for (Scope scope : ordered) {
            if (replaced) scope.shadowed = true;
            else { effective.add(scope); replaced = scope.properties.containsKey(ACTUAL); }
        }
        return effective;
    }

    static void own(List<Scope> path, String owner) throws IOException {
        for (Scope scope : path) {
            if (owner == null) throw new IOException("Authored text contains unassigned paint; source-tree preservation is required");
            if (scope.owner != null && !scope.owner.equals(owner))
                throw new IOException("Authored text crosses inferred tag boundaries; source-tree preservation is required");
            scope.owner = owner;
        }
    }

    static void addMarkedReplacement(COSDictionary properties, List<Scope> path) {
        // The stream writer coalesces all members into one continuous MCID
        // wrapper. Empty ActualText on later individual wrappers is unsafe:
        // some extractors fall back to the glyphs and announce them twice.
        for (Scope scope : path) if (scope.properties.containsKey(ACTUAL)) {
            properties.setItem(ACTUAL, scope.properties.getItem(ACTUAL)); break;
        }
    }

    void verify() throws IOException {
        for (Scope scope : scopes) {
            if (scope.shadowed && scope.owner == null) continue;
            if (scope.shadowed) throw new IOException("Authored text is only partly covered by an outer replacement");
            if (scope.owner == null || !scope.seen.containsAll(scope.expected))
                throw new IOException("Authored text has unmapped content; source-tree preservation is required");
        }
    }

    /** A single contiguous run per authored scope. Never capture neighboring MCRs. */
    static final class StructureRuns {
        private final List<Scope> open = new ArrayList<>();
        private final List<PDStructureElement> elements = new ArrayList<>();
        private final Set<Scope> closed = Collections.newSetFromMap(new IdentityHashMap<>());
        PDStructureElement parent(PDStructureElement base, List<Scope> path) throws IOException {
            int common = 0;
            while (common < open.size() && common < path.size() && open.get(common) == path.get(common)) common++;
            while (open.size() > common) { closed.add(open.remove(open.size()-1)); elements.remove(elements.size()-1); }
            for (int i = common; i < path.size(); i++) {
                Scope scope = path.get(i);
                if (closed.contains(scope)) throw new IOException("Authored text is not contiguous in inferred reading order");
                PDStructureElement parent = elements.isEmpty() ? base : elements.get(elements.size()-1);
                PDStructureElement span = new PDStructureElement("Span", parent);
                for (COSName name : scope.properties.keySet()) span.getCOSObject().setItem(name, scope.properties.getItem(name));
                parent.appendKid(span); open.add(scope); elements.add(span);
            }
            return elements.isEmpty() ? base : elements.get(elements.size()-1);
        }
    }
}
