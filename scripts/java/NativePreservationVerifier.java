import java.io.*;
import java.awt.image.BufferedImage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import org.apache.fontbox.cmap.CMap;
import org.apache.fontbox.cmap.CMapParser;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.io.RandomAccessReadBuffer;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.rendering.*;

/** Independent native-rebuild preservation evidence. This verifies current
 * VIEW/PRINT rendering and protected objects; it does not certify accessibility. */
final class NativePreservationVerifier {
    private static final int DPI=120,MAX_PAGES=500;
    private static final long MAX_PIXELS=16000000,MAX_TOTAL_PIXELS=200000000,MAX_STREAM=64L*1024*1024;
    private final Map<COSDictionary,String> fonts=new IdentityHashMap<>();
    private final Map<COSDictionary,Integer> pages=new IdentityHashMap<>();
    private int nodes;
    private static String hex(byte[] bytes){return HexFormat.of().formatHex(bytes);}
    private static String hash(byte[] bytes)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private static String fileHash(File file)throws Exception{var h=MessageDigest.getInstance("SHA-256");try(var in=Files.newInputStream(file.toPath())){byte[] b=new byte[65536];for(int n;(n=in.read(b))!=-1;)h.update(b,0,n);}return hex(h.digest());}
    private static COSBase resolve(COSBase v){return v instanceof COSObject o?o.getObject():v;}
    private static byte[] decoded(COSStream stream)throws IOException{try(var in=stream.createInputStream()){byte[] b=in.readNBytes((int)MAX_STREAM+1);if(b.length>MAX_STREAM)throw new IOException("Protected stream exceeds limit");return b;}}
    private static String ref(COSBase value)throws IOException{COSBase v=resolve(value);if(v instanceof COSDictionary d&&d.getKey()!=null)return d.getKey().getNumber()+":"+d.getKey().getGeneration();throw new IOException("Protected parent has no indirect identity");}

