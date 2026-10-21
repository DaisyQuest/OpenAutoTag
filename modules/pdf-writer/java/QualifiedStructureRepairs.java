import java.io.*;
import java.util.*;
import java.net.URI;
import java.awt.geom.Rectangle2D;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.text.PDFTextStripperByArea;

/** Small, individually enabled repairs. No guessed role mappings or document-root link insertion. */
public final class QualifiedStructureRepairs {
    private static COSBase resolve(COSBase v) { return v instanceof COSObject ? ((COSObject)v).getObject() : v; }
    private static String ref(COSBase v) { v = resolve(v); return v == null || v.getKey() == null ? "direct" : v.getKey().getNumber() + " " + v.getKey().getGeneration() + " R"; }
    private static void record(List<Map<String, Object>> out, String rule, String target, String decision, String reason) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("ruleId", rule); entry.put("version", Set.of("link-context-binding", "link-description").contains(rule) ? 2 : 1); entry.put("target", target);
        entry.put("decision", decision); entry.put("reason", reason); out.add(entry);
    }
    public static Map<COSDictionary, String> snapshot(PDDocument doc) throws IOException {
        Map<COSDictionary, String> result = new LinkedHashMap<>();
        var root = doc.getDocumentCatalog().getStructureTreeRoot();
        if (root != null) snapshotNode(root.getCOSObject(), result, Collections.newSetFromMap(new IdentityHashMap<>()), 0);
        return result;
    }
    private static void snapshotNode(COSBase raw, Map<COSDictionary, String> out, Set<COSBase> seen, int depth) throws IOException {
        COSBase value = resolve(raw);
        if (value == null || value instanceof COSInteger) return;
        if (!seen.add(value)) return;
        if (depth > 128 || seen.size() > 100000) throw new IOException("Excessive structure in repair audit");
        if (value instanceof COSArray) { for (COSBase child : (COSArray)value) snapshotNode(child, out, seen, depth + 1); }
        else if (value instanceof COSDictionary) {
            COSDictionary d = (COSDictionary)value;
            if (d.containsKey(COSName.S)) out.put(d, d.getNameAsString(COSName.S) + ";parent=" + ref(d.getItem(COSName.P)));
            snapshotNode(d.getItem(COSName.K), out, seen, depth + 1);
        }
    }
    public static void recordChanges(PDDocument doc, Map<COSDictionary, String> before, String rule, List<Map<String, Object>> ledger) throws IOException {
        for (var entry : snapshot(doc).entrySet()) {
            String prior = before.get(entry.getKey());
            if (!Objects.equals(prior, entry.getValue())) record(ledger, rule, ref(entry.getKey()), "apply", "before=" + prior + ";after=" + entry.getValue());
        }
    }
    public static List<Map<String, Object>> apply(PDDocument doc) throws IOException {
        if (!"1".equals(System.getenv("PASSTHROUGH_REPAIR_LINKS"))) return new ArrayList<>();
        return applyLinks(doc);
    }
    public static List<Map<String, Object>> applyLinks(PDDocument doc) throws IOException {
        if (doc.isEncrypted() || !doc.getSignatureDictionaries().isEmpty()) throw new IOException("Encrypted or signed PDFs are outside the qualified link repair scope");
        List<Map<String, Object>> result = new ArrayList<>();
        var root = doc.getDocumentCatalog().getStructureTreeRoot();
        if (root == null) return result;
        Map<COSDictionary, List<COSDictionary>> owners = new IdentityHashMap<>();
        Set<COSBase> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        collect(root.getCOSObject().getItem(COSName.K), root.getCOSObject(), null, owners, seen, 0);
        repairLinks(doc, root.getCOSObject(), owners, result);
        return result;
    }
    private static void collect(COSBase raw, COSDictionary parent, COSDictionary link, Map<COSDictionary, List<COSDictionary>> owners, Set<COSBase> seen, int depth) throws IOException {
        COSBase v = resolve(raw);
        if (v == null || v instanceof COSInteger) return;
        if (depth > 128 || seen.size() > 100000 || !seen.add(v)) throw new IOException("Ambiguous or excessive structure in repair preflight");
        if (v instanceof COSArray) { for (COSBase child : (COSArray)v) collect(child, parent, link, owners, seen, depth + 1); return; }
        if (!(v instanceof COSDictionary)) return;
        COSDictionary d = (COSDictionary)v;
        if (d.containsKey(COSName.S) && d.getCOSDictionary(COSName.P) != parent) throw new IOException("Incorrect structure parent in link repair preflight");
        if ("Link".equals(d.getNameAsString(COSName.S))) link = d;
        if ("OBJR".equals(d.getNameAsString(COSName.TYPE))) {
            COSDictionary object = d.getCOSDictionary(COSName.OBJ);
            if (object != null) owners.computeIfAbsent(object, k -> new ArrayList<>()).add(link);
        } else collect(d.getItem(COSName.K), d, link, owners, seen, depth + 1);
    }
    private static String uri(COSDictionary annotation) {
        COSDictionary action = annotation.getCOSDictionary(COSName.A);
        return action != null && "URI".equals(action.getNameAsString(COSName.S)) ? action.getString(COSName.URI, "") : "";
    }
    private static boolean simpleUriAction(COSDictionary annotation) {
        COSDictionary action = annotation.getCOSDictionary(COSName.A);
        return action != null && !annotation.containsKey(COSName.AA) && !annotation.containsKey(COSName.DEST) &&
            action.keySet().stream().allMatch(k -> Set.of("Type", "S", "URI").contains(k.getName())) && !uri(annotation).isBlank();
    }
    private static boolean usableAnchor(COSDictionary annotation, COSDictionary owner, PDPage page, Map<Integer, COSBase> slots) {
        if (owner == null || !"Link".equals(owner.getNameAsString(COSName.S)) || !simpleUriAction(annotation)) return false;
        if (resolve(slots.get(annotation.getInt(COSName.STRUCT_PARENT, -1))) != owner) return false;
        if (annotation.getCOSDictionary(COSName.P) != null && annotation.getCOSDictionary(COSName.P) != page.getCOSObject()) return false;
        return true;
    }
    private static boolean matchesLiteralDestination(String text, String destination) {
        try {
            URI uri = new URI(destination);
            if (destination.equals(text)) return Set.of("http", "https", "mailto").contains(uri.getScheme());
            if ("mailto".equals(uri.getScheme())) {
                String address = uri.getRawSchemeSpecificPart();
                return address.matches("[A-Za-z0-9.!#$%&'*+/=_`{|}~-]+@[A-Za-z0-9.-]+") && address.equals(text);
            }
            if (!Set.of("http", "https").contains(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) return false;
            String display = uri.getRawAuthority() + uri.getRawPath();
            return display.equals(text) || (uri.getRawPath().equals("/") && uri.getRawAuthority().equals(text));
        } catch (Exception e) { return false; }
    }
    private static Map<COSDictionary, String> linkText(PDPage page, List<PDAnnotation> annotations) throws IOException {
        Map<COSDictionary, String> result = new IdentityHashMap<>();
        // Text-region coordinates are qualified only for ordinary, unrotated pages.
        if (page.getRotation() != 0 || page.getUserUnit() != 1) return result;
        var crop = page.getCropBox(); PDFTextStripperByArea stripper = new PDFTextStripperByArea(); stripper.setSortByPosition(true);
        // Each overlapping region must receive its own copy of the extracted glyphs.
        stripper.setSuppressDuplicateOverlappingText(false);
        Map<String, COSDictionary> regions = new LinkedHashMap<>();
        for (PDAnnotation a : annotations) {
            if (!(a instanceof PDAnnotationLink) || a.isHidden() || a.isInvisible() || a.isNoView() || a.getCOSObject().containsKey(COSName.QUADPOINTS)) continue;
            var box = a.getRectangle();
            if (box == null || box.getWidth() <= 0 || box.getHeight() <= 0 || box.getWidth() > crop.getWidth() || box.getHeight() > 40 ||
                box.getLowerLeftX() < crop.getLowerLeftX() || box.getLowerLeftY() < crop.getLowerLeftY() || box.getUpperRightX() > crop.getUpperRightX() || box.getUpperRightY() > crop.getUpperRightY()) continue;
            String key = Integer.toString(regions.size()); regions.put(key, a.getCOSObject());
            stripper.addRegion(key, new Rectangle2D.Float(box.getLowerLeftX() - crop.getLowerLeftX(), crop.getUpperRightY() - box.getUpperRightY(), box.getWidth(), box.getHeight()));
        }
        if (regions.size() > 10000) throw new IOException("Excessive link regions");
        if (!regions.isEmpty()) stripper.extractRegions(page);
        for (var e : regions.entrySet()) result.put(e.getValue(), stripper.getTextForRegion(e.getKey()).strip());
        return result;
    }
    private static COSDictionary insertAdjacentLink(COSDictionary anchor, COSDictionary annotation, PDPage page, String destination, COSDictionary roleMap) {
        COSDictionary parent = anchor.getCOSDictionary(COSName.P);
        // Never insert at document root or inside a Link, list container or table container.
        if (parent == null) return null;
        String role = parent.getNameAsString(COSName.S, ""); Set<String> seen = new HashSet<>();
        while (roleMap != null && roleMap.containsKey(COSName.getPDFName(role))) {
            if (!seen.add(role) || seen.size() > 128) return null;
            role = roleMap.getNameAsString(COSName.getPDFName(role), "");
        }
        if (!Set.of("P", "Span", "Sect", "Div", "Part", "Document", "LBody", "TD", "TH").contains(role)) return null;
        COSBase raw = parent.getItem(COSName.K), children = resolve(raw); COSArray kids = new COSArray(); int matches = 0;
        COSDictionary link = new COSDictionary(); link.setName(COSName.TYPE, "StructElem"); link.setName(COSName.S, "Link");
        link.setItem(COSName.P, parent); link.setItem(COSName.PG, page.getCOSObject()); link.setString(COSName.ALT, destination);
        COSDictionary objr = new COSDictionary(); objr.setName(COSName.TYPE, "OBJR"); objr.setItem(COSName.OBJ, annotation); objr.setItem(COSName.PG, page.getCOSObject()); link.setItem(COSName.K, objr);
        if (children instanceof COSArray) {
            for (COSBase child : (COSArray)children) { kids.add(child); if (resolve(child) == anchor) { kids.add(link); matches++; } }
        } else if (children == anchor) { kids.add(raw); kids.add(link); matches++; }
        if (matches != 1) return null;
        parent.setItem(COSName.K, kids); return link;
    }
    private static double overlap(PDAnnotation a, PDAnnotation b) {
        var x = a.getRectangle(); var y = b.getRectangle();
        if (x == null || y == null || x.getWidth() <= 0 || x.getHeight() <= 0 || y.getWidth() <= 0 || y.getHeight() <= 0) return 0;
        double area = Math.max(0, Math.min(x.getUpperRightX(), y.getUpperRightX()) - Math.max(x.getLowerLeftX(), y.getLowerLeftX())) *
            Math.max(0, Math.min(x.getUpperRightY(), y.getUpperRightY()) - Math.max(x.getLowerLeftY(), y.getLowerLeftY()));
        return area / Math.min(x.getWidth() * x.getHeight(), y.getWidth() * y.getHeight());
    }
    private static void readSlots(COSDictionary tree, Map<Integer, COSBase> slots, Set<COSDictionary> seen, int depth) throws IOException {
        if (tree == null) return;
        if (depth > 128 || !seen.add(tree) || seen.size() > 10000) throw new IOException("Invalid ParentTree in link repair");
        COSArray nums = tree.getCOSArray(COSName.NUMS);
        if (nums != null) {
            if (nums.size() % 2 != 0) throw new IOException("Odd ParentTree pairs");
            for (int i = 0; i < nums.size(); i += 2) {
                if (!(nums.getObject(i) instanceof COSInteger) || ((COSInteger)nums.getObject(i)).longValue() < 0 || ((COSInteger)nums.getObject(i)).longValue() > Integer.MAX_VALUE || slots.putIfAbsent(((COSInteger)nums.getObject(i)).intValue(), nums.get(i + 1)) != null) throw new IOException("Invalid ParentTree key");
            }
        }
        COSArray kids = tree.getCOSArray(COSName.KIDS);
        if (kids != null) for (COSBase child : kids) {
            if (!(resolve(child) instanceof COSDictionary)) throw new IOException("Invalid ParentTree child");
            readSlots((COSDictionary)resolve(child), slots, seen, depth + 1);
        }
    }
    private static void repairLinks(PDDocument doc, COSDictionary root, Map<COSDictionary, List<COSDictionary>> owners, List<Map<String, Object>> ledger) throws IOException {
        Map<Integer, COSBase> slots = new TreeMap<>();
        readSlots(root.getCOSDictionary(COSName.PARENT_TREE), slots, Collections.newSetFromMap(new IdentityHashMap<>()), 0);
        long nextKey = Math.max((long)root.getInt(COSName.PARENT_TREE_NEXT_KEY, 0), (long)slots.keySet().stream().mapToInt(Integer::intValue).max().orElse(-1) + 1);
        if (nextKey < 0 || nextKey >= Integer.MAX_VALUE) throw new IOException("ParentTree key space exhausted");
        int next = (int)nextKey;
        boolean changed = false;
        for (PDPage page : doc.getPages()) {
            List<PDAnnotation> annotations = page.getAnnotations();
            Map<COSDictionary, String> text = linkText(page, annotations);
            // Newly inserted owners cannot become anchors for other inferred repairs.
            Map<COSDictionary, List<COSDictionary>> originalOwners = new IdentityHashMap<>(owners);
            for (PDAnnotation annotation : annotations) {
                if (!(annotation instanceof PDAnnotationLink)) continue;
                COSDictionary dict = annotation.getCOSObject(); String destination = uri(dict);
                List<COSDictionary> bindings = owners.getOrDefault(dict, List.of());
                COSDictionary owner = bindings.size() == 1 ? bindings.get(0) : null;
                if (bindings.isEmpty() && !destination.isBlank()) {
                    Set<COSDictionary> candidates = Collections.newSetFromMap(new IdentityHashMap<>());
                    for (PDAnnotation other : annotations) {
                        List<COSDictionary> known = originalOwners.getOrDefault(other.getCOSObject(), List.of());
                        if (other != annotation && other instanceof PDAnnotationLink && known.size() == 1 && known.get(0) != null &&
                            usableAnchor(other.getCOSObject(), known.get(0), page, slots) && simpleUriAction(dict) &&
                            destination.equals(uri(other.getCOSObject())) && overlap(annotation, other) >= 0.7) candidates.add(known.get(0));
                    }
                    if (candidates.size() == 1 && !dict.containsKey(COSName.STRUCT_PARENT)) {
                        if (next == Integer.MAX_VALUE) throw new IOException("ParentTree key space exhausted");
                        owner = candidates.iterator().next();
                        COSDictionary objr = new COSDictionary(); objr.setName(COSName.TYPE, "OBJR"); objr.setItem(COSName.PG, page.getCOSObject()); objr.setItem(COSName.OBJ, dict);
                        COSArray kids = new COSArray(); COSBase existing = resolve(owner.getItem(COSName.K));
                        if (existing instanceof COSArray) for (COSBase child : (COSArray)existing) kids.add(child);
                        else if (existing != null) kids.add(owner.getItem(COSName.K));
                        kids.add(objr); owner.setItem(COSName.K, kids);
                        dict.setInt(COSName.STRUCT_PARENT, next); slots.put(next++, owner); changed = true;
                        owners.put(dict, List.of(owner));
                        record(ledger, "link-context-binding", ref(dict), "apply", "same-destination-overlap-with-unique-authored-link:" + ref(owner));
                    }
                    if (owner == null && !dict.containsKey(COSName.STRUCT_PARENT) && simpleUriAction(dict) && matchesLiteralDestination(text.getOrDefault(dict, ""), destination)) {
                        Set<COSDictionary> anchors = Collections.newSetFromMap(new IdentityHashMap<>());
                        for (PDAnnotation other : annotations) {
                            List<COSDictionary> known = originalOwners.getOrDefault(other.getCOSObject(), List.of());
                            if (other != annotation && other instanceof PDAnnotationLink && known.size() == 1 &&
                                usableAnchor(other.getCOSObject(), known.get(0), page, slots) && overlap(annotation, other) >= 0.85 &&
                                text.getOrDefault(dict, "").equals(text.get(other.getCOSObject()))) anchors.add(known.get(0));
                        }
                        if (anchors.size() == 1) {
                            if (next == Integer.MAX_VALUE) throw new IOException("ParentTree key space exhausted");
                            COSDictionary anchor = anchors.iterator().next(); owner = insertAdjacentLink(anchor, dict, page, destination, root.getCOSDictionary(COSName.ROLE_MAP));
                            if (owner != null) {
                                dict.setInt(COSName.STRUCT_PARENT, next); slots.put(next++, owner); changed = true; owners.put(dict, List.of(owner));
                                record(ledger, "link-literal-adjacent-binding", ref(dict), "apply", "separate action; exact extracted destination text; adjacent to authored Link:" + ref(anchor));
                            }
                        }
                    }
                }
                if (owner == null) record(ledger, "link-context-binding", ref(dict), "review", "No unique authored Link association");
                if (dict.getString(COSName.CONTENTS, "").isBlank() && simpleUriAction(dict)) {
                    dict.setString(COSName.CONTENTS, destination);
                    record(ledger, "link-description", ref(dict), "apply", "exact-existing-URI-action");
                }
            }
        }
        if (changed) {
            COSArray nums = new COSArray(); for (var entry : slots.entrySet()) { nums.add(COSInteger.get(entry.getKey())); nums.add(entry.getValue()); }
            COSDictionary tree = new COSDictionary(); tree.setItem(COSName.NUMS, nums);
            root.setItem(COSName.PARENT_TREE, tree); root.setInt(COSName.PARENT_TREE_NEXT_KEY, next);
        }
    }
    public static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map<?, ?>) { List<String> parts = new ArrayList<>(); for (var e : ((Map<?, ?>)value).entrySet()) parts.add(json(e.getKey().toString()) + ":" + json(e.getValue())); return "{" + String.join(",", parts) + "}"; }
        if (value instanceof List<?>) { List<String> parts = new ArrayList<>(); for (Object item : (List<?>)value) parts.add(json(item)); return "[" + String.join(",", parts) + "]"; }
        String s = value.toString(); StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c == '"' || c == '\\') out.append('\\').append(c); else if (c < 32) out.append(String.format("\\u%04x", (int)c)); else out.append(c); }
        return out.append('"').toString();
    }
}
