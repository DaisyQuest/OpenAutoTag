import java.io.*;
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
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.*;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.*;

public class AuthoredTextProbe {
    static COSName n(String s) { return COSName.getPDFName(s); }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
    static void op(ContentStreamWriter out, String name, Object... operands) throws Exception {
        out.writeTokens(Arrays.asList(operands)); out.writeToken(Operator.getOperator(name));
    }
    static COSDictionary props(String name, String value) { var p = new COSDictionary(); p.setString(n(name), value); return p; }
    static void begin(ContentStreamWriter out, COSDictionary p) throws Exception { op(out, "BDC", n("Span"), p); }
    static void show(ContentStreamWriter out, PDFont font, String s) throws Exception { op(out, "Tj", new COSString(font.encode(s))); }
    static void line(ContentStreamWriter out, int y) throws Exception { op(out,"BT");op(out,"Tf",n("F"),COSInteger.get(12));op(out,"Td",COSInteger.get(72),COSInteger.get(y)); }
    static void marked(ContentStreamWriter out, PDFont font, int mcid, String text) throws Exception {
        var p=new COSDictionary();p.setInt(COSName.MCID,mcid);begin(out,p);show(out,font,text);op(out,"EMC");
    }
    static void struct(PDStructureElement root, PDPage page, PDFormXObject stream, String property, String value, int... ids) {
        var span=new PDStructureElement("Span",root);span.setPage(page);span.getCOSObject().setString(n(property),value);root.appendKid(span);
        for(int id:ids) { var m=new COSDictionary();m.setItem(COSName.TYPE,COSName.MCR);m.setItem(COSName.PG,page);m.setInt(COSName.MCID,id);if(stream!=null)m.setItem(n("Stm"),stream);span.appendKid(new PDMarkedContentReference(m)); }
    }
    static void create(String file,String fontFile,String variant) throws Exception {
        try(var doc=new PDDocument();var fontIn=new FileInputStream(fontFile)) {
            var font=PDType0Font.load(doc,fontIn,false);var page=new PDPage(PDRectangle.LETTER);doc.addPage(page);
            var resources=new PDResources();resources.put(n("F"),font);page.setResources(resources);
            var named=new COSDictionary();named.setItem(n("Ligature"),props("ActualText","fi"));resources.getCOSObject().setItem(COSName.PROPERTIES,named);
            if("visibility".equals(variant)) {
                var layer=new org.apache.pdfbox.pdmodel.graphics.optionalcontent.PDOptionalContentGroup("Replacement layer");
                var optional=new org.apache.pdfbox.pdmodel.graphics.optionalcontent.PDOptionalContentProperties();optional.addGroup(layer);doc.getDocumentCatalog().setOCProperties(optional);named.setItem(n("Layer"),layer);
            }
            var form=new PDFormXObject(doc);form.setBBox(new PDRectangle(612,50));form.setResources(resources);
            try(var bytes=form.getCOSObject().createOutputStream()) {var out=new ContentStreamWriter(bytes);line(out,0);begin(out,props("ActualText","fi"));show(out,font,"ﬁ");op(out,"EMC");op(out,"ET");}
            var plain=new PDFormXObject(doc);plain.setBBox(new PDRectangle(612,50));plain.setResources(resources);
            try(var bytes=plain.getCOSObject().createOutputStream()) {var out=new ContentStreamWriter(bytes);line(out,0);marked(out,font,105,"X");marked(out,font,106,"Y");op(out,"ET");}
            // Avoid circular resource dictionaries in the fixture.
            var pageResources=new PDResources(new COSDictionary(resources.getCOSObject()));pageResources.put(n("Form"),form);pageResources.put(n("Plain"),plain);page.setResources(pageResources);
            var tree=new PDStructureTreeRoot();var root=new PDStructureElement("Document",tree);tree.appendKid(root);doc.getDocumentCatalog().setStructureTreeRoot(tree);
            struct(root,page,null,"ActualText","structure words",101,102);struct(root,page,null,"E","European Union",103,104);
            struct(root,page,plain,"ActualText","form words",105,106);
            if("missing-reference".equals(variant))struct(root,page,null,"ActualText","missing",999);
            if("cycle".equals(variant))root.appendKid(root);
            var stream=new PDStream(doc);page.setContents(stream);
            try(var bytes=stream.createOutputStream()) {
                var out=new ContentStreamWriter(bytes);
                line(out,740);show(out,font,"Before ");op(out,"BDC",n("Span"),n("Ligature"));show(out,font,"ﬁ");op(out,"EMC");show(out,font," after");op(out,"ET");
                line(out,700);begin(out,props("E","National Aeronautics and Space Administration"));show(out,font,"NA");show(out,font,"SA");op(out,"EMC");show(out,font," neighbor");op(out,"ET");
                line(out,660);show(out,font,"Start ");begin(out,props("ActualText","Cooperate"));show(out,font,"C");
                if("visibility".equals(variant))op(out,"BDC",COSName.OC,n("Layer"));
                show(out,font,"o");if("visibility".equals(variant))op(out,"EMC");
                op(out,"EMC");show(out,font," end");op(out,"ET");
                line(out,620);show(out,font,"Left ");begin(out,props("ActualText",""));show(out,font,"noise");op(out,"EMC");show(out,font," right");op(out,"ET");
                line(out,580);show(out,font,"Tab");begin(out,props("ActualText","\t "));show(out,font,".");show(out,font,".");op(out,"EMC");show(out,font," end");op(out,"ET");
                line(out,540);begin(out,props("ActualText","complete"));show(out,font,"a");begin(out,props("ActualText","inner"));show(out,font,"b");op(out,"EMC");show(out,font,"c");op(out,"EMC");show(out,font," neighbor");op(out,"ET");
                line(out,500);show(out,font,"Before ");marked(out,font,101,"S");
                if("intervening".equals(variant))show(out,font," after");
                marked(out,font,102,"T");if(!"intervening".equals(variant))show(out,font," after");op(out,"ET");
                line(out,460);marked(out,font,103,"E");marked(out,font,104,"U");show(out,font," neighbor");op(out,"ET");
                for(int y:new int[]{420,380}){op(out,"q");op(out,"cm",COSInteger.ONE,COSInteger.ZERO,COSInteger.ZERO,COSInteger.ONE,COSInteger.ZERO,COSInteger.get(y));op(out,"Do",n("Form"));op(out,"Q");}
                op(out,"q");op(out,"cm",COSInteger.ONE,COSInteger.ZERO,COSInteger.ZERO,COSInteger.ONE,COSInteger.ZERO,COSInteger.get(340));op(out,"Do",n("Plain"));op(out,"Q");
                // Source scope outside a Form invocation must reach its content.
                begin(out,props("E","A nested ligature"));op(out,"q");op(out,"cm",COSInteger.ONE,COSInteger.ZERO,COSInteger.ZERO,COSInteger.ONE,COSInteger.ZERO,COSInteger.get(300));op(out,"Do",n("Form"));op(out,"Q");op(out,"EMC");
                if("invalid".equals(variant)){var p=new COSDictionary();p.setInt(n("ActualText"),42);begin(out,p);op(out,"EMC");}
                if("empty-scope".equals(variant)){begin(out,props("ActualText","unpainted"));op(out,"EMC");}
                if("graphic".equals(variant)){begin(out,props("ActualText","diagram"));op(out,"re",COSInteger.ZERO,COSInteger.ZERO,COSInteger.get(10),COSInteger.get(10));op(out,"f");op(out,"EMC");}
            }
            doc.save(file);
        }
    }
    record Key(COSDictionary stream,int mcid) {}
    record Mark(String tag,COSDictionary props) {}
    static String decode(PDFont font,COSBase value) throws Exception {
        var s=new StringBuilder();if(value instanceof COSString text){var in=new ByteArrayInputStream(text.getBytes());while(in.available()>0)s.append(font.toUnicode(font.readCode(in)));}
        else if(value instanceof COSArray a)for(int i=0;i<a.size();i++)s.append(decode(font,a.getObject(i)));return s.toString();
    }
    static void content(PDContentStream source,PDResources resources,COSDictionary stream,Map<Key,String> texts) throws Exception {
        var stack=new ArrayList<Mark>();var pending=new ArrayList<COSBase>();PDFont font=null;
        for(Object token:new PDFStreamParser(source).parse()) {
            if(!(token instanceof Operator operator)){pending.add((COSBase)token);continue;}String op=operator.getName();
            if("Tf".equals(op))font=resources.getFont((COSName)pending.get(0));
            if("BDC".equals(op)||"BMC".equals(op)){COSDictionary p=null;if("BDC".equals(op)){COSBase v=pending.get(1);p=v instanceof COSDictionary?(COSDictionary)v:resources.getCOSObject().getCOSDictionary(COSName.PROPERTIES).getCOSDictionary((COSName)v);}stack.add(new Mark(((COSName)pending.get(0)).getName(),p));}
            if("EMC".equals(op))stack.remove(stack.size()-1);
            if("Do".equals(op)){var form=(PDFormXObject)resources.getXObject((COSName)pending.get(0));content(form,form.getResources(),form.getCOSObject(),texts);}
            if(Set.of("Tj","TJ","'","\"").contains(op)) {
                int mcid=-1;String replacement=null;int owners=0;
                for(Mark mark:stack){if(mark.props!=null&&mark.props.containsKey(COSName.MCID)){mcid=mark.props.getInt(COSName.MCID);owners++;}if(replacement==null&&mark.props!=null&&mark.props.containsKey(n("ActualText")))replacement=mark.props.getString(n("ActualText"));}
                check(owners==1,"Every fixture text fragment has exactly one semantic owner");
                Key key=new Key(stream,mcid);String value=replacement==null?decode(font,pending.get(pending.size()-1)):replacement;texts.merge(key,value,String::concat);
            }
            pending.clear();
        }
        check(stack.isEmpty(),"Balanced saved content");
    }
    static String logical(COSBase value,COSDictionary page,Map<Key,String> texts,Set<Key> seen,Map<String,Integer> expansions) {
        if(value==null)return "";if(value instanceof COSArray a){var s=new StringBuilder();for(int i=0;i<a.size();i++)s.append(logical(a.getObject(i),page,texts,seen,expansions));return s.toString();}
        if(value instanceof COSDictionary d){if(d.getCOSDictionary(COSName.PG)!=null)page=d.getCOSDictionary(COSName.PG);
            if(COSName.MCR.equals(d.getCOSName(COSName.TYPE))){Key key=new Key(d.getCOSDictionary(n("Stm"))==null?page:d.getCOSDictionary(n("Stm")),d.getInt(COSName.MCID));check(seen.add(key),"Duplicate structure reference");check(texts.containsKey(key),"Reachable painted MCR");return texts.get(key);}
            String children=logical(d.getDictionaryObject(COSName.K),page,texts,seen,expansions);
            if(d.containsKey(n("ActualText"))) {
                COSBase kids=d.getDictionaryObject(COSName.K);if(kids instanceof COSArray array){check(array.size()==1,"Replacement has one continuous MCR, never first-text plus empty replacements");kids=array.getObject(0);}
                check(kids instanceof COSDictionary m && COSName.MCR.equals(m.getCOSName(COSName.TYPE)),"Authored replacement owns one continuous marked-content sequence");
            }
            if(d.containsKey(n("E")))expansions.merge(d.getString(n("E")),1,Integer::sum);
            return d.containsKey(n("ActualText"))?d.getString(n("ActualText")):children;
        }return "";
    }
    static class Glyphs extends PDFTextStripper {
        final List<String> glyphs=new ArrayList<>();Glyphs()throws IOException{}
        @Override public void beginMarkedContentSequence(COSName tag,COSDictionary properties){}
        @Override public void endMarkedContentSequence(){}
        @Override protected void processTextPosition(TextPosition p){glyphs.add(Arrays.toString(p.getCharacterCodes())+"/"+p.getUnicode()+"/"+p.getX()+"/"+p.getY()+"/"+p.getWidth());super.processTextPosition(p);}
    }
    static void verify(String source,String candidate) throws Exception {
        try(var before=Loader.loadPDF(new File(source));var after=Loader.loadPDF(new File(candidate))) {
            var a=new Glyphs();a.getText(before);var b=new Glyphs();b.getText(after);check(a.glyphs.equals(b.glyphs),"Every source glyph position and code preserved");
            var x=new PDFRenderer(before).renderImageWithDPI(0,150);var y=new PDFRenderer(after).renderImageWithDPI(0,150);check(Arrays.equals(x.getRGB(0,0,x.getWidth(),x.getHeight(),null,0,x.getWidth()),y.getRGB(0,0,y.getWidth(),y.getHeight(),null,0,y.getWidth())),"150 DPI pixels identical");
            Map<Key,String> texts=new HashMap<>();var page=after.getPage(0);content(page,page.getResources(),page.getCOSObject(),texts);
            var seen=new HashSet<Key>();var expansions=new TreeMap<String,Integer>();String logical=logical(after.getDocumentCatalog().getStructureTreeRoot().getCOSObject().getDictionaryObject(COSName.K),null,texts,seen,expansions);
            check(logical.equals("Before fi afterNASA neighborStart Cooperate endLeft  rightTab\t  endcomplete neighborBefore structure words afterEU neighborfifiform wordsfi"),"Exact logical text: "+logical);
            check(seen.equals(texts.keySet()),"Every painted owner reachable");
            check(expansions.equals(Map.of("National Aeronautics and Space Administration",1,"European Union",1,"A nested ligature",1)),"Expansion scopes preserved once: "+expansions);
            String extracted=new PDFTextStripper().getText(after);check(extracted.contains("Cooperate")&&!extracted.contains("noise")&&!extracted.contains("inner")&&extracted.contains("structure words"),"Extractor replacement survives nested ownership: "+extracted);
            System.out.println("Authored replacement, expansion, neighbors, ownership, glyphs and 150 DPI pixels verified");
        }
    }
    public static void main(String[] args)throws Exception {if("create".equals(args[0]))create(args[1],args[2],args.length>3?args[3]:"");else verify(args[1],args[2]);}
}
