import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.text.PDFTextStripperByArea;
import org.apache.pdfbox.text.TextPosition;
import org.apache.pdfbox.pdmodel.graphics.state.PDTextState;

/**
 * Operator-level content stream parser for native PDF tagging.
 *
 * Records every text-rendering operator (Tj, TJ, ', ") with exact position,
 * font, and text content. This operator-level granularity is the foundation
 * for injecting BDC/MCID/EMC marked-content sequences around original content
 * without rasterization.
 *
 * Uses PDFBox's PDFTextStripper infrastructure to process glyphs but intercepts
 * at the operator level via processOperator override.
 */
public class NativeContentStreamParser extends org.apache.pdfbox.text.PDFTextStripper {

    private final List<OperatorRecord> records = new ArrayList<>();
    private int sequenceIndex = 0;
    private int currentPage = 0;

    static class OperatorRecord {
        int page;
        int seq;
        String op;
        String text;
        float x;
        float y;
        String fontName;
        float fontSize;
        int glyphs;
    }

    public NativeContentStreamParser() throws IOException {
        super();
        setSortByPosition(false);
    }

    @Override
    protected void processOperator(Operator operator, List<COSBase> operands) throws IOException {
        String opName = operator.getName();

        if ("Tj".equals(opName) || "'".equals(opName)) {
            String text = "";
            if (!operands.isEmpty() && operands.get(0) instanceof COSString str) {
                PDFont font = getGraphicsState().getTextState().getFont();
                if (font != null) {
                    text = str.getString();
                } else {
                    text = str.getString();
                }
            }
            recordOp(opName, text);
        } else if ("TJ".equals(opName)) {
            if (!operands.isEmpty() && operands.get(0) instanceof COSArray arr) {
                StringBuilder sb = new StringBuilder();
                PDFont font = getGraphicsState().getTextState().getFont();
                for (int i = 0; i < arr.size(); i++) {
                    COSBase item = arr.get(i);
                    if (item instanceof COSString s) {
                        if (font != null) {
                            sb.append(s.getString());
                        } else {
                            sb.append(s.getString());
                        }
                    }
                }
                recordOp("TJ", sb.toString());
            }
        } else if ("\"".equals(opName)) {
            String text = "";
            for (COSBase op : operands) {
                if (op instanceof COSString s) {
                    PDFont font = getGraphicsState().getTextState().getFont();
                    if (font != null) {
                        text = s.getString();
                    } else {
                        text = s.getString();
                    }
                    break;
                }
            }
            recordOp("\"", text);
        }

        super.processOperator(operator, operands);
    }

    private void recordOp(String op, String text) {
        OperatorRecord rec = new OperatorRecord();
        rec.page = currentPage;
        rec.seq = sequenceIndex++;
        rec.op = op;
        rec.text = text != null ? text : "";
        rec.glyphs = rec.text.length();

        try {
            org.apache.pdfbox.util.Matrix tm = getTextMatrix();
            if (tm != null) {
                rec.x = tm.getTranslateX();
                rec.y = tm.getTranslateY();
            }
        } catch (Exception e) {
            rec.x = 0;
            rec.y = 0;
        }

        PDTextState ts = getGraphicsState().getTextState();
        rec.fontName = ts.getFont() != null ? ts.getFont().getName() : "";
        rec.fontSize = ts.getFontSize();

        records.add(rec);
    }

    public List<OperatorRecord> parseOnePage(PDDocument doc, int pageIndex) throws IOException {
        records.clear();
        sequenceIndex = 0;
        currentPage = pageIndex + 1;
        setStartPage(pageIndex + 1);
        setEndPage(pageIndex + 1);
        getText(doc);
        return new ArrayList<>(records);
    }

    // --- CLI ---
    public static void main(String[] args) throws Exception {
        String pdfPath = null;
        int targetPage = -1;

        for (int i = 0; i < args.length; i++) {
            if ("--pdf".equals(args[i]) && i + 1 < args.length) pdfPath = args[++i];
            else if ("--page".equals(args[i]) && i + 1 < args.length) targetPage = Integer.parseInt(args[++i]);
        }
        if (pdfPath == null) {
            System.err.println("Usage: java NativeContentStreamParser --pdf <path> [--page <n>]");
            System.exit(1);
        }

        try (PDDocument doc = Loader.loadPDF(new File(pdfPath))) {
            NativeContentStreamParser parser = new NativeContentStreamParser();
            StringBuilder json = new StringBuilder();
            json.append("{\"pages\":[");

            int pageCount = doc.getNumberOfPages();
            boolean firstPage = true;

            for (int p = 0; p < pageCount; p++) {
                if (targetPage >= 0 && p != targetPage) continue;

                List<OperatorRecord> ops = parser.parseOnePage(doc, p);

                if (!firstPage) json.append(",");
                firstPage = false;

                json.append("{\"pageNumber\":").append(p + 1);
                json.append(",\"operatorCount\":").append(ops.size());
                json.append(",\"operators\":[");

                for (int i = 0; i < ops.size(); i++) {
                    OperatorRecord r = ops.get(i);
                    if (i > 0) json.append(",");
                    json.append("{");
                    json.append("\"seq\":").append(r.seq);
                    json.append(",\"op\":\"").append(r.op).append("\"");
                    json.append(",\"text\":").append(escapeJson(r.text));
                    json.append(",\"x\":").append(String.format("%.1f", r.x));
                    json.append(",\"y\":").append(String.format("%.1f", r.y));
                    json.append(",\"font\":\"").append(escapeStr(r.fontName)).append("\"");
                    json.append(",\"fontSize\":").append(String.format("%.1f", r.fontSize));
                    json.append(",\"glyphs\":").append(r.glyphs);
                    json.append("}");
                }
                json.append("]}");
            }

            json.append("],\"totalPages\":").append(pageCount);
            json.append("}");

            System.out.println(json.toString());
        }
    }

    private static String escapeJson(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    private static String escapeStr(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
