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
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.TreeSet;
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
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkInfo;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkedContentReference;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDObjectReference;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDParentTreeValue;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationLink;
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

    // Visible graphics/image paint operators. These do not carry text MCIDs,
    // but Acrobat still expects them to be tagged or artifacted.
    private static final Set<String> PAINT_OPS = new HashSet<>();
    static {
        PAINT_OPS.add("S");
        PAINT_OPS.add("s");
        PAINT_OPS.add("f");
        PAINT_OPS.add("F");
        PAINT_OPS.add("f*");
        PAINT_OPS.add("B");
        PAINT_OPS.add("B*");
        PAINT_OPS.add("b");
        PAINT_OPS.add("b*");
        PAINT_OPS.add("Do");
        PAINT_OPS.add("sh");
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
        int opIndexInStream;
        double x;
        double y;
        String text;
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
        List<Integer> unmatchedOperatorIndices = new ArrayList<>();
    }

    /**
     * Hierarchical tag tree node from tagging.json. The tag-builder
     * produces a semantically-nested tree (Document > Sect > H1 + Table
     * > TR > TD, etc.) — we preserve that nesting in the output
     * PDStructureTreeRoot so assistive tech and PDF/UA validators see
     * the intended structure. The legacy flat-build path remains as a
     * fallback when --tags is not supplied, but every stage-plan
     * invocation passes it now.
     */
    private static class TagTreeNode {
        String id;
        String type;
        List<TagTreeNode> children = new ArrayList<>();
        String lang;
        String alt;
        String actualText;
        String footnoteGroupId;
        String headerId;
        String scope;
        int rowSpan = 1;
        int columnSpan = 1;
        List<String> tableHeaders = new ArrayList<>();
    }

    private static TagTreeNode parseTaggingTree(String jsonStr) {
        Map<String, Object> doc = asMap(parseJson(jsonStr));
        Object root = doc.get("root");
        if (root == null) return null;
        return parseTagNode(root);
    }

    private static TagTreeNode parseTagNode(Object o) {
        Map<String, Object> m = asMap(o);
        TagTreeNode n = new TagTreeNode();
        n.id = asString(m.get("id"));
        // tag-builder uses "type" for the PDF tag role; sourceNode.role
        // is the semantic role. Prefer "type" when present.
        Object type = m.get("type");
        if (type == null) type = m.get("role");
        n.type = asString(type);
        if (n.type == null || n.type.isEmpty()) n.type = "NonStruct";
        Object lang = m.get("lang");
        if (lang != null) n.lang = asString(lang);
        Object alt = m.get("alt");
        if (alt != null) n.alt = asString(alt);
        Object actualText = m.get("actualText");
        if (actualText != null) n.actualText = asString(actualText);
        Object footnoteGroupId = m.get("footnoteGroupId");
        if (footnoteGroupId != null) n.footnoteGroupId = asString(footnoteGroupId);
        Object headerId = m.get("headerId");
        if (headerId != null) n.headerId = nonEmptyString(headerId);
        Object scope = m.get("scope");
        if (scope != null) n.scope = normalizeScopeName(asString(scope));
        Object rowSpan = m.get("rowSpan");
        if (rowSpan != null) n.rowSpan = positiveInt(rowSpan, n.rowSpan);
        Object columnSpan = m.get("columnSpan");
        if (columnSpan != null) n.columnSpan = positiveInt(columnSpan, n.columnSpan);
        collectStringList(m.get("headers"), n.tableHeaders);
        collectStringList(m.get("tableHeaders"), n.tableHeaders);
        Object tableAttrsObj = m.get("tableAttrs");
        if (tableAttrsObj instanceof Map) {
            Map<String, Object> tableAttrs = asMap(tableAttrsObj);
            n.rowSpan = positiveInt(firstPresent(tableAttrs, "RowSpan", "rowSpan"), n.rowSpan);
            n.columnSpan = positiveInt(firstPresent(tableAttrs, "ColSpan", "columnSpan"), n.columnSpan);
            Object attrScope = firstPresent(tableAttrs, "Scope", "scope");
            if ((n.scope == null || n.scope.isEmpty()) && attrScope != null) n.scope = normalizeScopeName(asString(attrScope));
            collectStringList(firstPresent(tableAttrs, "Headers", "headers"), n.tableHeaders);
        }
        List<Object> children = asList(m.get("children"));
        for (Object c : children) n.children.add(parseTagNode(c));
        return n;
    }

    private static Object firstPresent(Map<String, Object> values, String... keys) {
        for (String key : keys) {
            if (values.containsKey(key)) return values.get(key);
        }
        return null;
    }

    private static int positiveInt(Object o, int fallback) {
        int parsed = asInt(o);
        return parsed > 0 ? parsed : fallback;
    }

    private static String nonEmptyString(Object o) {
        String value = asString(o).trim();
        return value.isEmpty() ? null : value;
    }

    private static void collectStringList(Object raw, List<String> out) {
        if (raw == null) return;
        if (raw instanceof List) {
            for (Object item : asList(raw)) {
                String value = nonEmptyString(item);
                if (value != null && !out.contains(value)) out.add(value);
            }
            return;
        }
        String value = nonEmptyString(raw);
        if (value != null && !out.contains(value)) out.add(value);
    }

    private static String normalizeScopeName(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        if ("column".equals(value) || "col".equals(value)) return "Column";
        if ("row".equals(value)) return "Row";
        if ("both".equals(value)) return "Both";
        return "";
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
                    ref.opIndexInStream = om.containsKey("opIndexInStream") ? asInt(om.get("opIndexInStream")) : ref.seq;
                    ref.x = om.containsKey("x") ? asDouble(om.get("x")) : Double.NaN;
                    ref.y = om.containsKey("y") ? asDouble(om.get("y")) : Double.NaN;
                    ref.text = asString(om.get("text"));
                    a.operators.add(ref);
                }
                pp.assignments.add(a);
            }

            // Parse unmatched operators (just need their seq values)
            List<Object> unmatched = asList(pm.get("unmatchedOperators"));
            for (Object uObj : unmatched) {
                Map<String, Object> um = asMap(uObj);
                pp.unmatchedOperatorSeqs.add(asInt(um.get("seq")));
                pp.unmatchedOperatorIndices.add(um.containsKey("opIndexInStream") ? asInt(um.get("opIndexInStream")) : asInt(um.get("seq")));
            }

            plans.add(pp);
        }
        return plans;
    }

    private static int splitAssignmentsIntoMarkedRuns(PagePlan plan, Set<Integer> barrierOperatorIndices) {
        int addedRuns = 0;
        TreeSet<Integer> barriers = new TreeSet<>(barrierOperatorIndices);

        int nextMcid = 0;
        for (Assignment assignment : plan.assignments) {
            nextMcid = Math.max(nextMcid, assignment.mcid + 1);
        }

        List<Assignment> expanded = new ArrayList<>();
        for (Assignment assignment : plan.assignments) {
            if (assignment.operators.size() <= 1) {
                expanded.add(assignment);
                continue;
            }

            List<List<OpRef>> runs = new ArrayList<>();
            List<OpRef> currentRun = new ArrayList<>();
            OpRef previous = null;
            for (OpRef ref : assignment.operators) {
                if (previous != null && hasBarrierBetween(previous, ref, barriers)) {
                    runs.add(currentRun);
                    currentRun = new ArrayList<>();
                }
                currentRun.add(ref);
                previous = ref;
            }
            if (!currentRun.isEmpty()) {
                runs.add(currentRun);
            }

            if (runs.size() <= 1) {
                expanded.add(assignment);
                continue;
            }

            for (int runIndex = 0; runIndex < runs.size(); runIndex++) {
                Assignment split = new Assignment();
                split.tagNodeId = assignment.tagNodeId;
                split.tagType = assignment.tagType;
                split.matchConfidence = assignment.matchConfidence;
                split.mcid = runIndex == 0 ? assignment.mcid : nextMcid++;
                split.operators.addAll(runs.get(runIndex));
                expanded.add(split);
            }
            addedRuns += runs.size() - 1;
        }

        plan.assignments = expanded;
        return addedRuns;
    }

    private static boolean hasBarrierBetween(OpRef previous, OpRef next, TreeSet<Integer> barriers) {
        int low = Math.min(previous.opIndexInStream, next.opIndexInStream);
        int high = Math.max(previous.opIndexInStream, next.opIndexInStream);
        if (high - low <= 1) return false;
        return barriers.ceiling(low + 1) != null && barriers.ceiling(low + 1) < high;
    }

    private static Set<Integer> collectBarrierOperatorIndices(PDPage page, PagePlan plan) throws IOException {
        Set<Integer> barriers = new HashSet<>(plan.unmatchedOperatorIndices);
        PDFStreamParser parser = new PDFStreamParser(page);
        List<Object> tokens = parser.parse();
        int operatorIndex = 0;

        for (Object token : tokens) {
            if (token instanceof Operator) {
                Operator op = (Operator) token;
                if (PAINT_OPS.contains(op.getName())) {
                    barriers.add(operatorIndex);
                }
                operatorIndex++;
            }
        }

        return barriers;
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
     *  - Visible non-text paint operators outside tagged content are artifacted
     */
    /** Result of rewriting one content stream; surfaced in the final report. */
    private static class RewriteResult {
        int taggedWrapped;
        int artifactWrapped;
        int skippedInsideSourceMarkedContent;
    }

    private static RewriteResult rewritePageContentStream(PDDocument doc, PDPage page, PagePlan plan) throws IOException {
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

        PDFStreamParser parser = new PDFStreamParser(page);
        List<Object> tokens = parser.parse();

        List<Object> newTokens = new ArrayList<>();
        int textOpSeq = 0;
        boolean inArtifact = false;
        // LIFO stack of MCIDs whose BDC we've emitted but not yet
        // closed with a matching EMC. Needed because a tagged group's
        // seqIsLast op can fall inside a source marked-content block
        // (where we intentionally skip emission) — without the stack
        // we'd never close the BDC and the page would ship with
        // unbalanced marked-content. See PDF 32000-1 §14.6 for the
        // LIFO requirement on nested marked-content.
        java.util.Deque<Integer> openMcidStack = new java.util.ArrayDeque<>();
        // Depth of pre-existing marked-content (BMC/BDC) in the source stream.
        // When > 0 we are inside a source-owned marker; our own BDC wrappers
        // would produce invalid nesting, so we leave those operators alone.
        int sourceMCDepth = 0;

        List<COSBase> pendingOperands = new ArrayList<>();
        RewriteResult result = new RewriteResult();

        for (Object token : tokens) {
            if (token instanceof Operator) {
                Operator op = (Operator) token;
                String opName = op.getName();

                // STRIP source marked-content markers entirely. Keeping
                // them causes MCID collisions with OUR matcher-assigned
                // MCIDs — the source's numbering is independent from
                // ours. When the source /Article <</MCID 0>> BDC ... EMC
                // wraps zero text, and our matcher assigns MCID 0 to a
                // real text run elsewhere, Adobe resolves the struct
                // leaf to the EMPTY source wrapper → "blank tag".
                // Dropping source MC removes that ambiguity; our
                // struct tree is owned end-to-end by our pipeline.
                if ("BMC".equals(opName) || "BDC".equals(opName) || "EMC".equals(opName)) {
                    if ("EMC".equals(opName) && inArtifact) {
                        // Stray EMC: if it's our own artifact close,
                        // honor it. But this only happens if a source
                        // EMC precedes our own artifact close — unusual.
                        newTokens.add(op);
                        inArtifact = false;
                    }
                    // Otherwise drop the source marker. Don't emit the
                    // operator or its operands — the visible rendering
                    // is identical since BMC/BDC/EMC are metadata-only.
                    pendingOperands.clear();
                    continue;
                }

                if (TEXT_OPS.contains(opName)) {
                    int currentSeq = textOpSeq;
                    textOpSeq++;

                    Assignment assignment = seqToAssignment.get(currentSeq);

                    if (assignment != null) {
                        if (inArtifact) {
                            newTokens.add(Operator.getOperator("EMC"));
                            inArtifact = false;
                        }

                        if (seqIsFirst.containsKey(currentSeq)) {
                            COSDictionary props = new COSDictionary();
                            props.setInt(COSName.MCID, assignment.mcid);
                            newTokens.add(COSName.getPDFName(assignment.tagType));
                            newTokens.add(props);
                            newTokens.add(Operator.getOperator("BDC"));
                            openMcidStack.push(assignment.mcid);
                        }

                        newTokens.addAll(pendingOperands);
                        newTokens.add(op);

                        if (seqIsLast.containsKey(currentSeq)) {
                            // Close our BDC only if we actually opened one
                            // for this mcid.
                            if (openMcidStack.contains(assignment.mcid)) {
                                while (!openMcidStack.isEmpty()) {
                                    int top = openMcidStack.pop();
                                    newTokens.add(Operator.getOperator("EMC"));
                                    if (top == assignment.mcid) break;
                                }
                                result.taggedWrapped++;
                            }
                        }
                    } else {
                        // Unmatched or orphaned text op — wrap as /Artifact.
                        // Do NOT drain openMcidStack here: the next
                        // tagged op (continuation of the same group)
                        // would become orphaned from its BDC wrapper
                        // and Adobe would show a "blank tag" (struct
                        // leaf points to an MC region with no text).
                        // Artifact BMC nested inside our own BDC is
                        // legal per PDF 32000-1 §14.6.
                        if (!inArtifact) {
                            newTokens.add(COSName.ARTIFACT);
                            newTokens.add(Operator.getOperator("BMC"));
                            inArtifact = true;
                        }
                        newTokens.addAll(pendingOperands);
                        newTokens.add(op);
                        result.artifactWrapped++;
                    }
                } else if (PAINT_OPS.contains(opName) && openMcidStack.isEmpty()) {
                    // Decorative paths/images/charts are visible page content.
                    // Keep their graphics-state/path setup unchanged, but wrap
                    // the paint operator so Acrobat sees the content as an
                    // artifact instead of an untagged element.
                    if (!inArtifact) {
                        newTokens.add(COSName.ARTIFACT);
                        newTokens.add(Operator.getOperator("BMC"));
                        inArtifact = true;
                    }
                    newTokens.addAll(pendingOperands);
                    newTokens.add(op);
                    result.artifactWrapped++;
                } else {
                    // Any non-paint, non-MC operator: pass through unchanged.
                    newTokens.addAll(pendingOperands);
                    newTokens.add(op);
                }

                pendingOperands.clear();
            } else if (token instanceof COSBase) {
                pendingOperands.add((COSBase) token);
            }
            // Unknown token types (e.g., PDFBox's inline-image wrappers) are
            // intentionally dropped from the emitted stream only if they
            // aren't COSBase/Operator — but PDFStreamParser only emits those
            // two token classes in PDFBox 3.x, so this branch never fires.
        }

        if (inArtifact) {
            newTokens.add(Operator.getOperator("EMC"));
            inArtifact = false;
        }
        // Drain any remaining open tagged BDCs — the only reason they'd
        // still be open is seqIsLast fell inside a skipped source MC
        // block, or the stream ended before the group's last op.
        while (!openMcidStack.isEmpty()) {
            openMcidStack.pop();
            newTokens.add(Operator.getOperator("EMC"));
        }

        newTokens.addAll(pendingOperands);

        PDStream newStream = new PDStream(doc);
        try (OutputStream out = newStream.createOutputStream()) {
            ContentStreamSerializer.writeTokens(out, newTokens);
        }
        page.setContents(newStream);
        return result;
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
    /**
     * Hierarchical structure tree builder. Walks the tag-builder
     * tagging.json tree depth-first and produces a matching
     * PDStructureElement hierarchy (Document → Sect → H1, Table → TR
     * → TD, etc.). Leaf elements get PDMarkedContentReference kids —
     * one per matched assignment — so multi-page elements are
     * represented correctly with per-ref /Pg attributes.
     *
     * Behavior when a tag node has no matched assignments:
     *   - Non-leaf container (has tree children): still emitted so the
     *     hierarchy isn't truncated — its children carry MCIDs.
     *   - Leaf with zero assignments: skipped (nothing to reference).
     *
     * Fallback: when tagTree is null (caller didn't supply --tags) we
     * fall back to the flat build for backward compatibility.
     */
    private static void buildStructureTreeHierarchical(PDDocument doc, List<PagePlan> plans, TagTreeNode tagTree) {
        if (tagTree == null) {
            buildStructureTree(doc, plans);
            return;
        }

        PDDocumentCatalog catalog = doc.getDocumentCatalog();
        PDStructureTreeRoot treeRoot = new PDStructureTreeRoot();
        catalog.setStructureTreeRoot(treeRoot);

        PDMarkInfo markInfo = new PDMarkInfo();
        markInfo.setMarked(true);
        catalog.setMarkInfo(markInfo);

        // Index: tagNodeId -> ordered list of (page, mcid) refs. One
        // tag node can have assignments across multiple pages (e.g. a
        // paragraph that wraps across a page break).
        Map<String, List<PageMcRef>> refsByTag = new LinkedHashMap<>();
        Map<Integer, COSArray> parentArraysByPageKey = new LinkedHashMap<>();
        Map<PDPage, Double> pageDisplayHeight = new LinkedHashMap<>();
        // Link annotations, grouped by page. Each Link annot maps to
        // one Link StructElement that'll collect the MCIDs whose
        // position falls inside the annot rect. StructParent keys are
        // assigned after the page-level StructParents so every key is
        // unique within the /ParentTree.
        List<LinkAnnot> linkAnnots = new ArrayList<>();
        int nextPageKey = 0;

        for (PagePlan plan : plans) {
            int pageIndex = plan.pageNumber - 1;
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) continue;
            PDPage page = doc.getPage(pageIndex);
            int pageKey = nextPageKey++;
            page.setStructParents(pageKey);
            page.getCOSObject().setItem(COSName.getPDFName("Tabs"), COSName.S);

            PDRectangle cropBox = page.getCropBox();
            pageDisplayHeight.put(page, cropBox != null ? (double) cropBox.getHeight() : 792.0);

            // Link annotation wrapping is intentionally disabled in
            // the current cut. A proper implementation needs:
            //   1. Rotation-aware coordinate transform (annot rects
            //      are in UN-rotated user space, op positions are in
            //      rotated display space — they don't align on
            //      /Rotate 90|270 pages today).
            //   2. /ParentTree entries for annotations must be direct
            //      struct-element refs, not COSArrays wrapping them
            //      (ISO 32000-1 § 14.7.4.4). Our current PDNumberTreeNode
            //      plumbing treats every slot as a COSArray, which is
            //      correct for /StructParents on pages but wrong for
            //      /StructParent on annots.
            // Shipping the TH /Scope fix and the hierarchical structure
            // tree as the high-ROI improvements; link wrapping stays
            // queued for a follow-up when both gaps are resolved.

            COSArray parentArray = new COSArray();
            parentArraysByPageKey.put(pageKey, parentArray);

            for (Assignment a : plan.assignments) {
                // Use the centroid of the assignment's operators as
                // the representative position for annot-rect tests.
                // A single-operator assignment falls through cleanly;
                // multi-op assignments average out in both axes which
                // is the right behavior for a paragraph that spans a
                // link's rect — we want the link to "catch" the
                // assignment if the bulk of its text is inside.
                double sumX = 0, sumY = 0; int n = 0;
                for (OpRef op : a.operators) {
                    if (!Double.isNaN(op.x) && !Double.isNaN(op.y)) { sumX += op.x; sumY += op.y; n++; }
                }
                double cx = n > 0 ? sumX / n : Double.NaN;
                double cy = n > 0 ? sumY / n : Double.NaN;
                refsByTag.computeIfAbsent(a.tagNodeId, k -> new ArrayList<>())
                         .add(new PageMcRef(page, a.mcid, pageKey, cx, cy));
            }
        }

        // Walk tag tree and create structure elements. The tree's root
        // is the Document node the tag-builder emits. Ancestor context
        // threads through so element-specific attributes (e.g. TH
        // /Scope, List /ListNumbering, /RowSpan on merged cells) can
        // be derived from local tree position. Link annotations are
        // matched against operator positions during the walk so
        // link-covered MCIDs end up under a /Link StructElement.
        TreeContext rootContext = new TreeContext();
        PDStructureElement rootElement = buildStructureSubtree(treeRoot, tagTree, rootContext, refsByTag, parentArraysByPageKey, linkAnnots, pageDisplayHeight);
        if (rootElement != null) treeRoot.appendKid(rootElement);

        // Link annotation wrapping is disabled (see LinkAnnot
        // comment in the page-collection loop above). No post-walk
        // annotation bookkeeping to do.

        PDNumberTreeNode parentTree = new PDNumberTreeNode(PDParentTreeValue.class);
        Map<Integer, COSObjectable> numbers = new TreeMap<>();
        for (Map.Entry<Integer, COSArray> entry : parentArraysByPageKey.entrySet()) {
            numbers.put(entry.getKey(), new PDParentTreeValue(entry.getValue()));
        }
        parentTree.setNumbers(numbers);
        treeRoot.setParentTree(parentTree);
        treeRoot.setParentTreeNextKey(nextPageKey);
        ensureEngineRoleMap(treeRoot);
    }

    private static void ensureEngineRoleMap(PDStructureTreeRoot treeRoot) {
        if (treeRoot == null) return;

        COSDictionary rootDict = treeRoot.getCOSObject();
        COSBase roleMapBase = rootDict.getDictionaryObject(COSName.ROLE_MAP);
        COSDictionary roleMap;
        if (roleMapBase instanceof COSDictionary) {
            roleMap = (COSDictionary) roleMapBase;
        } else {
            roleMap = new COSDictionary();
            rootDict.setItem(COSName.ROLE_MAP, roleMap);
        }

        if (!roleMap.containsKey(COSName.getPDFName("Aside"))) {
            roleMap.setItem(COSName.getPDFName("Aside"), COSName.getPDFName("Note"));
        }
    }

    /**
     * Page-qualified marked-content reference for use while building
     * the hierarchical structure tree. Captures the PDF page, the
     * MCID, the /ParentTree key, and the operator's (x, y) position
     * so downstream passes (e.g. Link-annotation wrapping) can decide
     * whether the MCID falls inside a given page annotation rect.
     */
    private static class PageMcRef {
        final PDPage page;
        final int mcid;
        final int pageKey;
        final double opX;
        final double opY;
        PageMcRef(PDPage page, int mcid, int pageKey, double opX, double opY) {
            this.page = page; this.mcid = mcid; this.pageKey = pageKey; this.opX = opX; this.opY = opY;
        }
    }

    /**
     * Ancestor context threaded through the recursive walker. Small
     * set of booleans/counters the tree walker uses to derive
     * attributes that aren't carried on the tag-builder's nodes —
     * TH /Scope, heading-depth tracking for H1-H6 level fix-up,
     * inherited /Lang, etc. Only the bits we actually consume are
     * tracked; keep this tight.
     */
    private static class TreeContext {
        boolean insideTHead = false;
        String inheritedLang = null;  // /Lang from nearest ancestor
        int openHeadingLevel = 0;     // highest H# seen in this Sect

        TreeContext descend() {
            TreeContext c = new TreeContext();
            c.insideTHead = this.insideTHead;
            c.inheritedLang = this.inheritedLang;
            c.openHeadingLevel = this.openHeadingLevel;
            return c;
        }
    }

    /**
     * A link annotation and its page rectangle, used during structure
     * tree construction to wrap the MCIDs whose text falls inside the
     * link in a /Link StructElement with an /OBJR kid (Matterhorn
     * 28-004, PDF/UA-1 §7.18.5). Collected once per doc up front so
     * the recursive walker can cheap-intersect an operator position
     * against the set.
     */
    private static class LinkAnnot {
        final PDPage page;
        final PDAnnotationLink annot;
        final PDRectangle rect;
        final int structParent;
        int parentTreeKey = -1;
        PDStructureElement emittedElement = null;
        LinkAnnot(PDPage page, PDAnnotationLink annot, int structParent) {
            this.page = page;
            this.annot = annot;
            this.rect = annot.getRectangle();
            this.structParent = structParent;
        }

        /**
         * PDF annotation rects use bottom-origin y coordinates (like
         * raw PDF user space). Operator positions captured by our
         * parser are in top-origin display space (y=0 at page top,
         * coordinateOrigin="top"). Convert once per query using the
         * page's cropBox height.
         */
        boolean containsDisplay(double opX, double opY, double pageDisplayHeight) {
            if (rect == null) return false;
            double llx = rect.getLowerLeftX();
            double lly = rect.getLowerLeftY();
            double urx = rect.getUpperRightX();
            double ury = rect.getUpperRightY();
            // Flip op y into bottom-origin PDF space.
            double bottomY = pageDisplayHeight - opY;
            double pad = 1.0; // 1pt slack for anti-aliasing/rounding
            return opX >= llx - pad && opX <= urx + pad
                && bottomY >= lly - pad && bottomY <= ury + pad;
        }
    }

    private static void applyTableAttributes(PDStructureElement el, TagTreeNode node, TreeContext ctx) {
        boolean isTableCell = "TH".equals(node.type) || "TD".equals(node.type);
        if (!isTableCell) return;

        if ("TH".equals(node.type) && node.headerId != null && !node.headerId.isEmpty()) {
            el.getCOSObject().setString(COSName.getPDFName("ID"), node.headerId);
        }

        COSDictionary attrs = new COSDictionary();
        attrs.setItem(COSName.O, COSName.getPDFName("Table"));
        boolean hasAttrs = false;

        if (node.columnSpan > 1) {
            attrs.setInt(COSName.getPDFName("ColSpan"), node.columnSpan);
            hasAttrs = true;
        }
        if (node.rowSpan > 1) {
            attrs.setInt(COSName.getPDFName("RowSpan"), node.rowSpan);
            hasAttrs = true;
        }

        if ("TH".equals(node.type)) {
            String scope = node.scope != null && !node.scope.isEmpty()
                ? node.scope
                : (ctx.insideTHead ? "Column" : "Row");
            if (!scope.isEmpty()) {
                attrs.setName(COSName.getPDFName("Scope"), scope);
                hasAttrs = true;
            }
        }

        if (!node.tableHeaders.isEmpty()) {
            COSArray headers = new COSArray();
            for (String header : node.tableHeaders) {
                if (header != null && !header.isEmpty()) headers.add(new COSString(header));
            }
            if (headers.size() > 0) {
                attrs.setItem(COSName.getPDFName("Headers"), headers);
                hasAttrs = true;
            }
        }

        if (hasAttrs) el.getCOSObject().setItem(COSName.A, attrs);
    }

    /**
     * Recursive helper. Returns the PDStructureElement for this node
     * (or null if the node and its subtree have no MCIDs and should
     * be skipped). Refs come through refsByTag keyed by tagNodeId;
     * parentArraysByPageKey gets populated at each (page, mcid) slot
     * with the emitting structure element so /ParentTree lookups
     * work from both directions. The parentNode argument lets TH
     * emit the /Scope attribute JAWS/NVDA need for table navigation.
     */
    private static PDStructureElement buildStructureSubtree(
            PDStructureTreeRoot treeRoot,
            TagTreeNode node,
            TreeContext ctx,
            Map<String, List<PageMcRef>> refsByTag,
            Map<Integer, COSArray> parentArraysByPageKey,
            List<LinkAnnot> linkAnnots,
            Map<PDPage, Double> pageDisplayHeight) {

        // Derive child context from current — threshold updates to
        // boolean flags happen here before the recursive call so all
        // descendants see the right ancestor state.
        TreeContext childCtx = ctx.descend();
        if ("THead".equals(node.type)) childCtx.insideTHead = true;
        if (node.lang != null && !node.lang.isEmpty()) childCtx.inheritedLang = node.lang;

        List<PageMcRef> myRefs = refsByTag.getOrDefault(node.id, java.util.Collections.emptyList());
        List<PDStructureElement> childElements = new ArrayList<>();
        for (TagTreeNode child : node.children) {
            PDStructureElement childEl = buildStructureSubtree(treeRoot, child, childCtx, refsByTag, parentArraysByPageKey, linkAnnots, pageDisplayHeight);
            if (childEl != null) childElements.add(childEl);
        }
        boolean hasSemanticText = node.actualText != null && !node.actualText.isEmpty();
        boolean hasAltText = node.alt != null && !node.alt.isEmpty();
        if (myRefs.isEmpty() && childElements.isEmpty() && !hasSemanticText && !hasAltText) return null;

        PDStructureElement el = new PDStructureElement(node.type, treeRoot);
        if (node.lang != null && !node.lang.isEmpty()) el.setLanguage(node.lang);
        if (node.alt != null && !node.alt.isEmpty()) el.setAlternateDescription(node.alt);
        if (node.actualText != null && !node.actualText.isEmpty()) el.setActualText(node.actualText);
        if ("Aside".equals(node.type)) {
            el.getCOSObject().setString(COSName.getPDFName("ID"), noteStructureId(node));
        }

        applyTableAttributes(el, node, ctx);

        for (PageMcRef ref : myRefs) {
            // Emit an MCR dict kid so multi-page elements carry a
            // per-ref /Pg. For single-page elements this is redundant
            // with setPage, but it's correct in both cases and avoids
            // a separate code path.
            COSDictionary mcrDict = new COSDictionary();
            mcrDict.setItem(COSName.TYPE, COSName.getPDFName("MCR"));
            mcrDict.setInt(COSName.MCID, ref.mcid);
            mcrDict.setItem(COSName.PG, ref.page.getCOSObject());
            PDMarkedContentReference mcr = new PDMarkedContentReference(mcrDict);

            // Link-annotation wrapping (Matterhorn 28-004 / PDF/UA-1
            // §7.18.5). When the operator position falls inside a
            // Link annotation's rect on this page, we insert a Link
            // StructElement under the current element and route the
            // MCID there. The Link element also gets an /OBJR child
            // pointing at the annotation dict so assistive tech can
            // follow the link target (JAWS's Links List, NVDA's "k"
            // navigation). Multiple MCIDs under the same Link annot
            // share the same Link StructElement.
            PDStructureElement containerForMcr = el;
            LinkAnnot matched = findLinkAnnot(ref, linkAnnots, pageDisplayHeight);
            if (matched != null && !"Link".equals(node.type)) {
                if (matched.emittedElement == null) {
                    PDStructureElement linkEl = new PDStructureElement("Link", treeRoot);
                    linkEl.setPage(ref.page);
                    // /Contents is the fallback text the screen reader
                    // announces if the Link has no text kids (JAWS
                    // requirement; NVDA and VoiceOver tolerant). Use
                    // the op text when available; annotation /Contents
                    // wins when both are present.
                    String existingContents = matched.annot.getContents();
                    if (existingContents == null || existingContents.isEmpty()) {
                        // PDAnnotationLink doesn't emit /Contents by
                        // default; set one from the representative
                        // op text so AT has something to speak.
                        // Intentionally limited to 200 chars.
                        matched.annot.setContents(truncate(textForLink(matched, myRefs), 200));
                    }
                    // Attach OBJR referencing the annotation dict.
                    COSDictionary objrDict = new COSDictionary();
                    objrDict.setItem(COSName.TYPE, COSName.getPDFName("OBJR"));
                    objrDict.setItem(COSName.PG, ref.page.getCOSObject());
                    objrDict.setItem(COSName.OBJ, matched.annot.getCOSObject());
                    linkEl.appendKid(new PDObjectReference(objrDict));
                    el.appendKid(linkEl);
                    matched.emittedElement = linkEl;
                }
                containerForMcr = matched.emittedElement;
            }

            containerForMcr.appendKid(mcr);

            if (containerForMcr.getPage() == null) containerForMcr.setPage(ref.page);
            if (el.getPage() == null) el.setPage(ref.page);

            COSArray parentArray = parentArraysByPageKey.get(ref.pageKey);
            if (parentArray != null) {
                while (parentArray.size() <= ref.mcid) parentArray.add(COSNull.NULL);
                parentArray.set(ref.mcid, containerForMcr.getCOSObject());
            }
        }

        for (PDStructureElement childEl : childElements) {
            el.appendKid(childEl);
        }

        return el;
    }

    private static String noteStructureId(TagTreeNode node) {
        String element = sanitizeNoteIdPart(node.id);
        if (element.isBlank()) element = "unknown";

        String group = sanitizeNoteIdPart(node.footnoteGroupId);
        if (!group.isBlank()) {
            return "note-" + group + "-" + element;
        }
        return "note-" + element;
    }

    private static String sanitizeNoteIdPart(String raw) {
        return raw == null ? "" : raw.replaceAll("[^A-Za-z0-9_.-]+", "-");
    }

    /**
     * Find the first Link annotation on the ref's page whose rect
     * contains the op's display-space position. A ref that falls
     * inside two overlapping Link rects matches the first one — rare
     * in practice (overlapping links are typically an authoring
     * mistake), and deterministic resolution beats arbitrary.
     */
    private static LinkAnnot findLinkAnnot(PageMcRef ref, List<LinkAnnot> linkAnnots, Map<PDPage, Double> pageDisplayHeight) {
        if (linkAnnots == null || linkAnnots.isEmpty()) return null;
        if (Double.isNaN(ref.opX) || Double.isNaN(ref.opY)) return null;
        Double ph = pageDisplayHeight.get(ref.page);
        if (ph == null) return null;
        for (LinkAnnot la : linkAnnots) {
            if (la.page != ref.page) continue;
            if (la.containsDisplay(ref.opX, ref.opY, ph)) return la;
        }
        return null;
    }

    private static String textForLink(LinkAnnot la, List<PageMcRef> refs) {
        // Best-effort: prefer the Link annotation's action URI for
        // /Contents, falling back to a concatenation of the matching
        // refs' op text. We don't have direct access to op text from
        // PageMcRef (we store position only), so URI is the practical
        // fallback.
        try {
            if (la.annot.getAction() != null) {
                String s = la.annot.getAction().toString();
                if (s != null && !s.isEmpty()) return s;
            }
        } catch (Throwable ignore) {}
        return "Link";
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max);
    }

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
        String tagsPath = null;
        String title = "Tagged PDF";
        String language = "en-US";
        // readingOrderStrategy is informational today: "semantic" means
        // structure tree children are emitted in matcher-assignment order
        // (which is semantic readingOrder). "file" is reserved for a future
        // debug mode that emits in content-stream order. The value is
        // surfaced in the report so operators can see what the writer did.
        String readingOrderStrategy = "semantic";

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--pdf":
                    if (i + 1 < args.length) pdfPath = args[++i];
                    break;
                case "--plan":
                case "--tag-plan":
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
                case "--reading-order-strategy":
                    if (i + 1 < args.length) readingOrderStrategy = args[++i];
                    break;
                case "--tags":
                    if (i + 1 < args.length) tagsPath = args[++i];
                    break;
            }
        }

        if (pdfPath == null || planPath == null || outputPath == null) {
            System.err.println("Usage: java NativeContentStreamRewriter --pdf <source.pdf> --plan <tag-plan.json> --output <tagged.pdf> [--tags <tagging.json>] [--title <title>] [--language <lang>]");
            System.exit(1);
        }

        System.err.println("[rewriter] Loading source PDF: " + pdfPath);
        System.err.println("[rewriter] Loading tag plan: " + planPath);

        // Parse the tag plan
        String planJson = readFile(planPath);
        List<PagePlan> plans = parseTagPlan(planJson);
        int originalAssignmentCount = 0;
        for (PagePlan plan : plans) originalAssignmentCount += plan.assignments.size();
        int splitMarkedContentRuns = 0;

        System.err.println("[rewriter] Tag plan has " + plans.size() + " page(s)");

        // Load and modify the PDF
        try (PDDocument doc = Loader.loadPDF(new File(pdfPath))) {
            int totalAssignments = 0;
            int totalMcids = 0;
            int totalArtifacts = 0;
            int totalTaggedWrapped = 0;
            int totalSkippedInsideSourceMC = 0;
            int pagesRewritten = 0;

            for (PagePlan plan : plans) {
                int pageIndex = plan.pageNumber - 1;
                if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) {
                    System.err.println("[rewriter] WARNING: page " + plan.pageNumber + " out of range, skipping");
                    continue;
                }

                PDPage page = doc.getPage(pageIndex);
                splitMarkedContentRuns += splitAssignmentsIntoMarkedRuns(plan, collectBarrierOperatorIndices(page, plan));
                System.err.println("[rewriter] Rewriting page " + plan.pageNumber
                        + " (" + plan.assignments.size() + " assignments, "
                        + plan.unmatchedOperatorSeqs.size() + " unmatched ops)");

                RewriteResult res = rewritePageContentStream(doc, page, plan);
                totalAssignments += plan.assignments.size();
                totalMcids += plan.assignments.size();
                totalArtifacts += res.artifactWrapped;
                totalTaggedWrapped += res.taggedWrapped;
                totalSkippedInsideSourceMC += res.skippedInsideSourceMarkedContent;
                pagesRewritten++;
            }

            // Hierarchical structure tree when --tags is supplied
            // (normal path). Falls back to flat Document-has-all-leaves
            // when omitted, for backward compat with older callers.
            TagTreeNode tagTree = null;
            if (tagsPath != null) {
                try {
                    String tagsJson = readFile(tagsPath);
                    tagTree = parseTaggingTree(tagsJson);
                } catch (IOException ioe) {
                    System.err.println("[rewriter] WARNING: could not read --tags " + tagsPath + ": " + ioe.getMessage() + " — falling back to flat structure tree");
                }
            }
            buildStructureTreeHierarchical(doc, plans, tagTree);

            // Native rewriter delegates the full PDF/UA metadata +
            // font + link + XMP pass to the shared
            // PassthroughMetadataCli.applyPdfUaAccessibilityPass so
            // both writer modes produce identically-compliant output.
            // The rewriter's own applyMetadata used a single-
            // rdf:Description XMP that VeraPDF's XMPChecker didn't
            // like; the shared pass emits canonical multi-Description
            // XMP synced to /Info (so infoMatchesXmp=true), fills
            // /ViewerPreferences/DisplayDocTitle, attaches /Name to
            // OCProperties configs, embeds Standard 14 references,
            // auto-generates ToUnicode CMaps, and backfills
            // /Contents on Link annotations.
            try {
                String summary = PassthroughMetadataCli.applyPdfUaAccessibilityPass(doc, title, language, false);
                System.err.println("[rewriter] accessibility pass: " + summary);
            } catch (IOException e) {
                System.err.println("[rewriter] WARNING: accessibility pass failed, falling back to legacy metadata: " + e.getMessage());
                applyMetadata(doc, title, language);
            }

            doc.save(outputPath);
            System.err.println("[rewriter] Saved tagged PDF to: " + outputPath);

            // Post-save pass: PDFBox regenerates /CIDSet on save for
            // embedded CIDFontType2 subsets. The regenerated CIDSet
            // can be inconsistent with the actual glyph set (trips
            // VERAPDF_7_21_4_2_2). Re-open, strip /CIDSet entries,
            // re-save. Controlled via OAT_CIDSET_STRIP env (default
            // ON — disable with OAT_CIDSET_STRIP=0 for rollback).
            // Post-save CIDSet strip disabled: NO_COMPRESSION save
            // strips embedded font programs, regressing ~25 docs. The
            // in-memory strip alone doesn't help because PDFBox
            // regenerates /CIDSet during save. Accept VERAPDF_7_21_4_2_2
            // on affected docs (3 of 27) as a PDFBox limitation.
            // Turning OAT_CIDSET_STRIP=1 back on requires a save path
            // that preserves embedded fonts — open question.

            StringBuilder json = new StringBuilder();
            json.append("{");
            json.append("\"success\":true");
            json.append(",\"outputPath\":").append(escapeJson(outputPath));
            json.append(",\"pagesRewritten\":").append(pagesRewritten);
            json.append(",\"pagesNative\":").append(pagesRewritten);
            json.append(",\"totalAssignments\":").append(totalAssignments);
            json.append(",\"structureElementCount\":").append(originalAssignmentCount);
            json.append(",\"markedContentCount\":").append(totalTaggedWrapped);
            json.append(",\"totalMcids\":").append(totalMcids);
            json.append(",\"totalArtifactWraps\":").append(totalArtifacts);
            json.append(",\"splitMarkedContentRuns\":").append(splitMarkedContentRuns);
            json.append(",\"skippedInsideSourceMarkedContent\":").append(totalSkippedInsideSourceMC);
            json.append(",\"structureTreeBuilt\":true");
            json.append(",\"metadataApplied\":true");
            json.append(",\"readingOrderStrategy\":").append(escapeJson(readingOrderStrategy));
            json.append(",\"title\":").append(escapeJson(title));
            json.append(",\"language\":").append(escapeJson(language));
            json.append("}");
            System.out.println(json.toString());
        }
    }
}
