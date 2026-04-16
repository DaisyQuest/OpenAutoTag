import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNull;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.COSObjectable;
import org.apache.pdfbox.pdmodel.common.PDMetadata;
import org.apache.pdfbox.pdmodel.common.PDNumberTreeNode;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkInfo;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDParentTreeValue;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
import org.apache.pdfbox.pdmodel.interactive.viewerpreferences.PDViewerPreferences;

/**
 * Content stream rewriter for native PDF tagging.
 *
 * Takes a source PDF and a tag plan JSON (from NativeTagMatcher), then rewrites
 * each page's content stream to inject BDC/MCID/EMC marked-content sequences
 * around the original operators. Builds a proper structure tree with parent tree
 * so the output is a natively-tagged PDF.
 *
 * Unlike PdfTagWriterCli (which rasterizes pages and overlays invisible text),
 * this rewriter preserves the original content stream operators, keeping text
 * selectable and searchable while adding accessibility structure.
 */
public class NativeContentStreamRewriter {

    private static final String DOCUMENT_AUTHOR = "PDF Accessibility Engine";

    // Text-rendering operators that increment the sequence index
    private static final Set<String> TEXT_OPS = new HashSet<>();
    static {
        TEXT_OPS.add("Tj");
        TEXT_OPS.add("TJ");
        TEXT_OPS.add("'");
        TEXT_OPS.add("\"");
    }

    // ---------------------------------------------------------------
    //  Minimal JSON tokeniser (same approach as NativeTagMatcher)
    // ---------------------------------------------------------------

    private static final int TOK_LBRACE = 1;
    private static final int TOK_RBRACE = 2;
    private static final int TOK_LBRACKET = 3;
    private static final int TOK_RBRACKET = 4;
    private static final int TOK_COLON = 5;
    private static final int TOK_COMMA = 6;
    private static final int TOK_STRING = 7;
    private static final int TOK_NUMBER = 8;
    private static final int TOK_TRUE = 9;
    private static final int TOK_FALSE = 10;
    private static final int TOK_NULL = 11;
    private static final int TOK_EOF = 12;

    private static class JsonLexer {
        private final String src;
        private int pos;
        int tokenType;
        String tokenValue;

        JsonLexer(String src) { this.src = src; this.pos = 0; }

        void next() {
            skipWhitespace();
            if (pos >= src.length()) { tokenType = TOK_EOF; tokenValue = null; return; }
            char c = src.charAt(pos);
            switch (c) {
                case '{': tokenType = TOK_LBRACE; tokenValue = "{"; pos++; return;
                case '}': tokenType = TOK_RBRACE; tokenValue = "}"; pos++; return;
                case '[': tokenType = TOK_LBRACKET; tokenValue = "["; pos++; return;
                case ']': tokenType = TOK_RBRACKET; tokenValue = "]"; pos++; return;
                case ':': tokenType = TOK_COLON; tokenValue = ":"; pos++; return;
                case ',': tokenType = TOK_COMMA; tokenValue = ","; pos++; return;
                case '"': readString(); return;
                case 't': expect("true"); tokenType = TOK_TRUE; tokenValue = "true"; return;
                case 'f': expect("false"); tokenType = TOK_FALSE; tokenValue = "false"; return;
                case 'n': expect("null"); tokenType = TOK_NULL; tokenValue = "null"; return;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) { readNumber(); return; }
                    throw new RuntimeException("Unexpected char '" + c + "' at pos " + pos);
            }
        }

