import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;

/** Entirely generated test font: four geometric diamonds and a triangle.
 * No proprietary font program or external system font is loaded. */
class SymbolUnicodeFixture {
 static COSName n(String v){return COSName.getPDFName(v);}
 static COSArray array(COSBase...v){COSArray a=new COSArray();for(var x:v)a.add(x);return a;}
 static COSStream stream(PDDocument d,byte[] b)throws Exception{return new PDStream(d,new ByteArrayInputStream(b)).getCOSObject();}
 static COSStream stream(PDDocument d,String s)throws Exception{return stream(d,s.getBytes(StandardCharsets.US_ASCII));}
 static byte[] outline(boolean diamond,boolean changed)throws Exception {
  int[][] p=diamond?new int[][]{{473,440},{173,740},{473,1040},{774,740},{613,1180},{913,1480},{1214,1180},{913,879},{1353,1040},{1653,740},{1353,440},{1053,740},{1213,300},{913,0},{613,300},{913,600}}:new int[][]{{0,0},{500,1000},{1000,0}};
  if(changed)p[0][0]++;
  var b=new ByteArrayOutputStream();var s=new DataOutputStream(b);s.writeShort(diamond?4:1);s.writeShort(0);s.writeShort(0);s.writeShort(1653);s.writeShort(1480);
  if(diamond)for(int end:new int[]{3,7,11,15})s.writeShort(end);else s.writeShort(2);
  s.writeShort(0);for(var point:p)s.writeByte(1);
  for(int axis=0;axis<2;axis++){int old=0;for(var point:p){s.writeShort(point[axis]-old);old=point[axis];}}
  if((b.size()&1)!=0)s.writeByte(0);return b.toByteArray();
 }
 static byte[] font(String mode)throws Exception {
  var tables=new TreeMap<String,byte[]>();
  var head=ByteBuffer.allocate(54);head.putInt(0,0x10000);head.putInt(12,0x5f0f3cf5);head.putShort(18,(short)(mode.equals("wrong-units")?1000:2048));head.putShort(40,(short)1653);head.putShort(42,(short)1480);head.putShort(46,(short)8);head.putShort(48,(short)2);head.putShort(50,(short)1);tables.put("head",head.array());
  var hhea=ByteBuffer.allocate(36);hhea.putInt(0,0x10000);hhea.putShort(4,(short)1500);hhea.putShort(6,(short)-300);hhea.putShort(10,(short)1825);hhea.putShort(18,(short)1);hhea.putShort(34,(short)3);tables.put("hhea",hhea.array());
  var maxp=ByteBuffer.allocate(32);maxp.putInt(0,0x10000);maxp.putShort(4,(short)3);maxp.putShort(6,(short)16);maxp.putShort(8,(short)4);maxp.putShort(14,(short)2);tables.put("maxp",maxp.array());
  var hmtx=ByteBuffer.allocate(12);for(int i=0;i<3;i++)hmtx.putShort((short)(mode.equals("wrong-advance")?1800:1825)).putShort((short)0);tables.put("hmtx",hmtx.array());
  byte[] diamond=outline(true,mode.equals("changed-shape")),triangle=outline(false,false);var glyf=new ByteArrayOutputStream();glyf.write(diamond);glyf.write(triangle);tables.put("glyf",glyf.toByteArray());
  tables.put("loca",ByteBuffer.allocate(16).putInt(0).putInt(0).putInt(diamond.length).putInt(diamond.length+triangle.length).array());
  tables.put("post",ByteBuffer.allocate(32).putInt(0x30000).array());
  byte[] name="GeneratedGeometricSymbol".getBytes(StandardCharsets.UTF_16BE);var names=ByteBuffer.allocate(18+name.length);names.putShort((short)0).putShort((short)1).putShort((short)18).putShort((short)3).putShort((short)1).putShort((short)0x409).putShort((short)6).putShort((short)name.length).putShort((short)0).put(name);tables.put("name",names.array());
  if(List.of("unicode-bmp","unicode-supplementary","ambiguous","conflict","private","symbol-cmap","control").contains(mode)) {
   int cp=switch(mode){case "unicode-bmp"->0x25b3;case "unicode-supplementary"->0x1f680;case "private","symbol-cmap"->0xf076;case "control"->0x99;default->0x41;};
   int gid=mode.equals("conflict")?1:2,groups=mode.equals("ambiguous")?2:1;
   var cmap=ByteBuffer.allocate(28+12*groups);cmap.putShort((short)0).putShort((short)1).putShort((short)3).putShort((short)(mode.equals("symbol-cmap")?0:10)).putInt(12).putShort((short)12).putShort((short)0).putInt(16+12*groups).putInt(0).putInt(groups).putInt(cp).putInt(cp).putInt(gid);
   if(groups==2)cmap.putInt(cp+1).putInt(cp+1).putInt(gid);tables.put("cmap",cmap.array());
  }
  int count=tables.size(),offset=12+16*count;var rows=new ByteArrayOutputStream();var body=new ByteArrayOutputStream();var row=new DataOutputStream(rows);
  for(var t:tables.entrySet()){byte[] b=t.getValue(),padded=Arrays.copyOf(b,(b.length+3)&~3);long checksum=0;var words=ByteBuffer.wrap(padded);while(words.remaining()>0)checksum+=(words.getInt()&0xffffffffL);row.writeBytes(t.getKey());row.writeInt((int)checksum);row.writeInt(offset);row.writeInt(b.length);body.write(padded);offset+=padded.length;}
  var out=new ByteArrayOutputStream();var s=new DataOutputStream(out);s.writeInt(0x10000);s.writeShort(count);int power=Integer.highestOneBit(count);s.writeShort(power*16);s.writeShort(Integer.numberOfTrailingZeros(power));s.writeShort(count*16-power*16);out.write(rows.toByteArray());out.write(body.toByteArray());
  byte[] result=out.toByteArray();long checksum=0;var words=ByteBuffer.wrap(result);while(words.remaining()>0)checksum+=(words.getInt()&0xffffffffL);int pos=12;for(String tag:tables.keySet()){if(tag.equals("head"))ByteBuffer.wrap(result).putInt(ByteBuffer.wrap(result).getInt(pos+8)+8,(int)(0xb1b0afbaL-checksum));pos+=16;}return result;
 }
 static void create(Path dir,String formFont)throws Exception {
  Files.createDirectories(dir);
  for(String mode:List.of("fingerprint","vertical","renamed","unicode-bmp","unicode-supplementary","changed-shape","wrong-units","wrong-advance","ambiguous","conflict","private","symbol-cmap","control","unknown","mixed-unknown","unused","notdef","out-of-range","editable","actualtext","inline-actualtext","existing","empty-map","null-map","unembedded","custom-encoding","missing-font"))try(var d=new PDDocument()) {
   PDPage p=new PDPage();d.addPage(p);PDResources r=new PDResources();p.setResources(r);
   var fd=new COSDictionary();fd.setName(COSName.TYPE,"FontDescriptor");fd.setName(COSName.FONT_NAME,"GeneratedGeometricSymbol");fd.setInt(COSName.FLAGS,4);fd.setItem(COSName.FONT_BBOX,new PDRectangle(1800,1500).getCOSArray());fd.setInt(COSName.ASCENT,1500);fd.setInt(COSName.DESCENT,-300);fd.setInt(COSName.CAP_HEIGHT,1500);fd.setInt(COSName.STEM_V,80);fd.setInt(COSName.ITALIC_ANGLE,0);
   if(!mode.equals("unembedded"))fd.setItem(COSName.FONT_FILE2,stream(d,font(mode)));
   var info=new COSDictionary();info.setString(COSName.REGISTRY,"Adobe");info.setString(COSName.ORDERING,"Identity");info.setInt(COSName.SUPPLEMENT,0);
   var cid=new COSDictionary();cid.setName(COSName.TYPE,"Font");cid.setName(COSName.SUBTYPE,"CIDFontType2");cid.setName(COSName.BASE_FONT,"GeneratedGeometricSymbol");cid.setItem(COSName.FONT_DESC,fd);cid.setItem(COSName.CIDSYSTEMINFO,info);cid.setItem(COSName.CID_TO_GID_MAP,COSName.IDENTITY);cid.setInt(COSName.DW,891);
   var parent=new COSDictionary();parent.setName(COSName.TYPE,"Font");parent.setName(COSName.SUBTYPE,"Type0");parent.setName(COSName.BASE_FONT,mode.equals("renamed")?"InventedName": "GeneratedGeometricSymbol");parent.setName(COSName.ENCODING,mode.equals("vertical")?"Identity-V":mode.equals("custom-encoding")?"UniJIS-UTF16-H":"Identity-H");parent.setItem(COSName.DESCENDANT_FONTS,array(cid));
   String map="/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Existing def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ";
   if(mode.equals("existing")||mode.equals("empty-map"))parent.setItem(COSName.TO_UNICODE,stream(d,map+(mode.equals("existing")?"1 beginbfchar <0001> <0041> endbfchar ":"")+"endcmap CMapName currentdict /CMap defineresource pop end end"));
   if(mode.equals("null-map"))parent.setItem(COSName.TO_UNICODE,COSNull.NULL);
   r.getCOSObject().setItem(COSName.FONT,new COSDictionary());r.getCOSObject().getCOSDictionary(COSName.FONT).setItem(n("F1"),parent);
   int code=List.of("unicode-bmp","unicode-supplementary","ambiguous","private","symbol-cmap","control","unknown").contains(mode)?2:mode.equals("notdef")?0:mode.equals("out-of-range")?65535:1;
   String content="BT /F1 18 Tf 50 720 Td <"+String.format("%04X",code)+(mode.equals("mixed-unknown")?"0002":"")+"> Tj ET";
   if(mode.equals("unused"))content="q Q";
   if(mode.equals("inline-actualtext"))content="/Span << /ActualText (authored) >> BDC "+content+" EMC";
   if(mode.equals("missing-font"))content+=" BT /Missing 12 Tf (x) Tj ET";
   if(mode.equals("actualtext")){var st=new COSDictionary();st.setName(COSName.TYPE,"StructTreeRoot");st.setString(COSName.ACTUAL_TEXT,"authored");d.getDocumentCatalog().getCOSObject().setItem(COSName.STRUCT_TREE_ROOT,st);}
   if(mode.equals("editable")){PDAcroForm f=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(f);f.setDefaultResources(r);f.setDefaultAppearance("/F1 12 Tf 0 g");}
   if(mode.equals("fingerprint")){
    PDAcroForm f=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(f);PDResources dr=new PDResources();dr.put(n("Edit"),PDType0Font.load(d,new FileInputStream(formFont),false));f.setDefaultResources(dr);f.setDefaultAppearance("/Edit 12 Tf 0 g");PDTextField field=new PDTextField(f);field.setPartialName("entry");f.getFields().add(field);var widget=field.getWidgets().get(0);widget.setRectangle(new PDRectangle(50,600,250,24));widget.setPage(p);p.getAnnotations().add(widget);field.setValue("Original value");
   }
   p.setContents(new PDStream(stream(d,content)));d.save(dir.resolve(mode+".pdf").toFile());
  }
 }
 public static void main(String[] a)throws Exception {
  if(a[0].equals("create")){create(Path.of(a[1]),a[2]);return;}
  try(var d=Loader.loadPDF(new File(a[1]))){var f=d.getPage(0).getResources().getFont(n("F1"));if(a[0].equals("read")){System.out.println(Integer.toHexString(f.toUnicode(Integer.parseInt(a[2])).codePointAt(0)));return;}
   COSStream map=f.getCOSObject().getCOSStream(COSName.TO_UNICODE);byte[] b=map.createInputStream().readAllBytes();try(var out=map.createOutputStream()){out.write(new String(b,StandardCharsets.US_ASCII).replace("2756","0041").getBytes(StandardCharsets.US_ASCII));}d.save(a[2]);
  }
 }
}
