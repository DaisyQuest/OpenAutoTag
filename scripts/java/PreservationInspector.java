import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;

/** A bounded inventory for structure-only repairs that preserve object identities. */
public final class PreservationInspector {
    private static final int MAX_NODES = 100000, MAX_DEPTH = 128;
    private static final long MAX_STREAM_BYTES = 64L * 1024 * 1024;
    private final List<String> issues = new ArrayList<>(), limitations = new ArrayList<>();
    private final Map<COSDictionary, Integer> pagesByDict = new IdentityHashMap<>();
    private final Map<String, Object> widgets = new TreeMap<>();
    private final Map<String, Object> links = new TreeMap<>();
    private final List<Map<String, Object>> headings = new ArrayList<>();
    private final List<Map<String, Object>> structure = new ArrayList<>();
    private final Map<COSDictionary, Map<String, Object>> structureByDict = new IdentityHashMap<>();
    private final List<String> contentOrder = new ArrayList<>();
    private final Set<COSBase> visited = Collections.newSetFromMap(new IdentityHashMap<>());
    private int walked;
    private COSDictionary roleMap, classMap;
    private SavedContentInspector savedContent;
    private final Map<Integer, COSBase> parentSlots = new TreeMap<>();
    private final Map<Integer, COSDictionary> parentScopes = new TreeMap<>();
    private final Set<COSDictionary> registeredScopes = Collections.newSetFromMap(new IdentityHashMap<>());
    private final Map<String, COSBase> idSlots = new TreeMap<>();
    private final Map<String, String> contentOwners = new HashMap<>();
    private final Set<COSDictionary> elements = Collections.newSetFromMap(new IdentityHashMap<>());
    private static final Set<String> STANDARD_ROLES = Set.of("Document", "Part", "Art", "Sect", "Div", "BlockQuote", "Caption", "TOC", "TOCI", "Index", "NonStruct", "Private", "P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "L", "LI", "Lbl", "LBody", "Table", "TR", "TH", "TD", "THead", "TBody", "TFoot", "Span", "Quote", "Note", "Reference", "BibEntry", "Code", "Link", "Annot", "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP", "Figure", "Formula", "Form");

    public static Map<String, Object> inspect(PDDocument doc, File file) throws Exception {
        return new PreservationInspector().run(doc, file);
    }

    private Map<String, Object> run(PDDocument doc, File file) throws Exception {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schemaVersion", "1.0.0"); result.put("scope", "preserved-objects-v1");
        try (InputStream in = Files.newInputStream(file.toPath())) { result.put("sourceHash", streamHash(in, Long.MAX_VALUE)); }
        List<Object> pages = new ArrayList<>();
        int number = 0;
        for (PDPage page : doc.getPages()) pagesByDict.put(page.getCOSObject(), ++number);
        COSDictionary sourceForm=doc.getDocumentCatalog().getCOSObject().getCOSDictionary(COSName.ACRO_FORM);
        String formState=sourceForm==null?"absent":fieldRefs(sourceForm.getItem(COSName.FIELDS))+"|calculation:"+fieldRefs(sourceForm.getItem(COSName.CO))+"|"+
            canonical(sourceForm,Set.of("Fields","DR","CO"),Collections.newSetFromMap(new IdentityHashMap<>()),new int[]{0},0,pagesByDict);
        for (PDPage page : doc.getPages()) {
            var media = page.getMediaBox(); var crop = page.getCropBox();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("geometry", Arrays.asList(media.getLowerLeftX(), media.getLowerLeftY(), media.getUpperRightX(), media.getUpperRightY(),
                crop.getLowerLeftX(), crop.getLowerLeftY(), crop.getUpperRightX(), crop.getUpperRightY(), page.getRotation(), page.getUserUnit()));
            item.put("contentHash", fingerprint(page.getCOSObject().getItem(COSName.CONTENTS), Set.of()));
            item.put("resourcesHash", fingerprint(page.getResources() == null ? null : page.getResources().getCOSObject(), Set.of()));
            List<String> annotations = new ArrayList<>();
            int annotationIndex=0;
            for (var annotation : page.getAnnotations()) {
                COSDictionary dict = annotation.getCOSObject();
                registerParentScope(dict);
                boolean link = "Link".equals(annotation.getSubtype());
                String digest = fingerprint(dict, link ? Set.of("P", "Parent", "StructParent", "Contents") : Set.of("P", "Parent", "StructParent"));
                if (link) {
                    COSDictionary action = dict.getCOSDictionary(COSName.A);
                    String uri = action != null && "URI".equals(action.getNameAsString(COSName.S)) ? action.getString(COSName.URI, "") : "";
                    Map<String, Object> itemLink = new LinkedHashMap<>();
                    itemLink.put("digest", digest); itemLink.put("page", pagesByDict.get(page.getCOSObject()));
                    itemLink.put("nativeDigest",hash(canonical(dict,Set.of("P","Parent","StructParent","Contents"),Collections.newSetFromMap(new IdentityHashMap<>()),new int[]{0},0,pagesByDict)));
                    itemLink.put("annotationIndex",annotationIndex);
                    var rectangle=annotation.getRectangle();
                    itemLink.put("rectangle",rectangle==null?null:Arrays.asList(rectangle.getLowerLeftX(),rectangle.getLowerLeftY(),rectangle.getUpperRightX(),rectangle.getUpperRightY()));
                    itemLink.put("visible",!annotation.isHidden()&&!annotation.isInvisible()&&!annotation.isNoView());
                    itemLink.put("quadPointsPresent",dict.containsKey(COSName.getPDFName("QuadPoints")));
                    itemLink.put("linkPathPresent",dict.containsKey(COSName.getPDFName("Path")));
                    COSBase quadValue=dict.getDictionaryObject(COSName.getPDFName("QuadPoints"));
                    // Use the same float representation as Rect. Expanding only
                    // quads to double would put equal decimal edges outside Rect
                    // after JSON serialization (e.g. 42.9861 vs 42.986099243...).
                    List<Float> quadPoints=new ArrayList<>();boolean numeric=quadValue instanceof COSArray&&((COSArray)quadValue).size()<=8192;
                    if(numeric)for(COSBase q:(COSArray)quadValue) {
                        COSBase v=resolve(q);
                        if(!(v instanceof COSNumber n)||!Float.isFinite(n.floatValue())){numeric=false;break;}
                        quadPoints.add(((COSNumber)v).floatValue());
                    }
                    itemLink.put("quadPoints",numeric?quadPoints:null);
                    itemLink.put("structParent",dict.getInt(COSName.STRUCT_PARENT,-1));
                    itemLink.put("uri", uri); itemLink.put("contents", dict.getString(COSName.CONTENTS, "")); itemLink.put("owners", new ArrayList<String>());
                    if (links.putIfAbsent(requiredRef(dict), itemLink) != null) throw new IOException("Duplicate link annotation");
                }
                if ("Widget".equals(annotation.getSubtype())) {
                    String key = requiredRef(dict);
                    if (widgets.containsKey(key)) throw new IOException("Widget appears more than once: " + key);
                    Map<String, Object> widget = new LinkedHashMap<>();
                    widget.put("digest", digest); widget.put("page", pagesByDict.get(page.getCOSObject()));
                    widget.put("annotationIndex",annotationIndex);widget.put("structParent",dict.getInt(COSName.STRUCT_PARENT,-1));
                    widget.put("nativeDigest",hash(canonical(dict,Set.of("Parent","StructParent","AP"),Collections.newSetFromMap(new IdentityHashMap<>()),new int[]{0},0,pagesByDict)));
                    widget.put("appearanceHash",widgetAppearance(dict.getDictionaryObject(COSName.AP)));
                    List<String> names=new ArrayList<>(),states=new ArrayList<>();Set<COSDictionary> lineage=Collections.newSetFromMap(new IdentityHashMap<>());COSDictionary field=dict;
                    String accessible="";boolean nameScopeEnded=false;
                    while(field!=null) {
                        if(lineage.size()>=128||!lineage.add(field))throw new IOException("Cyclic or excessive widget field ancestry");
                        if(field.getDictionaryObject(COSName.T) instanceof COSString name&&!name.getString().isEmpty())names.add(name.getString());
                        if(!nameScopeEnded&&accessible.isEmpty()&&field.getDictionaryObject(COSName.TU) instanceof COSString tooltip&&!tooltip.getString().isBlank())accessible=tooltip.getString();
                        if(field.containsKey(COSName.T)||field.containsKey(COSName.FT))nameScopeEnded=true;
                        states.add(requiredRef(field)+":"+fieldRefs(field.getItem(COSName.KIDS))+":"+canonical(field,Set.of("Parent","Kids","P","StructParent","AP","DR"),Collections.newSetFromMap(new IdentityHashMap<>()),new int[]{0},0,pagesByDict));
                        COSBase ancestor=field.getDictionaryObject(COSName.PARENT);if(ancestor!=null&&!(ancestor instanceof COSDictionary))throw new IOException("Invalid widget field parent");field=(COSDictionary)ancestor;
                    }
                    Collections.reverse(names);widget.put("fieldName",String.join(".",names));widget.put("fieldStateHash",hash(formState+"|"+String.join("|",states)));widget.put("accessibleName",accessible);
                    widget.put("owners", new ArrayList<Map<String, Object>>()); widgets.put(key, widget);
                } else annotations.add(digest);
                annotationIndex++;
            }
            item.put("annotationsHash", hash(String.join("|", annotations)));
            pages.add(item);
        }
        Map<String, String> fields = new TreeMap<>();
        COSDictionary acro = doc.getDocumentCatalog().getCOSObject().getCOSDictionary(COSName.ACRO_FORM);
        if (acro != null) {
            // Raw traversal avoids appearance regeneration by form convenience APIs.
            walkFields(acro.getItem(COSName.FIELDS), new IdentityHashMap<>(), fields, 0);
            fields.put("@AcroForm", hash(fingerprint(acro, Set.of("Fields")) + "|roots:" + fieldRefs(acro.getItem(COSName.FIELDS))));
        }
        savedContent = new SavedContentInspector(doc, issues);
        for (COSDictionary scope : savedContent.scopes) registerParentScope(scope);
        var root = doc.getDocumentCatalog().getStructureTreeRoot();
        if (root != null) {
            roleMap = root.getCOSObject().getCOSDictionary(COSName.ROLE_MAP);
            classMap = root.getCOSObject().getCOSDictionary(COSName.getPDFName("ClassMap"));
            readTree(root.getCOSObject().getDictionaryObject(COSName.PARENT_TREE), false, new HashSet<>(), 0);
            readTree(root.getCOSObject().getDictionaryObject(COSName.ID_TREE), true, new HashSet<>(), 0);
        }
        if (root != null) walkStructure(root.getCOSObject().getItem(COSName.K), root.getCOSObject(), null,
            new ArrayList<>(), "", "", false, 0);
        for (var entry : idSlots.entrySet()) {
            COSBase target = resolve(entry.getValue());
            if (!(target instanceof COSDictionary) || !elements.contains(target) || !entry.getKey().equals(((COSDictionary) target).getString(COSName.ID))) issues.add("INVALID_ID_TREE_TARGET:" + entry.getKey());
        }
        for (var entry : parentSlots.entrySet()) {
            COSBase slot = resolve(entry.getValue());
            if (slot instanceof COSArray) for (COSBase child : (COSArray) slot) checkReachableParentTarget(child, entry.getKey());
            else checkReachableParentTarget(slot, entry.getKey());
            COSDictionary scope = parentScopes.get(entry.getKey());
            if (scope == null) { issues.add("ORPHAN_PARENT_TREE_KEY:" + entry.getKey()); continue; }
            if (slot instanceof COSArray) {
                if (!scope.containsKey(COSName.STRUCT_PARENTS)) issues.add("PARENT_TREE_SCOPE_TYPE:" + entry.getKey());
                COSArray array = (COSArray)slot;
                for (int i = 0; i < array.size(); i++) {
                    COSBase owner = array.getObject(i);
                    if (owner == null || owner instanceof COSNull) continue;
                    if (!ref(owner).equals(contentOwners.get(ref(scope) + ":" + i)))
                        issues.add("PARENT_TREE_REVERSE_MISMATCH:" + entry.getKey() + ":" + i);
                }
            } else if (!scope.containsKey(COSName.STRUCT_PARENT) || !ref(slot).equals(contentOwners.get("obj:" + ref(scope))))
                issues.add("OBJR_PARENT_TREE_REVERSE_MISMATCH:" + entry.getKey());
        }
        for (int key : parentScopes.keySet()) if (!parentSlots.containsKey(key)) issues.add("MISSING_PARENT_TREE_KEY:" + key);
        for (var entry : widgets.entrySet()) {
            Map<?, ?> widget = (Map<?, ?>) entry.getValue();
            if (((List<?>) widget.get("owners")).size() != 1) issues.add("WIDGET_OWNERSHIP:" + entry.getKey());
        }
        for (var entry : links.entrySet()) if (((List<?>) ((Map<?, ?>)entry.getValue()).get("owners")).size() != 1) issues.add("LINK_OWNERSHIP:" + entry.getKey());
        limitations.add("This inventory checks preservation, not semantic correctness or complete PDF structure validity.");
        limitations.add("Content-stream completeness, XObject invocation geometry, reader behavior and visual rendering require separate verification.");
        limitations.add("Heading coverage resolves RoleMap to H1-H6; generic H hierarchy still requires review.");
        result.put("pages", pages); result.put("fields", fields); result.put("widgets", widgets);
        result.put("links", links);
        result.put("navigation",NavigationInspector.inspect(doc));
        result.put("headings", headings); result.put("structure", structure); result.put("contentOrder", contentOrder);
        result.put("markedContent", savedContent.json());
        result.put("imageRuns",savedContent.imageRuns()); result.put("textRuns", savedContent.textRuns()); result.put("replacementScopes", savedContent.replacements());
        result.put("issues", issues); result.put("limitations", limitations);
        return result;
    }

    private void walkFields(COSBase value, Map<COSBase, Boolean> seen, Map<String, String> fields, int depth) throws Exception {
        value = resolve(value); guard(depth);
        if (value == null) return;
        if (seen.put(value, true) != null) throw new IOException("Cyclic or shared field tree");
        if (value instanceof COSArray) {
            for (COSBase child : (COSArray) value) walkFields(child, seen, fields, depth + 1);
        } else if (value instanceof COSDictionary) {
            COSDictionary field = (COSDictionary) value;
            String key = requiredRef(field);
            String digest = hash(fingerprint(field, Set.of("Parent", "Kids", "P", "StructParent")) +
                "|parent:" + ref(field.getItem(COSName.PARENT)) + "|kids:" + fieldRefs(field.getItem(COSName.KIDS)));
            if (fields.putIfAbsent(key, digest) != null) throw new IOException("Duplicate field identity: " + key);
            walkFields(field.getItem(COSName.KIDS), seen, fields, depth + 1);
        } else throw new IOException("Invalid field tree child");
    }

    @SuppressWarnings("unchecked")
    private void walkStructure(COSBase value, COSDictionary parent, COSDictionary page,
        List<Map<String, Object>> ancestors, String form, String listItem, boolean inBody, int depth) throws Exception {
        value = resolve(value); guard(depth);
        if (value == null) return;
        if (value instanceof COSInteger) { verifyContent(parent, page, null, ((COSInteger) value).intValue()); addContent(ancestors, page, null, ((COSInteger) value).intValue()); return; }
        if (!visited.add(value)) { issues.add("SHARED_OR_CYCLIC_STRUCTURE:" + ref(value)); return; }
        if (value instanceof COSArray) {
            for (COSBase kid : (COSArray) value) walkStructure(kid, parent, page, ancestors, form, listItem, inBody, depth + 1);
            return;
        }
        if (!(value instanceof COSDictionary)) { issues.add("INVALID_STRUCTURE_CHILD"); return; }
        COSDictionary dict = (COSDictionary) value;
        COSDictionary ownPage = dict.getCOSDictionary(COSName.PG);
        if (ownPage != null) page = ownPage;
        String type = dict.getNameAsString(COSName.TYPE, "");
        if ("MCR".equals(type)) {
            COSBase stream = dict.getDictionaryObject(COSName.getPDFName("Stm"));
            COSBase rawMcid = dict.getDictionaryObject(COSName.MCID);
            if (!(rawMcid instanceof COSInteger) || ((COSInteger)rawMcid).longValue() < 0 || ((COSInteger)rawMcid).longValue() > Integer.MAX_VALUE)
                issues.add("INVALID_MCR_IDENTIFIER:" + ref(parent));
            verifyContent(parent, page, stream, dict.getInt(COSName.MCID, -1));
            addContent(ancestors, page, stream, dict.getInt(COSName.MCID, -1)); return;
        }
        if ("OBJR".equals(type)) {
            COSBase object = dict.getDictionaryObject(COSName.OBJ);
            if (page == null && object instanceof COSDictionary) page = ((COSDictionary)object).getCOSDictionary(COSName.P);
            if (!(object instanceof COSDictionary)) issues.add("DANGLING_OBJR:" + ref(parent));
            else {
                registerParentScope((COSDictionary)object);
                int slot = ((COSDictionary) object).getInt(COSName.STRUCT_PARENT, -1);
                if (slot < 0 || resolve(parentSlots.get(slot)) != parent) issues.add("OBJR_PARENT_TREE_MISMATCH:" + ref(object));
                if (contentOwners.putIfAbsent("obj:" + ref(object), ref(parent)) != null) issues.add("DUPLICATE_OBJR:" + ref(object));
            }
            if (object != null && widgets.containsKey(ref(object))) {
                Map<String, Object> widget = (Map<String, Object>) widgets.get(ref(object));
                if (form.isEmpty()) issues.add("WIDGET_OUTSIDE_FORM:" + ref(object));
                ((List<Map<String, Object>>) widget.get("owners")).add(Map.of("form", form, "listItem", listItem, "inBody", inBody));
                if (!Objects.equals(pagesByDict.get(page), widget.get("page"))) issues.add("WIDGET_OBJR_PAGE_MISMATCH:" + ref(object));
            }
            if (object != null && links.containsKey(ref(object))) {
                if (!"Link".equals(resolveRole(parent.getNameAsString(COSName.S, ""), ref(parent)))) issues.add("LINK_OUTSIDE_LINK_TAG:" + ref(object));
                ((List<String>) ((Map<String, Object>)links.get(ref(object))).get("owners")).add(ref(parent));
                if (!Objects.equals(pagesByDict.get(page), ((Map<?, ?>)links.get(ref(object))).get("page"))) issues.add("LINK_OBJR_PAGE_MISMATCH:" + ref(object));
            }
            recordContent(parent, "obj:" + ref(object));
            return;
        }
        String role = dict.getNameAsString(COSName.S, "");
        if (role.isEmpty()) { issues.add("MISSING_STRUCTURE_ROLE:" + ref(dict)); return; }
        if ("direct".equals(ref(dict))) throw new IOException("Direct structure elements lack stable identity");
        if (dict.getDictionaryObject(COSName.P) != parent) issues.add("INCORRECT_STRUCTURE_PARENT:" + ref(dict));
        elements.add(dict);
        role = resolveRole(role, ref(dict));
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("objectRef", ref(dict)); semantic.put("parentRef", ref(parent)); semantic.put("role", role);
        semantic.put("identifier", dict.getString(COSName.ID, ""));
        semantic.put("actualText", dict.getString(COSName.ACTUAL_TEXT, ""));
        semantic.put("actualTextPresent", dict.containsKey(COSName.ACTUAL_TEXT));
        semantic.put("alt", dict.getString(COSName.ALT, ""));
        semantic.put("page", pagesByDict.getOrDefault(page, 0)); semantic.put("children", new ArrayList<String>());
        semantic.put("contentRefs", new ArrayList<String>()); semantic.put("headers", new ArrayList<String>());
        semantic.put("scope", ""); semantic.put("listNumbering", ""); semantic.put("rowSpan", 1); semantic.put("columnSpan", 1);
        readSemanticClasses(dict.getDictionaryObject(COSName.C), semantic, 0);
        readSemanticAttributes(dict.getDictionaryObject(COSName.A), semantic, 0);
        structure.add(semantic); structureByDict.put(dict, semantic);
        Map<String, Object> parentSemantic = structureByDict.get(parent);
        if (parentSemantic != null) ((List<String>) parentSemantic.get("children")).add(ref(dict));
        String id = dict.getString(COSName.ID);
        if (id != null && resolve(idSlots.get(id)) != dict) issues.add("ID_TREE_MISMATCH:" + ref(dict));
        if (role.matches("H[1-6]")) {
            Map<String, Object> heading = new LinkedHashMap<>();
            heading.put("id", ref(dict)); heading.put("role", role); heading.put("contentRefs", new ArrayList<String>());
            headings.add(heading); ancestors = new ArrayList<>(ancestors); ancestors.add(heading);
        }
        if ("Form".equals(role)) form = ref(dict);
        if ("LI".equals(role)) { listItem = ref(dict); inBody = false; }
        if ("LBody".equals(role)) inBody = true;
        walkStructure(dict.getItem(COSName.K), dict, page, ancestors, form, listItem, inBody, depth + 1);
    }

    @SuppressWarnings("unchecked")
    private void addContent(List<Map<String, Object>> ancestors, COSDictionary page, COSBase stream, int mcid) {
        if (ancestors.isEmpty()) return;
        Integer number = pagesByDict.get(page);
        if (number == null || mcid < 0) { issues.add("UNRESOLVED_HEADING_CONTENT"); return; }
        String id = "page:" + number + ":stream:" + (stream == null ? "page" : ref(stream)) + ":mcid:" + mcid;
        for (var heading : ancestors) ((List<String>) heading.get("contentRefs")).add(id);
    }

    private void guard(int depth) throws IOException {
        if (depth > MAX_DEPTH || ++walked > MAX_NODES) throw new IOException("Inspection traversal limit exceeded");
    }
    private String resolveRole(String role, String location) {
        Set<String> seen = new HashSet<>();
        while (!STANDARD_ROLES.contains(role)) {
            if (!seen.add(role) || seen.size() > 128) { issues.add("ROLE_MAP_CYCLE:" + location); return role; }
            COSBase mapped = roleMap == null ? null : roleMap.getDictionaryObject(COSName.getPDFName(role));
            if (!(mapped instanceof COSName)) { issues.add("UNMAPPED_ROLE:" + location + ":" + role); return role; }
            role = ((COSName) mapped).getName();
        }
        return role;
    }
    private void verifyContent(COSDictionary parent, COSDictionary page, COSBase stream, int mcid) {
        String contentRef = SavedContentInspector.key(pagesByDict.getOrDefault(page, 0), stream, mcid);
        recordContent(parent, contentRef);
        if (!savedContent.contains(contentRef)) issues.add("MISSING_MARKED_CONTENT_SEQUENCE:" + contentRef);
        COSDictionary owner = stream instanceof COSDictionary ? (COSDictionary) stream : page;
        if (stream != null && !(stream instanceof COSStream)) issues.add("INVALID_MCR_STREAM:" + ref(parent));
        if (owner != null) registerParentScope(owner);
        int slot = owner == null ? -1 : owner.getInt(COSName.STRUCT_PARENTS, -1);
        COSBase value = resolve(parentSlots.get(slot));
        if (mcid < 0 || !(value instanceof COSArray) || mcid >= ((COSArray) value).size() || ((COSArray) value).getObject(mcid) != parent) issues.add("MCID_PARENT_TREE_MISMATCH:" + ref(parent) + ":" + mcid);
        String key = ref(owner) + ":" + mcid;
        if (contentOwners.putIfAbsent(key, ref(parent)) != null) issues.add("DUPLICATE_CONTENT_OWNER:" + key);
    }
    private void registerParentScope(COSDictionary scope) {
        if (!registeredScopes.add(scope)) return;
        if (scope.containsKey(COSName.STRUCT_PARENT) && scope.containsKey(COSName.STRUCT_PARENTS)) issues.add("CONFLICTING_PARENT_SCOPE_KEYS:" + ref(scope));
        for (COSName name : List.of(COSName.STRUCT_PARENT, COSName.STRUCT_PARENTS)) {
            COSBase value = scope.getDictionaryObject(name);
            if (value == null) continue;
            if (!(value instanceof COSInteger) || ((COSInteger)value).longValue() < 0 || ((COSInteger)value).longValue() > Integer.MAX_VALUE) {
                issues.add("INVALID_PARENT_SCOPE_KEY:" + ref(scope)); continue;
            }
            int key = ((COSInteger)value).intValue();
            COSDictionary previous = parentScopes.putIfAbsent(key, scope);
            if (previous != null && previous != scope) issues.add("DUPLICATE_PARENT_SCOPE_KEY:" + key);
        }
    }
    @SuppressWarnings("unchecked")
    private void recordContent(COSDictionary owner, String key) {
        contentOrder.add(key);
        Map<String, Object> item = structureByDict.get(owner);
        if (item != null) ((List<String>) item.get("contentRefs")).add(key);
    }
    @SuppressWarnings("unchecked")
    private void readSemanticClasses(COSBase raw, Map<String,Object> item, int depth) throws IOException {
        if(depth>16)throw new IOException("Semantic class nesting limit exceeded");
        COSBase value=resolve(raw);
        if(value instanceof COSArray)for(COSBase c:(COSArray)value)readSemanticClasses(c,item,depth+1);
        else if(value instanceof COSName) {
            COSBase attrs=classMap==null?null:classMap.getDictionaryObject((COSName)value);
            if(attrs==null)issues.add("UNRESOLVED_ATTRIBUTE_CLASS:"+item.get("objectRef"));
            else readSemanticAttributes(attrs,item,0);
        }
    }
    @SuppressWarnings("unchecked")
    private void readSemanticAttributes(COSBase raw, Map<String, Object> item, int depth) throws IOException {
        if (depth > 16) throw new IOException("Semantic attribute nesting limit exceeded");
        COSBase value = resolve(raw);
        if (value instanceof COSArray) { for (COSBase v : (COSArray)value) readSemanticAttributes(v, item, depth + 1); }
        else if (value instanceof COSDictionary) {
            COSDictionary a = (COSDictionary)value;
            if ("Table".equals(a.getNameAsString(COSName.O))) {
                if(a.containsKey(COSName.getPDFName("Scope")))item.put("scope", a.getNameAsString(COSName.getPDFName("Scope"), ""));
                if(a.containsKey(COSName.getPDFName("RowSpan")))item.put("rowSpan", a.getInt(COSName.getPDFName("RowSpan"), 1));
                if(a.containsKey(COSName.getPDFName("ColSpan")))item.put("columnSpan", a.getInt(COSName.getPDFName("ColSpan"), 1));
                COSArray headers = a.getCOSArray(COSName.getPDFName("Headers"));
                if(headers!=null)((List<String>)item.get("headers")).clear();
                if (headers != null) for (COSBase h : headers) {
                    COSBase resolved = resolve(h);
                    if (resolved instanceof COSString) ((List<String>)item.get("headers")).add(((COSString)resolved).getString());
                    else issues.add("INVALID_HEADER_REFERENCE:" + item.get("objectRef"));
                }
            }
            if ("List".equals(a.getNameAsString(COSName.O))) item.put("listNumbering", a.getNameAsString(COSName.getPDFName("ListNumbering"), ""));
        }
    }
    private void checkReachableParentTarget(COSBase raw, int slot) {
        COSBase value = resolve(raw);
        if (value == null || value instanceof COSNull) return;
        if (!(value instanceof COSDictionary) || !elements.contains(value)) issues.add("UNREACHABLE_PARENT_TREE_TARGET:" + slot);
    }
    private void readTree(COSBase raw, boolean names, Set<COSBase> seen, int depth) throws IOException {
        COSBase value = resolve(raw); guard(depth);
        if (value == null) return;
        if (!(value instanceof COSDictionary) || !seen.add(value)) { issues.add("INVALID_REFERENCE_TREE"); return; }
        COSDictionary node = (COSDictionary) value;
        COSArray pairs = node.getCOSArray(names ? COSName.NAMES : COSName.NUMS);
        if (pairs != null) {
            if (pairs.size() % 2 != 0) issues.add("ODD_REFERENCE_TREE_PAIRS");
            for (int i = 0; i + 1 < pairs.size(); i += 2) {
                COSBase key = pairs.getObject(i), target = pairs.get(i + 1);
                if (names && key instanceof COSString) {
                    if (idSlots.putIfAbsent(((COSString) key).getString(), target) != null) issues.add("DUPLICATE_ID_TREE_KEY");
                } else if (!names && key instanceof COSInteger) {
                    if (parentSlots.putIfAbsent(((COSInteger) key).intValue(), target) != null) issues.add("DUPLICATE_PARENT_TREE_KEY");
                } else issues.add("INVALID_REFERENCE_TREE_KEY");
            }
        }
        COSArray kids = node.getCOSArray(COSName.KIDS);
        if (kids != null) for (COSBase kid : kids) readTree(kid, names, seen, depth + 1);
    }
    private static COSBase resolve(COSBase value) { return value instanceof COSObject ? ((COSObject) value).getObject() : value; }
    private static String requiredRef(COSBase value) throws IOException {
        String key = ref(value);
        if ("direct".equals(key)) throw new IOException("Direct field or widget lacks stable identity");
        return key;
    }
    private static String fieldRefs(COSBase value) throws IOException {
        value = resolve(value);
        if (value == null) return "[]";
        if (!(value instanceof COSArray)) throw new IOException("Field children must be an array");
        List<String> refs = new ArrayList<>();
        for (COSBase child : (COSArray) value) refs.add(requiredRef(child));
        return refs.toString();
    }
    private static String ref(COSBase value) {
        COSBase object = resolve(value);
        if (object == null || object.getKey() == null) return "direct";
        return object.getKey().getNumber() + " " + object.getKey().getGeneration() + " R";
    }
    private static String hash(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
    private static String streamHash(InputStream in, long limit) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[8192]; long total = 0; int n;
        while ((n = in.read(buffer)) != -1) { total += n; if (total > limit) throw new IOException("Inspection stream limit exceeded"); digest.update(buffer, 0, n); }
        return HexFormat.of().formatHex(digest.digest());
    }
    // Appearance bytes and geometry remain exact. Resource dictionaries may
    // receive existing separately audited Unicode maps; no appearance is rebuilt.
    private static String widgetAppearance(COSBase value) throws Exception {
        value=resolve(value);if(value==null)return "absent";
        if(value instanceof COSStream)return fingerprint(value,Set.of("Resources"));
        if(!(value instanceof COSDictionary))throw new IOException("Invalid widget appearance dictionary");
        List<COSName> keys=new ArrayList<>(((COSDictionary)value).keySet());keys.sort(Comparator.comparing(COSName::getName));StringBuilder result=new StringBuilder();
        for(COSName key:keys) {
            COSBase entry=((COSDictionary)value).getDictionaryObject(key);
            if(entry instanceof COSStream)result.append(key.getName()).append(':').append(fingerprint(entry,Set.of("Resources")));
            else if(entry instanceof COSDictionary) {
                List<COSName> states=new ArrayList<>(((COSDictionary)entry).keySet());states.sort(Comparator.comparing(COSName::getName));
                for(COSName state:states) {COSBase stream=((COSDictionary)entry).getDictionaryObject(state);if(!(stream instanceof COSStream))throw new IOException("Invalid widget appearance state");result.append(key.getName()).append('/').append(state.getName()).append(':').append(fingerprint(stream,Set.of("Resources")));}
            } else throw new IOException("Invalid widget appearance entry");
        }
        return hash(result.toString());
    }
    static String fingerprint(COSBase value, Set<String> skip) throws Exception {
        return hash(canonical(value, skip, Collections.newSetFromMap(new IdentityHashMap<>()), new int[]{0}, 0));
    }
    static String navigationFingerprint(COSBase value,Set<String> skip,Map<COSDictionary,Integer> pages,int[] work)throws Exception {
        return hash(navigationCanonical(value,skip,pages,new IdentityHashMap<>(),work,0));
    }
    private static String navigationCanonical(COSBase raw,Set<String> skip,Map<COSDictionary,Integer> pages,Map<COSBase,Integer> seen,int[] work,int depth)throws Exception {
        if(depth>MAX_DEPTH||++work[0]>1000000)throw new IOException("Navigation fingerprint limit exceeded");
        COSBase v=resolve(raw);
        if(v==null||v instanceof COSNull)return "null";
        if(v instanceof COSString s){if(s.getBytes().length>1024*1024)throw new IOException("Navigation string limit exceeded");return "string:"+HexFormat.of().formatHex(s.getBytes());}
        if(!(v instanceof COSArray)&&!(v instanceof COSDictionary))return v.toString();
        if(v instanceof COSDictionary&&pages.containsKey(v))return "page:"+pages.get(v);
        if(seen.containsKey(v))return "shared:"+seen.get(v);
        seen.put(v,seen.size());StringBuilder out=new StringBuilder();
        if(v instanceof COSArray a){out.append('[');for(COSBase c:a){String item=navigationCanonical(c,Set.of(),pages,seen,work,depth+1);out.append(item.length()).append(':').append(item);if(out.length()>16*1024*1024)throw new IOException("Navigation fingerprint byte limit exceeded");}return out.append(']').toString();}
        COSDictionary d=(COSDictionary)v;out.append('{');List<COSName> keys=new ArrayList<>(d.keySet());keys.sort(Comparator.comparing(COSName::getName));
        for(COSName key:keys){if(skip.contains(key.getName())||(v instanceof COSStream&&Set.of(COSName.LENGTH,COSName.FILTER,COSName.DECODE_PARMS).contains(key)))continue;String item=navigationCanonical(d.getItem(key),Set.of(),pages,seen,work,depth+1);out.append(key.getName().length()).append(':').append(key.getName()).append(item.length()).append(':').append(item);if(out.length()>16*1024*1024)throw new IOException("Navigation fingerprint byte limit exceeded");}
        if(v instanceof COSStream s)try(InputStream in=s.createInputStream()){out.append("stream:").append(streamHash(in,MAX_STREAM_BYTES));}
        return out.append('}').toString();
    }
    private static String canonical(COSBase raw, Set<String> skip, Set<COSBase> active, int[] count, int depth) throws Exception {
        return canonical(raw,skip,active,count,depth,null);
    }
    private static String canonical(COSBase raw, Set<String> skip, Set<COSBase> active, int[] count, int depth, Map<COSDictionary,Integer> pageRefs) throws Exception {
        if (depth > MAX_DEPTH || ++count[0] > MAX_NODES) throw new IOException("Resource traversal limit exceeded");
        COSBase value = resolve(raw);
        if (value == null || value instanceof COSNull) return "null";
        if (value instanceof COSString) return "string:" + HexFormat.of().formatHex(((COSString) value).getBytes());
        if (!(value instanceof COSArray) && !(value instanceof COSDictionary)) return value.toString();
        // A local destination points to a page, whose content is intentionally
        // rewritten by native tagging. Preserve target identity by page ordinal
        // rather than hashing the entire page graph as part of a link action.
        if(pageRefs!=null&&value instanceof COSDictionary&&pageRefs.containsKey(value))return "page:"+pageRefs.get(value);
        if (!active.add(value)) return "cycle:" + ref(value);
        try {
            if (value instanceof COSArray) {
                StringBuilder out = new StringBuilder("[");
                for (COSBase kid : (COSArray) value) { String item = canonical(kid, Set.of(), active, count, depth + 1,pageRefs); out.append(item.length()).append(':').append(item); }
                return out.append(']').toString();
            }
            COSDictionary dict = (COSDictionary) value; StringBuilder out = new StringBuilder("{");
            List<COSName> keys = new ArrayList<>(dict.keySet()); keys.sort(Comparator.comparing(COSName::getName));
            for (COSName key : keys) {
                if (skip.contains(key.getName()) || (value instanceof COSStream && Set.of("Length", "Filter", "DecodeParms").contains(key.getName()))) continue;
                String item = canonical(dict.getItem(key), Set.of(), active, count, depth + 1,pageRefs);
                out.append(key.getName().length()).append(':').append(key.getName()).append(item.length()).append(':').append(item);
            }
            if (value instanceof COSStream) try (InputStream in = ((COSStream) value).createInputStream()) { out.append("stream:").append(streamHash(in, MAX_STREAM_BYTES)); }
            return out.append('}').toString();
        } finally { active.remove(value); }
    }
}
