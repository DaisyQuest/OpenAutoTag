import java.io.IOException;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;

/** Index emitted IDs and reject dangling table header references before saving a rebuilt tree. */
public final class StructureIdentifiers {
    private record Header(COSDictionary table,String id) {}
    private static COSBase resolve(COSBase v) { return v instanceof COSObject ? ((COSObject)v).getObject() : v; }
    public static void install(PDStructureTreeRoot root) throws IOException {
        TreeMap<String,COSDictionary> ids=new TreeMap<>(); List<Header> references=new ArrayList<>();
        Map<COSDictionary,COSDictionary> tables=new IdentityHashMap<>();
        Set<COSBase> seen=Collections.newSetFromMap(new IdentityHashMap<>());
        walk(root.getCOSObject().getItem(COSName.K),ids,references,tables,null,seen,0);
        for(Header reference:references) {
            COSDictionary target=ids.get(reference.id());
            if(target==null) throw new IOException("Missing emitted table header ID: "+reference.id());
            if(!"TH".equals(target.getNameAsString(COSName.S)) || reference.table()==null || tables.get(target)!=reference.table())
                throw new IOException("Table header must resolve to a TH in the same table: "+reference.id());
        }
        if(ids.isEmpty()) return;
        COSArray names=new COSArray();
        for(var entry:ids.entrySet()) { names.add(new COSString(entry.getKey())); names.add(entry.getValue()); }
        COSDictionary tree=new COSDictionary(); tree.setItem(COSName.NAMES,names);
        root.getCOSObject().setItem(COSName.getPDFName("IDTree"),tree);
    }
    private static void walk(COSBase raw,Map<String,COSDictionary> ids,List<Header> refs,Map<COSDictionary,COSDictionary> tables,COSDictionary table,Set<COSBase> seen,int depth) throws IOException {
        if(depth>128 || seen.size()>200000) throw new IOException("Structure ID traversal limit exceeded");
        COSBase value=resolve(raw); if(value==null || !seen.add(value)) return;
        if(value instanceof COSArray) { for(COSBase kid:(COSArray)value) walk(kid,ids,refs,tables,table,seen,depth+1); }
        else if(value instanceof COSDictionary && "StructElem".equals(((COSDictionary)value).getNameAsString(COSName.TYPE))) {
            COSDictionary d=(COSDictionary)value; String id=d.getString(COSName.ID);
            if("Table".equals(d.getNameAsString(COSName.S))) table=d;
            tables.put(d,table);
            if(id!=null && ids.putIfAbsent(id,d)!=null) throw new IOException("Duplicate emitted structure ID: "+id);
            attributes(d.getDictionaryObject(COSName.A),refs,table,0); walk(d.getItem(COSName.K),ids,refs,tables,table,seen,depth+1);
        }
    }
    private static void attributes(COSBase value,List<Header> refs,COSDictionary table,int depth) throws IOException {
        if(depth>16) throw new IOException("Excessive table attribute nesting");
        if(value instanceof COSArray) for(COSBase child:(COSArray)value) attributes(resolve(child),refs,table,depth+1);
        else if(value instanceof COSDictionary && "Table".equals(((COSDictionary)value).getNameAsString(COSName.O))) {
            COSArray headers=((COSDictionary)value).getCOSArray(COSName.getPDFName("Headers"));
            if(headers!=null) for(COSBase id:headers) {
                if(!(resolve(id) instanceof COSString)) throw new IOException("Invalid table header ID");
                refs.add(new Header(table,((COSString)resolve(id)).getString()));
            }
        }
    }
}