    private String canonical(COSBase value,Set<COSBase> stack,int depth,Set<COSDictionary> normalizedFonts,Set<COSDictionary> mappedCids)throws Exception{
        COSBase v=resolve(value);if(v==null||v==COSNull.NULL)return "null";
        if(++nodes>2000000||depth>128)throw new IOException("Protected object graph exceeds limit");
        if(v instanceof COSDictionary d&&pages.containsKey(d))return "page:"+pages.get(d);
        if(stack.contains(v))throw new IOException("Cyclic protected resource graph");
        if(v instanceof COSDictionary d){
            String subtype=d.getNameAsString(COSName.SUBTYPE,"");
            if(!normalizedFonts.contains(d)&&(subtype.equals("Type0")||subtype.equals("TrueType")))return font(d,stack,depth);
            Set<COSBase> next=Collections.newSetFromMap(new IdentityHashMap<>());next.addAll(stack);next.add(v);StringBuilder b=new StringBuilder("dict{");
            for(COSName k:d.keySet().stream().sorted(Comparator.comparing(COSName::getName)).toList()){
                String name=k.getName();if(v instanceof COSStream&&Set.of("Length","Filter","DecodeParms").contains(name))continue;
                if(subtype.equals("Widget")&&name.equals("StructParent"))continue;
                if(normalizedFonts.contains(d)&&name.equals("ToUnicode"))continue;
                if(mappedCids.contains(d)&&name.equals("CIDToGIDMap"))continue;
                b.append(name.length()).append(':').append(name).append('=');
                b.append(name.equals("Parent")?"ref:"+ref(d.getItem(k)):canonical(d.getItem(k),next,depth+1,normalizedFonts,mappedCids)).append(';');
            }
            if(v instanceof COSStream stream)b.append("bytes:").append(hash(decoded(stream)));return b.append('}').toString();
        }
        if(v instanceof COSArray array){Set<COSBase> next=Collections.newSetFromMap(new IdentityHashMap<>());next.addAll(stack);next.add(v);StringBuilder b=new StringBuilder("array[");for(COSBase child:array)b.append(canonical(child,next,depth+1,normalizedFonts,mappedCids)).append(';');return b.append(']').toString();}
        if(v instanceof COSString s)return "string:"+hex(s.getBytes());
        if(v instanceof COSName n)return "name:"+n.getName();
        if(v instanceof COSBoolean b)return "bool:"+b.getValue();
        if(v instanceof COSNumber n)return "number:"+n.toString();
        throw new IOException("Unsupported protected object");
    }
    private String font(COSDictionary d,Set<COSBase> stack,int depth)throws Exception{
        if(fonts.containsKey(d))return fonts.get(d);
        if(fonts.size()>=256)throw new IOException("Protected font limit exceeded");
        // Normalize only supported embedded TrueType maps. All program bytes,
        // widths, encoding, names and descriptor properties remain protected.
        boolean typed=COSName.FONT.equals(d.getDictionaryObject(COSName.TYPE));
        if("Type0".equals(d.getNameAsString(COSName.SUBTYPE))){COSArray children=d.getCOSArray(COSName.DESCENDANT_FONTS);typed&=children!=null&&children.size()==1&&children.getObject(0) instanceof COSDictionary child&&COSName.FONT.equals(child.getDictionaryObject(COSName.TYPE))&&"CIDFontType2".equals(child.getNameAsString(COSName.SUBTYPE));}
        PDFont f=typed?PDFontFactory.createFont(d):null;boolean supported=f!=null&&f.isEmbedded()&&(f instanceof PDTrueTypeFont||f instanceof PDType0Font t&&t.getDescendantFont() instanceof PDCIDFontType2&&Set.of("Identity-H","Identity-V").contains(d.getNameAsString(COSName.ENCODING,"")));
        Set<COSDictionary> normalized=Collections.newSetFromMap(new IdentityHashMap<>()),cids=Collections.newSetFromMap(new IdentityHashMap<>());normalized.add(d);
        if(!supported){String exact=canonical(d,stack,depth,normalized,Set.of());COSBase u=d.getDictionaryObject(COSName.TO_UNICODE);String value="exact-font:"+hash((exact+"|unicode:"+canonical(u,stack,depth+1,Set.of(),Set.of())).getBytes(StandardCharsets.UTF_8));fonts.put(d,value);return value;}
        if(f instanceof PDType0Font t)cids.add(t.getDescendantFont().getCOSObject());
        String protectedBytes=canonical(d,stack,depth,normalized,cids);COSBase raw=d.getDictionaryObject(COSName.TO_UNICODE);CMap unicode=null;
        if(raw!=null){if(!(raw instanceof COSStream s))throw new IOException("Invalid form font Unicode map");try(var in=new RandomAccessReadBuffer(decoded(s))){unicode=new CMapParser().parse(in);}}
        var map=MessageDigest.getInstance("SHA-256");var encoder=StandardCharsets.UTF_8.newEncoder();int end=f instanceof PDType0Font?65536:256;
        for(int code=0;code<end;code++){
            int gid=f instanceof PDType0Font t?t.codeToGID(code):((PDTrueTypeFont)f).codeToGID(code);String text=unicode==null?null:unicode.toUnicode(code);
            if(text==null||text.isEmpty()||text.equals("\u0000")||text.equals("\ufeff"))text="\ufffd";
            if(text.length()>4096||!encoder.canEncode(text))throw new IOException("Invalid or excessive font Unicode mapping");
            byte[] bytes=text.getBytes(StandardCharsets.UTF_8);map.update((gid+":"+bytes.length+":").getBytes(StandardCharsets.US_ASCII));map.update(bytes);
        }
        String result="mapped-font:"+hash(protectedBytes.getBytes(StandardCharsets.UTF_8))+":"+hex(map.digest());fonts.put(d,result);return result;
    }
    private String protectedHash(PDDocument doc,COSBase value)throws Exception{int i=0;for(PDPage p:doc.getPages())pages.put(p.getCOSObject(),++i);return hash(canonical(value,Collections.newSetFromMap(new IdentityHashMap<>()),0,Set.of(),Set.of()).getBytes(StandardCharsets.UTF_8));}
    private static String pixels(BufferedImage image)throws Exception{var digest=MessageDigest.getInstance("SHA-256");byte[] row=new byte[image.getWidth()*3];for(int y=0;y<image.getHeight();y++){for(int x=0;x<image.getWidth();x++){int rgb=image.getRGB(x,y),i=x*3;row[i]=(byte)(rgb>>16);row[i+1]=(byte)(rgb>>8);row[i+2]=(byte)rgb;}digest.update(row);}return image.getWidth()+"x"+image.getHeight()+":"+hex(digest.digest());}
    private static void check(List<Map<String,Object>> checks,String id,Object a,Object b){checks.add(Map.of("id",id,"status",Objects.equals(a,b)?"pass":"fail","source",a,"candidate",b));}
    @SuppressWarnings("unchecked")
    static Map<String,Object> inspect(PDDocument source,PDDocument candidate,File sourceFile,File candidateFile)throws Exception{
        String sourceHash=fileHash(sourceFile),candidateHash=fileHash(candidateFile);List<Map<String,Object>> checks=new ArrayList<>();List<String> unavailable=new ArrayList<>();
        Map<String,Object> a=PreservationInspector.inspect(source,sourceFile),b=PreservationInspector.inspect(candidate,candidateFile);
        List<Map<String,Object>> ap=(List<Map<String,Object>>)a.get("pages"),bp=(List<Map<String,Object>>)b.get("pages");check(checks,"page_count",ap.size(),bp.size());
        check(checks,"navigation",a.get("navigation"),b.get("navigation"));
        for(int i=0;i<Math.min(ap.size(),bp.size());i++){check(checks,"geometry:"+(i+1),ap.get(i).get("geometry"),bp.get(i).get("geometry"));check(checks,"annotations:"+(i+1),ap.get(i).get("annotationsHash"),bp.get(i).get("annotationsHash"));}
        Map<String,Map<String,Object>> aw=(Map<String,Map<String,Object>>)a.get("widgets"),bw=(Map<String,Map<String,Object>>)b.get("widgets");check(checks,"widget_inventory",new ArrayList<>(new TreeSet<>(aw.keySet())),new ArrayList<>(new TreeSet<>(bw.keySet())));
        for(String ref:aw.keySet())if(bw.containsKey(ref))for(String key:List.of("page","annotationIndex","fieldName","nativeDigest","fieldStateHash","appearanceHash"))check(checks,"widget:"+ref+":"+key,aw.get(ref).get(key),bw.get(ref).get(key));
        COSDictionary ac=source.getDocumentCatalog().getCOSObject(),bc=candidate.getDocumentCatalog().getCOSObject();
        try{
            var left=new NativePreservationVerifier();var right=new NativePreservationVerifier();
            check(checks,"acroform",left.protectedHash(source,ac.getItem(COSName.ACRO_FORM)),right.protectedHash(candidate,bc.getItem(COSName.ACRO_FORM)));
            for(String key:List.of("OpenAction","AA","Names","PageMode","Threads")){COSName n=COSName.getPDFName(key);check(checks,"catalog:"+key,left.protectedHash(source,ac.getItem(n)),right.protectedHash(candidate,bc.getItem(n)));}
        }catch(Exception e){unavailable.add("Protected resources: "+e.getMessage());}
        if(source.isEncrypted()||candidate.isEncrypted()||!source.getSignatureDictionaries().isEmpty()||!candidate.getSignatureDictionaries().isEmpty())unavailable.add("Encrypted or signed document");
        for(COSDictionary catalog:List.of(ac,bc)){if(catalog.containsKey(COSName.getPDFName("OCProperties")))unavailable.add("Optional-content states need separate preservation proof");COSDictionary form=catalog.getCOSDictionary(COSName.ACRO_FORM);if(form!=null&&form.containsKey(COSName.XFA))unavailable.add("XFA needs separate preservation proof");}
        long total=0;boolean bounded=ap.size()>0&&ap.size()<=MAX_PAGES&&ap.size()==bp.size();
        for(PDDocument doc:List.of(source,candidate))for(PDPage p:doc.getPages()){double size=Math.ceil(p.getCropBox().getWidth()*DPI/72d)*Math.ceil(p.getCropBox().getHeight()*DPI/72d);bounded&=Double.isFinite(size)&&size>0&&size<=MAX_PIXELS;total+=(long)size;}
        bounded&=total<=MAX_TOTAL_PIXELS;
        if(!bounded)unavailable.add("Rendering limits exceeded");
        else{PDFRenderer left=new PDFRenderer(source),right=new PDFRenderer(candidate);for(int i=0;i<ap.size();i++)for(RenderDestination destination:List.of(RenderDestination.VIEW,RenderDestination.PRINT)){
            try{BufferedImage x=left.renderImage(i,DPI/72f,ImageType.RGB,destination),y=right.renderImage(i,DPI/72f,ImageType.RGB,destination);check(checks,"pixels:"+(i+1)+":"+destination.name(),pixels(x),pixels(y));x.flush();y.flush();}catch(Exception e){unavailable.add("Rendering page "+(i+1)+": "+e.getMessage());}
        }}
        check(checks,"source_stable",sourceHash,fileHash(sourceFile));check(checks,"candidate_stable",candidateHash,fileHash(candidateFile));
        boolean failed=checks.stream().anyMatch(c->c.get("status").equals("fail"));
        return Map.of("schemaVersion","1.0.0","policy","native-preservation-v1","sourceHash",sourceHash,"candidateHash",candidateHash,"status",failed?"rejected":unavailable.isEmpty()?"verified":"incomplete","dpi",DPI,"pageCount",ap.size(),"checks",checks,"unavailable",unavailable,"limitations",List.of("Exact current VIEW/PRINT pixels at 120 DPI, protected form dictionaries and supported font maps; no reader or human semantic certification.","Dynamic optional-content states, signed/encrypted documents and XFA require separate qualification."));
    }
}
