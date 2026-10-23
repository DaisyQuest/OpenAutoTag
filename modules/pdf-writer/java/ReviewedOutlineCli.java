import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.*;
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.destination.PDPageFitDestination;

/** Append an accepted outline; qualify every saved catalog/info object by replay. */
public final class ReviewedOutlineCli {
    static void require(boolean ok,String reason)throws IOException{if(!ok)throw new IOException(reason);}
    static COSBase resolved(COSBase v){return v instanceof COSObject o?o.getObject():v;}
    static COSDictionary dict(COSBase v)throws IOException{v=resolved(v);require(v instanceof COSDictionary,"Invalid existing outline dictionary");return (COSDictionary)v;}
    static long validate(COSDictionary node,int depth,Set<COSDictionary> seen,boolean root)throws IOException {
        require(depth<=128&&seen.size()<100000&&seen.add(node),"Cyclic, shared or excessive existing outline");
        COSBase first=node.getDictionaryObject(COSName.FIRST),last=node.getDictionaryObject(COSName.LAST);
        require((first==null)==(last==null),"Invalid existing outline First/Last");
        COSDictionary previous=null,current=first==null?null:dict(first);long visible=0;
        while(current!=null){
            require(current.getDictionaryObject(COSName.PARENT)==node&&current.getDictionaryObject(COSName.PREV)==previous,"Invalid existing outline parent/previous relationship");
            require(current.getDictionaryObject(COSName.TITLE) instanceof COSString,"Existing outline title is missing");
            require(!(current.containsKey(COSName.DEST)&&current.containsKey(COSName.A)),"Existing outline has Dest and A");
            long children=validate(current,depth+1,seen,false);visible+=1+Math.max(0,children);previous=current;
            COSBase next=current.getDictionaryObject(COSName.NEXT);current=next==null?null:dict(next);
        }
        require(previous==last,"Invalid existing outline Last relationship");
        COSBase raw=node.getDictionaryObject(COSName.COUNT);require(raw==null||raw instanceof COSInteger,"Invalid existing outline Count");long count=raw==null?0:((COSInteger)raw).longValue();
        require(root?count==visible:Math.abs(count)==visible,"Invalid existing outline Count value");return count;
    }
    @SuppressWarnings("unchecked")
    static PDOutlineItem build(PDDocument doc,Map<String,Object> entry,Set<String> ids,int depth)throws IOException {
        require(depth<=32&&ids.size()<4096,"Reviewed outline exceeds limits");
        Object id=entry.get("id"),title=entry.get("title"),number=entry.get("pageNumber"),open=entry.get("open"),children=entry.get("children");
        require(id instanceof String&&ids.add((String)id)&&title instanceof String&&!((String)title).isBlank()&&((String)title).length()<=4096&&number instanceof Number&&open instanceof Boolean&&children instanceof List,"Invalid reviewed bookmark");
        double page=((Number)number).doubleValue();require(Double.isFinite(page)&&page==Math.rint(page)&&page>=1&&page<=doc.getNumberOfPages(),"Reviewed bookmark page is outside document");
        PDOutlineItem item=new PDOutlineItem();item.setTitle((String)title);PDPageFitDestination destination=new PDPageFitDestination();destination.setPage(doc.getPage((int)page-1));item.setDestination(destination);
        for(Object child:(List<?>)children){require(child instanceof Map,"Invalid reviewed bookmark child");item.addLast(build(doc,(Map<String,Object>)child,ids,depth+1));}
        if((Boolean)open)item.openNode();else item.closeNode();return item;
    }
    @SuppressWarnings("unchecked")
    static int apply(PDDocument doc,Map<String,Object> review)throws IOException {
        require(!doc.isEncrypted()&&doc.getSignatureDictionaries().isEmpty(),"Encrypted or signed PDFs require separate outline review");
        PDDocumentOutline outline=doc.getDocumentCatalog().getDocumentOutline();
        if(outline!=null)validate(outline.getCOSObject(),0,Collections.newSetFromMap(new IdentityHashMap<>()),true);
        require("accepted".equals(review.get("decision"))&&review.get("bookmarks") instanceof List,"Accepted reviewed outline required");
        List<PDOutlineItem> added=new ArrayList<>();Set<String> ids=new HashSet<>();
        for(Object entry:(List<?>)review.get("bookmarks")){require(entry instanceof Map,"Invalid bookmark entry");added.add(build(doc,(Map<String,Object>)entry,ids,0));}
        require(!added.isEmpty(),"Reviewed outline is empty");
        if(outline==null){outline=new PDDocumentOutline();doc.getDocumentCatalog().setDocumentOutline(outline);}
        for(PDOutlineItem item:added)outline.addLast(item);
        validate(outline.getCOSObject(),0,Collections.newSetFromMap(new IdentityHashMap<>()),true);
        return ids.size();
    }
    static String sha(Path path)throws Exception{MessageDigest d=MessageDigest.getInstance("SHA-256");try(InputStream in=Files.newInputStream(path)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)d.update(b,0,n);}return HexFormat.of().formatHex(d.digest());}
    @SuppressWarnings("unchecked")
    public static void main(String[] args)throws Exception {
        require(args.length==4&&Set.of("apply","verify").contains(args[0]),"Usage: apply|verify source target accepted-outline.json");
        Path source=Path.of(args[1]),target=Path.of(args[2]),reviewPath=Path.of(args[3]);
        require(!source.toAbsolutePath().normalize().equals(target.toAbsolutePath().normalize()),"Output must differ from source");
        require(!args[0].equals("apply")||!Files.exists(target),"Refusing to overwrite existing output");
        require(Files.size(reviewPath)<=1024*1024,"Outline review exceeds size limit");
        Object parsed=NativeContentStreamRewriter.parseJson(Files.readString(reviewPath));require(parsed instanceof Map,"Invalid outline review");Map<String,Object> review=(Map<String,Object>)parsed;
        require(sha(source).equals(review.get("sourceHash")),"Outline review source hash is stale");
        try(PDDocument doc=Loader.loadPDF(source.toFile())){
            int count=apply(doc,review);Map<String,Object> verification;
            if(args[0].equals("verify"))verification=SavedObjectVerifier.verify(doc,target);
            else {
                Path temp=Files.createTempFile(target.toAbsolutePath().getParent(),".reviewed-outline-",".pdf");
                try{
                    try(OutputStream out=Files.newOutputStream(temp)){doc.saveIncremental(out);}
                    try(PDDocument expected=Loader.loadPDF(source.toFile())){apply(expected,review);verification=SavedObjectVerifier.verify(expected,temp);}
                    require("pass".equals(verification.get("status")),verification.get("reason").toString());Files.move(temp,target);
                }finally{Files.deleteIfExists(temp);}
            }
            require("pass".equals(verification.get("status")),verification.get("reason").toString());
            System.out.println(QualifiedStructureRepairs.json(Map.of("addedBookmarks",count,"verification",verification)));
        }
    }
}
