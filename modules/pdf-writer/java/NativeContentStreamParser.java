import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
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
    private int currentPageRotation;

    /** Buffer for the currently-dispatching text operator. */
    private StringBuilder currentOpText = new StringBuilder();
    /** Record slot for the currently-dispatching text operator (null between ops). */
    private OperatorRecord currentRecord = null;
    /** Lexical operator index within the current page or Form stream. */
    private int streamOperatorIndex = 0;
    /** Nesting counter for BMC/BDC/EMC detection in the current stream. */
    private int markedContentDepth = 0;
    private String streamOrigin = "page";
    private final Set<COSStream> activeForms = new HashSet<>();
    private int formInvocations = 0;

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
         * page's top-level content stream. Each /index component identifies
         * a lexical Do invocation, so reused and nested Forms remain distinct.
         */
        String streamOrigin;
        /** Index of this operator within its enclosing content stream. */
        int opIndexInStream;
        /** True if this operator is lexically inside an already-open BMC/BDC block. */
        boolean insideMarkedContent;
        /** True once we've captured a position from a non-whitespace glyph. */
        boolean positionLocked;
        TextMapping mapping;
        final List<float[]> glyphPositions = new ArrayList<>();
    }

    /** A source font code is indivisible even when ToUnicode expands it. */
    public static final class SourceGlyph {
        final int part, byteStart, byteEnd, code, textStart, textEnd;
        final String unicode;
        SourceGlyph(int part, int from, int to, int code, int start, String unicode) {
            this.part=part; byteStart=from; byteEnd=to; this.code=code; textStart=start;
            textEnd=start+unicode.length(); this.unicode=unicode;
        }
    }

    /** Immutable mapping and slicing of the original operand; never re-encode text. */
    public static final class TextMapping {
        static final int MAX_GLYPHS = 32768;
        final List<COSBase> parts;
        final List<SourceGlyph> glyphs;
        final String text, sha256;
        final boolean array;
        TextMapping(List<COSBase> parts, List<SourceGlyph> glyphs, String text, String hash, boolean array) {
            this.parts=List.copyOf(parts); this.glyphs=List.copyOf(glyphs); this.text=text; sha256=hash; this.array=array;
        }
        /** Half-open glyph interval; adjustments after a boundary go to the next interval. */
        COSBase slice(int first, int end) {
            if (first < 0 || end <= first || end > glyphs.size()) throw new IllegalArgumentException("Invalid glyph interval");
            SourceGlyph left=first==0?null:glyphs.get(first-1), right=end==glyphs.size()?null:glyphs.get(end-1);
            int startPart=left==null?0:left.part, endPart=right==null?parts.size():right.part;
            COSArray result=new COSArray();
            for(int p=startPart;p<parts.size() && p<=endPart;p++) {
                COSBase part=parts.get(p);
                if(part instanceof COSString) {
                    byte[] bytes=((COSString)part).getBytes();
                    int from=left!=null && p==startPart?left.byteEnd:0;
                    int to=right!=null && p==endPart?right.byteEnd:bytes.length;
                    if(to>from || bytes.length==0 && (left==null || p>startPart))
                        result.add(new COSString(java.util.Arrays.copyOfRange(bytes,from,to)));
                } else if (p<endPart) result.add(part);
            }
            return array?result:result.getObject(0);
        }
    }

    public static TextMapping mapOperand(PDFont font, COSBase operand) {
        if(font==null) return null;
        List<COSBase> parts=new ArrayList<>();
        if(operand instanceof COSString) parts.add(operand);
        else if(operand instanceof COSArray) {
            COSArray a=(COSArray)operand; if(a.size()>4096)return null;
            for(int i=0;i<a.size();i++)parts.add(a.getObject(i));
        } else return null;
        long bytesTotal=0;
        for(COSBase part:parts) {
            if(part instanceof COSString)bytesTotal+=((COSString)part).getBytes().length;
            else if(!(part instanceof COSNumber) || !Float.isFinite(((COSNumber)part).floatValue()))return null;
        }
        if(bytesTotal>1048576)return null;
        List<SourceGlyph> glyphs=new ArrayList<>(); StringBuilder text=new StringBuilder();
        try {
            for(int p=0;p<parts.size();p++) {
                if(!(parts.get(p) instanceof COSString))continue;
                byte[] bytes=((COSString)parts.get(p)).getBytes();
                java.io.ByteArrayInputStream in=new java.io.ByteArrayInputStream(bytes);
                while(in.available()>0) {
                    int before=in.available(),code=font.readCode(in);
                    if(in.available()>=before || glyphs.size()>=TextMapping.MAX_GLYPHS)return null;
                    String unicode=font.toUnicode(code);
                    if(unicode==null || unicode.isEmpty() || unicode.indexOf('\ufffd')>=0)return null;
                    for(int u=0;u<unicode.length();u++) {
                        char c=unicode.charAt(u);
                        if(Character.isHighSurrogate(c)) { if(++u>=unicode.length() || !Character.isLowSurrogate(unicode.charAt(u)))return null; }
                        else if(Character.isLowSurrogate(c))return null;
                    }
                    glyphs.add(new SourceGlyph(p,bytes.length-before,bytes.length-in.available(),code,text.length(),unicode));
                    text.append(unicode); if(text.length()>262144)return null;
                }
            }
            var bytes=new java.io.ByteArrayOutputStream(); new ContentStreamWriter(bytes).writeToken(operand);
            String hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray()));
            return new TextMapping(parts,glyphs,text.toString(),hash,operand instanceof COSArray);
        } catch(IOException | java.security.NoSuchAlgorithmException ex) { return null; }
    }

    public NativeContentStreamParser() throws IOException {
        super();
        setSortByPosition(false);
    }

    /**
     * PDFBox's operator processors use the String overload for synthetic
     * operations (TD sets leading and moves text; quotes advance and show text).
     * Only the Operator overload is called by the stream tokenizer.
     * Execute synthetic operations normally,
     * but keep their glyphs in the enclosing source operator's record and do
     * not advance its lexical index.
     */
    @Override
    public void processOperator(String operation, List<COSBase> operands) throws IOException {
        super.processOperator(Operator.getOperator(operation), operands);
    }

    @Override
    protected void processOperator(Operator operator, List<COSBase> operands) throws IOException {
        String opName = operator.getName();
        int currentOperatorIndex = streamOperatorIndex++;

        if ("Do".equals(opName) && operands.size() == 1 && operands.get(0) instanceof COSName
                && getResources() != null && getResources().getXObject((COSName) operands.get(0)) instanceof PDFormXObject) {
            PDFormXObject form = (PDFormXObject) getResources().getXObject((COSName) operands.get(0));
            if (activeForms.size() >= 32 || ++formInvocations > 10000 || !activeForms.add(form.getCOSObject()))
                throw new IllegalStateException("Cyclic or excessive Form XObject traversal");
            String parentOrigin = streamOrigin;
            int parentIndex = streamOperatorIndex, parentDepth = markedContentDepth;
            streamOrigin = parentOrigin + "/" + currentOperatorIndex;
            streamOperatorIndex = 0;
            markedContentDepth = 0;
            try { super.processOperator(operator, operands); }
            finally {
                streamOrigin = parentOrigin; streamOperatorIndex = parentIndex; markedContentDepth = parentDepth;
                activeForms.remove(form.getCOSObject());
            }
            return;
        }

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
            rec.opIndexInStream = currentOperatorIndex;
            rec.streamOrigin = streamOrigin;
            rec.insideMarkedContent = markedContentDepth > 0;

            // Font state captured pre-super (the super-dispatched operator
            // may install a different font for subsequent ops but THIS op
            // uses the pre-state).
            PDTextState ts = getGraphicsState().getTextState();
            rec.fontName = ts.getFont() != null ? ts.getFont().getName() : "";
            rec.fontSize = ts.getFontSize();
            rec.mapping = operands.isEmpty() || ts.getFont() == null || ts.getFont().isVertical()
                ? null : mapOperand(ts.getFont(), operands.get(operands.size()-1));

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
            if(rec.mapping!=null && (rec.glyphPositions.size()!=rec.mapping.glyphs.size() || !rec.mapping.text.equals(rec.text)))rec.mapping=null;
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
            if(currentRecord.mapping!=null) {
                int i=currentRecord.glyphPositions.size(); int[] codes=text.getCharacterCodes();
                if(i>=currentRecord.mapping.glyphs.size() || codes.length!=1 || codes[0]!=currentRecord.mapping.glyphs.get(i).code
                        || !currentRecord.mapping.glyphs.get(i).unicode.equals(unicode)) currentRecord.mapping=null;
                else {
                    // TextPosition's direction-adjusted width is a projection
                    // onto a cardinal axis. Only publish partition geometry
                    // when that axis agrees with the actual baseline vector.
                    // Skewed/mirrored/vertical writing keeps whole-op matching.
                    var matrix = text.getTextMatrix();
                    double a = matrix.getScaleX(), b = matrix.getShearY(), length = Math.hypot(a,b);
                    double direction = Math.toRadians(text.getDir());
                    double angle = Math.toRadians(currentPageRotation-text.getDir());
                    float half = text.getWidthDirAdj()/2;
                    float x = text.getX()+(float)Math.cos(angle)*half, y = text.getY()+(float)Math.sin(angle)*half;
                    if (!Double.isFinite(length) || length == 0 || Math.abs(a/length-Math.cos(direction))>0.00001
                            || Math.abs(b/length-Math.sin(direction))>0.00001 || !Float.isFinite(x) || !Float.isFinite(y)) currentRecord.mapping=null;
                    else currentRecord.glyphPositions.add(new float[]{x,y});
                }
            }
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
        streamOperatorIndex = 0;
        markedContentDepth = 0;
        streamOrigin = "page";
        activeForms.clear();
        formInvocations = 0;
        currentPage = pageIndex + 1;
        PDPage page = doc.getPage(pageIndex);
        currentPageRotation = page.getRotation();
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
            json.append(",\"title\":").append(escapeJson(info != null ? nullToEmpty(info.getTitle()) : ""));
            json.append(",\"language\":").append(escapeJson(catalog != null ? nullToEmpty(catalog.getLanguage()) : ""));
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
                json.append(",\"pageWidth\":").append(Float.toString(pageWidth));
                json.append(",\"pageHeight\":").append(Float.toString(pageHeight));
                json.append(",\"userUnit\":").append(Float.toString(page.getUserUnit()));
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
                    json.append(",\"op\":").append(escapeJson(r.op));
                    json.append(",\"text\":").append(escapeJson(r.text));
                    json.append(",\"x\":").append(Float.toString(r.x));
                    json.append(",\"y\":").append(Float.toString(r.y));
                    json.append(",\"font\":\"").append(escapeStr(r.fontName)).append("\"");
                    json.append(",\"fontSize\":").append(String.format("%.1f", r.fontSize));
                    json.append(",\"glyphs\":").append(r.glyphs);
                    json.append(",\"streamOrigin\":\"").append(escapeStr(r.streamOrigin)).append("\"");
                    json.append(",\"opIndexInStream\":").append(r.opIndexInStream);
                    json.append(",\"insideMarkedContent\":").append(r.insideMarkedContent);
                    if(r.mapping!=null && !r.mapping.glyphs.isEmpty()) {
                        json.append(",\"glyphMap\":{\"sha256\":").append(escapeJson(r.mapping.sha256)).append(",\"glyphs\":[");
                        for(int g=0;g<r.mapping.glyphs.size();g++) {
                            SourceGlyph glyph=r.mapping.glyphs.get(g); float[] pos=r.glyphPositions.get(g);
                            if(g>0)json.append(',');
                            // Compact fixed-width rows: part, byteStart, byteEnd,
                            // code, UTF-16 start/end, display-center x/y.
                            json.append('[').append(glyph.part).append(',').append(glyph.byteStart).append(',').append(glyph.byteEnd).append(',')
                                .append(glyph.code).append(',').append(glyph.textStart).append(',').append(glyph.textEnd).append(',')
                                .append(Float.toString(pos[0])).append(',').append(Float.toString(pos[1])).append(']');
                        }
                        json.append("]}");
                    }
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
