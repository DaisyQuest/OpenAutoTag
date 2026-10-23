import java.io.*;
import java.util.*;
import java.awt.geom.AffineTransform;
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
import org.apache.pdfbox.util.Matrix;

/** Lexical recursive oracle, independent of the native parser and its dispatcher. */
public class NativeFormProbe {
    static void emit(ContentStreamWriter out, String op, Object... values) throws Exception {
        out.writeTokens(Arrays.asList(values)); out.writeToken(Operator.getOperator(op));
    }
    static void text(ContentStreamWriter out, PDFont font, int x, int y, String value) throws Exception {
        emit(out,"BT"); emit(out,"Tf",COSName.getPDFName("F"),COSInteger.get(12));
        emit(out,"Td",COSInteger.get(x),COSInteger.get(y)); emit(out,"Tj",new COSString(font.encode(value))); emit(out,"ET");
    }
    static final Map<COSDictionary,Map<Integer,String>> owners = new IdentityHashMap<>();
    static final List<COSDictionary> mcrs = new ArrayList<>();
    static Map<Integer,? extends org.apache.pdfbox.pdmodel.common.COSObjectable> parentTree;
    static final Set<COSDictionary> invokedScopes = Collections.newSetFromMap(new IdentityHashMap<>());
    static void structure(COSBase raw, COSDictionary parent, COSDictionary page) {
        COSBase value=raw instanceof COSObject ? ((COSObject)raw).getObject() : raw;
        if(value instanceof COSArray array) { for(COSBase child:array) structure(child,parent,page); return; }
        if(!(value instanceof COSDictionary dict)) return;
        if(dict.getCOSDictionary(COSName.PG)!=null) page=dict.getCOSDictionary(COSName.PG);
        if("MCR".equals(dict.getNameAsString(COSName.TYPE))) {
            mcrs.add(dict);
            COSDictionary stream=dict.getCOSDictionary(COSName.getPDFName("Stm"));
            COSDictionary scope=stream==null?page:stream; int mcid=dict.getInt(COSName.MCID);
            var refs=(COSArray)parentTree.get(scope.getInt(COSName.STRUCT_PARENTS)).getCOSObject();
            if(refs.getObject(mcid)!=parent) throw new AssertionError("Non-reciprocal ParentTree");
            var map=owners.computeIfAbsent(scope,k->new HashMap<>());
            if(map.put(mcid,parent.getString(COSName.ID,"flat"))!=null) throw new AssertionError("Duplicate owner in scope");
        } else if(dict.containsKey(COSName.K)) structure(dict.getDictionaryObject(COSName.K),dict,page);
    }
    static String decode(PDFont font,COSBase value) throws Exception {
        var out=new StringBuilder();
        if(value instanceof COSArray a) { for(COSBase item:a) if(item instanceof COSString) out.append(decode(font,item)); }
        else if(value instanceof COSString s) { var bytes=new ByteArrayInputStream(s.getBytes()); while(bytes.available()>0) out.append(font.toUnicode(font.readCode(bytes))); }
        return out.toString();
    }
    static void scan(PDContentStream source, PDResources inherited, PDFont font, COSDictionary scope, String origin, int page, boolean tagged) throws Exception {
        PDResources resources=source.getResources()==null?inherited:source.getResources();
        var operands=new ArrayList<COSBase>(); var fontStack=new ArrayList<PDFont>(); var marked=new ArrayDeque<Integer>();
        int index=0;
        for(Object token:new PDFStreamParser(source).parse()) {
            if(!(token instanceof Operator op)) { operands.add((COSBase)token); continue; }
            String name=op.getName();
            if("q".equals(name)) fontStack.add(font);
            if("Q".equals(name)) font=fontStack.remove(fontStack.size()-1);
            if("Tf".equals(name)) font=resources.getFont((COSName)operands.get(0));
            if("BMC".equals(name)) marked.push(-1);
            if("BDC".equals(name)) { if(!marked.isEmpty()) throw new AssertionError("Nested content ownership"); marked.push(((COSDictionary)operands.get(1)).getInt(COSName.MCID,-1)); }
            if("EMC".equals(name)) marked.pop();
            if(Set.of("Tj","TJ","'","\"").contains(name)) {
                String id="-"; int mcid=marked.isEmpty()?-1:marked.peek();
                if(tagged) {
                    if(mcid<0 || !owners.containsKey(scope) || !owners.get(scope).containsKey(mcid)) throw new AssertionError("Missing painted owner at "+origin+":"+index);
                    invokedScopes.add(scope); id=owners.get(scope).get(mcid);
                }
                System.out.println(page+"\t"+origin+"\t"+index+"\t"+decode(font,operands.get(operands.size()-1))+"\t"+id+"\t"+mcid);
            }
            if("Do".equals(name) && resources.getXObject((COSName)operands.get(0)) instanceof PDFormXObject form) {
                if(tagged && !marked.isEmpty()) throw new AssertionError("Outer wrapper obscures nested Form tags");
                scan(form,resources,font,form.getCOSObject(),origin+"/"+index,page,tagged);
            }
            index++; operands.clear();
        }
        if(!marked.isEmpty()) throw new AssertionError("Unbalanced scope");
    }
    public static void main(String[] args) throws Exception {
        if(args[0].startsWith("create")) {
            try(var doc=new PDDocument(); var input=new FileInputStream(args[2])) {
                var font=PDType0Font.load(doc,input,false);
                var child=new PDFormXObject(doc); child.setBBox(new PDRectangle(200,40)); child.setMatrix(AffineTransform.getTranslateInstance(5,3));
                // No child Resources: resolve F through each invoking parent's resources.
                try(var out=child.getCOSObject().createOutputStream()) { text(new ContentStreamWriter(out),font,0,10,"Child"); }
                var parent=new PDFormXObject(doc); parent.setBBox(new PDRectangle(240,120));
                var resources=new PDResources(); resources.put(COSName.getPDFName("F"),font); resources.put(COSName.getPDFName("Nested"),child); parent.setResources(resources);
                COSDictionary group=new COSDictionary(); group.setItem(COSName.S,COSName.getPDFName("Transparency")); group.setBoolean(COSName.getPDFName("I"),true); parent.getCOSObject().setItem(COSName.GROUP,group);
                try(var bytes=parent.getCOSObject().createOutputStream()) {
                    var out=new ContentStreamWriter(bytes); text(out,font,10,85,"Parent");
                    emit(out,"q"); emit(out,"cm",COSInteger.ONE,COSInteger.ZERO,COSInteger.ZERO,COSInteger.ONE,COSInteger.get(10),COSInteger.get(20));
                    emit(out,"Do",COSName.getPDFName("Nested")); emit(out,"Q"); text(out,font,35,5,"End");
                    if("create-cycle".equals(args[0])) { resources.put(COSName.getPDFName("Loop"),parent); emit(out,"Do",COSName.getPDFName("Loop")); }
                }
                for(int p=0;p<2;p++) {
                    var page=new PDPage(PDRectangle.LETTER); doc.addPage(page);
                    try(var out=new PDPageContentStream(doc,page)) {
                        out.beginText(); out.setFont(font,12); out.newLineAtOffset(72,p==0?720:772); out.showText("Before"); out.endText();
                        out.saveGraphicsState(); out.transform(Matrix.getTranslateInstance(72,p==0?520:620)); out.drawForm(parent); out.restoreGraphicsState();
                        if(p==0) { out.saveGraphicsState(); out.transform(new Matrix(.75f,0,0,.8f,320,520)); out.drawForm(parent); out.restoreGraphicsState(); }
                        out.saveGraphicsState(); out.transform(Matrix.getTranslateInstance(p==0?72:300,p==0?400:500)); out.drawForm(child); out.restoreGraphicsState();
                        out.beginText(); out.setFont(font,12); out.newLineAtOffset(72,342); out.showText("After"); out.endText();
                    }
                    // Child's font resource is inherited from the page on direct invocation.
                    page.getResources().put(COSName.getPDFName("F"),font);
                }
                doc.save(args[1]);
            }
            return;
        }
        try(var doc=Loader.loadPDF(new File(args[1]))) {
            if("swap-stream".equals(args[0])) {
                var root=doc.getDocumentCatalog().getStructureTreeRoot(); parentTree=root.getParentTree().getNumbers(); structure(root.getCOSObject(),null,null);
                var streams=mcrs.stream().filter(m->m.containsKey(COSName.getPDFName("Stm"))).toList();
                streams.get(0).setItem(COSName.getPDFName("Stm"),streams.get(1).getDictionaryObject(COSName.getPDFName("Stm")));
                doc.save(args[2]); return;
            }
            boolean tagged="verify".equals(args[0]);
            if(tagged) { var root=doc.getDocumentCatalog().getStructureTreeRoot(); parentTree=root.getParentTree().getNumbers(); structure(root.getCOSObject(),null,null); }
            for(int p=0;p<doc.getNumberOfPages();p++) { var page=doc.getPage(p); scan(page,page.getResources(),null,page.getCOSObject(),"page",p+1,tagged); }
            if(tagged) {
                if(invokedScopes.size()!=10 || owners.size()!=10) throw new AssertionError("Expected two page and eight independent Form scopes");
                if(owners.values().stream().filter(m->m.containsKey(0)).count()!=10) throw new AssertionError("MCID zero must resolve independently in every scope");
            }
        }
    }
}
