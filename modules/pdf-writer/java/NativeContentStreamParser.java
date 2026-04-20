import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkInfo;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
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
 * <p>Text decoding flows through PDFBox's glyph pipeline so Type0/Identity-H
 * CID fonts emit real post-ToUnicode strings instead of the raw byte payload
 * of the source COSString (which is what {@code COSString.getString()} would
 * return). Correlation between emitted glyphs and the enclosing text operator
 * is done by bracketing {@code super.processOperator} with start/end markers
 * on a per-operator buffer — every glyph PDFBox renders while super-dispatching
 * a text operator is appended to that operator's text.</p>
 */
public class NativeContentStreamParser extends org.apache.pdfbox.text.PDFTextStripper {

    private static final Set<String> TEXT_OPS = new HashSet<>();
    static {
        TEXT_OPS.add("Tj");
        TEXT_OPS.add("TJ");
        TEXT_OPS.add("'");
        TEXT_OPS.add("\"");
    }

    private final List<OperatorRecord> records = new ArrayList<>();
    private int sequenceIndex = 0;
    private int currentPage = 0;
    private float currentPageHeight = 792f;

    /** Buffer for the currently-dispatching text operator. */
    private StringBuilder currentOpText = new StringBuilder();
    /** Record slot for the currently-dispatching text operator (null between ops). */
    private OperatorRecord currentRecord = null;
    /** Nesting counter for BMC/BDC/EMC detection in the current stream. */
    private int markedContentDepth = 0;

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
        /**
         * Path to the content stream this operator lives in. "page" means the
         * page's top-level content stream; otherwise it is the XObject form
         * resource name (e.g., "Fm0") — the rewriter uses this to route the
         * operator back to the right stream.
         */
        String streamOrigin;
        /** Index of this operator within its enclosing content stream. */
        int opIndexInStream;
        /** True if this operator is lexically inside an already-open BMC/BDC block. */
        boolean insideMarkedContent;
        /** True once we've captured a position from a non-whitespace glyph. */
        boolean positionLocked;
    }

    public NativeContentStreamParser() throws IOException {
        super();
        setSortByPosition(false);
    }

    @Override
    protected void processOperator(Operator operator, List<COSBase> operands) throws IOException {
        String opName = operator.getName();

        // Track pre-existing marked-content nesting so downstream stages know
        // which operators are already inside a BDC/BMC block in the source.
        if ("BMC".equals(opName) || "BDC".equals(opName)) {
            markedContentDepth++;
            super.processOperator(operator, operands);
            return;
        }
        if ("EMC".equals(opName)) {
            if (markedContentDepth > 0) markedContentDepth--;
            super.processOperator(operator, operands);
            return;
        }

        if (TEXT_OPS.contains(opName)) {
            // Save parent state before overwriting. super.processOperator may
            // re-enter this override through nested content streams (form
            // XObjects, tiling patterns) that themselves contain text ops.
            // Without save/restore, the nested text op would null currentRecord
            // and the outer dispatch would NPE on exit.
            OperatorRecord savedRecord = currentRecord;
            StringBuilder savedText = currentOpText;

            OperatorRecord rec = new OperatorRecord();
            rec.page = currentPage;
            rec.seq = sequenceIndex++;
            rec.op = opName;
            // streamOrigin is always "page" today; XObject-form descent will
            // refine this in a follow-up pass (operators from /Do XObjects
            // currently inherit the page's stream id, which is structurally
            // correct for reporting but means the rewriter can't rewrite
            // those operators yet).
            rec.streamOrigin = "page";
            rec.insideMarkedContent = markedContentDepth > 0;

            // Font state captured pre-super (the super-dispatched operator
            // may install a different font for subsequent ops but THIS op
            // uses the pre-state).
            PDTextState ts = getGraphicsState().getTextState();
            rec.fontName = ts.getFont() != null ? ts.getFont().getName() : "";
            rec.fontSize = ts.getFontSize();

            // Position is captured from the FIRST glyph fired during the
            // super-dispatch below (via processTextPosition). TextPosition
            // coordinates are already post-CTM, post-rotation, and y-flipped
            // to the display convention that the semantic engine uses —
            // unlike getTextMatrix().getTranslate*(), which returns raw user-
            // space coordinates that can be outside the mediaBox when the
            // page uses a scaling CTM (e.g., 2026_31162.pdf: user-space y up
            // to 1005 on a 792pt page).
            rec.x = Float.NaN;
            rec.y = Float.NaN;

            currentRecord = rec;
            currentOpText = new StringBuilder();

            super.processOperator(operator, operands);

            rec.text = currentOpText.toString();
            rec.glyphs = rec.text.length();
            // If no glyphs fired (possible for empty string operators), fall
            // back to the text matrix so we still emit usable coordinates.
            if (Float.isNaN(rec.x) || Float.isNaN(rec.y)) {
                try {
                    org.apache.pdfbox.util.Matrix tm = getTextMatrix();
                    if (tm != null) {
                        rec.x = tm.getTranslateX();
                        rec.y = tm.getTranslateY();
                    } else {
                        rec.x = 0;
                        rec.y = 0;
                    }
                } catch (Exception ignored) {
                    rec.x = 0;
                    rec.y = 0;
                }
            }
            records.add(rec);

            currentRecord = savedRecord;
            currentOpText = savedText;
            return;
        }

        super.processOperator(operator, operands);
    }

    @Override
    protected void processTextPosition(TextPosition text) {
        if (currentRecord != null) {
            String unicode = text.getUnicode();
            if (unicode != null) {
                currentOpText.append(unicode);
            }
            // Capture the position of the first NON-WHITESPACE glyph. An op
            // whose text begins with leading spaces ("    Hello") draws
            // those spaces at x=textOrigin, then the "H" at x = origin +
            // N*spaceWidth. The semantic bbox starts at the "H" because
            // upstream layout ignores leading whitespace; if we captured
            // the whitespace-origin x we'd be to the left of every bbox
            // and all such operators would fail the containment check.
            // A single fallback to the first glyph (below) ensures we
            // still emit a position for whitespace-only ops.
            if (unicode != null && !isWhitespaceOnly(unicode) && !currentRecord.positionLocked) {
                currentRecord.x = text.getX();
                currentRecord.y = text.getY();
                currentRecord.positionLocked = true;
            } else if (Float.isNaN(currentRecord.x) || Float.isNaN(currentRecord.y)) {
                currentRecord.x = text.getX();
                currentRecord.y = text.getY();
            }
        }
        super.processTextPosition(text);
    }

    private static boolean isWhitespaceOnly(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (!Character.isWhitespace(s.charAt(i))) return false;
        }
        return true;
    }

    public List<OperatorRecord> parseOnePage(PDDocument doc, int pageIndex) throws IOException {
        records.clear();
        sequenceIndex = 0;
        markedContentDepth = 0;
        currentPage = pageIndex + 1;
        PDPage page = doc.getPage(pageIndex);
        PDRectangle cropBox = page.getCropBox();
        currentPageHeight = cropBox != null ? cropBox.getHeight() : 792f;
        setStartPage(pageIndex + 1);
        setEndPage(pageIndex + 1);
        getText(doc);
        return new ArrayList<>(records);
    }

    public float getCurrentPageHeight() {
        return currentPageHeight;
    }

    // --- CLI ---
    public static void main(String[] args) throws Exception {
        String pdfPath = null;
        String outputPath = null;
        int targetPage = -1;

        for (int i = 0; i < args.length; i++) {
            if ("--pdf".equals(args[i]) && i + 1 < args.length) pdfPath = args[++i];
            else if ("--output".equals(args[i]) && i + 1 < args.length) outputPath = args[++i];
            else if ("--page".equals(args[i]) && i + 1 < args.length) targetPage = Integer.parseInt(args[++i]);
        }
        if (pdfPath == null) {
            System.err.println("Usage: java NativeContentStreamParser --pdf <path> [--output <operators.json>] [--page <n>]");
            System.exit(1);
        }

        try (PDDocument doc = Loader.loadPDF(new File(pdfPath))) {
            NativeContentStreamParser parser = new NativeContentStreamParser();
            StringBuilder json = new StringBuilder();

            // Catalog-level facts about the source's existing accessibility
            // structure. The "already-tagged" heuristic downstream couples
            // these with the marked-content fraction, so a PDF with BMC/BDC
            // for OCG or artifact purposes (but no /StructTreeRoot) doesn't
            // get mistakenly treated as accessibility-tagged.
            PDDocumentCatalog catalog = doc.getDocumentCatalog();
            boolean hasStructTree = catalog != null && catalog.getStructureTreeRoot() != null;
            boolean markInfoMarked = false;
            if (catalog != null) {
                PDMarkInfo mi = catalog.getMarkInfo();
                markInfoMarked = mi != null && mi.isMarked();
            }
            boolean hasAcroForm = false;
            if (catalog != null) {
                PDAcroForm af = catalog.getAcroForm();
                hasAcroForm = af != null && af.getFields() != null && !af.getFields().isEmpty();
            }
            PDDocumentInformation info = doc.getDocumentInformation();
            String producer = info != null ? nullToEmpty(info.getProducer()) : "";
            String creator = info != null ? nullToEmpty(info.getCreator()) : "";
            float pdfVersion = doc.getVersion();
            json.append("{\"source\":{");
            json.append("\"hasStructTree\":").append(hasStructTree);
            json.append(",\"markInfoMarked\":").append(markInfoMarked);
            json.append(",\"hasAcroForm\":").append(hasAcroForm);
            json.append(",\"producer\":").append(escapeJson(producer));
            json.append(",\"creator\":").append(escapeJson(creator));
            json.append(",\"pdfVersion\":\"").append(String.format("%.1f", pdfVersion)).append("\"");
            // Operator (x, y) coordinates are captured from TextPosition,
            // which is post-CTM/post-rotation and uses the top-origin
            // display convention (y=0 at page top). The matcher uses this
            // flag to decide whether to flip y against pageHeight; "top"
            // means no flip needed, matching the semantic bbox convention.
            json.append("},\"coordinateOrigin\":\"top\",\"pages\":[");

            int pageCount = doc.getNumberOfPages();
            boolean firstPage = true;

            for (int p = 0; p < pageCount; p++) {
                if (targetPage >= 0 && p != targetPage) continue;

                List<OperatorRecord> ops = parser.parseOnePage(doc, p);
                PDPage page = doc.getPage(p);
                PDRectangle cropBox = page.getCropBox();
                float pageWidth = cropBox != null ? cropBox.getWidth() : 612f;
                float pageHeight = cropBox != null ? cropBox.getHeight() : 792f;

                if (!firstPage) json.append(",");
                firstPage = false;

                json.append("{\"pageNumber\":").append(p + 1);
                json.append(",\"pageWidth\":").append(String.format("%.1f", pageWidth));
                json.append(",\"pageHeight\":").append(String.format("%.1f", pageHeight));
                json.append(",\"rotation\":").append(page.getRotation());
                json.append(",\"operatorCount\":").append(ops.size());
                int markedOpCount = 0;
                for (OperatorRecord r : ops) if (r.insideMarkedContent) markedOpCount++;
                json.append(",\"markedContentOperators\":").append(markedOpCount);
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
                    json.append(",\"streamOrigin\":\"").append(escapeStr(r.streamOrigin)).append("\"");
                    json.append(",\"insideMarkedContent\":").append(r.insideMarkedContent);
                    json.append("}");
                }
                json.append("]}");
            }

            json.append("],\"totalPages\":").append(pageCount);
            json.append("}");

            if (outputPath != null) {
                try (java.io.Writer w = new java.io.OutputStreamWriter(
                        new java.io.FileOutputStream(outputPath),
                        java.nio.charset.StandardCharsets.UTF_8)) {
                    w.write(json.toString());
                }
            } else {
                System.out.println(json.toString());
            }
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

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
