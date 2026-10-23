import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.awt.image.BufferedImage;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.rendering.PDFRenderer;

public class CidMapFixture {
    static COSName n(String s){return COSName.getPDFName(s);}
    static PDStream stream(PDDocument d, byte[] data)throws Exception{return new PDStream(d,new ByteArrayInputStream(data));}
    static PDStream stream(PDDocument d, String text)throws Exception{return stream(d,text.getBytes(java.nio.charset.StandardCharsets.US_ASCII));}
    static COSArray array(COSBase value){COSArray a=new COSArray();a.add(value);return a;}
    static void create(Path dir,String fontPath)throws Exception {
        Files.createDirectories(dir);
        for(String mode:List.of("horizontal","vertical","custom-cmap","shared","inherited-form","inherited-no-type","pattern","inactive-appearance","unused","unembedded","out-of-range","notdef","bad-program","bad-loca","bad-units","existing","null-map","inactive-out-of-range","pattern-out-of-range","inherited-out-of-range","missing-font","recursive","type3")) {
            try(PDDocument d=new PDDocument()) {
                PDPage page=new PDPage();d.addPage(page);PDResources resources=new PDResources();page.setResources(resources);
                PDType0Font font=mode.equals("vertical")?PDType0Font.loadVertical(d,new FileInputStream(fontPath),false):PDType0Font.load(d,new FileInputStream(fontPath),false);
                resources.put(n("F1"),font);
                COSDictionary cid=font.getDescendantFont().getCOSObject(),fd=cid.getCOSDictionary(COSName.FONT_DESC);
                String encoded=HexFormat.of().formatHex(font.encode("MAPPING Café 123")),letter=HexFormat.of().formatHex(font.encode("A"));
                String content="BT /F1 14 Tf 50 720 Td <"+encoded+"> Tj ET";
                cid.removeItem(COSName.CID_TO_GID_MAP);
                if(mode.equals("existing"))cid.setItem(COSName.CID_TO_GID_MAP,COSName.IDENTITY);
                if(mode.equals("null-map"))cid.setItem(COSName.CID_TO_GID_MAP,COSNull.NULL);
                if(mode.equals("unused"))content="q Q";
                if(mode.equals("unembedded"))fd.removeItem(COSName.FONT_FILE2);
                if(mode.equals("bad-program"))fd.setItem(COSName.FONT_FILE2,stream(d,"invalid").getCOSObject());
                if(mode.equals("bad-loca")||mode.equals("bad-units")) {
                    byte[] bytes=fd.getCOSStream(COSName.FONT_FILE2).createInputStream().readAllBytes();
                    var b=java.nio.ByteBuffer.wrap(bytes);int count=b.getShort(4)&65535;
                    for(int i=0;i<count;i++){int start=12+i*16;String name=new String(bytes,start,4,java.nio.charset.StandardCharsets.US_ASCII);int offset=b.getInt(start+8);
                        if(mode.equals("bad-loca")&&name.equals("loca"))Arrays.fill(bytes,offset,offset+4,(byte)255);
                        if(mode.equals("bad-units")&&name.equals("head"))b.putShort(offset+18,(short)0);
                    }
                    fd.setItem(COSName.FONT_FILE2,stream(d,bytes).getCOSObject());
                }
                if(mode.equals("out-of-range"))content="BT /F1 14 Tf 50 720 Td <ffff> Tj ET";
                if(mode.equals("notdef"))content="BT /F1 14 Tf 50 720 Td <0000> Tj ET";
                if(mode.equals("missing-font"))content+=" BT /Absent 12 Tf (Unknown) Tj ET";
                if(mode.equals("custom-cmap")) {
                    int gid=Integer.parseInt(letter,16);
                    String base="/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def ";
                    font.getCOSObject().setItem(COSName.ENCODING,stream(d,base+"/CMapName /CustomMap def /CMapType 1 def 1 begincodespacerange <00> <ff> endcodespacerange 1 begincidchar <41> "+gid+" endcidchar endcmap CMapName currentdict /CMap defineresource pop end end").getCOSObject());
                    font.getCOSObject().setItem(COSName.TO_UNICODE,stream(d,base+"/CMapName /CustomUnicode def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 1 beginbfchar <41> <0041> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end").getCOSObject());
                    content="BT /F1 14 Tf 50 720 Td <41> Tj ET";
                }
                if(mode.equals("shared")) {
                    COSDictionary parent=new COSDictionary(font.getCOSObject());resources.getCOSObject().getCOSDictionary(COSName.FONT).setItem(n("Alias"),parent);
                    content+=" BT /Alias 12 Tf 50 690 Td <"+letter+"> Tj ET";
                }
                if(mode.contains("form")||mode.startsWith("inherited")||mode.equals("recursive")) {
                    COSStream form=stream(d,mode.equals("recursive")?"/Fm Do":"BT /F1 12 Tf 50 680 Td <"+(mode.contains("out-of-range")?"ffff":letter)+"> Tj ET").getCOSObject();
                    form.setName(COSName.TYPE,"XObject");form.setName(COSName.SUBTYPE,"Form");form.setItem(COSName.BBOX,new PDRectangle(612,792).getCOSArray());
                    if(mode.equals("inherited-no-type"))form.removeItem(COSName.TYPE);
                    COSDictionary objects=new COSDictionary();objects.setItem(n("Fm"),form);resources.getCOSObject().setItem(COSName.XOBJECT,objects);content+=" /Fm Do";
                }
                if(mode.startsWith("pattern")) {
                    COSStream pattern=stream(d,"BT /F1 10 Tf <"+(mode.contains("out-of-range")?"ffff":letter)+"> Tj ET").getCOSObject();
                    pattern.setName(COSName.TYPE,"Pattern");pattern.setInt(COSName.PATTERN_TYPE,1);pattern.setInt(COSName.PAINT_TYPE,1);pattern.setInt(COSName.TILING_TYPE,1);pattern.setInt(COSName.X_STEP,20);pattern.setInt(COSName.Y_STEP,20);pattern.setItem(COSName.BBOX,new PDRectangle(20,20).getCOSArray());
                    PDResources pr=new PDResources();pr.put(n("F1"),font);pattern.setItem(COSName.RESOURCES,pr);
                    COSDictionary patterns=new COSDictionary();patterns.setItem(n("P1"),pattern);resources.getCOSObject().setItem(COSName.PATTERN,patterns);content+=" q /Pattern cs /P1 scn 50 640 50 25 re f Q";
                }
                if(mode.equals("type3")) {COSDictionary unsupported=new COSDictionary();unsupported.setName(COSName.TYPE,"Font");unsupported.setName(COSName.SUBTYPE,"Type3");resources.getCOSObject().getCOSDictionary(COSName.FONT).setItem(n("Unsupported"),unsupported);}
                if(mode.startsWith("inactive")) {
                    var annotation=new org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationSquare();annotation.setRectangle(new PDRectangle(20,20,30,30));
                    COSStream hidden=stream(d,"BT /F1 12 Tf <"+(mode.contains("out-of-range")?"ffff":letter)+"> Tj ET").getCOSObject();hidden.setName(COSName.SUBTYPE,"Form");hidden.setItem(COSName.BBOX,new PDRectangle(30,30).getCOSArray());
                    PDResources ar=new PDResources();ar.put(n("F1"),font);hidden.setItem(COSName.RESOURCES,ar);
                    COSDictionary states=new COSDictionary(),ap=new COSDictionary();states.setItem(n("Hidden"),hidden);states.setItem(n("Off"),stream(d,"q Q").getCOSObject());ap.setItem(COSName.N,states);annotation.getCOSObject().setItem(COSName.AP,ap);annotation.getCOSObject().setName(COSName.AS,"Off");page.getAnnotations().add(annotation);
                }
                if(mode.equals("horizontal")) {
                    PDAcroForm form=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(form);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
                    PDTextField field=new PDTextField(form);field.setPartialName("entry");field.setAlternateFieldName("Editable mapping sample");form.getFields().add(field);
                    var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(50,600,250,24));widget.setPage(page);page.getAnnotations().add(widget);field.setValue("Original value");
                }
                page.setContents(stream(d,content));d.save(dir.resolve(mode+".pdf").toFile());
            }
        }
    }
    static void pixels(PDDocument a,PDDocument b)throws Exception {
        var ra=new PDFRenderer(a);var rb=new PDFRenderer(b);
        for(int i=0;i<a.getNumberOfPages();i++){BufferedImage x=ra.renderImageWithDPI(i,120),y=rb.renderImageWithDPI(i,120);
            if(x.getWidth()!=y.getWidth()||x.getHeight()!=y.getHeight()||!Arrays.equals(x.getRGB(0,0,x.getWidth(),x.getHeight(),null,0,x.getWidth()),y.getRGB(0,0,y.getWidth(),y.getHeight(),null,0,y.getWidth())))throw new IOException("Pixel change");}
    }
    public static void main(String[] args)throws Exception {
        if(args[0].equals("create")){create(Path.of(args[1]),args[2]);return;}
        try(PDDocument a=Loader.loadPDF(new File(args[1]));PDDocument b=Loader.loadPDF(new File(args[2]))) {
            if(args[0].equals("verify")) {
                pixels(a,b);
                if(a.getDocumentCatalog().getAcroForm(null)!=null) {
                    var old=a.getDocumentCatalog().getAcroForm(null).getField("entry");var changed=b.getDocumentCatalog().getAcroForm(null).getField("entry");
                    if(!old.getValueAsString().equals(changed.getValueAsString()))throw new IOException("Field value changed");
                    if(!Arrays.equals(old.getWidgets().get(0).getNormalAppearanceStream().getContents().readAllBytes(),changed.getWidgets().get(0).getNormalAppearanceStream().getContents().readAllBytes()))throw new IOException("Field appearance changed");
                    old.setValue("Jos\u00e9 caf\u00e9 987");changed.setValue("Jos\u00e9 caf\u00e9 987");a.save(args[2]+".source-filled.pdf");b.save(args[2]+".filled.pdf");
                    try(var aa=Loader.loadPDF(new File(args[2]+".source-filled.pdf"));var bb=Loader.loadPDF(new File(args[2]+".filled.pdf"))) {
                        if(!"Jos\u00e9 caf\u00e9 987".equals(bb.getDocumentCatalog().getAcroForm(null).getField("entry").getValueAsString()))throw new IOException("Saved value lost");pixels(aa,bb);
                    }
                }
                System.out.println("Pixels and field fill/save/reopen preserved");
            } else if(args[0].equals("mutate")) {
                COSDictionary font=(COSDictionary)b.getPage(0).getResources().getFont(n("F1")).getCOSObject().getCOSArray(COSName.DESCENDANT_FONTS).getObject(0);
                font.setItem(COSName.CID_TO_GID_MAP,stream(b,new byte[131072]));
                try(var out=Files.newOutputStream(Path.of(args[3]))){b.saveIncremental(out);}
            }
        }
    }
}
