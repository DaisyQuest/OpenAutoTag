import java.io.*;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

/** PDF 1.x structure metadata only. Never rewrites content, resources or field appearances. */
public final class QualifiedSemanticRepairs {
    private static final Set<String> STANDARD_ROLES = Set.of("Document", "Part", "Art", "Sect", "Div", "BlockQuote", "Caption", "TOC", "TOCI",
        "Index", "NonStruct", "Private", "P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "L", "LI", "Lbl", "LBody", "Table", "TR", "TH", "TD",
        "THead", "TBody", "TFoot", "Span", "Quote", "Note", "Reference", "BibEntry", "Code", "Link", "Annot", "Ruby", "RB", "RT", "RP",
        "Warichu", "WT", "WP", "Figure", "Formula", "Form");
    public record FigureDecision(String ref, String alt) {}
    private record Content(COSDictionary page, int mcid, COSDictionary owner) {}
    private static COSBase resolve(COSBase v) { return v instanceof COSObject ? ((COSObject)v).getObject() : v; }
    private static String ref(COSDictionary d) { return d.getKey() == null ? "direct" : d.getKey().getNumber() + " " + d.getKey().getGeneration() + " R"; }
    private static <T> Set<T> identities() { return Collections.newSetFromMap(new IdentityHashMap<>()); }
    private static void record(List<Map<String,Object>> out, String rule, String target, String decision, String reason) {
        out.add(Map.of("ruleId", rule, "version", 1, "target", target, "decision", decision, "reason", reason));
    }
    private static void collect(COSBase raw, COSDictionary parent, COSDictionary page, List<COSDictionary> elements,
            List<Content> content, Set<COSBase> seen, int depth) throws IOException {
        COSBase v = resolve(raw);
        if (v == null) return;
        if (depth > 128 || seen.size() > 100000) throw new IOException("Excessive semantic structure");
        if (v instanceof COSInteger) {
            long id = ((COSInteger)v).longValue();
            if (id < 0 || id > Integer.MAX_VALUE) throw new IOException("Invalid MCID in structure");
            content.add(new Content(page, (int)id, parent)); return;
        }
        if (!seen.add(v)) throw new IOException("Shared or cyclic semantic structure");
        if (v instanceof COSArray) { for (COSBase child : (COSArray)v) collect(child, parent, page, elements, content, seen, depth + 1); return; }
        if (!(v instanceof COSDictionary)) throw new IOException("Invalid semantic structure child");
        COSDictionary d = (COSDictionary)v;
        COSDictionary effectivePage = d.getCOSDictionary(COSName.PG); if (effectivePage == null) effectivePage = page;
        if (d.containsKey(COSName.S)) {
            if (d.getCOSDictionary(COSName.P) != parent) throw new IOException("Incorrect semantic structure parent");
            if (d.containsKey(COSName.getPDFName("NS"))) throw new IOException("Namespaced structure is outside PDF 1.x repair scope");
            elements.add(d); collect(d.getItem(COSName.K), d, effectivePage, elements, content, seen, depth + 1);
        } else if ("MCR".equals(d.getNameAsString(COSName.TYPE))) {
            if (!d.containsKey(COSName.getPDFName("Stm"))) collect(d.getItem(COSName.MCID), parent, effectivePage, elements, content, seen, depth + 1);
        } else if (!"OBJR".equals(d.getNameAsString(COSName.TYPE))) throw new IOException("Invalid semantic structure dictionary");
    }
    private static String role(COSDictionary element, COSDictionary roleMap) throws IOException {
        String role = element.getNameAsString(COSName.S, ""); Set<String> seen = new HashSet<>();
        while (roleMap != null && roleMap.containsKey(COSName.getPDFName(role))) {
            if (!seen.add(role) || seen.size() > 128) throw new IOException("Cyclic RoleMap in semantic repair");
            // Standard roles cannot be redefined. In particular, never rewrite a mapped H1-H6.
            if (STANDARD_ROLES.contains(role))
                throw new IOException("Redefined standard role in semantic repair");
            role = roleMap.getNameAsString(COSName.getPDFName(role), "");
            if (role.isEmpty()) throw new IOException("Invalid RoleMap target");
        }
        return role;
    }
    private static Map<COSDictionary,String> headingPlan(List<COSDictionary> elements, COSDictionary roleMap, List<Map<String,Object>> ledger) throws IOException {
        List<COSDictionary> headings = new ArrayList<>(); TreeSet<Integer> levels = new TreeSet<>(); boolean generic = false;
        Map<COSDictionary,Integer> ranks = new IdentityHashMap<>();
        for (COSDictionary e : elements) {
            String r = role(e, roleMap);
            if (r.equals("H") || r.matches("H[0-9]+") && !r.matches("H[1-6]")) generic = true;
            if (r.matches("H[1-6]")) { headings.add(e); int n = r.charAt(1)-'0'; levels.add(n); ranks.put(e,n); }
        }
        Map<COSDictionary,String> plan = new LinkedHashMap<>(); if (headings.isEmpty()) return plan;
        int previous = 0;
        for (COSDictionary e : headings) {
            int rank = levels.headSet(ranks.get(e), true).size();
            // A single monotone mapping preserves peers and relative depth throughout the document.
            // If it cannot fix every jump, guessing a different level per occurrence is unsafe.
            if (generic || rank > previous + 1) {
                record(ledger, "heading-rank-compaction", "structure-tree", "review", "Mixed or ambiguous heading hierarchy; existing levels retained"); return plan;
            }
            previous = rank;
        }
        for (COSDictionary e : headings) {
            String target = "H" + levels.headSet(ranks.get(e), true).size();
            if (!target.equals(role(e, roleMap))) plan.put(e, target);
        }
        return plan;
    }
    private static void slots(COSDictionary tree, Map<Integer,COSBase> out, Set<COSDictionary> seen, int depth) throws IOException {
        if (tree == null || depth > 128 || seen.size() > 10000 || !seen.add(tree)) throw new IOException("Invalid ParentTree in figure repair");
        COSArray nums = tree.getCOSArray(COSName.NUMS), kids = tree.getCOSArray(COSName.KIDS);
        if ((nums == null) == (kids == null)) throw new IOException("Invalid ParentTree node");
        if (nums != null) {
            if (nums.size() % 2 != 0) throw new IOException("Odd ParentTree pairs");
            for (int i=0;i<nums.size();i+=2) {
                COSBase key = nums.getObject(i);
                if (!(key instanceof COSInteger) || ((COSInteger)key).longValue()<0 || ((COSInteger)key).longValue()>Integer.MAX_VALUE ||
                    out.putIfAbsent(((COSInteger)key).intValue(), nums.get(i+1)) != null) throw new IOException("Invalid ParentTree key");
            }
        } else for (COSBase child : kids) {
            if (!(resolve(child) instanceof COSDictionary)) throw new IOException("Invalid ParentTree child");
            slots((COSDictionary)resolve(child), out, seen, depth+1);
        }
    }
    private static final Set<String> IMAGE_OPERATORS = Set.of("q","Q","cm","w","J","j","M","d","ri","i","gs",
        "m","l","c","v","y","h","re","W","W*","n","CS","cs","SC","SCN","sc","scn","G","g","RG","rg","K","k");
    /** Qualify one image-only page MCID; inline images, Forms, nested content and text require review. */
    private static void requireImage(PDPage page, int wanted) throws IOException {
        byte[] bytes; try (InputStream in = page.getContents()) { bytes = in.readNBytes(32*1024*1024+1); }
        if (bytes.length > 32*1024*1024) throw new IOException("Figure content exceeds limit");
        List<Object> tokens = new PDFStreamParser(bytes).parse();
        if (tokens.size() > 1000000) throw new IOException("Excessive figure content tokens");
        List<COSBase> operands = new ArrayList<>(); List<Integer> stack = new ArrayList<>(); int occurrences=0, images=0;
        for (Object token : tokens) {
            if (!(token instanceof Operator)) { if (token instanceof COSBase) operands.add((COSBase)token); continue; }
            String op = ((Operator)token).getName(); boolean active = stack.contains(wanted);
            if (op.equals("BDC") || op.equals("BMC")) {
                int mcid=-1;
                if (op.equals("BDC")) {
                    if (operands.size()!=2) throw new IOException("Invalid marked content");
                    COSBase props=resolve(operands.get(1));
                    if (props instanceof COSName && page.getResources()!=null) {
                        var list=page.getResources().getProperties((COSName)props); props=list==null?null:list.getCOSObject();
                    }
                    if (props instanceof COSDictionary) {
                        COSDictionary properties=(COSDictionary)props; mcid=properties.getInt(COSName.MCID,-1);
                        if (mcid==wanted && (properties.containsKey(COSName.ALT) || properties.containsKey(COSName.ACTUAL_TEXT) ||
                            !(operands.get(0) instanceof COSName) || "Artifact".equals(((COSName)operands.get(0)).getName())))
                            throw new IOException("Figure content has conflicting semantics");
                    }
                }
                boolean clipWrapper = op.equals("BMC") && operands.size()==1 && operands.get(0) instanceof COSName &&
                    Set.of("Clip", "ClipSpan").contains(((COSName)operands.get(0)).getName());
                if (active && !clipWrapper || mcid==wanted && !stack.isEmpty()) throw new IOException("Nested figure marked content");
                if (mcid==wanted) occurrences++;
                if (stack.size()>=128) throw new IOException("Excessive marked content nesting");
                stack.add(mcid);
            } else if (op.equals("EMC")) {
                if (stack.isEmpty()) throw new IOException("Unbalanced marked content"); stack.remove(stack.size()-1);
            } else if (active) {
                if (op.equals("Do")) {
                    if (operands.size()!=1 || !(operands.get(0) instanceof COSName) || page.getResources()==null ||
                        !(page.getResources().getXObject((COSName)operands.get(0)) instanceof PDImageXObject)) throw new IOException("Figure is not an image-only leaf");
                    images++;
                } else if (!IMAGE_OPERATORS.contains(op)) throw new IOException("Figure contains text or unsupported painting");
            }
            operands.clear();
        }
        if (!stack.isEmpty() || occurrences!=1 || images!=1) throw new IOException("Figure must own exactly one image occurrence");
    }
    public static List<Map<String,Object>> apply(PDDocument doc, List<FigureDecision> decisions) throws IOException {
        return apply(doc, decisions, false);
    }
    private static boolean layoutOnly(COSBase raw, COSDictionary classes, int depth) throws IOException {
        if(depth>16) throw new IOException("Excessive heading class nesting");
        COSBase value=resolve(raw);
        if(value==null) return true;
        if(value instanceof COSName) return classes!=null && classes.containsKey((COSName)value) && layoutOnly(classes.getItem((COSName)value),classes,depth+1);
        if(value instanceof COSDictionary) return "Layout".equals(((COSDictionary)value).getNameAsString(COSName.O));
        if(value instanceof COSArray) { for(COSBase child:(COSArray)value) if(!(resolve(child) instanceof COSInteger) && !layoutOnly(child,classes,depth+1)) return false; return true; }
        return false;
    }
    public static List<Map<String,Object>> apply(PDDocument doc, List<FigureDecision> decisions, boolean splitForms) throws IOException {
        return apply(doc, decisions, splitForms, List.of());
    }
    public static List<Map<String,Object>> apply(PDDocument doc, List<FigureDecision> decisions, boolean splitForms, List<String> paragraphs) throws IOException {
        if (doc.isEncrypted() || !doc.getSignatureDictionaries().isEmpty() || doc.getVersion()>=2) throw new IOException("Signed, encrypted or PDF 2.x files are outside semantic repair scope");
        List<Map<String,Object>> ledger=new ArrayList<>(); var structure=doc.getDocumentCatalog().getStructureTreeRoot();
        if (structure==null) { if (!decisions.isEmpty() || !paragraphs.isEmpty()) throw new IOException("Reviewed target has no structure tree"); return ledger; }
        COSDictionary root=structure.getCOSObject(), roleMap=root.getCOSDictionary(COSName.ROLE_MAP);
        if (root.containsKey(COSName.getPDFName("Namespaces"))) throw new IOException("Namespaced structure is outside PDF 1.x repair scope");
        List<COSDictionary> elements=new ArrayList<>(); List<Content> content=new ArrayList<>();
        collect(root.getItem(COSName.K),root,null,elements,content,identities(),0);
        Map<COSDictionary,String> headings, figures=new LinkedHashMap<>();
        Map<String,COSDictionary> byRef=new HashMap<>(); for(COSDictionary e:elements) if(!ref(e).equals("direct")) byRef.put(ref(e),e);
        Map<Integer,COSBase> parentSlots=new HashMap<>();
        if(!decisions.isEmpty() || !paragraphs.isEmpty()) slots(root.getCOSDictionary(COSName.PARENT_TREE),parentSlots,identities(),0);
        List<COSDictionary> paragraphTargets=new ArrayList<>(); Set<COSDictionary> seenParagraphs=identities();
        for(String decision:paragraphs) {
            COSDictionary e=byRef.get(decision);
            if(e==null || !e.getNameAsString(COSName.S, "").matches("H[1-6]") || !seenParagraphs.add(e) ||
                e.containsKey(COSName.ALT) || e.containsKey(COSName.ACTUAL_TEXT) || e.containsKey(COSName.getPDFName("Ref")) ||
                !layoutOnly(e.getItem(COSName.A),root.getCOSDictionary(COSName.CLASS_MAP),0) ||
                !layoutOnly(e.getItem(COSName.C),root.getCOSDictionary(COSName.CLASS_MAP),0)) throw new IOException("Paragraph decision requires a unique heading with only layout attributes");
            COSBase kids=resolve(e.getItem(COSName.K)); List<COSBase> children=new ArrayList<>();
            if(kids instanceof COSArray) for(COSBase child:(COSArray)kids) children.add(resolve(child)); else children.add(kids);
            int mcid=-1;
            for(COSBase child:children) {
                if(child instanceof COSInteger && mcid<0) mcid=((COSInteger)child).intValue();
                else if(!(child instanceof COSDictionary) || !"StructElem".equals(((COSDictionary)child).getNameAsString(COSName.TYPE)) || !"Form".equals(role((COSDictionary)child,roleMap)))
                    throw new IOException("Reviewed heading must contain one text MCID and optional existing Form children");
            }
            int targetMcid=mcid; COSDictionary pg=e.getCOSDictionary(COSName.PG);
            boolean actualPage=false; for(PDPage page:doc.getPages()) if(page.getCOSObject()==pg) { actualPage=true; break; }
            COSBase slot=pg==null?null:resolve(parentSlots.get(pg.getInt(COSName.STRUCT_PARENTS,-1)));
            if(!actualPage || mcid<0 || !(slot instanceof COSArray) || mcid>=((COSArray)slot).size() || ((COSArray)slot).getObject(mcid)!=e ||
                content.stream().filter(c->c.page()==pg && c.mcid()==targetMcid).count()!=1) throw new IOException("Paragraph heading ownership is not unique and reciprocal");
            paragraphTargets.add(e);
        }
        // Compute compaction after removing reviewed labels from heading membership.
        List<COSDictionary> remainingHeadings=new ArrayList<>(elements); remainingHeadings.removeAll(paragraphTargets);
        headings=headingPlan(remainingHeadings,roleMap,ledger);
        for(FigureDecision decision:decisions) {
            COSDictionary e=byRef.get(decision.ref()); String alt=decision.alt();
            if(e==null || figures.containsKey(e) || alt==null || alt.isBlank() || alt.length()>4096 || alt.chars().anyMatch(Character::isISOControl)) throw new IOException("Invalid or duplicate reviewed figure decision");
            if(!"Artifact".equals(e.getNameAsString(COSName.S)) || roleMap!=null && roleMap.containsKey(COSName.getPDFName("Artifact")) ||
                e.containsKey(COSName.ALT) || e.containsKey(COSName.ACTUAL_TEXT) || !(resolve(e.getItem(COSName.K)) instanceof COSInteger)) throw new IOException("Figure target is not an unmapped, undescribed Artifact leaf");
            int mcid=e.getInt(COSName.K,-1); COSDictionary pageDict=e.getCOSDictionary(COSName.PG); PDPage page=null;
            for(PDPage p:doc.getPages()) if(p.getCOSObject()==pageDict) { page=p; break; }
            COSBase slot=page==null?null:resolve(parentSlots.get(pageDict.getInt(COSName.STRUCT_PARENTS,-1)));
            if(mcid<0 || !(slot instanceof COSArray) || mcid>=((COSArray)slot).size() || ((COSArray)slot).getObject(mcid)!=e ||
                content.stream().filter(c->c.page()==pageDict && c.mcid()==mcid).count()!=1) throw new IOException("Figure ownership is not unique and reciprocal");
            requireImage(page,mcid); figures.put(e,alt);
        }
        // Commit only after every supplied decision passes preflight.
        for(COSDictionary e:paragraphTargets) {
            e.setName(COSName.S,"P");
            record(ledger,"reviewed-heading-paragraph",ref(e),"apply","Reviewed field label: heading -> P; all content and ownership retained");
        }
        for(var entry:headings.entrySet()) {
            COSDictionary e=entry.getKey(); String before=e.getNameAsString(COSName.S); e.setName(COSName.S,entry.getValue());
            record(ledger,"heading-rank-compaction",ref(e),"apply",before+" -> "+entry.getValue()+"; peer levels and all content retained");
        }
        for(var entry:figures.entrySet()) {
            entry.getKey().setName(COSName.S,"Figure"); entry.getKey().setString(COSName.ALT,entry.getValue());
            record(ledger,"reviewed-image-role",ref(entry.getKey()),"apply","Artifact -> Figure; reviewed Alt="+entry.getValue());
        }
        for(COSDictionary e:elements) if("Artifact".equals(e.getNameAsString(COSName.S)) && (roleMap==null || !roleMap.containsKey(COSName.getPDFName("Artifact"))))
            record(ledger,"reviewed-image-role",ref(e),"review","Unmapped Artifact requires reviewed semantics; no guessed role or description");
        if(splitForms) splitIndependentForms(doc,root,elements,ledger);
        return ledger;
    }

