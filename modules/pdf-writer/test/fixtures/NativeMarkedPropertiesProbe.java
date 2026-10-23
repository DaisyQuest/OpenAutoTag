import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.contentstream.PDContentStream;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.optionalcontent.*;
import org.apache.pdfbox.rendering.PDFRenderer;

/** Named/inline artifacts and optional groups/membership under source ownership. */
public class NativeMarkedPropertiesProbe {
    static void check(boolean ok,String message) { if(!ok)throw new AssertionError(message); }
    static COSName name(String value) { return COSName.getPDFName(value); }
    static void emit(ContentStreamWriter out,String operator,Object... args) throws Exception {
        out.writeTokens(Arrays.asList(args)); out.writeToken(Operator.getOperator(operator));
    }
    static void text(ContentStreamWriter out,PDFont font,int y,String text) throws Exception {
        emit(out,"BT"); emit(out,"Tf",name("F"),COSInteger.get(12)); emit(out,"Td",COSInteger.get(72),COSInteger.get(y));
        emit(out,"Tj",new COSString(font.encode(text))); emit(out,"ET");
    }
    static COSDictionary artifact(String type,String subtype,int bottom,int top) {
        var props=new COSDictionary(); props.setItem(COSName.TYPE,name(type));
        if(subtype!=null)props.setItem(COSName.SUBTYPE,name(subtype));
        var bbox=new COSArray(); for(int v:new int[]{60,bottom,540,top})bbox.add(COSInteger.get(v)); props.setItem(COSName.BBOX,bbox);
        var attached=new COSArray(); attached.add(name("Footer".equals(subtype)?"Bottom":"Top")); props.setItem(name("Attached"),attached);
        return props;
    }
    static void create(String path,String fontPath,String variant) throws Exception {
        try(var doc=new PDDocument(); var input=new FileInputStream(fontPath)) {
            var font=PDType0Font.load(doc,input,false);
            var a=new PDOptionalContentGroup("Layer A"); var b=new PDOptionalContentGroup("Layer B");
            var optional=new PDOptionalContentProperties(); optional.addGroup(a); optional.addGroup(b);
            optional.setGroupEnabled(a,true); optional.setGroupEnabled(b,false); doc.getDocumentCatalog().setOCProperties(optional);
            var resources=new PDResources(); resources.put(name("F"),font);
            var props=new COSDictionary(); props.setItem(name("Layer A"),a); props.setItem(name("B"),b);
            var membership=new COSDictionary(); membership.setItem(COSName.TYPE,COSName.OCMD);
            var groups=new COSArray(); groups.add(a); groups.add(b); membership.setItem(name("OCGs"),groups); membership.setItem(COSName.P,name("AllOn"));
            props.setItem(name("Both"),membership); var header=artifact("Pagination","Header",730,770);header.setInt(COSName.MCID,98);props.setItem(name("Header"),header);
            resources.getCOSObject().setItem(COSName.PROPERTIES,props);
            var form=new PDFormXObject(doc); form.setBBox(PDRectangle.LETTER);
            var formResources=new PDResources(new COSDictionary(resources.getCOSObject()));
            var formProps=new COSDictionary(props); formProps.setItem(name("Layer A"),b); formResources.getCOSObject().setItem(COSName.PROPERTIES,formProps); form.setResources(formResources);
            try(var bytes=form.getCOSObject().createOutputStream()) {
                var out=new ContentStreamWriter(bytes); emit(out,"BDC",COSName.OC,name("Layer A"));
                var old=new COSDictionary();old.setInt(COSName.MCID,77);emit(out,"BDC",name("Span"),old);
                text(out,font,400,"Form layer B"); emit(out,"EMC");emit(out,"EMC");
            }
            var decoration=new PDFormXObject(doc);decoration.setBBox(PDRectangle.LETTER);decoration.setResources(resources);
            try(var bytes=decoration.getCOSObject().createOutputStream()) {
                var out=new ContentStreamWriter(bytes);emit(out,"BDC",COSName.OC,name("B"));
                var old=new COSDictionary();old.setInt(COSName.MCID,88);emit(out,"BDC",name("Span"),old);
                text(out,font,100,"Watermark");emit(out,"EMC");emit(out,"EMC");
            }
            var page=new PDPage(PDRectangle.LETTER);doc.addPage(page);
            var pageResources=new PDResources(new COSDictionary(resources.getCOSObject()));
            pageResources.put(name("Semantic"),form);pageResources.put(name("Decoration"),decoration);page.setResources(pageResources);
            var first=new PDStream(doc);var second=new PDStream(doc);
            try(var bytes=first.createOutputStream()) {
                var out=new ContentStreamWriter(bytes);
                emit(out,"BDC",COSName.ARTIFACT,name("Header"));text(out,font,750,"Repeated heading");
                // Incorrect source artifact around meaningful text must not hide
                // an explicit semantic assignment with identical typography.
                text(out,font,650,"Repeated heading");emit(out,"EMC");
                var old=new COSDictionary();old.setInt(COSName.MCID,51);emit(out,"BDC",name("P"),old);
                emit(out,"BDC",COSName.OC,name("Layer A"));text(out,font,600,"Visible A");
                emit(out,"BDC",COSName.OC,name("B"));text(out,font,570,"Nested A and B");
                // Source marker pair crosses the physical page stream boundary.
            }
            try(var bytes=second.createOutputStream()) {
                var out=new ContentStreamWriter(bytes);emit(out,"EMC");emit(out,"EMC");emit(out,"EMC");
                emit(out,"BDC",COSName.OC,name("B"));text(out,font,540,"Hidden B");emit(out,"EMC");
                emit(out,"BDC",COSName.OC,name("Both"));text(out,font,510,"Membership both");emit(out,"EMC");
                emit(out,"BDC",COSName.ARTIFACT,artifact("Background",null,430,470));
                emit(out,"BDC",COSName.OC,name("B"));emit(out,"re",COSInteger.get(70),COSInteger.get(440),COSInteger.get(60),COSInteger.get(15));emit(out,"f");emit(out,"EMC");emit(out,"EMC");
                emit(out,"BDC",COSName.ARTIFACT,artifact("Pagination","Header",380,430));emit(out,"Do",name("Semantic"));emit(out,"EMC");
                emit(out,"BMC",COSName.OC);text(out,font,350,"Outside layers");emit(out,"EMC"); // ordinary application tag, no OCG
                emit(out,"BDC",COSName.ARTIFACT,artifact("Pagination","Watermark",80,130));emit(out,"Do",name("Decoration"));emit(out,"EMC");
                var footer=artifact("Pagination","Footer",20,50);footer.setInt(COSName.MCID,99);
                emit(out,"BDC",COSName.ARTIFACT,footer);text(out,font,35,"1");emit(out,"EMC");
                if("unclosed".equals(variant))emit(out,"BDC",COSName.OC,name("B"));
                if("unbalanced".equals(variant))emit(out,"EMC");
                if("missing".equals(variant)){emit(out,"BDC",COSName.OC,name("Missing"));emit(out,"EMC");}
                if("invalid".equals(variant)){emit(out,"BDC",COSName.OC,COSInteger.get(42));emit(out,"EMC");}
                if("inline".equals(variant)){var group=new COSDictionary();group.setItem(COSName.TYPE,COSName.OCG);group.setString(COSName.NAME,"Inline");emit(out,"BDC",COSName.OC,group);emit(out,"EMC");}
                if("excessive".equals(variant)){for(int i=0;i<257;i++)emit(out,"BMC",name("Span"));for(int i=0;i<257;i++)emit(out,"EMC");}
            }
            page.setContents(List.of(first,second));doc.save(path);
        }
    }
    record Mark(String tag,COSDictionary properties) {}
    record Paint(String text,String layers,String owner,String artifact) {}
    static String properties(COSDictionary p) { return p==null?"":p.getNameAsString(COSName.TYPE,"")+"/"+p.getNameAsString(COSName.SUBTYPE,"")+"/"+p.getDictionaryObject(COSName.BBOX)+"/"+p.getDictionaryObject(name("Attached")); }
    static String layer(COSDictionary p) {
        if(COSName.OCG.equals(p.getCOSName(COSName.TYPE)))return p.getString(COSName.NAME);
        var a=(COSArray)p.getDictionaryObject(name("OCGs"));var names=new ArrayList<String>();
        for(int i=0;i<a.size();i++)names.add(((COSDictionary)a.getObject(i)).getString(COSName.NAME));
        return p.getNameAsString(COSName.P)+names;
    }
    static String decode(PDFont font,COSBase operand) throws Exception {
        var result=new StringBuilder();
        if(operand instanceof COSString s){var in=new ByteArrayInputStream(s.getBytes());while(in.available()>0)result.append(font.toUnicode(font.readCode(in)));}
        else if(operand instanceof COSArray a)for(COSBase item:a)if(item instanceof COSString)result.append(decode(font,item));
        return result.toString();
    }
    static void scan(PDDocument doc,PDContentStream stream,PDResources resources,COSDictionary scope,List<Mark> inherited,List<Paint> paints,boolean tagged) throws Exception {
        var stack=new ArrayList<Mark>(inherited);int depth=stack.size();var pending=new ArrayList<COSBase>();var ids=new HashSet<Integer>();
        for(Object token:new PDFStreamParser(stream).parse()){
            if(!(token instanceof Operator op)){pending.add((COSBase)token);continue;}
            String name=op.getName();
            if("BDC".equals(name)||"BMC".equals(name)){
                COSDictionary p=null;if("BDC".equals(name)){var value=pending.get(1);p=value instanceof COSDictionary?(COSDictionary)value:resources.getCOSObject().getCOSDictionary(COSName.PROPERTIES).getCOSDictionary((COSName)value);}
                stack.add(new Mark(((COSName)pending.get(0)).getName(),p));
                if(tagged&&p!=null&&p.containsKey(COSName.MCID))check(ids.add(p.getInt(COSName.MCID)),"Duplicate MCID");
            }else if("EMC".equals(name)){check(stack.size()>depth,"Unbalanced EMC");stack.remove(stack.size()-1);}
            else if("Do".equals(name)){
                var form=(PDFormXObject)resources.getXObject((COSName)pending.get(0));scan(doc,form,form.getResources(),form.getCOSObject(),stack,paints,tagged);
            }else if(Set.of("Tj","TJ","'","\"","f").contains(name)){
                String text="f".equals(name)?"[background]":decode(resources.getFont(name("F")),pending.get(pending.size()-1));
                var layers=new ArrayList<String>();String owner="",artifact="";int owners=0;
                for(Mark mark:stack){if("OC".equals(mark.tag)&&mark.properties!=null&&(COSName.OCG.equals(mark.properties.getCOSName(COSName.TYPE))||COSName.OCMD.equals(mark.properties.getCOSName(COSName.TYPE))))layers.add(layer(mark.properties));if("Artifact".equals(mark.tag))artifact=properties(mark.properties);
                    if(mark.properties!=null&&mark.properties.containsKey(COSName.MCID)&&tagged){owners++;int mcid=mark.properties.getInt(COSName.MCID);var refs=(COSArray)doc.getDocumentCatalog().getStructureTreeRoot().getParentTree().getNumbers().get(scope.getInt(COSName.STRUCT_PARENTS)).getCOSObject();owner=((COSDictionary)refs.getObject(mcid)).getString(COSName.ID);}}
                if(tagged){check(owners<=1,"Nested semantic owners");check(owner.isEmpty()||artifact.isEmpty(),"Artifact hides semantic text");check(!owner.isEmpty()||!artifact.isEmpty(),"Unclassified paint");}
                paints.add(new Paint(text,layers.toString(),owner,artifact));
            }
            pending.clear();
        }
        check(stack.size()==depth,"Unclosed marked content");
    }
    public static void main(String[] args) throws Exception {
        System.setOut(new PrintStream(System.out,true,StandardCharsets.UTF_8));
        if(args[0].startsWith("create")){create(args[1],args[2],args.length>3?args[3]:"");return;}
        try(var source=Loader.loadPDF(new File(args[1]));var saved=Loader.loadPDF(new File(args[2]))){
            check(saved.getPage(0).getResources().getCOSObject().getCOSDictionary(COSName.PROPERTIES).getCOSDictionary(name("Header")).getInt(COSName.MCID)==98,
                "Shared source property dictionary was mutated");
            var before=new ArrayList<Paint>();var after=new ArrayList<Paint>();
            scan(source,source.getPage(0),source.getPage(0).getResources(),source.getPage(0).getCOSObject(),List.of(),before,false);
            scan(saved,saved.getPage(0),saved.getPage(0).getResources(),saved.getPage(0).getCOSObject(),List.of(),after,true);
            check(before.size()==after.size(),"Paint count changed");
            for(int i=0;i<before.size();i++){
                var a=before.get(i);var b=after.get(i);check(a.text.equals(b.text)&&a.layers.equals(b.layers),"Text or layer scope changed: "+a+" -> "+b);
                if(Set.of("Watermark","1","[background]").contains(b.text)||i==0)check(a.artifact.equals(b.artifact)&&b.owner.isEmpty(),"Artifact properties changed: "+b);
                else check(b.owner.equals("oat:n"+i)&&b.artifact.isEmpty(),"Semantic owner changed: "+b);
            }
            var unique=new HashSet<Integer>();
            for(int mask=-1;mask<4;mask++){
                if(mask>=0)for(var doc:List.of(source,saved)){
                    // Replace arrays explicitly: repeated PDFBox toggles after
                    // reload can retain duplicate indirect entries in OFF.
                    // A group in both lists is not a valid alternate-state test.
                    var oc=doc.getDocumentCatalog().getOCProperties().getCOSObject();var groups=oc.getCOSArray(name("OCGs"));
                    var on=new COSArray();var off=new COSArray();
                    for(int g=0;g<groups.size();g++)((mask&(1<<g))!=0?on:off).add(groups.get(g));
                    var config=oc.getCOSDictionary(COSName.D);config.setItem(name("ON"),on);config.setItem(name("OFF"),off);
                }
                var a=new PDFRenderer(source).renderImageWithDPI(0,150);var b=new PDFRenderer(saved).renderImageWithDPI(0,150);
                int[] left=a.getRGB(0,0,a.getWidth(),a.getHeight(),null,0,a.getWidth()),right=b.getRGB(0,0,b.getWidth(),b.getHeight(),null,0,b.getWidth());
                check(Arrays.equals(left,right),"Layer state changed pixels: "+mask);unique.add(Arrays.hashCode(left));
                if(args.length>3){source.save(args[3]+"-source-"+mask+".pdf");saved.save(args[3]+"-saved-"+mask+".pdf");}
            }
            check(unique.size()==4,"Fixture does not exercise all layer states");
            System.out.println("Layer scopes, artifact properties, semantic ownership and 150 DPI pixels preserved in default plus all four layer states");
        }
    }
}
