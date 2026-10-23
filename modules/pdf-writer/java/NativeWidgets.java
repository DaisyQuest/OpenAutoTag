import java.io.IOException;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;

/** Inventory original widgets without loading AcroForm convenience objects or
 * generating appearances. Binding changes only /StructParent on each widget. */
final class NativeWidgets {
    static final class Widget {
        final PDPage page;final PDAnnotation annotation;final int pageNumber,index;final String sourceRef,fieldName;
        String tagId,placement;boolean generated;int parentKey=-1;PDStructureElement element;
        Widget(PDPage p,PDAnnotation a,int pageNumber,int index) throws IOException {
            page=p;annotation=a;this.pageNumber=pageNumber;this.index=index;sourceRef=reference(a.getCOSObject());fieldName=fieldName(a.getCOSObject());
        }
        Map<String,Object> report() {
            Map<String,Object> r=new LinkedHashMap<>();r.put("pageNumber",pageNumber);r.put("annotationIndex",index);r.put("sourceRef",sourceRef);r.put("fieldName",fieldName);
            r.put("tagId",tagId);r.put("generated",generated);r.put("placement",placement);r.put("parentTreeKey",parentKey);return r;
        }
    }
    final List<Widget> widgets=new ArrayList<>();final Map<String,Widget> byRef=new HashMap<>();
    NativeWidgets(PDDocument doc) throws IOException {
        Set<COSDictionary> seen=Collections.newSetFromMap(new IdentityHashMap<>());int number=0;
        for(PDPage page:doc.getPages()) {
            int index=0;number++;
            for(PDAnnotation a:page.getAnnotations()) {
                if("Widget".equals(a.getSubtype())) {
                    if(widgets.size()>=10000||!seen.add(a.getCOSObject()))throw new IOException("Duplicate or excessive native widgets");
                    COSDictionary declaredPage=a.getCOSObject().getCOSDictionary(COSName.P);
                    if(declaredPage!=null&&declaredPage!=page.getCOSObject())throw new IOException("Native widget page disagrees with its annotation array");
                    Widget w=new Widget(page,a,number,index);if(byRef.put(w.sourceRef,w)!=null)throw new IOException("Duplicate native widget reference");widgets.add(w);
                }index++;
            }
        }
        // Field-tree widgets absent from every page cannot be silently omitted
        // from an ownership claim, including when an older plan has no intents.
        COSDictionary form=doc.getDocumentCatalog().getCOSObject().getCOSDictionary(COSName.ACRO_FORM);
        if(form!=null) {
            Set<COSDictionary> fields=Collections.newSetFromMap(new IdentityHashMap<>());
            verifyFieldWidgets(form.getDictionaryObject(COSName.FIELDS),seen,fields,0);
        }
    }
    private static void verifyFieldWidgets(COSBase raw,Set<COSDictionary> widgets,Set<COSDictionary> fields,int depth) throws IOException {
        if(raw==null)return;
        if(!(raw instanceof COSArray)||depth>128)throw new IOException("Invalid or excessive native field tree");
        COSArray array=(COSArray)raw;
        for(int i=0;i<array.size();i++) {
            COSBase value=array.getObject(i);
            if(!(value instanceof COSDictionary)||fields.size()>=100000||!fields.add((COSDictionary)value))throw new IOException("Duplicate or invalid native field tree entry");
            COSDictionary field=(COSDictionary)value;
            if("Widget".equals(field.getNameAsString(COSName.SUBTYPE))&&!widgets.contains(field))throw new IOException("Native field widget is absent from page annotations");
            verifyFieldWidgets(field.getDictionaryObject(COSName.KIDS),widgets,fields,depth+1);
        }
    }
    Widget bind(String ref,int pageNumber,String fieldName,String tagId,String placement,boolean generated) throws IOException {
        Widget w=byRef.get(ref);
        if(w==null||w.pageNumber!=pageNumber||w.tagId!=null||!w.fieldName.equals(fieldName))throw new IOException("Native widget intent does not resolve uniquely: "+tagId);
        w.tagId=tagId;w.placement=placement;w.generated=generated;return w;
    }
    static String reference(COSDictionary value) throws IOException {
        COSObjectKey key=value.getKey();if(key==null)throw new IOException("Native widget lacks an indirect source identity");
        return key.getNumber()+" "+key.getGeneration()+" R";
    }
    static String fieldName(COSDictionary widget) throws IOException {
        List<String> parts=new ArrayList<>();Set<COSDictionary> seen=Collections.newSetFromMap(new IdentityHashMap<>());COSDictionary n=widget;
        while(n!=null) {
            if(seen.size()>=128||!seen.add(n))throw new IOException("Cyclic or excessive widget field ancestry");
            COSBase name=n.getDictionaryObject(COSName.T);
            if(name instanceof COSString&&!((COSString)name).getString().isEmpty())parts.add(((COSString)name).getString());
            else if(name!=null&&!(name instanceof COSString))throw new IOException("Invalid native field name");
            COSBase parent=n.getDictionaryObject(COSName.PARENT);
            if(parent!=null&&!(parent instanceof COSDictionary))throw new IOException("Invalid native field parent");n=(COSDictionary)parent;
        }
        Collections.reverse(parts);return String.join(".",parts);
    }
}
