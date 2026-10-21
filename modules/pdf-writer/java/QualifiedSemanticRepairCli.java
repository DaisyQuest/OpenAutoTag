import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;

/** Repair heading ranks and explicitly reviewed image roles; verify every saved object. */
public final class QualifiedSemanticRepairCli {
    public static void main(String[] args) throws Exception {
        if (args.length < 4 || (args.length-4)%2 != 0 || !Set.of("repair", "verify").contains(args[0])) throw new IOException("Usage: repair|verify source candidate split-forms [figure-ref reviewed-alt]...");
        if(!Set.of("true","false").contains(args[3]))throw new IOException("Invalid split-forms flag");
        boolean splitForms=Boolean.parseBoolean(args[3]);
        Path source = Path.of(args[1]), target = Path.of(args[2]);
        if (source.toAbsolutePath().normalize().equals(target.toAbsolutePath().normalize())) throw new IOException("Output must differ from source");
        if (args[0].equals("repair") && Files.exists(target)) throw new IOException("Refusing to overwrite existing output");
        List<QualifiedSemanticRepairs.FigureDecision> decisions = new ArrayList<>();
        List<String> paragraphs = new ArrayList<>();
        for(int i=4;i<args.length;i+=2) {
            if (args[i].equals("--paragraph")) paragraphs.add(args[i+1]);
            else decisions.add(new QualifiedSemanticRepairs.FigureDecision(args[i],args[i+1]));
        }
        try (PDDocument doc = Loader.loadPDF(source.toFile())) {
            List<Map<String, Object>> ledger = QualifiedSemanticRepairs.apply(doc, decisions, splitForms, paragraphs);
            if (args[0].equals("verify")) requireMatch(SavedObjectVerifier.verify(doc, target));
            else {
                Path temp = Files.createTempFile(target.toAbsolutePath().getParent(), ".semantic-repair-", ".pdf");
                try {
                    if (ledger.stream().noneMatch(r -> r.get("decision").equals("apply"))) Files.copy(source, temp, StandardCopyOption.REPLACE_EXISTING);
                    else try (OutputStream out = Files.newOutputStream(temp)) { doc.saveIncremental(out); }
                    try (PDDocument expected = Loader.loadPDF(source.toFile())) {
                        QualifiedSemanticRepairs.apply(expected, decisions, splitForms, paragraphs); requireMatch(SavedObjectVerifier.verify(expected, temp));
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
