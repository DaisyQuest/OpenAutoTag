import java.io.*;
import java.awt.image.BufferedImage;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.image.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.util.Matrix;
public class CaptionFixture {
 static float[] point(PDPage p,float x,float y){var b=p.getCropBox();float u=p.getUserUnit();return switch(p.getRotation()){
  case 0 -> new float[]{b.getLowerLeftX()+x/u,b.getUpperRightY()-y/u};
  case 90 -> new float[]{b.getLowerLeftX()+y/u,b.getLowerLeftY()+x/u};
  case 180 -> new float[]{b.getUpperRightX()-x/u,b.getLowerLeftY()+y/u};
  default -> new float[]{b.getUpperRightX()-y/u,b.getUpperRightY()-x/u};};}
 static Matrix matrix(PDPage p,float x,float y,float w,float h){float[]a=point(p,x,y+h),b=point(p,x+w,y+h),c=point(p,x,y);return new Matrix(b[0]-a[0],b[1]-a[1],c[0]-a[0],c[1]-a[1],a[0],a[1]);}
 static void text(PDPageContentStream c,PDPage p,PDFont f,float x,float y,String text)throws Exception {c.beginText();c.setFont(f,1);c.setTextMatrix(matrix(p,x,y,12,12));c.showText(text);c.endText();}
 public static void main(String[]args)throws Exception{
  try(PDDocument doc=new PDDocument()){
   PDFont font=PDType0Font.load(doc,new FileInputStream(args[1]),false);
   BufferedImage pixels=new BufferedImage(32,24,BufferedImage.TYPE_INT_RGB);for(int y=0;y<24;y++)for(int x=0;x<32;x++)pixels.setRGB(x,y,(x<16?0x235fa3:0xe39e37)^(y*123));
   PDImageXObject image=LosslessFactory.createFromImage(doc,pixels);
   PDFormXObject inner=new PDFormXObject(doc);inner.setBBox(new PDRectangle(1,1));inner.setResources(new PDResources());
   try(var c=new PDFormContentStream(inner)){c.drawImage(image,0,0,1,1);}
   PDFormXObject outer=new PDFormXObject(doc);outer.setBBox(new PDRectangle(1,1));outer.setResources(new PDResources());
   try(var c=new PDFormContentStream(outer)){c.drawForm(inner);}
   for(int i=0;i<4;i++){
    PDPage page=new PDPage(new PDRectangle(600,800));if(i>0){page.setCropBox(new PDRectangle(20,30,500,700));page.setRotation(i*90);page.setUserUnit(1.5f);}doc.addPage(page);
    try(var c=new PDPageContentStream(doc,page)){
     text(c,page,font,72,30,"Caption preservation page "+(i+1));
     if(i%2==1)text(c,page,font,72,75,"Figure "+(i+1)+": Test pattern.");
     if(i<2){c.drawImage(image,matrix(page,72,100,120,80));if(i==0&&args.length>2&&args[2].equals("duplicate"))c.drawImage(image,matrix(page,72,100,120,80));}
     else {boolean artifact=i==2&&args.length>2&&args[2].equals("artifact-form");if(artifact)c.beginMarkedContent(COSName.ARTIFACT);c.saveGraphicsState();c.transform(matrix(page,72,100,120,80));c.drawForm(outer);c.restoreGraphicsState();if(artifact)c.endMarkedContent();
      c.saveGraphicsState();c.transform(matrix(page,350,100,90,60));c.drawForm(outer);c.restoreGraphicsState();}
     if(i%2==0)text(c,page,font,72,190,"Figure "+(i+1)+": Test pattern.");
     text(c,page,font,72,235,"Unrelated paragraph outside the figure.");
     if(i==0){text(c,page,font,72,285,"Table 1: Inventory.");text(c,page,font,72,310,"Item");text(c,page,font,250,310,"Count");text(c,page,font,72,335,"North");text(c,page,font,250,335,"100");}
     if(i==1){text(c,page,font,72,310,"Model");text(c,page,font,250,310,"Value");text(c,page,font,72,335,"South");text(c,page,font,250,335,"200");text(c,page,font,72,360,"Table 2: Inventory.");}
    }
   }
   PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(COSName.getPDFName("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
   PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Preserved caption field");form.getFields().add(field);var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(72,60,300,24));widget.setPage(doc.getPage(0));widget.setPrinted(true);doc.getPage(0).getAnnotations().add(widget);field.setValue("Original café");doc.save(args[0]);
  }
 }
}
