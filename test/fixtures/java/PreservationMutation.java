import java.io.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;

/** Deliberately damages a saved candidate to verify the preservation gate. Test-only. */
class PreservationMutation {
    public static void main(String[] args) throws Exception {
        try (PDDocument doc = Loader.loadPDF(new File(args[0]))) {
            String mode = args[2];
            COSDictionary catalog = doc.getDocumentCatalog().getCOSObject();
            if ("drop-field".equals(mode)) {
                catalog.getCOSDictionary(COSName.ACRO_FORM).getCOSArray(COSName.FIELDS).remove(0);
            } else if ("change-value".equals(mode)) {
                COSArray fields = catalog.getCOSDictionary(COSName.ACRO_FORM).getCOSArray(COSName.FIELDS);
                ((COSDictionary) fields.getObject(1)).setString(COSName.V, "CORRUPTED VALUE");
            } else if ("lose-heading".equals(mode)) {
                demote(doc.getDocumentCatalog().getStructureTreeRoot().getCOSObject(), Collections.newSetFromMap(new IdentityHashMap<>()));
            } else if ("page-geometry".equals(mode)) {
                doc.getPage(0).setRotation(90);
            } else if (!"unchanged".equals(mode)) throw new IllegalArgumentException(mode);
            try (OutputStream out = new FileOutputStream(args[1])) { doc.saveIncremental(out); }
        }
    }
    private static void demote(COSBase raw, Set<COSBase> seen) {
        COSBase value = raw instanceof COSObject ? ((COSObject) raw).getObject() : raw;
        if (value == null || !seen.add(value)) return;
        if (value instanceof COSArray) for (COSBase child : (COSArray) value) demote(child, seen);
        else if (value instanceof COSDictionary) {
            COSDictionary dict = (COSDictionary) value;
            if (dict.getNameAsString(COSName.S, "").matches("H[1-6]")) dict.setName(COSName.S, "P");
            demote(dict.getItem(COSName.K), seen);
        }
    }
}
