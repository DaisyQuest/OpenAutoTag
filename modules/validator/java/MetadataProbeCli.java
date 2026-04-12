import java.io.File;
import java.io.InputStream;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.common.PDMetadata;
import org.verapdf.model.impl.axl.AXLMainXMPPackage;
import org.verapdf.model.tools.XMPChecker;
import org.verapdf.xmp.impl.VeraPDFMeta;

public class MetadataProbeCli {
    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !"--pdf".equals(args[0])) {
            throw new IllegalArgumentException("Usage: java MetadataProbeCli --pdf <tagged.pdf>");
        }

        File pdfFile = new File(args[1]);
        try (PDDocument document = PDDocument.load(pdfFile)) {
            PDMetadata metadata = document.getDocumentCatalog().getMetadata();
            VeraPDFMeta xmp = null;

            if (metadata != null) {
                try (InputStream inputStream = metadata.createInputStream()) {
                    xmp = VeraPDFMeta.parse(inputStream);
                }
            }

            AXLMainXMPPackage mainPackage = new AXLMainXMPPackage(xmp, xmp != null);
            Boolean containsPdfUaIdentification = mainPackage.getcontainsPDFUAIdentification();
            String dcTitle = mainPackage.getdc_title();
            Long pdfUaPart = null;

            if (xmp != null && xmp.getPDFUAIdentificationPart() != null) {
                pdfUaPart = Long.valueOf(xmp.getPDFUAIdentificationPart().longValue());
            }

            String json = "{"
                + "\"metadataPresent\":" + (metadata != null)
                + ",\"infoMatchesXmp\":" + XMPChecker.doesInfoMatchXMP(document.getDocument())
                + ",\"dcTitleDetected\":" + (dcTitle != null && !dcTitle.isEmpty())
                + ",\"dcTitleValue\":\"" + escapeJson(dcTitle) + "\""
                + ",\"pdfUaIdentificationDetected\":" + (containsPdfUaIdentification != null && containsPdfUaIdentification.booleanValue())
                + ",\"pdfUaIdentificationPart\":" + (pdfUaPart == null ? "null" : pdfUaPart.toString())
                + "}";
            System.out.println(json);
        }
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }

        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n")
            .replace("\t", "\\t");
    }
}
