import java.io.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;
public class DiagramFixture {
 static void text(PDPageContentStream c,PDFont f,float x,float y,float size,String text)throws Exception{
  c.beginText();c.setFont(f,size);c.newLineAtOffset(x,792-y-size);c.showText(text);c.endText();
 }
 public static void main(String[]args)throws Exception{
  try(PDDocument doc=new PDDocument()){
   PDFont f=PDType0Font.load(doc,new FileInputStream(args[1]),false);doc.addPage(new PDPage());doc.addPage(new PDPage());
   try(PDPageContentStream c=new PDPageContentStream(doc,doc.getPage(0))){
    text(c,f,72,40,20,"System block diagram");
    for(int i=0;i<8;i++)text(c,f,100+(i%2)*220+(i%3)*4,110+(i/2)*60,12,"Component "+i);
    float[][] lines={{120,130,400,200},{120,200,400,270},{120,270,400,340},{120,340,400,130}};
    for(float[]s:lines){c.moveTo(s[0],792-s[1]);c.lineTo(s[2],792-s[3]);c.stroke();}
    text(c,f,72,500,12,"Ordinary text outside the diagram.");
   }
   try(PDPageContentStream c=new PDPageContentStream(doc,doc.getPage(1))){
    text(c,f,72,40,20,"Data flow catalog");String[][]rows={{"Parameter","Value"},{"Input","100"},{"Output","200"},{"Reserve","300"}};
    for(int r=0;r<rows.length;r++)for(int col=0;col<2;col++)text(c,f,100+col*220,110+r*40,12,rows[r][col]);
    for(int r=0;r<=4;r++){c.moveTo(90,792-100-r*40);c.lineTo(450,792-100-r*40);c.stroke();}
    for(int x:new int[]{90,300,450}){c.moveTo(x,692);c.lineTo(x,532);c.stroke();}
   }
   if(args.length<3||!args[2].equals("no-form")) {
    PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(COSName.getPDFName("F1"),f);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
    PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Preserved diagram field");form.getFields().add(field);var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(72,60,300,24));widget.setPage(doc.getPage(0));widget.setPrinted(true);doc.getPage(0).getAnnotations().add(widget);field.setValue("Original café");
   }
   doc.save(args[0]);
  }
 }
}
