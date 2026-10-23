import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.font.encoding.WinAnsiEncoding;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;

public class EditableFontFixture {
    public static void main(String[] args) throws Exception {
        Path dir=Path.of(args[0]); Files.createDirectories(dir);
        for(String mode:List.of("unicode","simple","inherited","multiwidget","multiline","comb","autosize","readonly","password","rich","file","maxlen","hidden","noview","zero-rect","no-page","actions","widget-actions","calculate","need-appearances","xfa","unembedded","missing-resource","conflict","clipped","subset","wrong-unicode","wrong-gid","checkbox","signed","encrypted")) {
            try(PDDocument doc=new PDDocument()) {
                PDPage page=new PDPage();doc.addPage(page);
                PDAcroForm form=new PDAcroForm(doc);doc.getDocumentCatalog().setAcroForm(form);
                PDResources resources=new PDResources();form.setDefaultResources(resources);
                PDFont font=mode.equals("simple")?PDTrueTypeFont.load(doc,new File(args[1]),WinAnsiEncoding.INSTANCE):
                    mode.equals("unembedded")?new PDType1Font(Standard14Fonts.FontName.HELVETICA):
                    PDType0Font.load(doc,new FileInputStream(args[1]),mode.equals("subset"));
                resources.put(COSName.getPDFName("F1"),font);form.setDefaultAppearance("/F1 12 Tf 0 g");
                PDTextField field=new PDTextField(form);field.setPartialName("sample");field.setDefaultAppearance("/F1 12 Tf 0 g");form.getFields().add(field);
                PDAnnotationWidget w=field.getWidgets().get(0);w.setRectangle(new PDRectangle(50,650,400,50));w.setPage(page);w.setPrinted(true);page.getAnnotations().add(w);
                field.setValue("Original");
                PDTextField other=new PDTextField(form);other.setPartialName("untouched");other.setDefaultAppearance("/F1 12 Tf 0 g");form.getFields().add(other);
                PDAnnotationWidget o=other.getWidgets().get(0);o.setRectangle(new PDRectangle(50,550,400,40));o.setPage(page);page.getAnnotations().add(o);other.setValue("Keep this value");
                try(PDPageContentStream content=new PDPageContentStream(doc,page)) {
                    content.setNonStrokingColor(0f,0f,0f);content.addRect(40,530,420,2);content.fill();
                }
                // Rendering synthesizes an AP for this link; it must never be saved in a probe.
                PDAnnotationLink link=new PDAnnotationLink();link.setRectangle(new PDRectangle(50,490,160,20));page.getAnnotations().add(link);
                if(mode.equals("inherited"))field.getCOSObject().removeItem(COSName.DA);
                if(mode.equals("multiwidget")) {
                    PDAnnotationWidget first=new PDAnnotationWidget();first.setRectangle(w.getRectangle());first.setPage(page);first.setParent(field);
                    PDPage second=new PDPage();doc.addPage(second);PDAnnotationWidget next=new PDAnnotationWidget();next.setRectangle(new PDRectangle(80,500,400,50));next.setPage(second);next.setParent(field);
                    field.getCOSObject().removeItem(COSName.SUBTYPE);field.getCOSObject().removeItem(COSName.RECT);field.getCOSObject().removeItem(COSName.AP);field.getCOSObject().removeItem(COSName.P);
                    field.setWidgets(List.of(first,next));page.getAnnotations().set(0,first);second.getAnnotations().add(next);field.setValue("Original");
                }
                switch(mode) {
                    case "multiline":field.setMultiline(true);break;
                    case "comb":field.setMaxLen(30);field.setComb(true);break;
                    case "autosize":field.setDefaultAppearance("/F1 0 Tf 0 g");break;
                    case "readonly":field.setReadOnly(true);break;
                    case "password":field.setPassword(true);break;
                    case "rich":field.setRichText(true);break;
                    case "file":field.setFileSelect(true);break;
                    case "maxlen":field.setMaxLen(2);break;
                    case "hidden":w.setHidden(true);break;
                    case "noview":w.setNoView(true);break;
                    case "zero-rect":w.setRectangle(new PDRectangle(0,0,0,20));break;
                    case "no-page":page.getAnnotations().remove(0);break;
                    case "actions":field.getCOSObject().setItem(COSName.AA,new COSDictionary());break;
                    case "widget-actions":w.getCOSObject().setItem(COSName.A,new COSDictionary());break;
                    case "calculate":form.getCOSObject().setItem(COSName.CO,new COSArray());break;
                    case "need-appearances":form.setNeedAppearances(true);break;
                    case "xfa":form.getCOSObject().setItem(COSName.XFA,new COSString("test"));break;
                    case "missing-resource":field.setDefaultAppearance("/Missing 12 Tf 0 g");break;
                    case "conflict":w.getNormalAppearanceStream().setResources(new PDResources());w.getNormalAppearanceStream().getResources().put(COSName.getPDFName("F1"),new PDType1Font(Standard14Fonts.FontName.HELVETICA));break;
                    case "clipped":field.setDefaultAppearance("/F1 200 Tf 0 g");break;
                    case "checkbox":field.getCOSObject().setName(COSName.FT,"Btn");break;
                    case "signed": {
                        PDSignatureField signature=new PDSignatureField(form);signature.setPartialName("signature");
                        signature.getCOSObject().setItem(COSName.V,new COSDictionary());form.getFields().add(signature);break;
                    }
                    case "encrypted": {
                        var policy=new org.apache.pdfbox.pdmodel.encryption.StandardProtectionPolicy("qa-owner", "",new org.apache.pdfbox.pdmodel.encryption.AccessPermission());
                        policy.setEncryptionKeyLength(128);doc.protect(policy);break;
                    }
                    case "wrong-unicode": {
                        int code=font.readCode(new ByteArrayInputStream(font.encode("A")));
                        String cmap="/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange 1 beginbfchar <"+String.format("%04x",code)+"> <0058> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
                        font.getCOSObject().setItem(COSName.TO_UNICODE,new PDStream(doc,new ByteArrayInputStream(cmap.getBytes(java.nio.charset.StandardCharsets.US_ASCII)))); break;
                    }
                    case "wrong-gid": {
                        PDType0Font f=(PDType0Font)font;int a=f.readCode(new ByteArrayInputStream(f.encode("A"))),b=f.codeToGID(f.readCode(new ByteArrayInputStream(f.encode("B"))));
                        byte[] map=new byte[65536*2];for(int i=0;i<65536;i++){map[i*2]=(byte)(i>>8);map[i*2+1]=(byte)i;}map[a*2]=(byte)(b>>8);map[a*2+1]=(byte)b;
                        f.getDescendantFont().getCOSObject().setItem(COSName.CID_TO_GID_MAP,new PDStream(doc,new ByteArrayInputStream(map)));break;
                    }
                }
                doc.save(dir.resolve(mode+".pdf").toFile());
            }
        }
    }
}
