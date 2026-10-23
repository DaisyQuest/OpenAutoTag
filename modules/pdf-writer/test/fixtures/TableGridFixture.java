import java.nio.file.*;
import java.io.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;

public class TableGridFixture {
    public static void main(String[] args)throws Exception {
        try(PDDocument doc=new PDDocument()) {
            PDFont font=PDType0Font.load(doc,new FileInputStream(args[2]),false);
            for(int i=0;i<4;i++)doc.addPage(new PDPage());
            for(String line:Files.readAllLines(Path.of(args[1]))) {
                String[] fields=line.split("\t",4);PDPage page=doc.getPage(Integer.parseInt(fields[0])-1);
                try(PDPageContentStream c=new PDPageContentStream(doc,page,PDPageContentStream.AppendMode.APPEND,true,true)) {
                    c.beginText();c.setFont(font,12);c.newLineAtOffset(Float.parseFloat(fields[1]),792-Float.parseFloat(fields[2])-12);c.showText(fields[3]);c.endText();
                }
            }
            if(args.length<4||!args[3].equals("no-form")) {
            PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(COSName.getPDFName("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
            PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Preserved grid field");form.getFields().add(field);
            var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(72,60,300,24));widget.setPage(doc.getPage(0));widget.setPrinted(true);doc.getPage(0).getAnnotations().add(widget);field.setValue("Original café");
            }
            doc.save(args[0]);
        }
    }
}
