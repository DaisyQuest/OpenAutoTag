import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.documentinterchange.markedcontent.PDPropertyList;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.pdmodel.interactive.action.PDActionURI;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.util.Matrix;

public class NativeLinkGroupFixture {
    static COSDictionary find(COSBase value,String id) {
        if(value instanceof COSObject o)value=o.getObject();
        if(value instanceof COSArray a){for(COSBase child:a){COSDictionary found=find(child,id);if(found!=null)return found;}}
        if(value instanceof COSDictionary d){if(id.equals(d.getString(COSName.ID)))return d;return find(d.getDictionaryObject(COSName.K),id);}
        return null;
    }
    static void mutate(String[] args)throws IOException {
        try(PDDocument doc=Loader.loadPDF(new File(args[1]))) {
            COSBase root=doc.getDocumentCatalog().getStructureTreeRoot().getCOSObject();
            COSDictionary link=find(root,"oat-native-link:1:0"),parent=find(root,"oat:body-1"),member=find(root,"oat:run-1-1");
            COSArray kids=link.getCOSArray(COSName.K);
            switch(args[3]){
                case "child-order":{COSBase first=kids.get(0);kids.set(0,kids.get(1));kids.set(1,first);break;}
                case "steal-neighbor":{COSDictionary neighbor=find(root,"oat:run-1-0");parent.getCOSArray(COSName.K).remove(0);kids.add(0,neighbor);neighbor.setItem(COSName.P,link);break;}
                case "wrong-parent":member.setItem(COSName.P,parent);break;
                case "group-replacement":link.setString(COSName.ACTUAL_TEXT,"open café");break;
                case "extra-content":{COSBase content=member.getDictionaryObject(COSName.K);kids.add(0,content instanceof COSArray a?a.get(0):content);break;}
                case "member-replacement":member.setString(COSName.ACTUAL_TEXT,"wrong");break;
                case "member-role":member.setItem(COSName.S,COSName.P);break;
            }
            doc.save(new File(args[2]));
        }
    }
    static float width(PDFont f,String s)throws IOException{return f.getStringWidth(s)*12/1000;}
    static void link(PDDocument doc,PDPage page,PDFont font,String[] texts,float[][] points,int[] indices)throws IOException {
        float[] quads=new float[8*indices.length];float left=10000,bottom=10000,right=0,top=0;int at=0;
        for(int i:indices){float x=points[i][0],y=points[i][1],w=width(font,texts[i]);for(float v:new float[]{x,y-2,x+w,y-2,x+w,y+12,x,y+12})quads[at++]=v;left=Math.min(left,x);bottom=Math.min(bottom,y-2);right=Math.max(right,x+w);top=Math.max(top,y+12);}
        PDAnnotationLink link=new PDAnnotationLink();link.setPage(page);link.setRectangle(new PDRectangle(left-1,bottom-1,right-left+2,top-bottom+2));link.setQuadPoints(quads);
        PDActionURI action=new PDActionURI();action.setURI("https://www.w3.org/WAI/"+indices[0]);link.setAction(action);
        COSArray border=new COSArray();for(int i=0;i<3;i++)border.add(COSInteger.ZERO);link.setBorder(border);
        PDAppearanceStream ap=new PDAppearanceStream(doc);ap.setBBox(new PDRectangle(1,1));ap.setResources(new PDResources());try(var out=ap.getCOSObject().createOutputStream()){}
        PDAppearanceDictionary appearances=new PDAppearanceDictionary();appearances.setNormalAppearance(ap);link.setAppearance(appearances);page.getAnnotations().add(link);
    }
    public static void main(String[] args)throws Exception {
        if(args[0].equals("mutate")){mutate(args);return;}
        Path dir=Path.of(args[0]);Files.createDirectories(dir);List<String> manifest=new ArrayList<>();
        try(PDDocument doc=new PDDocument()) {
            PDFont font=PDType0Font.load(doc,new FileInputStream(args[1]),false);
            for(String mode:List.of("wrapped","same-line","reverse-paint","generated-text","mixed-language","nested-form","two-groups","separate-paragraphs","intervening-sibling","different-parents","partial-span","differing-text","ancestor-text","authored-scope","alternate-text","nested-span")) {
                PDPage page=new PDPage();doc.addPage(page);String[] texts={"Before ","open ","café"," after","NEARBY"};
                float[][] points={{72,700},{130,700},{72,670},{110,670},{72,685}};
                if(mode.equals("same-line")){points[2]=new float[]{160,700};points[3]=new float[]{195,700};}
                int[] order=mode.equals("reverse-paint")?new int[]{4,3,2,1,0}:new int[]{0,1,2,3,4};
                PDFormXObject form=new PDFormXObject(doc);form.setBBox(new PDRectangle(612,792));form.setResources(new PDResources());
                try(PDFormContentStream c=new PDFormContentStream(form)){
                    for(int i:order){c.beginText();c.setFont(font,12);c.setTextMatrix(Matrix.getTranslateInstance(points[i][0],points[i][1]));
                        if(mode.equals("authored-scope")&&i==1){COSDictionary p=new COSDictionary();p.setString(COSName.ACTUAL_TEXT,texts[i]);c.beginMarkedContent(COSName.getPDFName("Span"),PDPropertyList.create(p));c.showText(texts[i]);c.endMarkedContent();}else c.showText(texts[i]);c.endText();}
                }
                if(mode.equals("nested-form"))try(PDPageContentStream c=new PDPageContentStream(doc,page)){c.drawForm(form);}
                else {PDStream stream=new PDStream(doc);try(var in=form.getContents();var out=stream.createOutputStream()){in.transferTo(out);}page.setContents(stream);page.setResources(form.getResources());}
                if(mode.equals("two-groups")){link(doc,page,font,texts,points,new int[]{0,1});link(doc,page,font,texts,points,new int[]{2,3});}
                else link(doc,page,font,texts,points,new int[]{1,2});
                List<String> runs=new ArrayList<>();for(int i=0;i<texts.length;i++)runs.add("{\"text\":\""+texts[i]+"\",\"bbox\":["+points[i][0]+","+(792-points[i][1]-12)+","+width(font,texts[i])+",14]}");
                manifest.add("{\"mode\":\""+mode+"\",\"pageNumber\":"+doc.getNumberOfPages()+",\"positive\":"+(manifest.size()<7)+",\"runs\":["+String.join(",",runs)+"]}");
            }
            PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(COSName.getPDFName("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
            PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Unchanged grouping fixture field");form.getFields().add(field);
            var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(72,500,300,30));widget.setPage(doc.getPage(0));widget.setPrinted(true);doc.getPage(0).getAnnotations().add(widget);field.setValue("Original café");
            doc.save(dir.resolve("source.pdf").toFile());
        }
        Files.writeString(dir.resolve("cases.json"),"["+String.join(",",manifest)+"]");
    }
}
