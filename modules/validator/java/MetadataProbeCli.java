import java.io.File;
import java.io.InputStream;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDMetadata;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationLink;
import org.apache.pdfbox.Loader;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.XMLConstants;
import org.w3c.dom.Element;

public class MetadataProbeCli {
    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !"--pdf".equals(args[0])) {
            throw new IllegalArgumentException("Usage: java MetadataProbeCli --pdf <tagged.pdf>");
        }

        File pdfFile = new File(args[1]);
        try (PDDocument document = Loader.loadPDF(pdfFile)) {
            PDMetadata metadata = document.getDocumentCatalog().getMetadata();
            String dcTitle = ""; Long pdfUaPart = null;
            if (metadata != null) {
                byte[] bytes;
                try (InputStream inputStream = metadata.createInputStream()) { bytes = inputStream.readNBytes(16*1024*1024+1); }
                if (bytes.length > 16*1024*1024) throw new IllegalArgumentException("XMP exceeds limit");
                DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance(); factory.setNamespaceAware(true);
                factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
                factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
                factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
                factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, ""); factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
                var xmp = factory.newDocumentBuilder().parse(new java.io.ByteArrayInputStream(bytes));
                var titles = xmp.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title");
                if (titles.getLength()==1) dcTitle = titles.item(0).getTextContent().trim();
                var parts = xmp.getElementsByTagNameNS("http://www.aiim.org/pdfua/ns/id/", "part");
                if (parts.getLength()==1 && parts.item(0).getTextContent().trim().equals("1")) pdfUaPart=1L;
                if (parts.getLength()==0) {
                    var descriptions = xmp.getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "Description");
                    int found=0;
                    for(int i=0;i<descriptions.getLength();i++) {
                        String part=((Element)descriptions.item(i)).getAttributeNS("http://www.aiim.org/pdfua/ns/id/", "part");
                        if (!part.isEmpty()) { found++; if(part.equals("1")) pdfUaPart=1L; }
                    }
                    if(found!=1) pdfUaPart=null;
                }
            }
            boolean containsPdfUaIdentification = Long.valueOf(1).equals(pdfUaPart);
            LinkStructProbe linkProbe = probeAnnotationStructure(document, "Link", "Link");
            WidgetStructProbe widgetProbe = probeWidgetStructureCorrectness(document);

            String json = "{"
                + "\"metadataPresent\":" + (metadata != null)
                + ",\"infoMatchesXmp\":" + java.util.Objects.equals(document.getDocumentInformation().getTitle(), dcTitle)
                + ",\"dcTitleDetected\":" + (dcTitle != null && !dcTitle.isEmpty())
                + ",\"dcTitleValue\":\"" + escapeJson(dcTitle) + "\""
                + ",\"pdfUaIdentificationDetected\":" + containsPdfUaIdentification
                + ",\"pdfUaIdentificationPart\":" + (pdfUaPart == null ? "null" : pdfUaPart.toString())
                + ",\"linkAnnotCount\":" + linkProbe.linkAnnotCount
                + ",\"linkAnnotsWithStructParent\":" + linkProbe.linkAnnotsWithStructParent
                + ",\"linkAnnotsResolvingToLinkElement\":" + linkProbe.linkAnnotsResolvingToLinkElement
                + ",\"linkStructCorrect\":" + linkProbe.allAnnotsCorrect
                + ",\"widgetAnnotCount\":" + widgetProbe.widgetAnnotCount
                + ",\"widgetsInFormStruct\":" + widgetProbe.widgetsInFormStruct
                + ",\"widgetStructCorrect\":" + widgetProbe.allCorrect
                + ",\"formChildRuleCorrect\":" + widgetProbe.formChildRuleCorrect
                + ",\"invalidFormChildCount\":" + widgetProbe.invalidFormChildCount
                + "}";
            System.out.println(json);
        }
    }

    /** Bounded reciprocal annotation ownership diagnostic; never suppresses veraPDF findings. */
    private static class LinkStructProbe {
        int linkAnnotCount;
        int linkAnnotsWithStructParent;
        int linkAnnotsResolvingToLinkElement;
        boolean allAnnotsCorrect;
    }

    private static class LinkBinding {
        final COSDictionary parent, page;
        LinkBinding(COSDictionary parent, COSDictionary page) { this.parent = parent; this.page = page; }
    }
    private static void collectLinkBindings(COSBase raw, COSDictionary parent, COSDictionary page,
        java.util.Map<COSDictionary, java.util.List<LinkBinding>> bindings, Set<COSBase> seen, int depth) {
        COSBase value = resolveIndirect(raw);
        if (value == null || value instanceof COSInteger) return;
        if (depth > 128 || seen.size() > 100000 || !seen.add(value)) throw new IllegalStateException("Invalid structure traversal");
        if (value instanceof COSArray) {
            for (COSBase child : (COSArray)value) collectLinkBindings(child, parent, page, bindings, seen, depth + 1);
            return;
        }
        if (!(value instanceof COSDictionary)) throw new IllegalStateException("Invalid structure child");
        COSDictionary d = (COSDictionary)value;
        COSBase ownPage = d.getDictionaryObject(COSName.PG);
        if (ownPage instanceof COSDictionary) page = (COSDictionary)ownPage;
        String type = d.getNameAsString(COSName.TYPE);
        if ("OBJR".equals(type)) {
            COSBase object = d.getDictionaryObject(COSName.OBJ);
            if (!(object instanceof COSDictionary)) throw new IllegalStateException("Dangling OBJR");
            bindings.computeIfAbsent((COSDictionary)object, key -> new java.util.ArrayList<>()).add(new LinkBinding(parent, page));
        } else if (!"MCR".equals(type)) {
            if (!d.containsKey(COSName.S) || d.getDictionaryObject(COSName.P) != parent) throw new IllegalStateException("Incorrect structure parent");
            collectLinkBindings(d.getItem(COSName.K), d, page, bindings, seen, depth + 1);
        }
    }
    private static LinkStructProbe probeAnnotationStructure(PDDocument doc, String subtype, String targetRole) {
        LinkStructProbe out = new LinkStructProbe();
        try {
            PDStructureTreeRoot treeRoot = doc.getDocumentCatalog().getStructureTreeRoot();
            if (treeRoot == null) return out;
            COSDictionary root = treeRoot.getCOSObject();
            java.util.Map<Integer, COSDictionary> slots = new java.util.HashMap<>();
            COSBase pt = root.getDictionaryObject(COSName.PARENT_TREE);
            if (!(pt instanceof COSDictionary)) return out;
            harvestParentTree((COSDictionary)pt, slots);
            java.util.Map<COSDictionary, java.util.List<LinkBinding>> bindings = new java.util.IdentityHashMap<>();
            collectLinkBindings(root.getItem(COSName.K), root, null, bindings,
                Collections.newSetFromMap(new java.util.IdentityHashMap<COSBase, Boolean>()), 0);
            COSBase rm = root.getDictionaryObject(COSName.ROLE_MAP);
            COSDictionary roles = rm instanceof COSDictionary ? (COSDictionary)rm : null;
            Set<Integer> usedSlots = new HashSet<>();
            boolean uniqueSlots = true;
            Set<COSDictionary> annotations = Collections.newSetFromMap(new java.util.IdentityHashMap<COSDictionary, Boolean>());
            for (PDPage page : doc.getPages()) for (PDAnnotation annot : page.getAnnotations()) {
                COSDictionary dict = annot.getCOSObject();
                COSBase sp = dict.getDictionaryObject(COSName.STRUCT_PARENT);
                if (sp instanceof COSInteger && !usedSlots.add(((COSInteger)sp).intValue())) uniqueSlots = false;
                if (!subtype.equals(annot.getSubtype())) continue;
                out.linkAnnotCount++;
                if (!annotations.add(dict)) continue;
                if (!(sp instanceof COSInteger) || ((COSInteger)sp).longValue() < 0 || ((COSInteger)sp).longValue() > Integer.MAX_VALUE) continue;
                out.linkAnnotsWithStructParent++;
                COSDictionary el = slots.get(((COSInteger)sp).intValue());
                java.util.List<LinkBinding> owned = bindings.get(dict);
                if (el == null || owned == null || owned.size() != 1 || owned.get(0).parent != el || owned.get(0).page != page.getCOSObject()) continue;
                COSBase annotPage = dict.getDictionaryObject(COSName.P);
                if (annotPage != null && annotPage != page.getCOSObject()) continue;
                String role = el.getNameAsString(COSName.S);
                Set<String> seen = new HashSet<>();
                while (role != null && !targetRole.equals(role) && roles != null && seen.add(role) && seen.size() <= 128) role = roles.getNameAsString(COSName.getPDFName(role));
                if (targetRole.equals(role)) out.linkAnnotsResolvingToLinkElement++;
            }
            out.allAnnotsCorrect = uniqueSlots && out.linkAnnotCount > 0 && out.linkAnnotsWithStructParent == out.linkAnnotCount && out.linkAnnotsResolvingToLinkElement == out.linkAnnotCount;
        } catch (Exception e) { out.allAnnotsCorrect = false; }
        return out;
    }

    private static class WidgetStructProbe {
        int widgetAnnotCount, widgetsInFormStruct, invalidFormChildCount;
        boolean allCorrect, formChildRuleCorrect;
    }
    private static WidgetStructProbe probeWidgetStructureCorrectness(PDDocument doc) {
        WidgetStructProbe out=new WidgetStructProbe();
        LinkStructProbe ownership=probeAnnotationStructure(doc,"Widget","Form");
        out.widgetAnnotCount=ownership.linkAnnotCount; out.widgetsInFormStruct=ownership.linkAnnotsResolvingToLinkElement; out.allCorrect=ownership.allAnnotsCorrect;
        try {
            var tree=doc.getDocumentCatalog().getStructureTreeRoot(); if(tree==null)return out;
            COSDictionary root=tree.getCOSObject();
            out.invalidFormChildCount=countInvalidForms(root.getItem(COSName.K),root.getCOSDictionary(COSName.ROLE_MAP),root.getCOSDictionary(COSName.CLASS_MAP),
                Collections.newSetFromMap(new java.util.IdentityHashMap<COSBase,Boolean>()),0);
            out.formChildRuleCorrect=out.invalidFormChildCount==0;
        } catch(Exception e) { out.formChildRuleCorrect=false; }
        return out;
    }
    private static boolean printRole(COSBase raw) {
        return printRole(raw,Collections.newSetFromMap(new java.util.IdentityHashMap<COSBase,Boolean>()),0);
    }
    private static boolean printRole(COSBase raw,Set<COSBase> seen,int depth) {
        COSBase v=resolveIndirect(raw);
        if(v==null)return false;
        if(depth>128 || !seen.add(v))throw new IllegalStateException("Cyclic attribute array");
        if(v instanceof COSArray) { for(COSBase child:(COSArray)v) if(printRole(child,seen,depth+1))return true; }
        if(v instanceof COSDictionary) { COSDictionary d=(COSDictionary)v; return "PrintField".equals(d.getNameAsString(COSName.O)) && d.getDictionaryObject(COSName.getPDFName("Role")) instanceof COSName; }
        return false;
    }
    private static int countInvalidForms(COSBase raw,COSDictionary roles,COSDictionary classes,Set<COSBase> seen,int depth) {
        COSBase v=resolveIndirect(raw); if(v==null || v instanceof COSInteger)return 0;
        if(depth>128 || seen.size()>100000 || !seen.add(v))throw new IllegalStateException("Invalid form traversal");
        int count=0;
        if(v instanceof COSArray) { for(COSBase child:(COSArray)v)count+=countInvalidForms(child,roles,classes,seen,depth+1); }
        else if(v instanceof COSDictionary) {
            COSDictionary d=(COSDictionary)v; String role=d.getNameAsString(COSName.S); Set<String> visited=new HashSet<>();
            while(role!=null && !"Form".equals(role) && roles!=null && visited.add(role) && visited.size()<=128)role=roles.getNameAsString(COSName.getPDFName(role));
            if("Form".equals(role)) {
                boolean hasRole=printRole(d.getItem(COSName.A)); COSBase c=d.getDictionaryObject(COSName.C);
                if(classes!=null) {
                    if(c instanceof COSName)hasRole|=printRole(classes.getItem((COSName)c));
                    else if(c instanceof COSArray)for(COSBase item:(COSArray)c)if(resolveIndirect(item) instanceof COSName)hasRole|=printRole(classes.getItem((COSName)resolveIndirect(item)));
                }
                COSBase k=d.getDictionaryObject(COSName.K);
                if(k instanceof COSArray && ((COSArray)k).size()==1)k=((COSArray)k).getObject(0);
                boolean one=k instanceof COSDictionary && "OBJR".equals(((COSDictionary)k).getNameAsString(COSName.TYPE)) &&
                    ((COSDictionary)k).getCOSDictionary(COSName.OBJ)!=null && "Widget".equals(((COSDictionary)k).getCOSDictionary(COSName.OBJ).getNameAsString(COSName.SUBTYPE));
                if(!hasRole && !one)count++;
            }
            count+=countInvalidForms(d.getItem(COSName.K),roles,classes,seen,depth+1);
        }
        return count;
    }

    private static void harvestParentTree(COSDictionary node, java.util.Map<Integer, COSDictionary> out) {
        harvestParentTree(node, out, Collections.newSetFromMap(new java.util.IdentityHashMap<COSDictionary, Boolean>()), new HashSet<Integer>(), 0);
    }
    private static void harvestParentTree(COSDictionary node, java.util.Map<Integer, COSDictionary> out,
        Set<COSDictionary> seen, Set<Integer> keys, int depth) {
        if (depth > 128 || seen.size() > 10000 || !seen.add(node)) throw new IllegalStateException("Cyclic or excessive ParentTree");
        COSBase nums = node.getDictionaryObject(COSName.NUMS);
        if (nums != null && !(nums instanceof COSArray)) throw new IllegalStateException("Invalid ParentTree Nums");
        if (nums instanceof COSArray) {
            COSArray arr = (COSArray)nums;
            if (arr.size() % 2 != 0) throw new IllegalStateException("Odd ParentTree pairs");
            for (int i = 0; i < arr.size(); i += 2) {
                COSBase k = arr.getObject(i);
                if (!(k instanceof COSInteger) || ((COSInteger)k).longValue() < 0 || ((COSInteger)k).longValue() > Integer.MAX_VALUE || !keys.add(((COSInteger)k).intValue())) throw new IllegalStateException("Invalid or duplicate ParentTree key");
                COSBase v = resolveIndirect(arr.getObject(i + 1));
                if (v instanceof COSDictionary) out.put(((COSInteger)k).intValue(), (COSDictionary)v);
                else if (!(v instanceof COSArray)) throw new IllegalStateException("Invalid ParentTree target");
            }
        }
        COSBase kids = node.getDictionaryObject(COSName.KIDS);
        if (kids != null && !(kids instanceof COSArray)) throw new IllegalStateException("Invalid ParentTree Kids");
        if (kids instanceof COSArray) for (COSBase k : (COSArray)kids) {
            COSBase r = resolveIndirect(k);
            if (!(r instanceof COSDictionary)) throw new IllegalStateException("Invalid ParentTree child");
            harvestParentTree((COSDictionary)r, out, seen, keys, depth + 1);
        }
    }

    /** PDFBox's COSArray.getObject has historically varied in
     *  whether it follows indirect refs. Wrap the resolution here
     *  so COSObject/COSObjectable wrappers get unwrapped to the
     *  backing dict. */
    private static COSBase resolveIndirect(COSBase b) {
        if (b instanceof org.apache.pdfbox.cos.COSObject) {
            COSBase obj = ((org.apache.pdfbox.cos.COSObject) b).getObject();
            return obj != null ? obj : b;
        }
        return b;
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }

        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n")
            .replace("\t", "\\t");
    }
}
