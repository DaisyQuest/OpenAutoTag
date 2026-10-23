import java.io.IOException;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;

/** Independent, bounded saved navigation inventory. Never changes the document. */
final class NavigationInspector {
    private final Map<COSDictionary,Integer> pages=new IdentityHashMap<>();
    private final Set<COSBase> visited=Collections.newSetFromMap(new IdentityHashMap<>());
    private final TreeMap<String,COSBase> named=new TreeMap<>();
    private final TreeMap<Integer,COSDictionary> labels=new TreeMap<>();
    private final List<String> issues=new ArrayList<>();
    private int count;
    private final int[] fingerprintWork={0};
    private String lastName;
    private long lastLabel=-1;
    private static COSBase value(COSBase v){return v instanceof COSObject o?o.getObject():v;}
    private static Map<String,Object> object(Object... fields){Map<String,Object> out=new LinkedHashMap<>();for(int i=0;i<fields.length;i+=2)out.put((String)fields[i],fields[i+1]);return out;}
    private void visit(COSBase v,int depth)throws IOException {
        if(depth>128||++count>100000||!visited.add(v))throw new IOException("Cyclic, shared or excessive navigation tree");
    }
    private static void require(boolean ok,String reason)throws IOException{if(!ok)throw new IOException("Invalid navigation: "+reason);}
    private static COSDictionary dictionary(COSBase raw)throws IOException{COSBase v=value(raw);require(v instanceof COSDictionary,"expected dictionary");return (COSDictionary)v;}
    private static String string(COSBase raw)throws IOException{COSBase v=value(raw);require(v instanceof COSString,"expected string");return ((COSString)v).getString();}
    private static long integer(COSBase raw,long fallback)throws IOException{COSBase v=value(raw);if(v==null)return fallback;require(v instanceof COSInteger,"expected integer");return ((COSInteger)v).longValue();}
    private String digest(COSBase v,Set<String> skip)throws Exception{return PreservationInspector.navigationFingerprint(v,skip,pages,fingerprintWork);}
    static Map<String,Object> inspect(PDDocument doc)throws Exception{return new NavigationInspector().run(doc);}
    private Map<String,Object> run(PDDocument doc)throws Exception {
        int page=0;for(PDPage p:doc.getPages())pages.put(p.getCOSObject(),++page);
        require(page<=100000,"page limit exceeded");COSDictionary catalog=doc.getDocumentCatalog().getCOSObject();
        COSDictionary names=catalog.getCOSDictionary(COSName.NAMES);
        COSBase nameRoot=names==null?null:names.getItem(COSName.DESTS),legacy=catalog.getDictionaryObject(COSName.DESTS);
        if(nameRoot!=null)readNames(dictionary(nameRoot),0);
        // PDF 1.1 name destinations and PDF 1.2 byte-string destinations are distinct.
        Map<String,COSBase> legacyNames=new TreeMap<>();
        if(legacy!=null)for(var e:dictionary(legacy).entrySet()){require(legacyNames.size()<100000,"legacy destination limit exceeded");legacyNames.put(e.getKey().getName(),e.getValue());}
        COSBase labelRoot=catalog.getItem(COSName.PAGE_LABELS);
        if(labelRoot!=null){readLabels(dictionary(labelRoot),0);require(!labels.isEmpty()&&labels.firstKey()==0,"page labels must begin at index zero");}
        List<Map<String,Object>> ranges=new ArrayList<>();
        for(var e:labels.entrySet()){
            COSDictionary d=e.getValue();String style=d.getNameAsString(COSName.S,"");
            require(!d.containsKey(COSName.S)||d.getDictionaryObject(COSName.S) instanceof COSName,"label style must be a name");
            require(Set.of("","D","R","r","A","a").contains(style),"unknown page-label style");
            String prefix=d.containsKey(COSName.P)?string(d.getItem(COSName.P)):"";long start=integer(d.getItem(COSName.ST),1);
            require(start>0&&start<=Integer.MAX_VALUE&&prefix.length()<=4096,"invalid page-label start/prefix");
            ranges.add(object("index",e.getKey(),"style",style,"prefix",prefix,"start",start,"propertiesHash",digest(d,Set.of())));
        }
        List<String> resolved=new ArrayList<>();
        for(int i=0;i<page;i++){
            if(labels.isEmpty()){resolved.add(Integer.toString(i+1));continue;}
            var e=labels.floorEntry(i);COSDictionary d=e.getValue();long n=integer(d.getItem(COSName.ST),1)+i-e.getKey();
            String prefix=d.getString(COSName.P,"");String label=prefix+number(d.getNameAsString(COSName.S,""),n);require(label.length()<=4096,"resolved label too long");resolved.add(label);
        }
        COSBase outlineRaw=catalog.getItem(COSName.OUTLINES);COSDictionary outline=outlineRaw==null?null:dictionary(outlineRaw);
        List<Map<String,Object>> items=outline==null?List.of():outlineChildren(outline,0,legacyNames);
        long open=outline==null?0:integer(outline.getItem(COSName.COUNT),0);
        if(outline!=null&&(open<0||open!=visible(items)))issues.add("OUTLINE_ROOT_COUNT");
        Map<String,Object> out=new LinkedHashMap<>();
        out.put("pageLabels",object("present",labelRoot!=null,"treeHash",digest(labelRoot,Set.of()),"ranges",ranges,"labels",resolved));
        out.put("outlines",object("present",outline!=null,"count",open,"propertiesHash",digest(outline,Set.of("First","Last","Count")),"graphHash",digest(outline,Set.of()),"items",items));
        out.put("namedDestinationsHash",digest(new COSArray(List.of(nameRoot==null?COSNull.NULL:nameRoot,legacy==null?COSNull.NULL:legacy)),Set.of()));
        out.put("issues",issues);
        return out;
    }
    private void readNames(COSDictionary node,int depth)throws IOException {
        visit(node,depth);String prior=lastName;COSArray pairs=node.getCOSArray(COSName.NAMES),kids=node.getCOSArray(COSName.KIDS);
        require((pairs==null)!=(kids==null),"name tree needs Names or Kids");
        if(pairs!=null){require(pairs.size()%2==0,"odd Names array");byte[] previous=null;
            for(int i=0;i<pairs.size();i+=2){string(pairs.get(i));byte[] bytes=((COSString)pairs.getObject(i)).getBytes();require(bytes.length<=4096&&named.size()<100000,"destination name limit exceeded");String name=HexFormat.of().formatHex(bytes);require((previous==null||Arrays.compareUnsigned(previous,bytes)<0)&&(lastName==null||lastName.compareTo(name)<0),"unordered destination names");require(named.putIfAbsent(name,pairs.get(i+1))==null,"duplicate destination name");previous=bytes;lastName=name;}}
        else for(COSBase kid:kids)readNames(dictionary(kid),depth+1);
        if(node.containsKey(COSName.LIMITS)){COSArray limits=node.getCOSArray(COSName.LIMITS);require(limits!=null&&limits.size()==2&&!Objects.equals(prior,lastName),"invalid name-tree Limits");string(limits.get(0));string(limits.get(1));String low=HexFormat.of().formatHex(((COSString)limits.getObject(0)).getBytes()),high=HexFormat.of().formatHex(((COSString)limits.getObject(1)).getBytes());String first=prior==null?named.firstKey():named.higherKey(prior);require(low.equals(first)&&high.equals(lastName),"name-tree Limits disagree with entries");}
    }
    private void readLabels(COSDictionary node,int depth)throws IOException {
        visit(node,depth);long prior=lastLabel;COSArray nums=node.getCOSArray(COSName.NUMS),kids=node.getCOSArray(COSName.KIDS);
        require((nums==null)!=(kids==null),"label tree needs Nums or Kids");
        if(nums!=null){require(nums.size()%2==0,"odd label Nums array");long previous=-1;
            for(int i=0;i<nums.size();i+=2){long key=integer(nums.get(i),-1);require(key>previous&&key>lastLabel&&key>=0&&key<pages.size(),"invalid label range index");require(labels.putIfAbsent((int)key,dictionary(nums.get(i+1)))==null,"duplicate label range");previous=key;lastLabel=key;}}
        else for(COSBase kid:kids)readLabels(dictionary(kid),depth+1);
        if(node.containsKey(COSName.LIMITS)){COSArray limits=node.getCOSArray(COSName.LIMITS);require(limits!=null&&limits.size()==2&&lastLabel!=prior,"invalid page-label Limits");require(integer(limits.get(0),-1)==labels.higherKey((int)prior)&&integer(limits.get(1),-1)==lastLabel,"page-label Limits disagree with entries");}
    }
    private List<Map<String,Object>> outlineChildren(COSDictionary parent,int depth,Map<String,COSBase> legacy)throws Exception {
        visit(parent,depth);List<Map<String,Object>> result=new ArrayList<>();COSBase first=parent.getDictionaryObject(COSName.FIRST),last=parent.getDictionaryObject(COSName.LAST);
        if((first==null)!=(last==null))issues.add("OUTLINE_FIRST_LAST:"+count);COSDictionary previous=null,current=first==null?null:dictionary(first);
        while(current!=null){
            if(current.getDictionaryObject(COSName.PARENT)!=parent)issues.add("OUTLINE_PARENT:"+count);
            if(current.getDictionaryObject(COSName.PREV)!=previous)issues.add("OUTLINE_PREVIOUS:"+count);
            String title=string(current.getItem(COSName.TITLE));require(title.length()<=32768,"outline title too long");
            require(!(current.containsKey(COSName.DEST)&&current.containsKey(COSName.A)),"outline has both Dest and A");
            List<Map<String,Object>> children=outlineChildren(current,depth+1,legacy);long open=integer(current.getItem(COSName.COUNT),0);
            if(!(children.isEmpty()?open==0:Math.abs(open)==visible(children)))issues.add("OUTLINE_COUNT:"+count);
            COSBase dest=current.getItem(COSName.DEST);COSDictionary action=current.getCOSDictionary(COSName.A);
            if(action!=null&&"GoTo".equals(action.getNameAsString(COSName.S)))dest=action.getItem(COSName.D);
            Map<String,Object> item=new LinkedHashMap<>();item.put("title",title);item.put("count",open);
            item.put("propertiesHash",digest(current,Set.of("Parent","Prev","Next","First","Last","Count")));
            item.put("destination",destination(dest,legacy));item.put("children",children);result.add(item);
            previous=current;COSBase next=current.getDictionaryObject(COSName.NEXT);current=next==null?null:dictionary(next);
        }
        if(previous!=last)issues.add("OUTLINE_LAST:"+count);return result;
    }
    private static long visible(List<Map<String,Object>> children){long total=children.size();for(var c:children)total+=Math.max(0,((Number)c.get("count")).longValue());return total;}
    private Map<String,Object> destination(COSBase raw,Map<String,COSBase> legacy)throws Exception {
        COSBase v=value(raw);String name="";
        if(v==null)return object("kind","none");
        if(v instanceof COSName n){name=n.getName();v=value(legacy.get(name));}
        else if(v instanceof COSString s){name=s.getString();v=value(named.get(HexFormat.of().formatHex(s.getBytes())));}
        require(v!=null,"unresolved named destination");if(v instanceof COSDictionary d)v=d.getDictionaryObject(COSName.D);
        require(v instanceof COSArray,"invalid destination type");COSArray a=(COSArray)v;
        require(a.size()>=2&&a.getObject(0) instanceof COSDictionary&&pages.containsKey(a.getObject(0))&&a.getObject(1) instanceof COSName,"invalid destination page/fit");
        String fit=((COSName)a.getObject(1)).getName();int length=switch(fit){case "Fit","FitB"->2;case "FitH","FitV","FitBH","FitBV"->3;case "XYZ"->5;case "FitR"->6;default->-1;};
        require(a.size()==length,"invalid destination operands");List<Object> values=new ArrayList<>();
        for(int i=2;i<a.size();i++){COSBase x=a.getObject(i);require(x instanceof COSNull&&!fit.equals("FitR")||x instanceof COSNumber&&Float.isFinite(((COSNumber)x).floatValue()),"invalid destination coordinate");values.add(x instanceof COSNull?null:((COSNumber)x).floatValue());}
        Map<String,Object> out=new LinkedHashMap<>();out.put("kind","local");out.put("name",name);out.put("pageNumber",pages.get(a.getObject(0)));out.put("fit",fit);out.put("values",values);return out;
    }
    private static String number(String style,long n)throws IOException {
        if(style.isEmpty())return "";if(style.equals("D"))return Long.toString(n);
        String out;
        if(style.equals("A")||style.equals("a")){long repeats=(n-1)/26+1;require(repeats<=4096,"alphabetic label too long");out=String.valueOf((char)('A'+(n-1)%26)).repeat((int)repeats);}
        else {require(n<4000000,"Roman label too long");StringBuilder b=new StringBuilder();int[] values={1000,900,500,400,100,90,50,40,10,9,5,4,1};String[] digits={"M","CM","D","CD","C","XC","L","XL","X","IX","V","IV","I"};for(int i=0;i<values.length;i++){while(n>=values[i]){b.append(digits[i]);n-=values[i];}}out=b.toString();}
        return style.equals(style.toLowerCase(Locale.ROOT))?out.toLowerCase(Locale.ROOT):out;
    }
}
