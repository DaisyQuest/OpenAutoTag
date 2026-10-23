import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.pdmodel.interactive.action.PDActionURI;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.util.Matrix;

public class NativeLinkGeometryFixture {
    static float width(PDFont font,String s)throws IOException{return font.getStringWidth(s)*12/1000;}
    static double[] transformed(Matrix m,double x,double y){var p=m.transformPoint((float)x,(float)y);return new double[]{p.x,p.y};}
    static float[] quad(Matrix m,double left,double bottom,double right,double top){
        float[] out=new float[8];int i=0;
        for(double[] p:new double[][]{{left,bottom},{right,bottom},{right,top},{left,top}}){double[] q=transformed(m,p[0],p[1]);out[i++]=(float)q[0];out[i++]=(float)q[1];}return out;
    }
    static PDRectangle bounds(float[]... quads){float minX=Float.MAX_VALUE,minY=minX,maxX=-minX,maxY=-minX;for(float[] q:quads)for(int i=0;i<q.length;i+=2){minX=Math.min(minX,q[i]);minY=Math.min(minY,q[i+1]);maxX=Math.max(maxX,q[i]);maxY=Math.max(maxY,q[i+1]);}return new PDRectangle(minX-1,minY-1,maxX-minX+2,maxY-minY+2);}
    static String displayBox(PDPage p,float[] q){List<Double> xs=new ArrayList<>(),ys=new ArrayList<>();var c=p.getCropBox();for(int i=0;i<q.length;i+=2){double x=q[i],y=q[i+1],a=0,b=0;switch(p.getRotation()){
        case 0:a=x-c.getLowerLeftX();b=c.getUpperRightY()-y;break;case 90:a=y-c.getLowerLeftY();b=x-c.getLowerLeftX();break;
        case 180:a=c.getUpperRightX()-x;b=y-c.getLowerLeftY();break;case 270:a=c.getUpperRightY()-y;b=c.getUpperRightX()-x;break;
    }xs.add(a*p.getUserUnit());ys.add(b*p.getUserUnit());}return "["+Collections.min(xs)+","+Collections.min(ys)+","+(Collections.max(xs)-Collections.min(xs))+","+(Collections.max(ys)-Collections.min(ys))+"]";}
    static PDAnnotationLink link(PDDocument doc,PDPage p,PDRectangle rect,float[] q,String uri)throws IOException{
        PDAnnotationLink a=new PDAnnotationLink();a.setPage(p);a.setRectangle(rect);PDActionURI action=new PDActionURI();action.setURI(uri);a.setAction(action);
        COSArray border=new COSArray();for(int i=0;i<3;i++)border.add(COSInteger.ZERO);a.setBorder(border);
        PDAppearanceStream ap=new PDAppearanceStream(doc);ap.setBBox(new PDRectangle(1,1));ap.setResources(new PDResources());try(var out=ap.getCOSObject().createOutputStream()){}
        PDAppearanceDictionary appearances=new PDAppearanceDictionary();appearances.setNormalAppearance(ap);a.setAppearance(appearances);
        if(q!=null)a.setQuadPoints(q);p.getAnnotations().add(a);return a;
    }
    public static void main(String[] args)throws Exception{
        Path dir=Path.of(args[0]);Files.createDirectories(dir);List<String> manifest=new ArrayList<>();
        try(PDDocument doc=new PDDocument()){
            PDFont font=PDType0Font.load(doc,new FileInputStream(args[1]),false);
            List<String> modes=List.of("rect-0","rect-90","rect-180","rect-270","rect-unit","quad-0","quad-90","quad-180","quad-270","quad-unit","text-37","text-90","text-180","text-270","shear","nested-37","multiline","disjoint","duplicate","boundary-decimals","clockwise","z-order","degenerate","concave","outside","empty","odd","non-number","excessive","path");
            for(String mode:modes){
                PDPage page=new PDPage(new PDRectangle(-31,47,500,600));page.setCropBox(new PDRectangle(-11,67,460,560));doc.addPage(page);
                int rotation=mode.matches("(rect|quad)-(90|180|270)")?Integer.parseInt(mode.substring(mode.indexOf('-')+1)):mode.endsWith("unit")?90:0;page.setRotation(rotation);if(mode.endsWith("unit"))page.setUserUnit(2);
                double angle=mode.startsWith("text-")?Math.toRadians(Integer.parseInt(mode.substring(5))):mode.equals("nested-37")?Math.toRadians(37):0;
                Matrix matrix=mode.equals("shear")?new Matrix(1.1f,.3f,.2f,.9f,130,350):Matrix.getRotateInstance(angle,180,350);
                if(mode.equals("boundary-decimals"))matrix=Matrix.getTranslateInstance(180.125f,350.3333f);
                float left=width(font,"Before "),right=left+width(font,"open café"),all=width(font,"Before open café after");
                boolean multi=mode.equals("multiline"),rectMode=mode.startsWith("rect-");
                float[] region=quad(matrix,left,-2,right,12),whole=quad(matrix,0,multi?-32:-2,all,12),region2=null;
                if(multi){region=quad(matrix,left,-2,left+width(font,"open "),12);region2=quad(matrix,0,-32,width(font,"café"),-18);}
                if(mode.equals("nested-37")){
                    PDFormXObject form=new PDFormXObject(doc);form.setResources(new PDResources());form.setBBox(new PDRectangle(-10,-10,all+20,40));
                    try(PDFormContentStream c=new PDFormContentStream(form)){c.beginText();c.setFont(font,12);c.showText("Before open café after");c.endText();}
                    try(PDPageContentStream c=new PDPageContentStream(doc,page)){c.transform(matrix);c.drawForm(form);}
                }else try(PDPageContentStream c=new PDPageContentStream(doc,page)){
                    c.transform(matrix);c.beginText();c.setFont(font,12);
                    c.showText(multi?"Before open ":"Before open café after");
                    if(multi){c.newLineAtOffset(0,-30);c.showText("café after");}
                    c.endText();
                    if(multi){c.beginText();c.setFont(font,7);c.newLineAtOffset(5,-12);c.showText("NEARBY");c.endText();}
                }
                float[] qs=region;
                if(multi){qs=new float[16];System.arraycopy(region,0,qs,0,8);System.arraycopy(region2,0,qs,8,8);}
                PDAnnotationLink annotation=link(doc,page,rectMode?bounds(region):bounds(whole),rectMode?null:qs,"https://www.w3.org/WAI/");
                if(mode.equals("boundary-decimals")){PDRectangle r=new PDRectangle();r.setLowerLeftX(region[0]);r.setLowerLeftY(region[1]);r.setUpperRightX(region[4]);r.setUpperRightY(region[5]);annotation.setRectangle(r);}
                if(mode.equals("disjoint"))link(doc,page,bounds(whole),quad(matrix,0,-2,width(font,"Before"),12),"https://www.nasa.gov/");
                if(mode.equals("duplicate")){float[] q=new float[16];System.arraycopy(region,0,q,0,8);System.arraycopy(region,0,q,8,8);annotation.setQuadPoints(q);}
                if(mode.equals("clockwise"))annotation.setQuadPoints(new float[]{region[0],region[1],region[6],region[7],region[4],region[5],region[2],region[3]});
                if(mode.equals("z-order"))annotation.setQuadPoints(new float[]{region[6],region[7],region[4],region[5],region[0],region[1],region[2],region[3]});
                if(mode.equals("degenerate")){float[] q=region.clone();q[4]=q[2];q[5]=q[3];annotation.setQuadPoints(q);}
                if(mode.equals("concave")){float[] q=quad(matrix,left,-5,right+100,12);double[] tip=transformed(matrix,right+80,-3);q[4]=(float)tip[0];q[5]=(float)tip[1];annotation.setRectangle(bounds(q));annotation.setQuadPoints(q);}
                if(mode.equals("outside")){float[] q=region.clone();q[0]=page.getCropBox().getLowerLeftX()-20;annotation.setQuadPoints(q);}
                if(mode.equals("empty"))annotation.setQuadPoints(new float[0]);
                if(mode.equals("odd"))annotation.setQuadPoints(Arrays.copyOf(region,7));
                if(mode.equals("non-number"))annotation.getCOSObject().getCOSArray(COSName.getPDFName("QuadPoints")).set(0,new COSString("bad"));
                if(mode.equals("excessive")){float[] q=new float[1025*8];for(int i=0;i<1025;i++)System.arraycopy(region,0,q,i*8,8);annotation.setQuadPoints(q);}
                if(mode.equals("path"))annotation.getCOSObject().setItem(COSName.getPDFName("Path"),new COSArray());
                boolean positive=modes.indexOf(mode)<20||mode.equals("concave");
                String line="{\"mode\":\""+mode+"\",\"pageNumber\":"+doc.getNumberOfPages()+",\"positive\":"+positive+",\"expectedBound\":"+(positive?(mode.equals("disjoint")?2:1):0)+",\"bbox\":"+displayBox(page,whole);
                if(multi)line+=",\"decoyBox\":"+displayBox(page,quad(matrix,5,-13,50,-5));
                if(mode.equals("concave"))line+=",\"expectedAnchor\":\"open café after\"";
                manifest.add(line+"}");
            }
            PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(COSName.getPDFName("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
            PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Unchanged geometry fixture field");form.getFields().add(field);
            var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(30,120,300,30));widget.setPage(doc.getPage(0));widget.setPrinted(true);doc.getPage(0).getAnnotations().add(widget);field.setValue("Original café");
            doc.save(dir.resolve("source.pdf").toFile());
        }
        Files.writeString(dir.resolve("cases.json"),"["+String.join(",",manifest)+"]");
    }
}
