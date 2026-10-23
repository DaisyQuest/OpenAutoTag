import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNull;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.contentstream.PDContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.font.PDFont;
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
        PAINT_OPS.add("BI");
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
        String streamOrigin = "page";
        boolean lexicalIdentity;
        boolean partial;
        int glyphStart, glyphEnd, sourceGlyphCount;
        String sourceText, operandSha256;
        NativeLinkOwnership.Link link;
    }

    /** An assignment: a tag node mapped to a set of operators with a given MCID */
    private static class Assignment {
        String tagNodeId;
        String tagType;
        int mcid;
        List<OpRef> operators = new ArrayList<>();
        double matchConfidence;
        boolean startsTagGroup;
        boolean emitted;
        boolean coalesced;
        List<AuthoredText.Scope> authoredText = List.of();
    }

    /** Per-page plan from the tag plan JSON */
    private static class PagePlan {
        int pageNumber;
        final List<String> sourceOwnership = new ArrayList<>();
        List<Assignment> assignments = new ArrayList<>();
        NativeLinkOwnership links;
        List<Integer> unmatchedOperatorSeqs = new ArrayList<>();
        List<Integer> unmatchedOperatorIndices = new ArrayList<>();
        Map<String, PDFormXObject> forms = new LinkedHashMap<>();
    }

    /** Source offsets are captured before serialization, never recovered from
     * the generated MCIDs. An independent reader checks this proposed intent. */
    private static class OwnershipCursor {
        final PagePlan plan; final String origin; final int index; final PDFont font;
        int offset;
        OwnershipCursor(PagePlan plan, String origin, int index, PDFont font) {
            this.plan=plan; this.origin=origin; this.index=index; this.font=font;
        }
        void record(String tag, List<COSBase> operands) throws IOException {
            int count=countGlyphs(operands.get(operands.size()-1));
            if(count>0) {
                if(plan.sourceOwnership.size()>=100000)throw new IOException("Source ownership range limit exceeded");
                plan.sourceOwnership.add("{\"pageNumber\":"+plan.pageNumber+",\"streamOrigin\":"+escapeJson(origin)
                    +",\"operatorIndex\":"+index+",\"glyphStart\":"+offset+",\"glyphEnd\":"+(offset+count)+",\"tagNodeId\":"+escapeJson(tag)+"}");
            }
            offset+=count;
        }
        private int countGlyphs(COSBase value) throws IOException {
            if(value instanceof COSArray) { int count=0; for(COSBase item:(COSArray)value)count+=countGlyphs(item); return count; }
            if(!(value instanceof COSString))return 0;
            ByteArrayInputStream in=new ByteArrayInputStream(((COSString)value).getBytes()); int count=0;
            while(in.available()>0) {
                int before=in.available(); if(font==null)in.read();else font.readCode(in);
                if(in.available()>=before||++count>2000000)throw new IOException("Invalid source glyph decoding");
            }
            return count;
        }
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
        List<OcrTextLayer.Line> ocrSegments = new ArrayList<>();
        String lang;
        String alt;
        String actualText;
        boolean intentionallyEmptyDataCell;
        String footnoteGroupId;
        String headerId;
        String listNumbering;
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
        for (Object value : asList(m.get("ocrSegments"))) {
            Map<String,Object> entry=asMap(value); List<Object> quad=asList(entry.get("quad"));
            double[] points=new double[quad.size()]; for(int i=0;i<points.length;i++)points[i]=asDouble(quad.get(i));
            n.ocrSegments.add(new OcrTextLayer.Line(n.id,asString(m.get("type")),requiredInteger(entry,"pageNumber"),asString(entry.get("text")),points));
        }
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
        if (m.get("listNumbering") != null) n.listNumbering = nonEmptyString(m.get("listNumbering"));
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
        n.intentionallyEmptyDataCell = "TD".equals(n.type) && children.isEmpty()
            && asList(m.get("sourceNodeIds")).isEmpty() && asString(m.get("label")).isBlank()
            && asString(m.get("actualText")).isBlank() && asString(m.get("alt")).isBlank();
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
                    ref.lexicalIdentity = om.containsKey("streamOrigin") && om.containsKey("opIndexInStream");
                    if (ref.lexicalIdentity) {
                        ref.streamOrigin = asString(om.get("streamOrigin"));
                        if (!ref.streamOrigin.matches("page(?:/[0-9]+)*") || ref.opIndexInStream < 0)
                            throw new IllegalArgumentException("Invalid native stream identity");
                    }
                    ref.partial = om.containsKey("glyphStart") || om.containsKey("glyphEnd") || om.containsKey("sourceGlyphCount")
                        || om.containsKey("sourceText") || om.containsKey("operandSha256");
                    if (ref.partial) {
                        ref.glyphStart = requiredInteger(om, "glyphStart"); ref.glyphEnd = requiredInteger(om, "glyphEnd");
                        ref.sourceGlyphCount = requiredInteger(om, "sourceGlyphCount");
                        ref.sourceText = asString(om.get("sourceText")); ref.operandSha256 = asString(om.get("operandSha256"));
                        if (!ref.lexicalIdentity || ref.glyphStart < 0 || ref.glyphEnd <= ref.glyphStart
                                || ref.glyphEnd > ref.sourceGlyphCount || ref.sourceGlyphCount > NativeContentStreamParser.TextMapping.MAX_GLYPHS
                                || ref.sourceText.isEmpty() || !ref.operandSha256.matches("[0-9a-f]{64}"))
                            throw new IllegalArgumentException("Invalid native glyph partition");
                    }
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

    private static int requiredInteger(Map<String,Object> map, String key) {
        Object value = map.get(key);
        if (!(value instanceof Number) || !Double.isFinite(asDouble(value)) || asDouble(value) != asInt(value))
            throw new IllegalArgumentException("Invalid native glyph partition field: " + key);
        return asInt(value);
    }

    private static void validatePartitions(PagePlan plan) throws IOException {
        Map<Integer,List<OpRef>> bySeq = new HashMap<>();
        Map<String,Integer> byAddress = new HashMap<>();
        for (Assignment a : plan.assignments) for (OpRef ref : a.operators) {
            bySeq.computeIfAbsent(ref.seq, k -> new ArrayList<>()).add(ref);
            if (ref.lexicalIdentity) {
                Integer previous = byAddress.putIfAbsent(ref.streamOrigin+":"+ref.opIndexInStream, ref.seq);
                if (previous != null && previous != ref.seq) throw new IOException("Text operator has multiple owners at scoped address");
            }
        }
        for (List<OpRef> refs : bySeq.values()) {
            OpRef first = refs.get(0);
            if (!first.partial) {
                if (refs.size() != 1) throw new IOException("Text operator has multiple owners: " + first.seq);
                continue;
            }
            refs.sort(java.util.Comparator.comparingInt(r -> r.glyphStart));
            int end = 0;
            for (OpRef ref : refs) {
                if (!ref.partial || ref.opIndexInStream != first.opIndexInStream || !ref.streamOrigin.equals(first.streamOrigin)
                        || !ref.operandSha256.equals(first.operandSha256) || !ref.sourceText.equals(first.sourceText)
                        || ref.sourceGlyphCount != first.sourceGlyphCount || ref.glyphStart != end)
                    throw new IOException("Incomplete, overlapping or inconsistent native glyph partition");
                end = ref.glyphEnd;
            }
            if (end != first.sourceGlyphCount) throw new IOException("Incomplete native glyph partition");
        }
    }

    /** Split source byte ranges at independently discovered annotation boundaries
     * before assigning MCIDs. No text is decoded and re-encoded for this split. */
    private static void prepareNativeLinks(PDDocument doc, PagePlan plan) throws IOException {
        validatePartitions(plan);
        plan.links=new NativeLinkOwnership(doc,plan.pageNumber);
        if(plan.links.links.isEmpty())return;
        for(Assignment assignment:plan.assignments) {
            List<OpRef> expanded=new ArrayList<>();
            for(OpRef ref:assignment.operators) {
                var evidence=plan.links.operators.get(NativeLinkOwnership.address(ref.streamOrigin,ref.opIndexInStream));
                if(!ref.lexicalIdentity||evidence==null) {expanded.add(ref);continue;}
                var mapping=evidence.record().sourceMapping;var owners=evidence.glyphLinks();
                int first=ref.partial?ref.glyphStart:0,end=ref.partial?ref.glyphEnd:owners.length;
                if(first<0||end>owners.length)throw new IOException("Native link glyph bounds disagree with source");
                if(ref.partial&&(!mapping.sha256.equals(ref.operandSha256)||!mapping.text.equals(ref.sourceText)||mapping.glyphs.size()!=ref.sourceGlyphCount))
                    throw new IOException("Native link source partition is stale");
                boolean hasLink=false;for(int g=first;g<end;g++)if(owners[g]!=null)hasLink=true;
                if(!hasLink){expanded.add(ref);continue;}
                for(int start=first;start<end;) {
                    int stop=start+1;while(stop<end&&owners[stop]==owners[start])stop++;
                    OpRef part=new OpRef();part.seq=ref.seq;part.opIndexInStream=ref.opIndexInStream;part.streamOrigin=ref.streamOrigin;part.lexicalIdentity=true;
                    part.x=ref.x;part.y=ref.y;part.sourceText=mapping.text;part.sourceGlyphCount=owners.length;part.operandSha256=mapping.sha256;
                    part.glyphStart=start;part.glyphEnd=stop;part.partial=ref.partial||start!=0||stop!=owners.length;
                    part.text=mapping.text.substring(mapping.glyphs.get(start).textStart,mapping.glyphs.get(stop-1).textEnd);part.link=owners[start];
                    expanded.add(part);start=stop;
                }
            }
            assignment.operators=expanded;
        }
    }

    /** Each text operator owns a disjoint marked-content run. A semantic node can
     * own many MCRs without swallowing unrelated paint between its operators.
     * Each stream has its own MCID numbering, qualified by its ParentTree slot. */
    private static int splitAssignmentsIntoMarkedRuns(PagePlan plan) throws IOException {
        validatePartitions(plan);
        Map<String, Integer> nextMcids = new HashMap<>();
        List<Assignment> expanded = new ArrayList<>();
        int addedRuns = 0;
        for (Assignment a : plan.assignments) {
            for (int i = 0; i < a.operators.size(); i++) {
                OpRef ref = a.operators.get(i);
                Assignment run = new Assignment();
                run.tagNodeId = a.tagNodeId;
                run.tagType = a.tagType;
                run.matchConfidence = a.matchConfidence;
                run.mcid = nextMcids.getOrDefault(ref.streamOrigin, 0);
                nextMcids.put(ref.streamOrigin, run.mcid + 1);
                run.startsTagGroup = i == 0;
                run.operators.add(ref);
                expanded.add(run);
                if (i > 0) addedRuns++;
            }
        }
        plan.assignments = expanded;
        return addedRuns;
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
        final List<TextEmission> textEmissions = new ArrayList<>();
        int taggedWrapped;
        int artifactWrapped;
        int skippedInsideSourceMarkedContent;
        void add(RewriteResult other) {
            taggedWrapped += other.taggedWrapped; artifactWrapped += other.artifactWrapped;
            skippedInsideSourceMarkedContent += other.skippedInsideSourceMarkedContent;
        }
    }

    private record TextEmission(Assignment assignment, int start, int end) {}

    private static void coalesceAuthoredText(List<Object> tokens, RewriteResult result) throws IOException {
        Map<AuthoredText.Scope,List<TextEmission>> groups = new LinkedHashMap<>();
        Object streamIdentity = new Object();
        for (TextEmission emission : result.textEmissions) for (AuthoredText.Scope scope : emission.assignment.authoredText) {
            if (!scope.properties.containsKey(AuthoredText.ACTUAL)) continue;
            if (scope.contentStream != null && scope.contentStream != streamIdentity)
                throw new IOException("Authored text spans multiple content streams; source-tree preservation is required");
            scope.contentStream = streamIdentity;
            groups.computeIfAbsent(scope, k -> new ArrayList<>()).add(emission);
            break;
        }
        for (List<TextEmission> group : groups.values()) {
            TextEmission first = group.get(0), previous = first;
            for (int i = 1; i < group.size(); i++) {
                TextEmission next = group.get(i);
                if (!first.assignment.authoredText.equals(next.assignment.authoredText))
                    throw new IOException("Authored text has overlapping expansion scopes");
                for (int j = previous.end; j < next.start; j++) if (tokens.get(j) instanceof Operator op
                        && (TEXT_OPS.contains(op.getName()) || PAINT_OPS.contains(op.getName()) || Set.of("BDC", "BMC", "EMC").contains(op.getName())))
                    throw new IOException("Authored text crosses unrelated paint or visibility scopes");
                // Keep the first opening and final closing. Every source text
                // operator and intervening positioning operator stays in place.
                tokens.set(previous.end - 1, null);
                for (int j = next.start; j < next.start + 3; j++) tokens.set(j, null);
                first.assignment.operators.addAll(next.assignment.operators);
                next.assignment.coalesced = true;
                result.taggedWrapped--;
                previous = next;
            }
        }
        tokens.removeIf(java.util.Objects::isNull);
    }

    private static class RewriteContext {
        final Set<COSStream> activeForms = new HashSet<>();
        final AuthoredText authoredText;
        int formInvocations;
        RewriteContext(AuthoredText authoredText) { this.authoredText = authoredText; }
    }

    private static PDResources privateResources(PDResources source) {
        COSDictionary copy = source == null ? new COSDictionary() : new COSDictionary(source.getCOSObject());
        COSDictionary xobjects = copy.getCOSDictionary(COSName.XOBJECT);
        if (xobjects != null) copy.setItem(COSName.XOBJECT, new COSDictionary(xobjects));
        return new PDResources(copy);
    }

    private static void collectListLabels(TagTreeNode node, Map<String,TagTreeNode> labels) {
        if (node == null) return;
        if ("LI".equals(node.type)) {
            TagTreeNode label=null, body=null;
            for(TagTreeNode child:node.children) { if("Lbl".equals(child.type))label=child; if("LBody".equals(child.type))body=child; }
            if(label!=null && body!=null && label.actualText!=null && !label.actualText.isEmpty()) labels.put(body.id,label);
        }
        for(TagTreeNode child:node.children)collectListLabels(child,labels);
    }

    private static boolean clearGeneratedReplacement(TagTreeNode node, Set<String> owners, List<String> suppressed) {
        boolean affected = owners.contains(node.id);
        for (TagTreeNode child : node.children) affected |= clearGeneratedReplacement(child, owners, suppressed);
        // An ancestor ActualText replaces all descendants. Removing only the
        // leaf's generated text would still mask the author's replacement.
        if (affected && node.actualText != null) { suppressed.add(node.id); node.actualText = null; }
        return affected;
    }

    private static TagTreeNode flatTagTree(List<PagePlan> plans) {
        TagTreeNode root = new TagTreeNode(); root.id = "document"; root.type = "Document";
        Map<String,TagTreeNode> leaves = new LinkedHashMap<>();
        for (PagePlan plan : plans) for (Assignment assignment : plan.assignments) {
            if (leaves.containsKey(assignment.tagNodeId)) continue;
            TagTreeNode leaf = new TagTreeNode(); leaf.id = assignment.tagNodeId; leaf.type = assignment.tagType;
            leaves.put(leaf.id, leaf); root.children.add(leaf);
        }
        return root;
    }

    static class TextSplit {
        final COSBase prefix;
        final COSBase remainder; // null when the entire operand belongs to the label
        TextSplit(COSBase prefix, COSBase remainder) { this.prefix = prefix; this.remainder = remainder; }
    }

    // Decode source font codes, never re-encode Unicode. A ligature or multi-code
    // Unicode sequence is indivisible. For TJ, retain every adjustment in order,
    // including adjustments between strings and after a standalone marker.
    static TextSplit splitTextPrefix(PDFont font, COSBase operand, String marker) {
        if (font == null || marker == null || marker.isEmpty() || marker.length() > 128) return null;
        List<COSBase> parts = new ArrayList<>();
        if (operand instanceof COSString) parts.add(operand);
        else if (operand instanceof COSArray) {
            COSArray array = (COSArray) operand;
            if (array.size() > 4096) return null;
            for (int i = 0; i < array.size(); i++) parts.add(array.getObject(i));
        } else return null;
        long byteCount = 0;
        for (COSBase part : parts) {
            if (part instanceof COSString) byteCount += ((COSString) part).getBytes().length;
            else if (!(part instanceof org.apache.pdfbox.cos.COSNumber)) return null;
        }
        if (byteCount > 1048576) return null;
        COSArray prefix = new COSArray(), remainder = new COSArray();
        StringBuilder decoded = new StringBuilder();
        boolean found = false;
        try {
            for (COSBase part : parts) {
                if (found) { remainder.add(part); continue; }
                if (!(part instanceof COSString)) { prefix.add(part); continue; }
                byte[] bytes = ((COSString) part).getBytes();
                ByteArrayInputStream in = new ByteArrayInputStream(bytes);
                while (in.available() > 0) {
                    int before = in.available(), code = font.readCode(in);
                    if (in.available() >= before) return null;
                    String unicode = font.toUnicode(code);
                    if (unicode == null || unicode.isEmpty()) return null;
                    decoded.append(unicode);
                    if (!marker.startsWith(decoded.toString())) return null;
                    if (decoded.toString().equals(marker)) {
                        int boundary = bytes.length - in.available();
                        prefix.add(new COSString(java.util.Arrays.copyOfRange(bytes, 0, boundary)));
                        if (boundary < bytes.length) remainder.add(new COSString(java.util.Arrays.copyOfRange(bytes, boundary, bytes.length)));
                        found = true;
                        break;
                    }
                }
                if (!found) prefix.add(part);
            }
        } catch (IOException ignored) { return null; }
        if (!found) return null;
        boolean hasBody = false;
        for (COSBase part : remainder) if (part instanceof COSString && ((COSString) part).getBytes().length > 0) hasBody = true;
        if (!hasBody) { for (COSBase part : remainder) prefix.add(part); }
        if (operand instanceof COSString) return new TextSplit(prefix.getObject(0), hasBody ? remainder.getObject(0) : null);
        return new TextSplit(prefix, hasBody ? remainder : null);
    }

    private static RewriteResult rewritePageContentStream(PDDocument doc, PDPage page, PagePlan plan, Map<String,TagTreeNode> listLabels, AuthoredText authoredText) throws IOException {
        PDResources resources = privateResources(page.getResources());
        page.setResources(resources);
        RewriteResult result = rewriteContentStream(doc, page, page, null, resources, plan, "page", listLabels, new RewriteContext(authoredText), null, false, List.of());
        for (Assignment a : plan.assignments) if (!a.emitted)
            throw new IOException("No source text operator for assigned tag " + a.tagNodeId);
        plan.assignments.removeIf(a -> a.coalesced);
        return result;
    }

    private static int emitOwnedText(List<Object> tokens, Assignment assignment, List<COSBase> operands, Operator op,
            PDFont font, Map<String,TagTreeNode> labels, PagePlan plan, RewriteResult result, int nextMcid, OwnershipCursor ownership) throws IOException {
        TagTreeNode label = labels.get(assignment.tagNodeId);
        if (label != null && assignment.startsTagGroup && ("Tj".equals(op.getName()) || "TJ".equals(op.getName())) && operands.size() == 1) {
            TextSplit split = splitTextPrefix(font, operands.get(0), label.actualText);
            if (split != null && split.remainder == null) {
                assignment.tagNodeId = label.id; assignment.tagType = "Lbl";
                operands.set(0, split.prefix);
            } else if (split != null) {
                Assignment marker = new Assignment(); marker.tagNodeId = label.id; marker.tagType = "Lbl"; marker.mcid = nextMcid++;
                marker.authoredText = assignment.authoredText;
                marker.operators.add(assignment.operators.get(0)); plan.assignments.add(marker);
                ownership.record(marker.tagNodeId, List.of(split.prefix));
                emitMarkedText(tokens, marker, List.of(split.prefix), op, result);
                operands.set(0, split.remainder);
            }
        }
        ownership.record(assignment.tagNodeId, operands);
        emitMarkedText(tokens, assignment, operands, op, result);
        return nextMcid;
    }

    private static void emitMarkedText(List<Object> tokens, Assignment assignment, List<COSBase> operands, Operator op, RewriteResult result) throws IOException {
        AuthoredText.own(assignment.authoredText, assignment.tagNodeId);
        int start = tokens.size();
        COSDictionary props = new COSDictionary(); props.setInt(COSName.MCID, assignment.mcid);
        AuthoredText.addMarkedReplacement(props, assignment.authoredText);
        tokens.add(COSName.getPDFName(props.containsKey(AuthoredText.ACTUAL) ? "Span" : assignment.tagType)); tokens.add(props); tokens.add(Operator.getOperator("BDC"));
        tokens.addAll(operands); tokens.add(op); tokens.add(Operator.getOperator("EMC"));
        result.textEmissions.add(new TextEmission(assignment, start, tokens.size()));
        result.taggedWrapped++; assignment.emitted = true;
    }

    private static NativeContentStreamParser.TextMapping verifiedMapping(PDFont font, List<COSBase> operands,
            String operator, List<Assignment> pieces) throws IOException {
        int arity = "\"".equals(operator) ? 3 : 1;
        if (operands.size() != arity || (arity == 3 && (!(operands.get(0) instanceof org.apache.pdfbox.cos.COSNumber)
                || !(operands.get(1) instanceof org.apache.pdfbox.cos.COSNumber))))
            throw new IOException("Invalid partitioned text operator operands");
        COSBase operand = operands.get(arity-1);
        if (!("TJ".equals(operator) ? operand instanceof COSArray : operand instanceof COSString))
            throw new IOException("Invalid partitioned text operand type");
        NativeContentStreamParser.TextMapping mapping = NativeContentStreamParser.mapOperand(font, operand);
        if (mapping == null) throw new IOException("Source glyph mapping cannot be verified");
        for (Assignment piece : pieces) {
            OpRef ref = piece.operators.get(0);
            if (!mapping.sha256.equals(ref.operandSha256) || !mapping.text.equals(ref.sourceText) || mapping.glyphs.size() != ref.sourceGlyphCount
                    || !mapping.text.substring(mapping.glyphs.get(ref.glyphStart).textStart, mapping.glyphs.get(ref.glyphEnd-1).textEnd).equals(ref.text))
                throw new IOException("Source glyph partition differs from native plan");
        }
        return mapping;
    }

    /** Source scopes and generated ownership scopes have independent lifetimes.
     * OC is a visibility condition, not an owner. Source Artifact properties
     * apply only to content which remains unassigned by the semantic plan. */
    private static class SourceMark {
        COSName tag;
        COSBase propertyOperand;
        COSDictionary properties;
        boolean optionalContent;
        List<AuthoredText.Scope> authoredText = List.of();
    }

    private static SourceMark sourceMark(String operator, List<COSBase> operands, PDResources resources) throws IOException {
        boolean dictionary = "BDC".equals(operator);
        if (operands.size() != (dictionary ? 2 : 1) || !(operands.get(0) instanceof COSName))
            throw new IOException("Malformed source marked-content opening");
        SourceMark mark = new SourceMark(); mark.tag = (COSName) operands.get(0);
        if (dictionary) {
            mark.propertyOperand = operands.get(1);
            if (mark.propertyOperand instanceof COSDictionary) mark.properties = (COSDictionary) mark.propertyOperand;
            else if (mark.propertyOperand instanceof COSName) {
                COSDictionary properties = resources.getCOSObject().getCOSDictionary(COSName.PROPERTIES);
                if (properties != null) mark.properties = properties.getCOSDictionary((COSName) mark.propertyOperand);
            }
            if (mark.properties == null) throw new IOException("Unresolved source marked-content properties");
        }
        // OC can also be an application's ordinary marked-content tag. It is
        // a visibility scope only when its properties identify an OCG/OCMD.
        mark.optionalContent = COSName.OC.equals(mark.tag) && mark.properties != null
            && (COSName.OCG.equals(mark.properties.getCOSName(COSName.TYPE)) || COSName.OCMD.equals(mark.properties.getCOSName(COSName.TYPE)));
        if (mark.optionalContent) {
            // PDF Reference 4.10.2 requires named resources here: group
            // identity depends on indirect objects, forbidden inline in streams.
            if (!(mark.propertyOperand instanceof COSName)) throw new IOException("Optional-content properties require a named resource");
            if (mark.properties.containsKey(COSName.MCID)) throw new IOException("Optional-content group cannot own an MCID");
        }
        return mark;
    }

    private static COSDictionary artifactProperties(java.util.Deque<SourceMark> sourceMarks) {
        for (SourceMark mark : sourceMarks) if (COSName.ARTIFACT.equals(mark.tag)) {
            if (mark.properties == null) return null;
            COSDictionary copy = new COSDictionary(mark.properties);
            copy.removeItem(COSName.MCID);
            return copy.size() == 0 ? null : copy;
        }
        return null;
    }

    private static boolean hasArtifactScope(java.util.Deque<SourceMark> sourceMarks) {
        return sourceMarks.stream().anyMatch(m -> COSName.ARTIFACT.equals(m.tag));
    }

    private static void beginArtifact(List<Object> tokens, java.util.Deque<SourceMark> sourceMarks) {
        tokens.add(COSName.ARTIFACT);
        COSDictionary props = artifactProperties(sourceMarks);
        if (props == null) tokens.add(Operator.getOperator("BMC"));
        else { tokens.add(props); tokens.add(Operator.getOperator("BDC")); }
    }

    private static List<AuthoredText.Scope> authoredPath(List<AuthoredText.Scope> inherited, java.util.Deque<SourceMark> marks) {
        List<AuthoredText.Scope> path = inherited;
        for (var iterator = marks.descendingIterator(); iterator.hasNext();) path = AuthoredText.merge(path, iterator.next().authoredText);
        return AuthoredText.effective(path);
    }

    private static RewriteResult rewriteContentStream(PDDocument doc, PDPage page, PDContentStream source,
            PDFormXObject targetForm, PDResources resources, PagePlan plan, String origin,
            Map<String,TagTreeNode> listLabels, RewriteContext context, PDFont inheritedFont, boolean inheritedArtifact,
            List<AuthoredText.Scope> inheritedText) throws IOException {
        Map<Integer, List<Assignment>> lexicalAssignments = new HashMap<>();
        Map<Integer, Assignment> legacyAssignments = new HashMap<>();
        for (Assignment a : plan.assignments) {
            if (a.operators.isEmpty()) continue;
            for (OpRef ref : a.operators) {
                if (!origin.equals(ref.streamOrigin)) continue;
                if (ref.lexicalIdentity) lexicalAssignments.computeIfAbsent(ref.opIndexInStream, k -> new ArrayList<>()).add(a);
                else legacyAssignments.put(ref.seq, a);
            }
        }
        for (List<Assignment> pieces : lexicalAssignments.values())
            pieces.sort(java.util.Comparator.comparingInt(a -> a.operators.get(0).glyphStart));

        PDFStreamParser parser = new PDFStreamParser(source);
        List<Object> tokens = parser.parse();

        List<Object> newTokens = new ArrayList<>();
        int textOpSeq = 0;
        int operatorIndex = 0;
        boolean inArtifact = false;
        java.util.Deque<SourceMark> sourceMarks = new java.util.ArrayDeque<>();

        List<COSBase> pendingOperands = new ArrayList<>();
        RewriteResult result = new RewriteResult();
        PDFont currentFont=inheritedFont;List<PDFont> fontStack=new ArrayList<>();
        int nextMcid=plan.assignments.stream().filter(a -> !a.operators.isEmpty() && origin.equals(a.operators.get(0).streamOrigin))
            .mapToInt(a->a.mcid).max().orElse(-1)+1;

        for (Object token : tokens) {
            if (token instanceof Operator) {
                Operator op = (Operator) token;
                String opName = op.getName();
                int currentOperatorIndex = operatorIndex++;
                if("q".equals(opName))fontStack.add(currentFont);
                if("Q".equals(opName) && !fontStack.isEmpty())currentFont=fontStack.remove(fontStack.size()-1);
                if("Tf".equals(opName)) {
                    currentFont=null;
                    if(pendingOperands.size()==2 && pendingOperands.get(0) instanceof COSName)
                        currentFont=resources.getFont((COSName)pendingOperands.get(0));
                }
                if("gs".equals(opName) && pendingOperands.size()==1 && pendingOperands.get(0) instanceof COSName) {
                    var state=resources.getExtGState((COSName)pendingOperands.get(0));
                    if(state!=null && state.getFontSetting()!=null)currentFont=state.getFontSetting().getFont();
                }

                if ("Do".equals(opName) && pendingOperands.size() == 1 && pendingOperands.get(0) instanceof COSName
                        && resources.getXObject((COSName) pendingOperands.get(0)) instanceof PDFormXObject) {
                    PDFormXObject form = (PDFormXObject) resources.getXObject((COSName) pendingOperands.get(0));
                    String childOrigin = origin + "/" + currentOperatorIndex;
                    boolean artifactForm = inheritedArtifact || hasArtifactScope(sourceMarks)
                        && plan.assignments.stream().flatMap(a -> a.operators.stream())
                            .noneMatch(r -> r.streamOrigin.equals(childOrigin) || r.streamOrigin.startsWith(childOrigin+"/"));
                    if (artifactForm && !inheritedArtifact && !inArtifact) { beginArtifact(newTokens, sourceMarks); inArtifact = true; }
                    if (context.activeForms.size() >= 32 || ++context.formInvocations > 10000 || !context.activeForms.add(form.getCOSObject()))
                        throw new IOException("Cyclic or excessive Form XObject traversal");
                    PDFormXObject copy = new PDFormXObject(doc);
                    for (COSName key : form.getCOSObject().keySet()) {
                        if (!COSName.LENGTH.equals(key) && !COSName.FILTER.equals(key) && !COSName.DECODE_PARMS.equals(key)
                                && !COSName.STRUCT_PARENTS.equals(key)) copy.getCOSObject().setItem(key, form.getCOSObject().getItem(key));
                    }
                    copy.setResources(privateResources(form.getResources() == null ? resources : form.getResources()));
                    plan.forms.put(childOrigin, copy);
                    try {
                        result.add(rewriteContentStream(doc, page, form, copy, copy.getResources(), plan, childOrigin, listLabels, context, currentFont, artifactForm, authoredPath(inheritedText, sourceMarks)));
                    } finally { context.activeForms.remove(form.getCOSObject()); }
                    String name = "OTForm" + currentOperatorIndex;
                    COSDictionary names = resources.getCOSObject().getCOSDictionary(COSName.XOBJECT);
                    while (names != null && names.containsKey(COSName.getPDFName(name))) name += "_";
                    COSName alias = COSName.getPDFName(name); resources.put(alias, copy);
                    // An unassigned decorative Form keeps its artifact box in
                    // the invoking coordinate space. An invocation with owned
                    // text must be outside any surrounding artifact wrapper.
                    if (inArtifact && !artifactForm) { newTokens.add(Operator.getOperator("EMC")); inArtifact = false; }
                    newTokens.add(alias); newTokens.add(op); pendingOperands.clear();
                    continue;
                }

                if ("BMC".equals(opName) || "BDC".equals(opName)) {
                    if (sourceMarks.size() >= 256) throw new IOException("Excessive source marked-content nesting");
                    SourceMark mark = sourceMark(opName, pendingOperands, resources);
                    if (!COSName.ARTIFACT.equals(mark.tag)) {
                        COSDictionary sourceStream = source instanceof PDFormXObject ? ((PDFormXObject)source).getCOSObject() : null;
                        mark.authoredText = AuthoredText.append(context.authoredText.forContent(page.getCOSObject(), sourceStream, mark.properties), context.authoredText.read(mark.properties));
                    }
                    if (inArtifact) { newTokens.add(Operator.getOperator("EMC")); inArtifact = false; }
                    sourceMarks.push(mark);
                    if (mark.optionalContent) { newTokens.addAll(pendingOperands); newTokens.add(op); }
                    pendingOperands.clear();
                    continue;
                }
                if ("EMC".equals(opName)) {
                    if (!pendingOperands.isEmpty() || sourceMarks.isEmpty()) throw new IOException("Unbalanced source marked content");
                    if (inArtifact) { newTokens.add(Operator.getOperator("EMC")); inArtifact = false; }
                    if (sourceMarks.pop().optionalContent) newTokens.add(op);
                    pendingOperands.clear();
                    continue;
                }

                if (TEXT_OPS.contains(opName)) {
                    int currentSeq = textOpSeq;
                    textOpSeq++;

                    List<Assignment> pieces = lexicalAssignments.get(currentOperatorIndex);
                    Assignment assignment = pieces == null ? legacyAssignments.get(currentSeq) : pieces.get(0);
                    List<AuthoredText.Scope> authored = authoredPath(inheritedText, sourceMarks);

                    if (assignment != null) {
                        OwnershipCursor ownership = new OwnershipCursor(plan, origin, currentOperatorIndex, currentFont);
                        if (inheritedArtifact) throw new IOException("Assigned text inside a decorative Form invocation");
                        if (inArtifact) {
                            newTokens.add(Operator.getOperator("EMC"));
                            inArtifact = false;
                        }

                        if (assignment.operators.get(0).partial) {
                            NativeContentStreamParser.TextMapping mapping = verifiedMapping(currentFont, pendingOperands, opName, pieces);
                            // Quote operators' spacing/line advance applies once,
                            // before the first fragment, never once per owner.
                            if ("\"".equals(opName)) {
                                newTokens.add(pendingOperands.get(0)); newTokens.add(Operator.getOperator("Tw"));
                                newTokens.add(pendingOperands.get(1)); newTokens.add(Operator.getOperator("Tc"));
                            }
                            if ("'".equals(opName) || "\"".equals(opName)) newTokens.add(Operator.getOperator("T*"));
                            Operator show = Operator.getOperator("TJ".equals(opName) ? "TJ" : "Tj");
                            for (Assignment piece : pieces) {
                                piece.authoredText = authored;
                                OpRef ref = piece.operators.get(0);
                                List<COSBase> sliced = new ArrayList<>(List.of(mapping.slice(ref.glyphStart, ref.glyphEnd)));
                                nextMcid = emitOwnedText(newTokens, piece, sliced, show, currentFont, listLabels, plan, result, nextMcid, ownership);
                            }
                        } else {
                            assignment.authoredText = authored;
                            nextMcid = emitOwnedText(newTokens, assignment, pendingOperands, op, currentFont, listLabels, plan, result, nextMcid, ownership);
                        }
                    } else {
                        AuthoredText.own(authored, null);
                        // Unmatched text remains explicitly unqualified as an
                        // artifact; it must never sit inside a semantic wrapper.
                        if (!inheritedArtifact && !inArtifact) {
                            beginArtifact(newTokens, sourceMarks);
                            inArtifact = true;
                        }
                        newTokens.addAll(pendingOperands);
                        newTokens.add(op);
                        result.artifactWrapped++;
                    }
                } else if (PAINT_OPS.contains(opName)) {
                    AuthoredText.own(authoredPath(inheritedText, sourceMarks), null);
                    // Decorative paths/images/charts are visible page content.
                    // Keep their graphics-state/path setup unchanged, but wrap
                    // the paint operator so Acrobat sees the content as an
                    // artifact instead of an untagged element.
                    if (!inheritedArtifact && !inArtifact) {
                        beginArtifact(newTokens, sourceMarks);
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
        if (!sourceMarks.isEmpty()) throw new IOException("Unclosed source marked content");

        newTokens.addAll(pendingOperands);
        coalesceAuthoredText(newTokens, result);

        PDStream newStream = targetForm == null ? new PDStream(doc) : new PDStream(targetForm.getCOSObject());
        try (OutputStream out = newStream.createOutputStream()) {
            // PDFBox preserves PDF numeric syntax, escaped names, booleans and
            // inline-image payloads; Java toString is not a PDF serializer.
            new ContentStreamWriter(out).writeTokens(newTokens);
        }
        if (targetForm == null) page.setContents(newStream);
        return result;
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
    private static int installFormParents(PagePlan plan, int nextKey, Map<Integer, COSArray> arrays) {
        Set<String> used = new HashSet<>();
        for (Assignment a : plan.assignments) for (OpRef ref : a.operators) used.add(ref.streamOrigin);
        for (Map.Entry<String, PDFormXObject> entry : plan.forms.entrySet()) {
            if (!used.contains(entry.getKey())) continue;
            entry.getValue().getCOSObject().setInt(COSName.STRUCT_PARENTS, nextKey);
            arrays.put(nextKey++, new COSArray());
        }
        return nextKey;
    }

    private static void buildStructureTreeHierarchical(PDDocument doc, List<PagePlan> plans, TagTreeNode tagTree) throws IOException {
        if (tagTree == null) tagTree = flatTagTree(plans);

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
        List<NativeLinkOwnership.Link> linkAnnots = new ArrayList<>();
        int nextPageKey = 0;

        for (PagePlan plan : plans) {
            int pageIndex = plan.pageNumber - 1;
            if (pageIndex < 0 || pageIndex >= doc.getNumberOfPages()) continue;
            PDPage page = doc.getPage(pageIndex);
            int pageKey = nextPageKey++;
            page.setStructParents(pageKey);
            page.getCOSObject().setItem(COSName.getPDFName("Tabs"), COSName.S);

            if(plan.links!=null)linkAnnots.addAll(plan.links.links);

            COSArray parentArray = new COSArray();
            parentArraysByPageKey.put(pageKey, parentArray);
            nextPageKey = installFormParents(plan, nextPageKey, parentArraysByPageKey);

            for (Assignment a : plan.assignments) {
                PDFormXObject stream = plan.forms.get(a.operators.get(0).streamOrigin);
                int ownerKey = stream == null ? pageKey : stream.getCOSObject().getInt(COSName.STRUCT_PARENTS);
                refsByTag.computeIfAbsent(a.tagNodeId, k -> new ArrayList<>())
                         .add(new PageMcRef(page, stream, a.mcid, ownerKey, a.authoredText, a.operators));
            }
        }

        qualifyNativeLinks(linkAnnots,refsByTag,tagTree);
        TreeContext rootContext = new TreeContext();
        PDStructureElement rootElement = buildStructureSubtree(treeRoot, tagTree, rootContext, refsByTag, parentArraysByPageKey);
        if (rootElement != null) treeRoot.appendKid(rootElement);
        StructureIdentifiers.install(treeRoot);

        PDNumberTreeNode parentTree = new PDNumberTreeNode(PDParentTreeValue.class);
        Map<Integer, COSObjectable> numbers = new TreeMap<>();
        for (Map.Entry<Integer, COSArray> entry : parentArraysByPageKey.entrySet()) {
            numbers.put(entry.getKey(), new PDParentTreeValue(entry.getValue()));
        }
        for(NativeLinkOwnership.Link link:linkAnnots) if(link.element!=null) {
            COSDictionary objr=new COSDictionary();objr.setItem(COSName.TYPE,COSName.getPDFName("OBJR"));objr.setItem(COSName.PG,link.page.getCOSObject());objr.setItem(COSName.OBJ,link.annotation.getCOSObject());
            link.element.appendKid(new PDObjectReference(objr));
            link.parentKey=nextPageKey++;link.annotation.getCOSObject().setInt(COSName.STRUCT_PARENT,link.parentKey);
            numbers.put(link.parentKey,new PDParentTreeValue(link.element.getCOSObject()));
            if(link.annotation.getContents()==null||link.annotation.getContents().isBlank())link.annotation.setContents(link.anchorText);
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
     * Page- and stream-qualified marked-content reference for use while building
     * the hierarchical structure tree. Captures the PDF page, optional Form,
     * MCID, /ParentTree key and exact source operator ranges. Only a run whose
     * ranges all identify the same qualified annotation can belong to its Link.
     */
    private static class PageMcRef {
        final PDPage page;
        final PDFormXObject stream;
        final int mcid;
        final int pageKey;
        final List<AuthoredText.Scope> authoredText;
        final List<OpRef> operators;
        NativeLinkOwnership.Link link;
        PageMcRef(PDPage page,PDFormXObject stream,int mcid,int pageKey,List<AuthoredText.Scope> authoredText,List<OpRef> operators) {
            this.page=page;this.stream=stream;this.mcid=mcid;this.pageKey=pageKey;this.authoredText=authoredText;this.operators=operators;
            link=operators.get(0).link;
            if(operators.stream().anyMatch(op->op.link!=link)) {
                for(OpRef op:operators)if(op.link!=null)op.link.review("Authored replacement scope crosses an anchor boundary");
                link=null;
            }
        }
    }

    private static void qualifyNativeLinks(List<NativeLinkOwnership.Link> links,Map<String,List<PageMcRef>> refs,TagTreeNode tree) {
        for(var entry:refs.entrySet()) for(PageMcRef ref:entry.getValue()) if(ref.link!=null) {
            var link=ref.link;
            if(link.ownerTagId!=null&&!link.ownerTagId.equals(entry.getKey()))link.review("Anchor spans separate semantic nodes; grouping requires review");
            link.ownerTagId=entry.getKey();
            if(!ref.authoredText.isEmpty())link.review("Authored replacement/expansion scope requires anchor review");
            for(OpRef op:ref.operators) {
                link.anchorText+=op.text;
                link.ranges.add(Map.of("streamOrigin",op.streamOrigin,"operatorIndex",op.opIndexInStream,"glyphStart",op.glyphStart,"glyphEnd",op.glyphEnd));
                for(int g=op.glyphStart;g<op.glyphEnd;g++) {
                    String key=NativeLinkOwnership.glyphKey(op.streamOrigin,op.opIndexInStream,g);
                    if(link.expected.contains(key)&&!link.assigned.add(key))link.review("Duplicate source anchor glyph ownership");
                }
            }
        }
        for(var link:links) {
            if(link.uncertain)continue;
            if(link.expected.isEmpty()||!link.expected.equals(link.assigned)){link.review("Anchor has missing or untagged source glyphs");continue;}
            var ownerRefs=refs.get(link.ownerTagId);boolean begun=false,ended=false;
            for(PageMcRef ref:ownerRefs) {
                if(ref.link==link){if(ended)link.review("Anchor runs are separated by unrelated semantic content");begun=true;}
                else if(begun)ended=true;
            }
            link.eligible=!link.uncertain;
        }
        qualifyLinkContainers(tree,links,refs,false);
    }

    private static void qualifyLinkContainers(TagTreeNode node,List<NativeLinkOwnership.Link> links,Map<String,List<PageMcRef>> refs,boolean blocked) {
        for(var link:links)if(node.id.equals(link.ownerTagId)&&link.eligible) {
            if(blocked||!node.children.isEmpty())link.review("Anchor container or replacement-text ancestry requires review");
            else if("Link".equals(node.type)&&refs.getOrDefault(node.id,List.of()).stream().anyMatch(ref->ref.link!=link))
                link.review("Existing Link tag contains text outside this annotation anchor");
        }
        // Generated replacement text identical to every original glyph is
        // redundant and would mask the inline Link. Authored scopes have already
        // disqualified their links. Keep differing replacements and ancestors.
        if(!blocked&&node.children.isEmpty()&&node.actualText!=null&&!node.actualText.isEmpty()
                &&links.stream().anyMatch(link->link.eligible&&node.id.equals(link.ownerTagId))) {
            StringBuilder raw=new StringBuilder();
            for(PageMcRef ref:refs.getOrDefault(node.id,List.of()))for(OpRef op:ref.operators)raw.append(op.text);
            if(node.actualText.contentEquals(raw)) {
                node.actualText=null;
                for(var link:links)if(link.eligible&&node.id.equals(link.ownerTagId))link.suppressedRedundantActualText=true;
            }
        }
        boolean replacement=node.actualText!=null&&!node.actualText.isEmpty();
        for(var link:links)if(node.id.equals(link.ownerTagId)&&link.eligible&&replacement)link.review("Anchor container or replacement-text ancestry requires review");
        for(TagTreeNode child:node.children)qualifyLinkContainers(child,links,refs,blocked||replacement||"Link".equals(node.type));
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
        String parentType;
        boolean insideTHead = false;
        String inheritedLang = null;  // /Lang from nearest ancestor
        int openHeadingLevel = 0;     // highest H# seen in this Sect

        TreeContext descend() {
            TreeContext c = new TreeContext();
            c.parentType = this.parentType;
            c.insideTHead = this.insideTHead;
            c.inheritedLang = this.inheritedLang;
            c.openHeadingLevel = this.openHeadingLevel;
            return c;
        }
    }

    private static void applyTableAttributes(PDStructureElement el, TagTreeNode node, TreeContext ctx) {
        if ("L".equals(node.type) && node.listNumbering != null && Set.of("None","Disc","Circle","Square","Decimal","UpperRoman","LowerRoman","UpperAlpha","LowerAlpha").contains(node.listNumbering)) {
            COSDictionary list=new COSDictionary(); list.setName(COSName.O,"List"); list.setName(COSName.getPDFName("ListNumbering"),node.listNumbering); el.getCOSObject().setItem(COSName.A,list);
        }
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
            Map<Integer, COSArray> parentArraysByPageKey) throws IOException {

        // Derive child context from current — threshold updates to
        // boolean flags happen here before the recursive call so all
        // descendants see the right ancestor state.
        TreeContext childCtx = ctx.descend();
        childCtx.parentType = node.type;
        if ("THead".equals(node.type)) childCtx.insideTHead = true;
        if (node.lang != null && !node.lang.isEmpty()) childCtx.inheritedLang = node.lang;

        List<PageMcRef> myRefs = refsByTag.getOrDefault(node.id, java.util.Collections.emptyList());
        List<PDStructureElement> childElements = new ArrayList<>();
        for (TagTreeNode child : node.children) {
            PDStructureElement childEl = buildStructureSubtree(treeRoot, child, childCtx, refsByTag, parentArraysByPageKey);
            if (childEl != null) childElements.add(childEl);
        }
        boolean hasSemanticText = node.actualText != null && !node.actualText.isEmpty();
        boolean hasAltText = node.alt != null && !node.alt.isEmpty();
        // Empty TDs carry grid position without painted content. Do not extend
        // this exception to unmatched source text, empty headers or orphan cells.
        boolean keepEmptyCell = node.intentionallyEmptyDataCell && "TR".equals(ctx.parentType);
        if (myRefs.isEmpty() && childElements.isEmpty() && !hasSemanticText && !hasAltText && !keepEmptyCell) return null;

        PDStructureElement el = new PDStructureElement(node.type, treeRoot);
        if (node.lang != null && !node.lang.isEmpty()) el.setLanguage(node.lang);
        if (node.alt != null && !node.alt.isEmpty()) el.setAlternateDescription(node.alt);
        if (node.actualText != null && !node.actualText.isEmpty()) el.setActualText(node.actualText);
        if ("Aside".equals(node.type)) {
            el.getCOSObject().setString(COSName.getPDFName("ID"), noteStructureId(node));
        }

        applyTableAttributes(el, node, ctx);
        if (!el.getCOSObject().containsKey(COSName.ID)) el.getCOSObject().setString(COSName.ID, "oat:" + node.id);

        AuthoredText.StructureRuns authoredRuns = new AuthoredText.StructureRuns();
        for (PageMcRef ref : myRefs) {
            // Emit an MCR dict kid so multi-page elements carry a
            // per-ref /Pg. For single-page elements this is redundant
            // with setPage, but it's correct in both cases and avoids
            // a separate code path.
            COSDictionary mcrDict = new COSDictionary();
            mcrDict.setItem(COSName.TYPE, COSName.getPDFName("MCR"));
            mcrDict.setInt(COSName.MCID, ref.mcid);
            mcrDict.setItem(COSName.PG, ref.page.getCOSObject());
            if (ref.stream != null) mcrDict.setItem(COSName.getPDFName("Stm"), ref.stream.getCOSObject());
            PDMarkedContentReference mcr = new PDMarkedContentReference(mcrDict);

            PDStructureElement containerForMcr=el;
            NativeLinkOwnership.Link matched=ref.link;
            if(matched!=null&&matched.eligible) {
                if(matched.element==null) {
                    if("Link".equals(node.type))matched.element=el;
                    else {
                        matched.element=new PDStructureElement("Link",el);matched.element.setPage(ref.page);
                        matched.element.getCOSObject().setString(COSName.ID,"oat-native-link:"+matched.pageNumber+":"+matched.index);
                        el.appendKid(matched.element);
                    }
                }
                containerForMcr=matched.element;
            }

            containerForMcr = authoredRuns.parent(containerForMcr, ref.authoredText);
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

        return "note-" + element;
    }

    private static String sanitizeNoteIdPart(String raw) {
        return raw == null ? "" : raw.replaceAll("[^A-Za-z0-9_.-]+", "-");
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

        // Parent tree: one slot per page or invoked Form content stream.
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

            nextPageKey = installFormParents(plan, nextPageKey, parentArraysByPageKey);
            for (Assignment assignment : plan.assignments) {
                // Create structure element
                PDStructureElement element = new PDStructureElement(assignment.tagType, docElement);
                docElement.appendKid(element);

                // Link to page and MCID
                element.setPage(page);
                PDFormXObject stream = plan.forms.get(assignment.operators.get(0).streamOrigin);
                COSDictionary mcr = new COSDictionary();
                mcr.setItem(COSName.TYPE, COSName.getPDFName("MCR"));
                mcr.setItem(COSName.PG, page.getCOSObject());
                mcr.setInt(COSName.MCID, assignment.mcid);
                if (stream != null) mcr.setItem(COSName.getPDFName("Stm"), stream.getCOSObject());
                element.appendKid(new PDMarkedContentReference(mcr));
                COSArray ownerArray = stream == null ? parentArray : parentArraysByPageKey.get(stream.getCOSObject().getInt(COSName.STRUCT_PARENTS));

                // Add to parent array at the MCID index
                while (ownerArray.size() <= assignment.mcid) {
                    ownerArray.add(COSNull.NULL);
                }
                ownerArray.set(assignment.mcid, element.getCOSObject());
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

    private static void collectOcrLines(TagTreeNode node, List<OcrTextLayer.Line> lines) {
        if(node==null)return;
        lines.addAll(node.ocrSegments);
        for(TagTreeNode child:node.children)collectOcrLines(child,lines);
    }

    private static int countStructureElements(COSBase raw, Set<COSBase> seen, int depth) throws IOException {
        if(depth>128 || seen.size()>200000)throw new IOException("Structure count limit exceeded");
        COSBase value=raw instanceof COSObject?((COSObject)raw).getObject():raw;
        if(value==null || !seen.add(value))return 0;
        int count=0;
        if(value instanceof COSArray)for(COSBase child:(COSArray)value)count+=countStructureElements(child,seen,depth+1);
        else if(value instanceof COSDictionary && "StructElem".equals(((COSDictionary)value).getNameAsString(COSName.TYPE)))
            count=1+countStructureElements(((COSDictionary)value).getItem(COSName.K),seen,depth+1);
        return count;
    }

    public static void main(String[] args) throws Exception {
        String pdfPath = null;
        String ocrFontPath = null;
        List<String> ocrFallbackFonts = new ArrayList<>();
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
                case "--ocr-font":
                    if (i + 1 < args.length) ocrFontPath = args[++i];
                    break;
                case "--ocr-fallback-font":
                    if (i + 1 < args.length) ocrFallbackFonts.add(args[++i]);
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
        int splitMarkedContentRuns = 0;
        TagTreeNode tagTree = tagsPath == null ? null : parseTaggingTree(readFile(tagsPath));
        Map<String,TagTreeNode> listLabels=new HashMap<>();collectListLabels(tagTree,listLabels);

        System.err.println("[rewriter] Tag plan has " + plans.size() + " page(s)");

        // Load and modify the PDF
        try (PDDocument doc = Loader.loadPDF(new File(pdfPath))) {
            List<OcrTextLayer.Line> ocrLines=new ArrayList<>(); collectOcrLines(tagTree,ocrLines);
            OcrTextLayer.Fonts ocrFonts=null;
            if (!ocrLines.isEmpty()) {
                if (ocrFontPath==null) throw new IOException("OCR requires an explicit embedded font");
                if (ocrLines.size()>100000) throw new IOException("OCR line limit exceeded");
                List<PDFont> available=new ArrayList<>();
                available.add(org.apache.pdfbox.pdmodel.font.PDType0Font.load(doc,new File(ocrFontPath)));
                if(ocrFallbackFonts.size()>8)throw new IOException("OCR fallback font limit exceeded");
                for(String file:ocrFallbackFonts)available.add(org.apache.pdfbox.pdmodel.font.PDType0Font.load(doc,new File(file)));
                ocrFonts=new OcrTextLayer.Fonts(available);
                Set<Integer> plannedPages=new HashSet<>();for(PagePlan p:plans)plannedPages.add(p.pageNumber);
                for(OcrTextLayer.Line line:ocrLines) {
                    if(line.pageNumber()<1 || line.pageNumber()>doc.getNumberOfPages() || !plannedPages.contains(line.pageNumber())) throw new IOException("OCR page is not in the native plan");
                    OcrTextLayer.validate(doc.getPage(line.pageNumber()-1),line,ocrFonts);
                }
            }
            AuthoredText authoredText = new AuthoredText(doc);
            List<String> suppressedActualText = new ArrayList<>();
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
                prepareNativeLinks(doc,plan);
                splitMarkedContentRuns += splitAssignmentsIntoMarkedRuns(plan);
                System.err.println("[rewriter] Rewriting page " + plan.pageNumber
                        + " (" + plan.assignments.size() + " assignments, "
                        + plan.unmatchedOperatorSeqs.size() + " unmatched ops)");

                RewriteResult res = rewritePageContentStream(doc, page, plan, listLabels, authoredText);
                List<OcrTextLayer.Line> pageLines=ocrLines.stream().filter(l->l.pageNumber()==plan.pageNumber).toList();
                int ocrMcid=plan.assignments.stream().mapToInt(a->a.mcid).max().orElse(-1)+1;
                OcrTextLayer.append(doc,page,pageLines,ocrFonts,ocrMcid);
                for(OcrTextLayer.Line line:pageLines) {
                    Assignment a=new Assignment();a.tagNodeId=line.tagId();a.tagType=line.type();a.mcid=ocrMcid++;a.emitted=true;
                    OpRef ref=new OpRef();ref.x=line.quad()[6];ref.y=line.quad()[7];ref.text=line.text();a.operators.add(ref);
                    plan.assignments.add(a);
                }
                totalAssignments += plan.assignments.size();
                totalMcids += plan.assignments.size();
                totalArtifacts += res.artifactWrapped;
                totalTaggedWrapped += res.taggedWrapped + pageLines.size();
                totalSkippedInsideSourceMC += res.skippedInsideSourceMarkedContent;
                pagesRewritten++;
            }

            // Hierarchical structure tree when --tags is supplied
            // (normal path). Falls back to flat Document-has-all-leaves
            // when omitted, for backward compat with older callers.
            authoredText.verify();
            if (!authoredText.scopes.isEmpty()) {
                if (tagTree == null) tagTree = flatTagTree(plans);
                Set<String> owners = new HashSet<>();
                for (AuthoredText.Scope scope : authoredText.scopes) owners.add(scope.owner);
                clearGeneratedReplacement(tagTree, owners, suppressedActualText);
            }
            buildStructureTreeHierarchical(doc, plans, tagTree);

            // Retain the shared metadata, structure, Unicode and link handling.
            // Native mode must not substitute source font families merely to
            // reduce validation findings; those need qualified font repair.
            // The rewriter's own applyMetadata used a single-
            // rdf:Description XMP that VeraPDF's XMPChecker didn't
            // like; the shared pass emits canonical multi-Description
            // XMP synced to /Info (so infoMatchesXmp=true), fills
            // /ViewerPreferences/DisplayDocTitle, attaches /Name to
            // OCProperties configs,
            // auto-generates ToUnicode CMaps, and backfills
            // /Contents on Link annotations.
            try {
                String summary = PassthroughMetadataCli.applyPdfUaAccessibilityPass(doc, title, language, false, false);
                System.err.println("[rewriter] accessibility pass: " + summary);
            } catch (IOException e) {
                System.err.println("[rewriter] WARNING: accessibility pass failed, falling back to legacy metadata: " + e.getMessage());
                applyMetadata(doc, title, language);
            }

            for(PagePlan plan:plans)if(plan.links!=null)plan.links.restoreAuthoredContents();

            // Cleanup can remove empty elements. Rebuild the index from the final reachable tree.
            StructureIdentifiers.install(doc.getDocumentCatalog().getStructureTreeRoot());
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
            json.append(",\"preservedAuthoredTextScopes\":").append(authoredText.scopes.stream().filter(s -> !s.shadowed).count());
            json.append(",\"shadowedAuthoredTextScopes\":").append(authoredText.scopes.stream().filter(s -> s.shadowed).count());
            json.append(",\"suppressedGeneratedActualText\":[");
            for (int i = 0; i < suppressedActualText.size(); i++) { if (i > 0) json.append(','); json.append(escapeJson(suppressedActualText.get(i))); }
            json.append(']');
            json.append(",\"totalAssignments\":").append(totalAssignments);
            json.append(",\"ocrTextLines\":").append(ocrLines.size());
            json.append(",\"structureElementCount\":").append(countStructureElements(doc.getDocumentCatalog().getStructureTreeRoot().getCOSObject().getItem(COSName.K),Collections.newSetFromMap(new IdentityHashMap<>()),0));
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
            json.append(",\"nativeLinks\":").append(QualifiedStructureRepairs.json(plans.stream().filter(p->p.links!=null).flatMap(p->p.links.links.stream()).map(NativeLinkOwnership.Link::report).toList()));
            json.append(",\"sourceOwnership\":[").append(String.join(",", plans.stream().flatMap(p->p.sourceOwnership.stream()).toList())).append("]");
            json.append("}");
            System.out.write((json.toString()+"\n").getBytes(StandardCharsets.UTF_8));
        }
    }
}
