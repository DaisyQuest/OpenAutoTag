import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;

/** Only reviewed missing terminal-field TU entries may change. */
public final class ReviewedFieldNamesCli {
    static void require(boolean ok,String message)throws IOException {if(!ok)throw new IOException(message);}
    static void requireMissing(COSDictionary dictionary)throws IOException {
        COSBase value=dictionary.getDictionaryObject(COSName.TU);
        require(value==null||value instanceof COSString&&((COSString)value).getString().isBlank(),"An authored accessible name already exists or is malformed");
    }
    @SuppressWarnings("unchecked")
    static List<Map<String,Object>> apply(PDDocument doc,Map<String,Object> review)throws IOException {
        require(!doc.isEncrypted()&&doc.getSignatureDictionaries().isEmpty(),"Encrypted or signed forms require separate review");
        NativeWidgets inventory=new NativeWidgets(doc);
        PDAcroForm form=doc.getDocumentCatalog().getAcroForm(null);
        require(form!=null&&!form.getCOSObject().containsKey(COSName.XFA),"A native AcroForm without XFA is required");
        Map<String,PDTerminalField> fields=new HashMap<>();int count=0;
        for(PDField field:form.getFieldTree()) {
            require(++count<=100000,"Field inventory limit exceeded");
            if(field instanceof PDTerminalField terminal)require(fields.put(NativeWidgets.reference(field.getCOSObject()),terminal)==null,"Duplicate terminal field identity");
        }
        require("accepted".equals(review.get("decision"))&&review.get("fields") instanceof List,"Accepted field-name review required");
        List<?> entries=(List<?>)review.get("fields");require(!entries.isEmpty()&&entries.size()<=1024,"Invalid reviewed field count");
        Set<String> seen=new HashSet<>();List<Map<String,Object>> changes=new ArrayList<>();
        for(Object raw:entries) {
            require(raw instanceof Map,"Invalid field-name entry");Map<String,Object> entry=(Map<String,Object>)raw;
            String ref=String.valueOf(entry.get("fieldRef")),label=String.valueOf(entry.get("label"));PDTerminalField field=fields.get(ref);
            require(field!=null&&seen.add(ref)&&Objects.equals(field.getFullyQualifiedName(),entry.get("fieldName")),"Reviewed field identity does not resolve uniquely");
            require(Set.of("Tx","Ch","Btn").contains(field.getFieldType()),"Unsupported field type for reviewed naming");
            require(!label.isBlank()&&label.length()<=4096&&label.equals(entry.get("label")),"Invalid reviewed accessible name");
            requireMissing(field.getCOSObject());List<String> widgetRefs=new ArrayList<>();
            for(var widget:field.getWidgets()) {
                String widgetRef=NativeWidgets.reference(widget.getCOSObject());NativeWidgets.Widget original=inventory.byRef.get(widgetRef);
                require(original!=null&&original.fieldName.equals(field.getFullyQualifiedName()),"Reviewed widget is not a unique page control");
                requireMissing(widget.getCOSObject());widgetRefs.add(widgetRef);
            }
            require(entry.get("widgetRefs") instanceof List,"Missing reviewed widgets");List<String> selected=new ArrayList<>((List<String>)entry.get("widgetRefs"));Collections.sort(widgetRefs);Collections.sort(selected);
            require(!widgetRefs.isEmpty()&&widgetRefs.equals(selected),"Review must identify all native field widgets");
            field.getCOSObject().setString(COSName.TU,label);field.getCOSObject().setNeedToBeUpdated(true);
            changes.add(Map.of("fieldRef",ref,"fieldName",field.getFullyQualifiedName(),"widgetRefs",widgetRefs,"label",label));
        }
        return changes;
    }
    @SuppressWarnings("unchecked")
    public static void main(String[] args)throws Exception {
        require(args.length==4&&Set.of("apply","verify").contains(args[0]),"Usage: apply|verify source target accepted-field-names.json");
        Path source=Path.of(args[1]),target=Path.of(args[2]),reviewFile=Path.of(args[3]);
        require(!source.toAbsolutePath().normalize().equals(target.toAbsolutePath().normalize()),"Output must differ from source");
        require(!args[0].equals("apply")||!Files.exists(target),"Refusing to overwrite existing output");
        require(Files.size(reviewFile)<=1024*1024,"Field-name review exceeds size limit");
        Object parsed=NativeContentStreamRewriter.parseJson(Files.readString(reviewFile));require(parsed instanceof Map,"Invalid field-name review");Map<String,Object> review=(Map<String,Object>)parsed;
        require(ReviewedOutlineCli.sha(source).equals(review.get("sourceHash")),"Field-name source hash is stale");
        try(PDDocument doc=Loader.loadPDF(source.toFile())) {
            var changes=apply(doc,review);Map<String,Object> verification;
            if(args[0].equals("verify"))verification=SavedObjectVerifier.verify(doc,target);
            else {
                Path temp=Files.createTempFile(target.toAbsolutePath().getParent(),".reviewed-field-names-",".pdf");
                try {
                    try(OutputStream out=Files.newOutputStream(temp)){doc.saveIncremental(out);}
                    try(PDDocument expected=Loader.loadPDF(source.toFile())){apply(expected,review);verification=SavedObjectVerifier.verify(expected,temp);}
                    require("pass".equals(verification.get("status")),verification.get("reason").toString());
                    require(ReviewedOutlineCli.sha(source).equals(review.get("sourceHash")),"Source changed during field-name repair");Files.move(temp,target);
                } finally {Files.deleteIfExists(temp);}
            }
            require("pass".equals(verification.get("status")),verification.get("reason").toString());
            System.out.println(QualifiedStructureRepairs.json(Map.of("changedFields",changes,"verification",verification)));
        }
    }
}