    private record Slot(COSArray nums,int index) {}
    private static void collectSlots(COSDictionary tree,Map<Integer,Slot> out) {
        COSArray nums=tree.getCOSArray(COSName.NUMS), kids=tree.getCOSArray(COSName.KIDS);
        if(nums!=null) for(int i=0;i<nums.size();i+=2)out.put(((COSInteger)nums.getObject(i)).intValue(),new Slot(nums,i+1));
        if(kids!=null) for(COSBase child:kids)collectSlots((COSDictionary)resolve(child),out);
    }
    /** Split only bare Form containers for distinct terminal fields with fully reciprocal ownership. */
    private static void splitIndependentForms(PDDocument doc,COSDictionary root,List<COSDictionary> elements,List<Map<String,Object>> ledger) throws IOException {
        COSDictionary tree=root.getCOSDictionary(COSName.PARENT_TREE); Map<Integer,COSBase> owners=new HashMap<>();
        slots(tree,owners,identities(),0); // Validate bounds, cycles and duplicate keys before locating mutable slots.
        Map<Integer,Slot> slotLocations=new HashMap<>(); collectSlots(tree,slotLocations);
        Map<COSDictionary,COSDictionary> fields=new IdentityHashMap<>(), pages=new IdentityHashMap<>();
        var form=doc.getDocumentCatalog().getAcroForm(null);
        if(form==null)return;
        int fieldCount=0;
        for(var field:form.getFieldTree()) {
            if(++fieldCount>100000)throw new IOException("Excessive field tree");
            if(field instanceof org.apache.pdfbox.pdmodel.interactive.form.PDTerminalField)for(var widget:field.getWidgets())
                if(fields.put(widget.getCOSObject(),field.getCOSObject())!=null)throw new IOException("Shared terminal field widget");
        }
        Set<Integer> usedSlots=new HashSet<>();
        for(PDPage page:doc.getPages())for(var annotation:page.getAnnotations()) {
            COSDictionary a=annotation.getCOSObject();
            if(pages.put(a,page.getCOSObject())!=null)throw new IOException("Shared page annotation");
            if(a.containsKey(COSName.STRUCT_PARENT) && !usedSlots.add(a.getInt(COSName.STRUCT_PARENT,-1)))throw new IOException("Shared annotation ParentTree slot");
        }
        Map<COSDictionary,Integer> references=new IdentityHashMap<>();
        for(COSDictionary e:elements) {
            COSBase k=resolve(e.getItem(COSName.K)); List<? extends COSBase> kids=k instanceof COSArray?((COSArray)k).toList():k==null?List.of():List.of(k);
            for(COSBase child:kids)if(resolve(child) instanceof COSDictionary) {
                COSDictionary d=(COSDictionary)resolve(child);
                if("OBJR".equals(d.getNameAsString(COSName.TYPE)) && d.getCOSDictionary(COSName.OBJ)!=null)references.merge(d.getCOSDictionary(COSName.OBJ),1,Integer::sum);
            }
        }
        for(COSDictionary e:elements) {
            if(!"Form".equals(e.getNameAsString(COSName.S)))continue;
            COSArray kids=e.getCOSArray(COSName.K); if(kids==null || kids.size()<2)continue;
            boolean valid=e.keySet().stream().allMatch(k->Set.of("Type","S","P","Pg","ID","K").contains(k.getName()));
            COSDictionary parent=e.getCOSDictionary(COSName.P); COSBase siblings=parent==null?null:resolve(parent.getItem(COSName.K));
            int occurrences=0;
            if(siblings instanceof COSArray) { for(COSBase s:(COSArray)siblings)if(resolve(s)==e)occurrences++; }
            else if(siblings==e)occurrences++;
            valid &= occurrences==1;
            Set<COSDictionary> distinctFields=identities(); List<Integer> keys=new ArrayList<>();
            for(COSBase child:kids) {
                COSBase v=resolve(child); if(!(v instanceof COSDictionary)) { valid=false; break; }
                COSDictionary objr=(COSDictionary)v, widget=objr.getCOSDictionary(COSName.OBJ), page=objr.getCOSDictionary(COSName.PG);
                if(page==null)page=e.getCOSDictionary(COSName.PG);
                if(widget==null || !"OBJR".equals(objr.getNameAsString(COSName.TYPE)) || !fields.containsKey(widget) ||
                    !"Widget".equals(widget.getNameAsString(COSName.SUBTYPE)) || pages.get(widget)!=page || page==null ||
                    widget.getCOSDictionary(COSName.P)!=null && widget.getCOSDictionary(COSName.P)!=page ||
                    !distinctFields.add(fields.get(widget)) || references.getOrDefault(widget,0)!=1) { valid=false; break; }
                int key=widget.getInt(COSName.STRUCT_PARENT,-1); keys.add(key);
                if(key<0 || resolve(owners.get(key))!=e)valid=false;
            }
            if(!valid) { record(ledger,"split-independent-form-widgets",ref(e),"review","Ambiguous ownership, shared field, semantic attributes or unsupported children; retained"); continue; }
            List<COSDictionary> added=new ArrayList<>();
            for(int i=1;i<kids.size();i++) {
                COSDictionary newForm=new COSDictionary(); newForm.setName(COSName.TYPE,"StructElem"); newForm.setName(COSName.S,"Form");
                newForm.setItem(COSName.P,parent); if(e.containsKey(COSName.PG))newForm.setItem(COSName.PG,e.getItem(COSName.PG));
                newForm.setItem(COSName.K,kids.get(i)); added.add(newForm);
                Slot slot=slotLocations.get(keys.get(i)); slot.nums().set(slot.index(),newForm);
            }
            COSArray replacement=new COSArray();
            if(siblings instanceof COSArray) {
                for(COSBase s:(COSArray)siblings) { replacement.add(s); if(resolve(s)==e)for(COSDictionary newForm:added)replacement.add(newForm); }
            } else { replacement.add(e); for(COSDictionary newForm:added)replacement.add(newForm); }
            parent.setItem(COSName.K,replacement); e.setItem(COSName.K,kids.get(0));
            record(ledger,"split-independent-form-widgets",ref(e),"apply","Retained first widget and original ID; added "+added.size()+" Form siblings for distinct fields; redirected existing ParentTree slots "+keys.subList(1,keys.size()));
        }
    }
}
