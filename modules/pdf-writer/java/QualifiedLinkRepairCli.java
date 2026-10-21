import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;

/** Repair only links, retaining all existing page/font/form objects and metadata. */
public final class QualifiedLinkRepairCli {
    public static void main(String[] args) throws Exception {
        if (args.length != 3 || !Set.of("repair", "verify").contains(args[0])) throw new IOException("Usage: repair|verify source candidate");
        Path source = Path.of(args[1]), target = Path.of(args[2]);
        if (source.toAbsolutePath().normalize().equals(target.toAbsolutePath().normalize())) throw new IOException("Output must differ from source");
        if (args[0].equals("repair") && Files.exists(target)) throw new IOException("Refusing to overwrite existing output");
        try (PDDocument doc = Loader.loadPDF(source.toFile())) {
            List<Map<String, Object>> ledger = QualifiedStructureRepairs.applyLinks(doc);
            if (args[0].equals("verify")) requireMatch(SavedObjectVerifier.verify(doc, target));
            else {
                Path temp = Files.createTempFile(target.toAbsolutePath().getParent(), ".link-repair-", ".pdf");
                try {
                    if (ledger.stream().noneMatch(r -> r.get("decision").equals("apply"))) Files.copy(source, temp, StandardCopyOption.REPLACE_EXISTING);
                    else try (OutputStream out = Files.newOutputStream(temp)) { doc.saveIncremental(out); }
                    try (PDDocument expected = Loader.loadPDF(source.toFile())) {
                        QualifiedStructureRepairs.applyLinks(expected); requireMatch(SavedObjectVerifier.verify(expected, temp));
                    }
                    Files.move(temp, target);
                } finally { Files.deleteIfExists(temp); }
            }
            System.out.println(QualifiedStructureRepairs.json(Map.of("repairLedger", ledger)));
        }
    }
    private static void requireMatch(Map<String, Object> proof) throws IOException {
        if (!proof.get("status").equals("pass")) throw new IOException(proof.get("reason").toString());
    }
}
