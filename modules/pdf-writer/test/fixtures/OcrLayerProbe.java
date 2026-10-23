import java.io.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.rendering.PDFRenderer;

public class OcrLayerProbe {
    static byte[] bytes(PDStream s)throws Exception{try(var in=s.createInputStream()){return in.readAllBytes();}}
    static void samePixels(PDDocument a,PDDocument b)throws Exception {
        var ra=new PDFRenderer(a);var rb=new PDFRenderer(b);
        for(int i=0;i<a.getNumberOfPages();i++) {
            var x=ra.renderImageWithDPI(i,120);var y=rb.renderImageWithDPI(i,120);
            if(x.getWidth()!=y.getWidth()||x.getHeight()!=y.getHeight()||!Arrays.equals(x.getRGB(0,0,x.getWidth(),x.getHeight(),null,0,x.getWidth()),y.getRGB(0,0,y.getWidth(),y.getHeight(),null,0,y.getWidth())))throw new IOException("Pixel difference page "+(i+1));
            for(COSName name:a.getPage(i).getResources().getXObjectNames()) {
                var left=a.getPage(i).getResources().getXObject(name);var right=b.getPage(i).getResources().getXObject(name);
                if(left instanceof org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject && (right==null||!Arrays.equals(bytes(new PDStream(left.getCOSObject())),bytes(new PDStream(right.getCOSObject())))))throw new IOException("Source image changed");
            }
        }
    }
    public static void main(String[] args)throws Exception {
        try(var doc=Loader.loadPDF(new File(args[1]))) {
            if(args[0].equals("mixed")) {
                PDType0Font font;try(var input=new FileInputStream(args[3])){font=PDType0Font.load(doc,input,false);}var page=doc.getPage(0);
                try(var s=new PDPageContentStream(doc,page,PDPageContentStream.AppendMode.APPEND,true,true)) {
                    s.beginText();s.setFont(font,12);s.newLineAtOffset(30,110);s.showText("Native words stay once");s.endText();
                }
                var form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);var resources=new PDResources();resources.put(COSName.getPDFName("Focr"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/Focr 10 Tf 0 g");
                var field=new PDTextField(form);field.setPartialName("review");field.setDefaultAppearance("/Focr 10 Tf 0 g");form.getFields().add(field);
                var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(30,25,180,20));widget.setPage(page);page.getAnnotations().add(widget);field.setValue("Original value");doc.save(args[2]);return;
            }
            if(args[0].equals("verify")) {
                try(var other=Loader.loadPDF(new File(args[2]))) {
                    samePixels(doc,other);
                    if(doc.getDocumentCatalog().getAcroForm()!=null) {
                        var a=doc.getDocumentCatalog().getAcroForm().getField("review");var b=other.getDocumentCatalog().getAcroForm().getField("review");
                        if(b==null||!a.getValueAsString().equals(b.getValueAsString()))throw new IOException("Field changed");
                        if(!Arrays.equals(bytes(new PDStream(a.getWidgets().get(0).getNormalAppearanceStream().getCOSObject())),bytes(new PDStream(b.getWidgets().get(0).getNormalAppearanceStream().getCOSObject()))))throw new IOException("Field appearance changed");
                        a.setValue("Edited value");b.setValue("Edited value");
                        doc.save(args[2]+".source-filled.pdf");other.save(args[2]+".filled.pdf");
                        try(var aa=Loader.loadPDF(new File(args[2]+".source-filled.pdf"));var bb=Loader.loadPDF(new File(args[2]+".filled.pdf"))) {
                            if(!"Edited value".equals(bb.getDocumentCatalog().getAcroForm().getField("review").getValueAsString()))throw new IOException("Saved field value lost");samePixels(aa,bb);
                        }
                    }
                }
                System.out.println("pixels, images and editable fields preserved");return;
            }
            PDPage page=doc.getPage(0);var streams=new ArrayList<PDStream>();page.getContentStreams().forEachRemaining(streams::add);
            PDStream layer=streams.get(streams.size()-1);var tokens=new PDFStreamParser(bytes(layer)).parse();String mode=args[3];
            if(mode.equals("missing")){streams.remove(streams.size()-1);page.setContents(streams);}
            else {
                for(int i=0;i<tokens.size();i++)if(tokens.get(i) instanceof Operator) {
                    String op=((Operator)tokens.get(i)).getName();
                    if(mode.equals("visible")&&op.equals("Tr")){tokens.set(i-1,COSInteger.ZERO);break;}
                    if(mode.equals("shifted")&&op.equals("Tm")){tokens.set(i-2,new COSFloat(((COSNumber)tokens.get(i-2)).floatValue()+5));break;}
                    if(mode.equals("partial")&&op.equals("Tj")){byte[] s=((COSString)tokens.get(i-1)).getBytes();tokens.set(i-1,new COSString(Arrays.copyOf(s,s.length-2)));break;}
                    if(mode.equals("owner")&&op.equals("BDC")){((COSDictionary)tokens.get(i-1)).setInt(COSName.MCID,50000);break;}
                }
                if(mode.equals("duplicate"))tokens.addAll(new ArrayList<>(tokens));
                try(var out=layer.createOutputStream(COSName.FLATE_DECODE)){new ContentStreamWriter(out).writeTokens(tokens);}
            }
            doc.save(args[2]);
        }
    }
}
