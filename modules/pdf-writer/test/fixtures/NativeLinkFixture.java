import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.font.encoding.WinAnsiEncoding;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.pdmodel.interactive.action.PDActionURI;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.destination.PDPageFitDestination;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.documentinterchange.markedcontent.PDPropertyList;
import org.apache.pdfbox.util.Matrix;

public class NativeLinkFixture {
    static float width(PDFont font,String text)throws Exception{return font.getStringWidth(text)*12/1000;}
    public static void main(String[] args)throws Exception {
        Path dir=Path.of(args[0]);Files.createDirectories(dir);
        for(String mode:List.of("partial","operators","array","simple","nested","destination","authored-contents","appearance","two-links","overlap","no-anchor","hidden","quad-review","shared","two-nodes","existing-link","existing-link-boundary","generated-text","differing-text","ancestor-text","authored-scope"))try(PDDocument doc=new PDDocument()) {
            PDPage page=new PDPage();doc.addPage(page);
            if(mode.equals("destination"))doc.addPage(new PDPage());
            PDFont font=mode.equals("simple")?PDTrueTypeFont.load(doc,new File(args[1]),WinAnsiEncoding.INSTANCE):PDType0Font.load(doc,new FileInputStream(args[1]),false);
            String prefix="Before ",anchor="open café",after=" after";
            if(mode.equals("existing-link")){prefix="";after="";}
            float x=72,y=700,left=x+width(font,prefix),right=left+width(font,anchor);
            if(mode.equals("nested")) {
                PDFormXObject form=new PDFormXObject(doc);form.setBBox(new PDRectangle(0,0,400,60));form.setResources(new PDResources());
                try(PDFormContentStream c=new PDFormContentStream(form)){c.beginText();c.setFont(font,12);c.newLineAtOffset(0,20);c.showText(prefix+anchor+after);c.endText();}
                try(PDPageContentStream c=new PDPageContentStream(doc,page)){c.saveGraphicsState();c.transform(Matrix.getTranslateInstance(x,y-20));c.drawForm(form);c.restoreGraphicsState();c.saveGraphicsState();c.transform(Matrix.getTranslateInstance(x,y-120));c.drawForm(form);c.restoreGraphicsState();}
            } else try(PDPageContentStream c=new PDPageContentStream(doc,page)) {
                c.beginText();c.setFont(font,12);c.newLineAtOffset(x,y);
                if(mode.equals("authored-scope")){
                    c.showText(prefix);COSDictionary property=new COSDictionary();property.setString(COSName.ACTUAL_TEXT,anchor);
                    c.beginMarkedContent(COSName.getPDFName("Span"),PDPropertyList.create(property));c.showText(anchor);c.endMarkedContent();c.showText(after);
                }
                else if(mode.equals("operators")||mode.equals("two-nodes")){c.showText(prefix);c.showText(anchor);c.showText(after);}
                else if(mode.equals("array")){c.showTextWithPositioning(new Object[]{prefix,30f,"open ",-40f,"café",after});left-=0.36f;right+=0.12f;}
                else c.showText(prefix+anchor+after);
                c.endText();
            }
            PDAnnotationLink link=new PDAnnotationLink();link.setRectangle(new PDRectangle(left,y-2,right-left,14));link.setPage(page);
            PDActionURI uri=new PDActionURI();uri.setURI("https://www.w3.org/WAI/");link.setAction(uri);page.getAnnotations().add(link);
            if(mode.equals("destination")){link.getCOSObject().removeItem(COSName.A);PDPageFitDestination dest=new PDPageFitDestination();dest.setPage(page);link.setDestination(dest);}
            if(mode.equals("authored-contents"))link.setContents("Authored accessible description");
            if(mode.equals("appearance")){
                PDAppearanceStream ap=new PDAppearanceStream(doc);ap.setBBox(new PDRectangle(right-left,14));ap.setResources(new PDResources());
                try(PDAppearanceContentStream c=new PDAppearanceContentStream(ap)){c.setStrokingColor(0f,0f,1f);c.moveTo(0,1);c.lineTo(right-left,1);c.stroke();}
                PDAppearanceDictionary dictionary=new PDAppearanceDictionary();dictionary.setNormalAppearance(ap);link.setAppearance(dictionary);
            }
            if(mode.equals("overlap")){PDAnnotationLink other=new PDAnnotationLink();other.setRectangle(link.getRectangle());PDActionURI a=new PDActionURI();a.setURI("https://www.nasa.gov/");other.setAction(a);page.getAnnotations().add(other);}
            if(mode.equals("two-links")){PDAnnotationLink other=new PDAnnotationLink();other.setRectangle(new PDRectangle(x,y-2,width(font,"Before"),14));PDActionURI a=new PDActionURI();a.setURI("https://www.nasa.gov/");other.setAction(a);page.getAnnotations().add(other);}
            if(mode.equals("no-anchor"))link.setRectangle(new PDRectangle(72,400,100,15));
            if(mode.equals("hidden"))link.setHidden(true);
            if(mode.equals("quad-review"))link.setQuadPoints(new float[]{left,y+12,right,y+12,left,y-2,right,y-2});
            if(mode.equals("shared"))page.getAnnotations().add(link);
            PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(COSName.getPDFName("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
            PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Unchanged sample field");form.getFields().add(field);
            var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(72,500,300,30));widget.setPage(page);widget.setPrinted(true);page.getAnnotations().add(widget);field.setValue("Original café");
            doc.save(dir.resolve(mode+".pdf").toFile());
        }
    }
}
