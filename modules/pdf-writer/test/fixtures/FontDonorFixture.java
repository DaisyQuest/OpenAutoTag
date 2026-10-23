import java.io.*;import java.nio.*;import java.nio.file.*;import java.util.*;
import org.apache.pdfbox.Loader;import org.apache.pdfbox.cos.*;import org.apache.pdfbox.pdmodel.*;import org.apache.pdfbox.pdmodel.common.*;import org.apache.pdfbox.pdmodel.font.*;import org.apache.pdfbox.pdmodel.font.encoding.WinAnsiEncoding;import org.apache.pdfbox.pdmodel.interactive.form.*;

/** Uses the available exact Arial program, or PDFBox's bundled Liberation fallback.
 * Generated PDFs and donor binaries stay in the test output, never in the repository. */
class FontDonorFixture {
 static COSName n(String s){return COSName.getPDFName(s);}
 static COSStream stream(PDDocument d,String s)throws Exception{return new PDStream(d,new ByteArrayInputStream(s.getBytes(java.nio.charset.StandardCharsets.US_ASCII))).getCOSObject();}
 static void changeTable(byte[] bytes,String tag,int relative,int value){var b=ByteBuffer.wrap(bytes);for(int i=0;i<(b.getShort(4)&65535);i++){int p=12+i*16;if(new String(bytes,p,4,java.nio.charset.StandardCharsets.US_ASCII).equals(tag)){b.putShort(b.getInt(p+8)+relative,(short)value);return;}}throw new IllegalArgumentException(tag);}
 static void create(Path dir,String editableFont)throws Exception {
  Files.createDirectories(dir);COSDictionary probe=new COSDictionary();probe.setName(COSName.TYPE,"Font");probe.setName(COSName.SUBTYPE,"TrueType");probe.setName(COSName.BASE_FONT,"ArialMT");probe.setItem(COSName.ENCODING,COSName.WIN_ANSI_ENCODING);
  byte[] bytes;try(var in=new PDTrueTypeFont(probe).getTrueTypeFont().getOriginalData()){bytes=in.readAllBytes();}
  Path donor=dir.resolve("donor.ttf");Files.write(donor,bytes);
  byte[] changed=bytes.clone();changeTable(changed,"hmtx",0,333);Files.write(dir.resolve("changed-program.ttf"),changed);
  byte[] restricted=bytes.clone();changeTable(restricted,"OS/2",8,2);Files.write(dir.resolve("restricted.ttf"),restricted);
  byte[] preview=bytes.clone();changeTable(preview,"OS/2",8,4);Files.write(dir.resolve("preview-only.ttf"),preview);
  byte[] bitmap=bytes.clone();changeTable(bitmap,"OS/2",8,512);Files.write(dir.resolve("bitmap-only.ttf"),bitmap);
  Files.write(dir.resolve("broken.ttf"),new byte[32]);
  for(String mode:List.of("exact","shared","form","pattern","appearance","clipping","width-mismatch","fractional-width","unused","notdef","editable","missing-font","wrong-name","existing","null-program"))try(var d=new PDDocument()){
   PDPage p=new PDPage();d.addPage(p);PDResources r=new PDResources();p.setResources(r);
   PDTrueTypeFont f=PDTrueTypeFont.load(d,donor.toFile(),WinAnsiEncoding.INSTANCE);r.put(n("F1"),f);COSDictionary fd=f.getFontDescriptor().getCOSObject();
   COSArray widths=new COSArray();for(int code=0;code<256;code++){float width=f.getWidthFromFont(code);if(code==65&&mode.equals("width-mismatch"))width+=5;if(code==65&&mode.equals("fractional-width"))width+=0.125f;widths.add(new COSFloat(width));}
   f.getCOSObject().setInt(COSName.FIRST_CHAR,0);f.getCOSObject().setInt(COSName.LAST_CHAR,255);f.getCOSObject().setItem(COSName.WIDTHS,widths);
   if(!mode.equals("existing"))fd.removeItem(COSName.FONT_FILE2);
   if(mode.equals("null-program"))fd.setItem(COSName.FONT_FILE2,COSNull.NULL);
   if(mode.equals("wrong-name"))f.getCOSObject().setName(COSName.BASE_FONT,"UnrelatedFont");
   String content="BT /F1 18 Tf 50 720 Td <4d415050494e4720436166e920313233> Tj ET";
   if(mode.equals("unused"))content="q Q";
   if(mode.equals("notdef"))content="BT /F1 18 Tf 50 720 Td <00> Tj ET";
   if(mode.equals("missing-font"))content+=" BT /Absent 12 Tf (missing) Tj ET";
   if(mode.equals("shared")){var second=new COSDictionary(f.getCOSObject());r.getCOSObject().getCOSDictionary(COSName.FONT).setItem(n("F2"),second);content+=" BT /F2 18 Tf 50 680 Td (ALIAS) Tj ET";}
   if(mode.equals("form")){COSStream form=stream(d,content);form.setName(COSName.TYPE,"XObject");form.setName(COSName.SUBTYPE,"Form");form.setItem(COSName.BBOX,new PDRectangle(612,792).getCOSArray());PDResources fr=new PDResources();fr.put(n("F1"),f);form.setItem(COSName.RESOURCES,fr);var x=new COSDictionary();x.setItem(n("Fm"),form);r.getCOSObject().setItem(COSName.XOBJECT,x);content="/Fm Do";}
   if(mode.equals("pattern")){COSStream pattern=stream(d,"BT /F1 18 Tf 5 5 Td (A) Tj ET");pattern.setName(COSName.TYPE,"Pattern");pattern.setInt(COSName.PATTERN_TYPE,1);pattern.setInt(COSName.PAINT_TYPE,1);pattern.setInt(COSName.TILING_TYPE,1);pattern.setInt(COSName.X_STEP,40);pattern.setInt(COSName.Y_STEP,30);pattern.setItem(COSName.BBOX,new PDRectangle(40,30).getCOSArray());PDResources pr=new PDResources();pr.put(n("F1"),f);pattern.setItem(COSName.RESOURCES,pr);var patterns=new COSDictionary();patterns.setItem(n("P1"),pattern);r.getCOSObject().setItem(COSName.PATTERN,patterns);content="/Pattern cs /P1 scn 50 600 250 100 re f";}
   if(mode.equals("appearance")){var an=new org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationSquare();an.setRectangle(new PDRectangle(50,600,250,30));COSStream ap=stream(d,"BT /F1 18 Tf 5 5 Td (APPEARANCE) Tj ET");ap.setName(COSName.SUBTYPE,"Form");ap.setItem(COSName.BBOX,new PDRectangle(250,30).getCOSArray());PDResources ar=new PDResources();ar.put(n("F1"),f);ap.setItem(COSName.RESOURCES,ar);var aps=new COSDictionary();aps.setItem(COSName.N,ap);an.getCOSObject().setItem(COSName.AP,aps);p.getAnnotations().add(an);content="q Q";}
   if(mode.equals("clipping"))content="q BT /F1 40 Tf 7 Tr 50 600 Td (CLIP) Tj ET 0.1 0.5 0.8 rg 0 0 612 792 re f Q";
   if(mode.equals("editable")){var form=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(form);form.setDefaultResources(r);form.setDefaultAppearance("/F1 12 Tf 0 g");}
   if(mode.equals("exact")){PDAcroForm form=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(form);PDResources dr=new PDResources();dr.put(n("Edit"),PDType0Font.load(d,new FileInputStream(editableFont),false));form.setDefaultResources(dr);form.setDefaultAppearance("/Edit 12 Tf 0 g");PDTextField field=new PDTextField(form);field.setPartialName("entry");form.getFields().add(field);var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(50,500,250,24));widget.setPage(p);p.getAnnotations().add(widget);field.setValue("Original value");}
   p.setContents(new PDStream(stream(d,content)));d.save(dir.resolve(mode+".pdf").toFile());
  }
 }
 public static void main(String[]a)throws Exception {if(a[0].equals("create")){create(Path.of(a[1]),a[2]);return;}try(var d=Loader.loadPDF(new File(a[1]))){var f=d.getPage(0).getResources().getFont(n("F1"));if(a[0].equals("mutate")){COSStream s=f.getFontDescriptor().getFontFile2().getCOSObject();byte[] b=s.createInputStream().readAllBytes();changeTable(b,"hmtx",0,222);try(var out=s.createOutputStream()){out.write(b);}d.save(a[2]);}else System.out.println(f.getName()+" "+f.isEmbedded());}}
}
