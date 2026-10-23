import java.io.*;
import java.nio.file.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.*;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.destination.*;
import org.apache.pdfbox.pdmodel.interactive.action.*;

public class NavigationFixture {
    static PDOutlineItem bookmark(PDPage page,String title){PDOutlineItem item=new PDOutlineItem();item.setTitle(title);PDPageFitDestination d=new PDPageFitDestination();d.setPage(page);item.setDestination(d);return item;}
    static COSDictionary label(String style,String prefix,int start){COSDictionary d=new COSDictionary();if(!style.isEmpty())d.setName(COSName.S,style);d.setString(COSName.P,prefix);d.setInt(COSName.ST,start);return d;}
    static COSArray array(COSBase... values){COSArray a=new COSArray();for(COSBase v:values)a.add(v);return a;}
    static void mutate(String[] args)throws Exception {
        try(PDDocument doc=Loader.loadPDF(new File(args[1]))){
            COSDictionary cat=doc.getDocumentCatalog().getCOSObject(),root=cat.getCOSDictionary(COSName.OUTLINES);
            COSDictionary first=root.getCOSDictionary(COSName.FIRST),last=root.getCOSDictionary(COSName.LAST);
            COSDictionary labels=cat.getCOSDictionary(COSName.PAGE_LABELS),leaf=labels.getCOSArray(COSName.KIDS).getObject(0) instanceof COSDictionary d?d:null;
            COSDictionary range=leaf.getCOSArray(COSName.NUMS).getObject(1) instanceof COSDictionary d?d:null;
            switch(args[3]){
                case "title":first.setString(COSName.TITLE,"Altered authored title");break;
                case "destination":first.getCOSArray(COSName.DEST).set(0,doc.getPage(5).getCOSObject());break;
                case "remote-destination":root.getCOSDictionary(COSName.FIRST).getCOSDictionary(COSName.NEXT).getCOSDictionary(COSName.A).setString(COSName.F,"other.pdf");break;
                case "named-destination":cat.getCOSDictionary(COSName.NAMES).getCOSDictionary(COSName.DESTS).getCOSArray(COSName.NAMES).getObject(1);((COSArray)cat.getCOSDictionary(COSName.NAMES).getCOSDictionary(COSName.DESTS).getCOSArray(COSName.NAMES).getObject(1)).set(0,doc.getPage(5).getCOSObject());break;
                case "parent":first.setItem(COSName.PARENT,first);break;
                case "cycle":last.setItem(COSName.NEXT,first);break;
                case "count":root.setInt(COSName.COUNT,999);break;
                case "reviewed-title":last.setString(COSName.TITLE,"Unexpected accepted title");break;
                case "label-prefix":range.setString(COSName.P,"Wrong-");break;
                case "label-start":range.setInt(COSName.ST,12);break;
                case "label-style":range.setName(COSName.S,"D");break;
                case "label-remove":cat.removeItem(COSName.PAGE_LABELS);break;
                case "label-cycle":labels.setItem(COSName.KIDS,array(labels));break;
                case "field":doc.getDocumentCatalog().getAcroForm().getField("entry").setValue("Changed");break;
                case "label-zero":range.setInt(COSName.ST,0);break;
                case "label-limits":leaf.setItem(COSName.LIMITS,array(COSInteger.ZERO,COSInteger.get(5)));break;
                case "label-kid-order":{COSArray kids=labels.getCOSArray(COSName.KIDS);COSBase v=kids.get(0);kids.set(0,kids.get(1));kids.set(1,v);break;}
            }
            try(OutputStream out=Files.newOutputStream(Path.of(args[2]))){doc.saveIncremental(out);}
        }
    }
    public static void main(String[] args)throws Exception {
        if(args[0].equals("mutate")){mutate(args);return;}
        try(PDDocument doc=new PDDocument()){
            PDFont font=PDType0Font.load(doc,new FileInputStream(args[2]),false);
            for(int i=1;i<=6;i++){PDPage page=new PDPage();doc.addPage(page);try(PDPageContentStream c=new PDPageContentStream(doc,page)){c.beginText();c.setFont(font,12);c.newLineAtOffset(72,700);c.showText("Navigation page "+i);c.endText();}}
            COSDictionary catalog=doc.getDocumentCatalog().getCOSObject();
            PDDocumentOutline outline=new PDDocumentOutline();doc.getDocumentCatalog().setDocumentOutline(outline);
            PDOutlineItem first=bookmark(doc.getPage(1),"Original résumé");first.setBold(true);first.setItalic(true);outline.addLast(first);
            PDOutlineItem child=new PDOutlineItem();child.setTitle("Named café");child.getCOSObject().setItem(COSName.DEST,new COSString("chapter"));first.addLast(child);
            PDOutlineItem legacy=new PDOutlineItem();legacy.setTitle("Legacy destination");legacy.getCOSObject().setItem(COSName.DEST,COSName.getPDFName("legacy"));first.addLast(legacy);first.openNode();
            PDOutlineItem remote=new PDOutlineItem();remote.setTitle("Authored remote manual");PDActionRemoteGoTo action=new PDActionRemoteGoTo();COSDictionary a=action.getCOSObject();a.setString(COSName.F,"manual.pdf");a.setItem(COSName.D,array(COSInteger.ZERO,COSName.getPDFName("Fit")));remote.setAction(action);outline.addLast(remote);
            COSDictionary names=new COSDictionary(),destinations=new COSDictionary();destinations.setItem(COSName.NAMES,array(new COSString("chapter"),array(doc.getPage(2).getCOSObject(),COSName.getPDFName("FitH"),COSInteger.get(500))));names.setItem(COSName.DESTS,destinations);catalog.setItem(COSName.NAMES,names);
            COSDictionary oldNames=new COSDictionary();oldNames.setItem(COSName.getPDFName("legacy"),array(doc.getPage(3).getCOSObject(),COSName.getPDFName("FitV"),COSInteger.get(40)));catalog.setItem(COSName.DESTS,oldNames);
            if(!args[3].equals("absent")){
                COSDictionary labels=new COSDictionary();COSArray kids=new COSArray();
                if(java.util.Set.of("mixed","fresh","empty-outline").contains(args[3])){for(int i=0;i<3;i++){COSDictionary leaf=new COSDictionary();int start=i*2;leaf.setItem(COSName.NUMS,array(COSInteger.get(start),label(i==0?"r":i==1?"D":"A",i==1?"Sec-":"",i==2?27:1)));leaf.setItem(COSName.LIMITS,array(COSInteger.get(start),COSInteger.get(start)));kids.add(leaf);}}
                else {COSDictionary leaf=new COSDictionary();leaf.setItem(COSName.NUMS,array(COSInteger.ZERO,label(args[3].equals("prefix")?"":args[3],args[3].equals("prefix")?"Appendix":"",1)));leaf.setItem(COSName.LIMITS,array(COSInteger.ZERO,COSInteger.ZERO));kids.add(leaf);}
                labels.setItem(COSName.KIDS,kids);catalog.setItem(COSName.PAGE_LABELS,labels);
            }
            PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(COSName.getPDFName("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
            PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Unchanged navigation fixture field");form.getFields().add(field);
            var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(72,500,300,30));widget.setPage(doc.getPage(0));widget.setPrinted(true);doc.getPage(0).getAnnotations().add(widget);field.setValue("Original café");
            if(args[3].equals("fresh"))catalog.removeItem(COSName.OUTLINES);
            if(args[3].equals("empty-outline"))catalog.setItem(COSName.OUTLINES,new PDDocumentOutline());
            doc.save(new File(args[1]));
        }
    }
}
