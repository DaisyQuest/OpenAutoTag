import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.font.encoding.WinAnsiEncoding;
import org.apache.pdfbox.pdmodel.interactive.form.*;

class InvalidUnicodeFixture {
 static COSName n(String s){return COSName.getPDFName(s);}
 static String hex(byte[] b){return HexFormat.of().formatHex(b);}
 static COSStream stream(PDDocument d,String s)throws Exception{return new PDStream(d,new ByteArrayInputStream(s.getBytes(StandardCharsets.US_ASCII))).getCOSObject();}
 static String map(String body,boolean simple){return "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /TestUnicode def\n/CMapType 2 def\n1 begincodespacerange\n"+(simple?"<00> <ff>":"<0000> <ffff>")+"\nendcodespacerange\n"+body+"\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";}
 static void create(Path dir,String fontPath)throws Exception {
  Files.createDirectories(dir);
  for(String mode:List.of("partial","surrogate","odd","empty-value","null","empty-stream","absent","simple","vertical","array","form","pattern","appearance","shared","late-invalid","conflict","sequence","duplicate","count","truncated","usecmap","inherited","invalid-unused","actualtext","editable","missing-font","unembedded","valid-range","valid-array","valid-sequence","override-valid","override-invalid"))try(PDDocument d=new PDDocument()){
   PDPage p=new PDPage();d.addPage(p);PDResources resources=new PDResources();p.setResources(resources);boolean simple=mode.equals("simple");
   PDFont f=simple?PDTrueTypeFont.load(d,new File(fontPath),WinAnsiEncoding.INSTANCE):PDType0Font.load(d,new FileInputStream(fontPath),false);resources.put(n("F1"),f);
   byte[] a=f.encode("A"),b=f.encode("B"),c=f.encode("C"),z=f.encode("Z");
   String body="1 beginbfchar\n<"+hex(a)+"> <0041>\nendbfchar\n1 beginbfchar\n<"+hex(c)+"> <0043>\nendbfchar\n1 beginbfchar\n<"+hex(z)+"> <006600660069>\nendbfchar\n";
   String bValue=switch(mode){case "surrogate"->"d800";case "odd"->"41";case "empty-value"->"";case "conflict"->"0058";default->null;};
   if(bValue!=null)body+="1 beginbfchar\n<"+hex(b)+"> <"+bValue+">\nendbfchar\n";
   if(mode.equals("sequence"))body="1 beginbfchar\n<"+hex(a)+"> <00660069>\nendbfchar\n";
   if(mode.equals("duplicate"))body+="2 beginbfchar\n<"+hex(b)+"> <0042>\n<"+hex(b)+"> <0058>\nendbfchar\n";
   if(mode.startsWith("override-")||mode.equals("late-invalid")){String first=mode.equals("override-invalid")?"d800":"0058",last=mode.equals("late-invalid")?"d800":"0042";body+="2 beginbfchar\n<"+hex(b)+"> <"+first+">\n<"+hex(b)+"> <"+last+">\nendbfchar\n";}
   if(mode.equals("array"))body="1 beginbfrange\n<"+hex(a)+"> <"+hex(c)+"> [<0041> <d800> <0043>]\nendbfrange\n";
   if(mode.equals("valid-array"))body="1 beginbfrange\n<"+hex(a)+"> <"+hex(c)+"> [<0041> <0042> <0043>]\nendbfrange\n";
   if(mode.equals("valid-range"))body="1 beginbfrange\n<"+hex(a)+"> <"+hex(c)+"> <0041>\nendbfrange\n";
   if(mode.equals("count"))body=body.replaceFirst("1 beginbfchar","2 beginbfchar");
   if(mode.equals("invalid-unused"))body=body.replace("006600660069","d800");
   String text="BT /F1 18 Tf 50 720 Td <"+hex(f.encode("ABC"))+"> Tj ET";
   if(mode.equals("valid-sequence")){body="1 beginbfchar\n<"+hex(a)+"> <0041>\nendbfchar\n1 beginbfchar\n<"+hex(z)+"> <006600660069>\nendbfchar\n";text="BT /F1 18 Tf 50 720 Td <"+hex(a)+"> Tj ET";}
   String cmap=map(body,simple);if(mode.equals("truncated"))cmap=cmap.replace("endcmap","");if(mode.equals("usecmap"))cmap=cmap.replace("begincmap","begincmap\n/Identity-H usecmap");
   COSStream map=stream(d,mode.equals("empty-stream")?"":cmap);if(mode.equals("inherited"))map.setItem(n("UseCMap"),n("Identity-H"));f.getCOSObject().setItem(COSName.TO_UNICODE,map);
   if(mode.equals("null"))f.getCOSObject().setItem(COSName.TO_UNICODE,COSNull.NULL);if(mode.equals("absent"))f.getCOSObject().removeItem(COSName.TO_UNICODE);
   if(mode.equals("unembedded"))f.getFontDescriptor().getCOSObject().removeItem(COSName.FONT_FILE2);
   if(mode.equals("vertical"))f.getCOSObject().setItem(COSName.ENCODING,COSName.IDENTITY_V);
   if(mode.equals("actualtext"))text="/Span << /ActualText (Authored replacement) >> BDC "+text+" EMC";
   if(mode.equals("missing-font"))text+=" BT /Absent 12 Tf (Missing) Tj ET";
   if(mode.equals("editable")){PDAcroForm form=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(form);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");}
   if(mode.equals("shared")){COSDictionary second=new COSDictionary(f.getCOSObject());resources.getCOSObject().getCOSDictionary(COSName.FONT).setItem(n("F2"),second);text+=" BT /F2 18 Tf 50 680 Td <"+hex(a)+"> Tj ET";}
   if(mode.equals("form")||mode.equals("pattern")||mode.equals("appearance")){
    COSStream child=stream(d,text.replace("50 720 Td","5 5 Td"));child.setItem(COSName.BBOX,new PDRectangle(250,30).getCOSArray());PDResources cr=new PDResources();cr.put(n("F1"),f);child.setItem(COSName.RESOURCES,cr);
    if(mode.equals("form")){child.setName(COSName.SUBTYPE,"Form");COSDictionary x=new COSDictionary();x.setItem(n("Fm"),child);resources.getCOSObject().setItem(COSName.XOBJECT,x);text="q 1 0 0 1 50 600 cm /Fm Do Q";}
    if(mode.equals("pattern")){child.setInt(COSName.PATTERN_TYPE,1);child.setInt(COSName.PAINT_TYPE,1);child.setInt(COSName.TILING_TYPE,1);child.setInt(COSName.X_STEP,250);child.setInt(COSName.Y_STEP,30);COSDictionary patterns=new COSDictionary();patterns.setItem(n("P1"),child);resources.getCOSObject().setItem(COSName.PATTERN,patterns);text="/Pattern cs /P1 scn 50 600 250 30 re f";}
    if(mode.equals("appearance")){child.setName(COSName.SUBTYPE,"Form");var an=new org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationSquare();an.setRectangle(new PDRectangle(50,600,250,30));COSDictionary ap=new COSDictionary();ap.setItem(COSName.N,child);an.getCOSObject().setItem(COSName.AP,ap);p.getAnnotations().add(an);text="q Q";}
   }
   if(mode.equals("partial")){PDAcroForm form=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(form);PDResources dr=new PDResources();dr.put(n("Edit"),PDType0Font.load(d,new FileInputStream(fontPath),false));form.setDefaultResources(dr);form.setDefaultAppearance("/Edit 12 Tf 0 g");PDTextField field=new PDTextField(form);field.setPartialName("entry");form.getFields().add(field);var w=field.getWidgets().get(0);w.setRectangle(new PDRectangle(50,500,250,24));w.setPage(p);p.getAnnotations().add(w);field.setValue("Original value");}
   p.setContents(new PDStream(stream(d,text)));d.save(dir.resolve(mode+".pdf").toFile());
  }
 }
 public static void main(String[] args)throws Exception {
  if(args[0].equals("create")){create(Path.of(args[1]),args[2]);return;}
  try(PDDocument d=Loader.loadPDF(new File(args[1]))){PDFont f=d.getPage(0).getResources().getFont(n("F1"));if(args[0].startsWith("read")){StringBuilder s=new StringBuilder();for(int i=2;i<args.length;i++)s.append(f.toUnicode(Integer.parseInt(args[i])));System.out.println(args[0].equals("read-hex")?s.toString().codePoints().mapToObj(Integer::toHexString).collect(java.util.stream.Collectors.joining(",")):s);}
   else {COSStream map=f.getCOSObject().getCOSStream(COSName.TO_UNICODE);String s=new String(map.createInputStream().readAllBytes(),StandardCharsets.US_ASCII).replace("0042","0058");try(var out=map.createOutputStream()){out.write(s.getBytes(StandardCharsets.US_ASCII));}d.save(args[2]);}}
 }
}