        private void skipWhitespace() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++; else break;
            }
        }

        private void readString() {
            pos++;
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') { tokenType = TOK_STRING; tokenValue = sb.toString(); return; }
                if (c == '\\') {
                    if (pos >= src.length()) break;
                    char esc = src.charAt(pos++);
                    switch (esc) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'u':
                            if (pos + 4 <= src.length()) {
                                sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
                                pos += 4;
                            }
                            break;
                        default: sb.append(esc);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new RuntimeException("Unterminated string");
        }

        private void readNumber() {
            int start = pos;
            if (pos < src.length() && src.charAt(pos) == '-') pos++;
            while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') pos++;
            if (pos < src.length() && src.charAt(pos) == '.') {
                pos++;
                while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') pos++;
            }
            if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
                pos++;
                if (pos < src.length() && (src.charAt(pos) == '+' || src.charAt(pos) == '-')) pos++;
                while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') pos++;
            }
            tokenType = TOK_NUMBER;
            tokenValue = src.substring(start, pos);
        }

        private void expect(String word) {
            for (int i = 0; i < word.length(); i++) {
                if (pos + i >= src.length() || src.charAt(pos + i) != word.charAt(i))
                    throw new RuntimeException("Expected '" + word + "' at pos " + pos);
            }
            pos += word.length();
        }
    }

    static Object parseJson(String src) {
        JsonLexer lex = new JsonLexer(src);
        lex.next();
        return parseValue(lex);
    }

    private static Object parseValue(JsonLexer lex) {
        switch (lex.tokenType) {
            case TOK_LBRACE: return parseObject(lex);
            case TOK_LBRACKET: return parseArray(lex);
            case TOK_STRING: { String v = lex.tokenValue; lex.next(); return v; }
            case TOK_NUMBER: { String v = lex.tokenValue; lex.next(); return Double.parseDouble(v); }
            case TOK_TRUE: lex.next(); return Boolean.TRUE;
            case TOK_FALSE: lex.next(); return Boolean.FALSE;
            case TOK_NULL: lex.next(); return null;
            default: throw new RuntimeException("Unexpected token type " + lex.tokenType);
        }
    }

    private static Map<String, Object> parseObject(JsonLexer lex) {
        Map<String, Object> map = new LinkedHashMap<>();
        lex.next();
        if (lex.tokenType == TOK_RBRACE) { lex.next(); return map; }
        while (true) {
            if (lex.tokenType != TOK_STRING) throw new RuntimeException("Expected string key");
            String key = lex.tokenValue;
            lex.next();
            if (lex.tokenType != TOK_COLON) throw new RuntimeException("Expected ':'");
            lex.next();
            map.put(key, parseValue(lex));
            if (lex.tokenType == TOK_COMMA) { lex.next(); continue; }
            if (lex.tokenType == TOK_RBRACE) { lex.next(); return map; }
            throw new RuntimeException("Expected ',' or '}' in object");
        }
    }

    private static List<Object> parseArray(JsonLexer lex) {
        List<Object> list = new ArrayList<>();
        lex.next();
        if (lex.tokenType == TOK_RBRACKET) { lex.next(); return list; }
        while (true) {
            list.add(parseValue(lex));
            if (lex.tokenType == TOK_COMMA) { lex.next(); continue; }
            if (lex.tokenType == TOK_RBRACKET) { lex.next(); return list; }
            throw new RuntimeException("Expected ',' or ']' in array");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o) { return (Map<String, Object>) o; }
    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object o) { return o == null ? new ArrayList<>() : (List<Object>) o; }
    private static String asString(Object o) { return o == null ? "" : o.toString(); }
    private static int asInt(Object o) {
        if (o instanceof Number) return ((Number) o).intValue();
        if (o instanceof String) try { return Integer.parseInt((String) o); } catch (NumberFormatException e) { return 0; }
        return 0;
    }
    private static double asDouble(Object o) {
        if (o instanceof Number) return ((Number) o).doubleValue();
        if (o instanceof String) try { return Double.parseDouble((String) o); } catch (NumberFormatException e) { return 0; }
        return 0;
    }

    // ---------------------------------------------------------------
    //  Tag plan data structures
    // ---------------------------------------------------------------

    /** A single operator reference inside an assignment */
    private static class OpRef {
        int seq;
    }

    /** An assignment: a tag node mapped to a set of operators with a given MCID */
    private static class Assignment {
        String tagNodeId;
        String tagType;
        int mcid;
        List<OpRef> operators = new ArrayList<>();
        double matchConfidence;
    }

    /** Per-page plan from the tag plan JSON */
    private static class PagePlan {
        int pageNumber;
        List<Assignment> assignments = new ArrayList<>();
        List<Integer> unmatchedOperatorSeqs = new ArrayList<>();
    }

    // ---------------------------------------------------------------
    //  Tag plan parsing
    // ---------------------------------------------------------------

    private static List<PagePlan> parseTagPlan(String jsonStr) {
        Map<String, Object> root = asMap(parseJson(jsonStr));
        List<Object> pages = asList(root.get("pages"));
        List<PagePlan> plans = new ArrayList<>();

        for (Object pageObj : pages) {
            Map<String, Object> pm = asMap(pageObj);
            PagePlan pp = new PagePlan();
            pp.pageNumber = asInt(pm.get("pageNumber"));

            List<Object> assignments = asList(pm.get("assignments"));
            for (Object aObj : assignments) {
                Map<String, Object> am = asMap(aObj);
                Assignment a = new Assignment();
                a.tagNodeId = asString(am.get("tagNodeId"));
                a.tagType = asString(am.get("tagType"));
                a.mcid = asInt(am.get("mcid"));
                a.matchConfidence = am.containsKey("matchConfidence") ? asDouble(am.get("matchConfidence")) : 1.0;

                List<Object> ops = asList(am.get("operators"));
                for (Object opObj : ops) {
                    Map<String, Object> om = asMap(opObj);
                    OpRef ref = new OpRef();
                    ref.seq = asInt(om.get("seq"));
                    a.operators.add(ref);
                }
                pp.assignments.add(a);
            }

            // Parse unmatched operators (just need their seq values)
            List<Object> unmatched = asList(pm.get("unmatchedOperators"));
            for (Object uObj : unmatched) {
                Map<String, Object> um = asMap(uObj);
                pp.unmatchedOperatorSeqs.add(asInt(um.get("seq")));
            }

            plans.add(pp);
        }
        return plans;
    }

    // ---------------------------------------------------------------
    //  Content stream rewriting
    // ---------------------------------------------------------------

    /**
     * Rewrite a page's content stream by injecting BDC/EMC around operators
     * identified in the tag plan assignments.
     *
     * Strategy:
     *  - Parse all tokens from the existing content stream
     *  - Walk through tokens, tracking a text-operator sequence index
     *  - Before the first operator of an MCID group: inject /TagType <</MCID n>> BDC
     *  - After the last operator of an MCID group: inject EMC
     *  - Unmatched text operators get wrapped as /Artifact BMC ... EMC
     *  - Non-text operators pass through untouched
     */
    private static void rewritePageContentStream(PDDocument doc, PDPage page, PagePlan plan) throws IOException {
        // Build lookup: seq -> assignment (for first/last detection)
        // and seq -> which assignment it belongs to
        Map<Integer, Assignment> seqToAssignment = new HashMap<>();
        Map<Integer, Boolean> seqIsFirst = new HashMap<>();
        Map<Integer, Boolean> seqIsLast = new HashMap<>();
        Set<Integer> unmatchedSeqs = new HashSet<>(plan.unmatchedOperatorSeqs);

        for (Assignment a : plan.assignments) {
            if (a.operators.isEmpty()) continue;
            for (OpRef ref : a.operators) {
                seqToAssignment.put(ref.seq, a);
            }
            seqIsFirst.put(a.operators.get(0).seq, true);
            seqIsLast.put(a.operators.get(a.operators.size() - 1).seq, true);
        }

        // Parse the existing content stream
        PDFStreamParser parser = new PDFStreamParser(page);
        List<Object> tokens = parser.parse();

        // Build the new token list
        List<Object> newTokens = new ArrayList<>();
        int textOpSeq = 0;
        boolean inArtifact = false;

        // Walk through tokens. We need to identify operator+operands groups.
        // PDFStreamParser returns a flat list where operands precede the operator.
        // We collect operands until we hit an Operator.
        List<COSBase> pendingOperands = new ArrayList<>();

        for (Object token : tokens) {
            if (token instanceof Operator) {
                Operator op = (Operator) token;
                String opName = op.getName();

                if (TEXT_OPS.contains(opName)) {
                    int currentSeq = textOpSeq;
                    textOpSeq++;

                    Assignment assignment = seqToAssignment.get(currentSeq);

                    if (assignment != null) {
                        // This operator belongs to a tagged assignment
                        if (inArtifact) {
                            // Close any open artifact wrapper
                            newTokens.add(Operator.getOperator("EMC"));
                            inArtifact = false;
                        }

                        if (seqIsFirst.containsKey(currentSeq)) {
                            // Inject BDC: /TagType <</MCID n>> BDC
                            COSDictionary props = new COSDictionary();
                            props.setInt(COSName.MCID, assignment.mcid);
                            newTokens.add(COSName.getPDFName(assignment.tagType));
                            newTokens.add(props);
                            newTokens.add(Operator.getOperator("BDC"));
                        }

                        // Write the operands and operator
                        newTokens.addAll(pendingOperands);
                        newTokens.add(op);

                        if (seqIsLast.containsKey(currentSeq)) {
                            // Inject EMC
                            newTokens.add(Operator.getOperator("EMC"));
                        }
                    } else if (unmatchedSeqs.contains(currentSeq)) {
                        // Unmatched text operator - wrap as Artifact
                        if (!inArtifact) {
                            newTokens.add(COSName.ARTIFACT);
                            newTokens.add(Operator.getOperator("BMC"));
                            inArtifact = true;
                        }
                        newTokens.addAll(pendingOperands);
                        newTokens.add(op);
                    } else {
                        // Text operator not in any assignment or unmatched list
                        // Wrap as Artifact to be safe
                        if (!inArtifact) {
                            newTokens.add(COSName.ARTIFACT);
                            newTokens.add(Operator.getOperator("BMC"));
                            inArtifact = true;
                        }
                        newTokens.addAll(pendingOperands);
                        newTokens.add(op);
                    }
                } else {
                    // Non-text operator: just pass through
                    // But if we're transitioning between groups, handle artifact state
                    newTokens.addAll(pendingOperands);
                    newTokens.add(op);
                }

                pendingOperands.clear();
            } else if (token instanceof COSBase) {
                pendingOperands.add((COSBase) token);
            }
        }

        // Close any trailing artifact
        if (inArtifact) {
            newTokens.add(Operator.getOperator("EMC"));
            inArtifact = false;
        }

        // Flush any remaining operands (shouldn't happen in valid PDF)
        newTokens.addAll(pendingOperands);

        // Write the new content stream
        PDStream newStream = new PDStream(doc);
        try (OutputStream out = newStream.createOutputStream()) {
            ContentStreamSerializer.writeTokens(out, newTokens);
        }
        page.setContents(newStream);
    }

    // ---------------------------------------------------------------
    //  Content stream serialization (manual, since PDFBox 3.x
    //  ContentStreamWriter is not always accessible)
    // ---------------------------------------------------------------

    /**
     * Writes a list of content stream tokens (COSBase operands + Operator objects)
     * to an output stream in valid PDF content stream syntax.
     */
    private static class ContentStreamSerializer {

        static void writeTokens(OutputStream out, List<Object> tokens) throws IOException {
            boolean needsSpace = false;
            for (Object token : tokens) {
                if (token instanceof Operator) {
                    Operator op = (Operator) token;
                    if (needsSpace) out.write(' ');
                    out.write(op.getName().getBytes(StandardCharsets.US_ASCII));
                    out.write('\n');
                    needsSpace = false;
                } else if (token instanceof COSBase) {
                    if (needsSpace) out.write(' ');
                    writeCOSBase(out, (COSBase) token);
                    needsSpace = true;
                }
            }
        }

        static void writeCOSBase(OutputStream out, COSBase obj) throws IOException {
            if (obj instanceof COSName) {
                COSName name = (COSName) obj;
                out.write('/');
                out.write(name.getName().getBytes(StandardCharsets.US_ASCII));
            } else if (obj instanceof COSInteger) {
                out.write(String.valueOf(((COSInteger) obj).intValue()).getBytes(StandardCharsets.US_ASCII));
            } else if (obj instanceof COSFloat) {
                // Use a formatting that avoids unnecessary trailing zeros
                float val = ((COSFloat) obj).floatValue();
                String s;
                if (val == Math.floor(val) && !Float.isInfinite(val)) {
                    s = String.valueOf((int) val);
                } else {
                    s = String.valueOf(val);
                }
                out.write(s.getBytes(StandardCharsets.US_ASCII));
            } else if (obj instanceof COSString) {
                COSString str = (COSString) obj;
                byte[] bytes = str.getBytes();
                // Write as hex string to avoid escaping issues
                out.write('<');
                for (byte b : bytes) {
                    out.write(String.format("%02X", b & 0xFF).getBytes(StandardCharsets.US_ASCII));
                }
                out.write('>');
            } else if (obj instanceof COSArray) {
                COSArray arr = (COSArray) obj;
                out.write('[');
                for (int i = 0; i < arr.size(); i++) {
                    if (i > 0) out.write(' ');
                    writeCOSBase(out, arr.get(i));
                }
                out.write(']');
            } else if (obj instanceof COSDictionary) {
                COSDictionary dict = (COSDictionary) obj;
                out.write('<');
                out.write('<');
                for (COSName key : dict.keySet()) {
                    out.write(' ');
                    out.write('/');
                    out.write(key.getName().getBytes(StandardCharsets.US_ASCII));
                    out.write(' ');
                    writeCOSBase(out, dict.getItem(key));
                }
                out.write(' ');
                out.write('>');
                out.write('>');
            } else if (obj instanceof COSNull) {
                out.write("null".getBytes(StandardCharsets.US_ASCII));
            } else {
                // Fallback: try toString
                out.write(obj.toString().getBytes(StandardCharsets.US_ASCII));
            }
        }
    }

    // ---------------------------------------------------------------
    //  Structure tree building
    // ---------------------------------------------------------------

    /**
     * Build the PDF structure tree from the tag plan assignments.
     *
     * Creates a Document element as the root, with each assignment becoming
     * a structure element of the appropriate type, linked to the page and MCID.
     */
    private static void buildStructureTree(PDDocument doc, List<PagePlan> plans) {
        PDDocumentCatalog catalog = doc.getDocumentCatalog();

        PDStructureTreeRoot treeRoot = new PDStructureTreeRoot();
        catalog.setStructureTreeRoot(treeRoot);

        // Mark as tagged
        PDMarkInfo markInfo = new PDMarkInfo();
        markInfo.setMarked(true);
        catalog.setMarkInfo(markInfo);

        // Create Document element as root
        PDStructureElement docElement = new PDStructureElement("Document", treeRoot);
        treeRoot.appendKid(docElement);

        // Parent tree: maps (pageKey, mcid) -> structure element
        // We use one parent tree entry per page
        Map<Integer, COSArray> parentArraysByPageKey = new LinkedHashMap<>();
        int nextPageKey = 0;

        for (PagePlan plan : plans) {
            int pageIndex = plan.pageNumber - 1;
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) continue;

            PDPage page = doc.getPage(pageIndex);

            // Assign StructParents to the page
            int pageKey = nextPageKey++;
            page.setStructParents(pageKey);

            // Set Tabs order to structure
            page.getCOSObject().setItem(COSName.getPDFName("Tabs"), COSName.S);

            COSArray parentArray = new COSArray();
            parentArraysByPageKey.put(pageKey, parentArray);

            for (Assignment assignment : plan.assignments) {
                // Create structure element
                PDStructureElement element = new PDStructureElement(assignment.tagType, docElement);
                docElement.appendKid(element);

                // Link to page and MCID
                element.setPage(page);
                element.appendKid(assignment.mcid);

                // Add to parent array at the MCID index
                while (parentArray.size() <= assignment.mcid) {
                    parentArray.add(COSNull.NULL);
                }
                parentArray.set(assignment.mcid, element.getCOSObject());
            }
        }

        // Build the parent tree
        PDNumberTreeNode parentTree = new PDNumberTreeNode(PDParentTreeValue.class);
        Map<Integer, COSObjectable> numbers = new TreeMap<>();
        for (Map.Entry<Integer, COSArray> entry : parentArraysByPageKey.entrySet()) {
            numbers.put(entry.getKey(), new PDParentTreeValue(entry.getValue()));
        }
        parentTree.setNumbers(numbers);
        treeRoot.setParentTree(parentTree);
        treeRoot.setParentTreeNextKey(nextPageKey);
    }

    // ---------------------------------------------------------------
    //  Metadata
    // ---------------------------------------------------------------

    private static void applyMetadata(PDDocument doc, String title, String language) throws IOException {
        doc.setVersion(1.7f);
        PDDocumentCatalog catalog = doc.getDocumentCatalog();

        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        cal.setTimeInMillis(now.toEpochMilli());

        PDDocumentInformation info = doc.getDocumentInformation();
        info.setTitle(title);
        info.setAuthor(DOCUMENT_AUTHOR);
        info.setCreator(DOCUMENT_AUTHOR);
        info.setProducer(DOCUMENT_AUTHOR);
        info.setCreationDate((Calendar) cal.clone());
        info.setModificationDate((Calendar) cal.clone());

        catalog.setLanguage(language);

        PDViewerPreferences viewerPrefs = catalog.getViewerPreferences();
        if (viewerPrefs == null) {
            viewerPrefs = new PDViewerPreferences();
        }
        viewerPrefs.setDisplayDocTitle(true);
        catalog.setViewerPreferences(viewerPrefs);

        // XMP metadata for PDF/UA
        PDMetadata metadata = new PDMetadata(doc);
        metadata.importXMPMetadata(buildXmp(title, language, now).getBytes(StandardCharsets.UTF_8));
        catalog.setMetadata(metadata);
    }

    private static String buildXmp(String title, String language, Instant timestamp) {
        String ts = timestamp.toString();
        String et = escapeXml(title);
        String el = escapeXml(language);
        String ea = escapeXml(DOCUMENT_AUTHOR);
        StringBuilder x = new StringBuilder();
        x.append("<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n");
        x.append("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"PDF Accessibility Engine\">\n");
        x.append("  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n");
        x.append("    <rdf:Description rdf:about=\"\"\n");
        x.append("      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n");
        x.append("      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n");
        x.append("      xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\"\n");
        x.append("      xmlns:pdfuaid=\"http://www.aiim.org/pdfua/ns/id/\"\n");
        x.append("      xmlns:pdfaExtension=\"http://www.aiim.org/pdfa/ns/extension/\"\n");
        x.append("      xmlns:pdfaSchema=\"http://www.aiim.org/pdfa/ns/schema#\"\n");
        x.append("      xmlns:pdfaProperty=\"http://www.aiim.org/pdfa/ns/property#\">\n");
        x.append("      <dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">").append(et).append("</rdf:li></rdf:Alt></dc:title>\n");
        x.append("      <dc:creator><rdf:Seq><rdf:li>").append(ea).append("</rdf:li></rdf:Seq></dc:creator>\n");
        x.append("      <dc:language><rdf:Bag><rdf:li>").append(el).append("</rdf:li></rdf:Bag></dc:language>\n");
        x.append("      <xmp:CreatorTool>PDF Accessibility Engine</xmp:CreatorTool>\n");
        x.append("      <xmp:CreateDate>").append(ts).append("</xmp:CreateDate>\n");
        x.append("      <xmp:ModifyDate>").append(ts).append("</xmp:ModifyDate>\n");
        x.append("      <pdf:Producer>").append(ea).append("</pdf:Producer>\n");
        x.append("      <pdfuaid:part>1</pdfuaid:part>\n");
        x.append("    </rdf:Description>\n");
        x.append("  </rdf:RDF>\n");
        x.append("</x:xmpmeta>\n");
        x.append("<?xpacket end=\"w\"?>");
        return x.toString();
    }

    private static String escapeXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }

    // ---------------------------------------------------------------
    //  File I/O
    // ---------------------------------------------------------------

    private static String readFile(String path) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new FileReader(path, StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = reader.read(buf)) != -1) sb.append(buf, 0, n);
        }
        return sb.toString();
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

    // ---------------------------------------------------------------
    //  CLI entry point
    // ---------------------------------------------------------------

    public static void main(String[] args) throws Exception {
        String pdfPath = null;
        String planPath = null;
        String outputPath = null;
        String title = "Tagged PDF";
        String language = "en-US";

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--pdf":
                    if (i + 1 < args.length) pdfPath = args[++i];
                    break;
                case "--plan":
                    if (i + 1 < args.length) planPath = args[++i];
                    break;
                case "--output":
                    if (i + 1 < args.length) outputPath = args[++i];
                    break;
                case "--title":
                    if (i + 1 < args.length) title = args[++i];
                    break;
                case "--language":
                    if (i + 1 < args.length) language = args[++i];
                    break;
            }
        }

        if (pdfPath == null || planPath == null || outputPath == null) {
            System.err.println("Usage: java NativeContentStreamRewriter --pdf <source.pdf> --plan <tag-plan.json> --output <tagged.pdf> [--title <title>] [--language <lang>]");
            System.exit(1);
        }

        System.err.println("[rewriter] Loading source PDF: " + pdfPath);
        System.err.println("[rewriter] Loading tag plan: " + planPath);

        // Parse the tag plan
        String planJson = readFile(planPath);
        List<PagePlan> plans = parseTagPlan(planJson);

        System.err.println("[rewriter] Tag plan has " + plans.size() + " page(s)");

        // Load and modify the PDF
        try (PDDocument doc = Loader.loadPDF(new File(pdfPath))) {
            int totalAssignments = 0;
            int totalMcids = 0;
            int totalArtifacts = 0;

            // Rewrite content streams for each page in the plan
            for (PagePlan plan : plans) {
                int pageIndex = plan.pageNumber - 1;
                if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                    System.err.println("[rewriter] WARNING: page " + plan.pageNumber + " out of range, skipping");
                    continue;
                }

                PDPage page = doc.getPage(pageIndex);
                System.err.println("[rewriter] Rewriting page " + plan.pageNumber
                        + " (" + plan.assignments.size() + " assignments, "
                        + plan.unmatchedOperatorSeqs.size() + " unmatched ops)");

                rewritePageContentStream(doc, page, plan);
                totalAssignments += plan.assignments.size();
                for (Assignment a : plan.assignments) {
                    totalMcids++;
                }
                totalArtifacts += plan.unmatchedOperatorSeqs.size();
            }

            // Build structure tree
            buildStructureTree(doc, plans);

            // Apply metadata
            applyMetadata(doc, title, language);

            // Save
            doc.save(outputPath);
            System.err.println("[rewriter] Saved tagged PDF to: " + outputPath);

            // Output result JSON to stdout
            StringBuilder json = new StringBuilder();
            json.append("{");
            json.append("\"success\":true");
            json.append(",\"outputPath\":").append(escapeJson(outputPath));
            json.append(",\"pagesRewritten\":").append(plans.size());
            json.append(",\"totalAssignments\":").append(totalAssignments);
            json.append(",\"totalMcids\":").append(totalMcids);
            json.append(",\"totalArtifactWraps\":").append(totalArtifacts);
            json.append(",\"structureTreeBuilt\":true");
            json.append(",\"metadataApplied\":true");
            json.append(",\"title\":").append(escapeJson(title));
            json.append(",\"language\":").append(escapeJson(language));
            json.append("}");
            System.out.println(json.toString());
        }
    }
}
