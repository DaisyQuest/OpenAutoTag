import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Operator-to-tag matcher for native PDF tagging.
 *
 * Connects content stream operators (from NativeContentStreamParser) to semantic
 * nodes and tag tree MCIDs using position + text matching. Produces a native tag
 * plan JSON that maps each operator to its corresponding structural tag.
 *
 * Key coordinate handling: PDF y=0 is at page bottom; semantic bbox y=0 is at
 * page top. The matcher flips operator y via: convertedY = pageHeight - operator.y
 */
public class NativeTagMatcher {

    // ---------------------------------------------------------------
    //  Minimal JSON tokeniser (same approach as other Java CLI tools)
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

        JsonLexer(String src) {
            this.src = src;
            this.pos = 0;
        }

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
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }

        private void readString() {
            pos++; // skip opening quote
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

    // ---------------------------------------------------------------
    //  Generic JSON value types (Object = Map, Array = List, etc.)
    // ---------------------------------------------------------------

    static Object parseJson(String src) {
        JsonLexer lex = new JsonLexer(src);
        lex.next();
        Object val = parseValue(lex);
        return val;
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

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseObject(JsonLexer lex) {
        Map<String, Object> map = new HashMap<>();
        lex.next(); // skip {
        if (lex.tokenType == TOK_RBRACE) { lex.next(); return map; }
        while (true) {
            if (lex.tokenType != TOK_STRING) throw new RuntimeException("Expected string key");
            String key = lex.tokenValue;
            lex.next(); // skip key
            if (lex.tokenType != TOK_COLON) throw new RuntimeException("Expected ':'");
            lex.next(); // skip :
            map.put(key, parseValue(lex));
            if (lex.tokenType == TOK_COMMA) { lex.next(); continue; }
            if (lex.tokenType == TOK_RBRACE) { lex.next(); return map; }
            throw new RuntimeException("Expected ',' or '}' in object");
        }
    }

    private static List<Object> parseArray(JsonLexer lex) {
        List<Object> list = new ArrayList<>();
        lex.next(); // skip [
        if (lex.tokenType == TOK_RBRACKET) { lex.next(); return list; }
        while (true) {
            list.add(parseValue(lex));
            if (lex.tokenType == TOK_COMMA) { lex.next(); continue; }
            if (lex.tokenType == TOK_RBRACKET) { lex.next(); return list; }
            throw new RuntimeException("Expected ',' or ']' in array");
        }
    }

    // ---------------------------------------------------------------
    //  Convenience accessors for parsed JSON maps/lists
    // ---------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object o) {
        return o == null ? new ArrayList<>() : (List<Object>) o;
    }

    private static String asString(Object o) {
        return o == null ? "" : o.toString();
    }

    private static double asDouble(Object o) {
        if (o instanceof Number) return ((Number) o).doubleValue();
        if (o instanceof String) {
            try { return Double.parseDouble((String) o); } catch (NumberFormatException e) { return 0; }
        }
        return 0;
    }

    private static int asInt(Object o) {
        return (int) asDouble(o);
    }

    // ---------------------------------------------------------------
    //  Data holders
    // ---------------------------------------------------------------

    static class OpInfo {
        int seq;
        String op;
        String text;
        double x;
        double y; // raw PDF coordinate (y=0 at bottom)
        String fontName;
        double fontSize;
        int glyphs;
        int page;
    }

    static class SemanticNode {
        String id;
        int pageNumber;
        String role;
        String text;
        double bboxX, bboxY, bboxW, bboxH; // bbox y=0 at top
        double confidence;
        int readingOrder;
    }

    static class TagNode {
        String id;
        String type;
        List<String> sourceNodeIds = new ArrayList<>();
        List<TagNode> children = new ArrayList<>();
    }

    static class OperatorAssignment {
        int seq;
        String text;
        double x;
        double y;
        double confidence;
    }

    static class Assignment {
        String tagNodeId;
        String tagType;
        int mcid;
        List<OperatorAssignment> operators = new ArrayList<>();
        double matchConfidence;
        double textCoverage;
    }

    // ---------------------------------------------------------------
    //  Parsing input JSONs into data holders
    // ---------------------------------------------------------------

    private static List<List<OpInfo>> parseOperators(Object json) {
        Map<String, Object> root = asMap(json);
        List<Object> pages = asList(root.get("pages"));
        List<List<OpInfo>> result = new ArrayList<>();
        for (Object pageObj : pages) {
            Map<String, Object> page = asMap(pageObj);
            List<Object> ops = asList(page.get("operators"));
            List<OpInfo> pageOps = new ArrayList<>();
            int pageNum = asInt(page.get("pageNumber"));
            for (Object opObj : ops) {
                Map<String, Object> om = asMap(opObj);
                OpInfo oi = new OpInfo();
                oi.seq = asInt(om.get("seq"));
                oi.op = asString(om.get("op"));
                oi.text = asString(om.get("text"));
                oi.x = asDouble(om.get("x"));
                oi.y = asDouble(om.get("y"));
                oi.fontName = asString(om.get("font"));
                oi.fontSize = asDouble(om.get("fontSize"));
                oi.glyphs = asInt(om.get("glyphs"));
                oi.page = pageNum;
                pageOps.add(oi);
            }
            result.add(pageOps);
        }
        return result;
    }

    private static List<SemanticNode> parseSemanticNodes(Object json) {
        Map<String, Object> root = asMap(json);
        List<Object> nodes = asList(root.get("nodes"));
        List<SemanticNode> result = new ArrayList<>();
        for (Object nodeObj : nodes) {
            Map<String, Object> nm = asMap(nodeObj);
            SemanticNode sn = new SemanticNode();
            sn.id = asString(nm.get("id"));
            sn.pageNumber = asInt(nm.get("pageNumber"));
            sn.role = asString(nm.get("role"));
            sn.text = asString(nm.get("text"));
            sn.confidence = nm.containsKey("confidence") ? asDouble(nm.get("confidence")) : 1.0;
            sn.readingOrder = nm.containsKey("readingOrder") ? asInt(nm.get("readingOrder")) : 0;

            List<Object> bbox = asList(nm.get("bbox"));
            if (bbox.size() >= 4) {
                sn.bboxX = asDouble(bbox.get(0));
                sn.bboxY = asDouble(bbox.get(1));
                sn.bboxW = asDouble(bbox.get(2));
                sn.bboxH = asDouble(bbox.get(3));
            }
            result.add(sn);
        }
        return result;
    }

    private static TagNode parseTagNode(Object json) {
        Map<String, Object> nm = asMap(json);
        TagNode tn = new TagNode();
        tn.id = asString(nm.get("id"));
        tn.type = asString(nm.get("type"));
        List<Object> srcIds = asList(nm.get("sourceNodeIds"));
        for (Object s : srcIds) tn.sourceNodeIds.add(asString(s));
        List<Object> children = asList(nm.get("children"));
        for (Object child : children) tn.children.add(parseTagNode(child));
        return tn;
    }

    private static void flattenTagTree(TagNode node, List<TagNode> out) {
        out.add(node);
        for (TagNode child : node.children) flattenTagTree(child, out);
    }

    // ---------------------------------------------------------------
    //  Text similarity (normalised Jaccard on character bigrams)
    // ---------------------------------------------------------------

    private static String normalizeText(String s) {
        return s.toLowerCase().replaceAll("\\s+", " ").trim();
    }

    private static double textSimilarity(String a, String b) {
        String na = normalizeText(a);
        String nb = normalizeText(b);
        if (na.isEmpty() && nb.isEmpty()) return 1.0;
        if (na.isEmpty() || nb.isEmpty()) return 0.0;
        if (na.equals(nb)) return 1.0;

        // Check if one contains the other
        if (na.contains(nb) || nb.contains(na)) {
            double shorter = Math.min(na.length(), nb.length());
            double longer = Math.max(na.length(), nb.length());
            return shorter / longer;
        }

        // Character bigram Jaccard
        Map<String, Integer> bigramsA = bigrams(na);
        Map<String, Integer> bigramsB = bigrams(nb);
        int intersection = 0;
        int union = 0;
        for (Map.Entry<String, Integer> e : bigramsA.entrySet()) {
            int countB = bigramsB.getOrDefault(e.getKey(), 0);
            intersection += Math.min(e.getValue(), countB);
        }
        for (Map.Entry<String, Integer> e : bigramsA.entrySet()) union += e.getValue();
        for (Map.Entry<String, Integer> e : bigramsB.entrySet()) union += e.getValue();
        union -= intersection;
        return union == 0 ? 0 : (double) intersection / union;
    }

    private static Map<String, Integer> bigrams(String s) {
        Map<String, Integer> map = new HashMap<>();
        for (int i = 0; i < s.length() - 1; i++) {
            String bg = s.substring(i, i + 2);
            map.merge(bg, 1, Integer::sum);
        }
        return map;
    }

    // ---------------------------------------------------------------
    //  Matching algorithm
    // ---------------------------------------------------------------

    private static double operatorConfidence(double dx, double dy, double textSim) {
        double dist = Math.sqrt(dx * dx + dy * dy);
        if (textSim >= 0.5 && dist <= 2.0) return 1.0;
        if (textSim >= 0.5 && dist <= 10.0) return 0.8;
        if (dist <= 10.0) return 0.5; // position match, text mismatch
        return 0.0;
    }

    /**
     * Match operators on a given page to semantic nodes.
     * Returns a list of assignments and a list of unmatched operator indices.
     */
    private static MatchResult matchPage(
            List<OpInfo> operators,
            List<SemanticNode> pageNodes,
            List<TagNode> flatTags,
            double pageHeight,
            double tolerance) {

        // Build semantic-id to tag-node map
        Map<String, TagNode> semanticToTag = new HashMap<>();
        for (TagNode tn : flatTags) {
            for (String srcId : tn.sourceNodeIds) {
                semanticToTag.put(srcId, tn);
            }
        }

        // Track which operators have been assigned
        boolean[] assigned = new boolean[operators.size()];

        // MCID counter for this page
        int nextMcid = 0;

        // Group semantic nodes by tag node id (multiple semantic nodes may map to same tag)
        // Process in reading order
        List<SemanticNode> sortedNodes = new ArrayList<>(pageNodes);
        sortedNodes.sort((a, b) -> Integer.compare(a.readingOrder, b.readingOrder));

        // Group by tag node
        Map<String, List<SemanticNode>> tagToSemantic = new HashMap<>();
        Map<String, TagNode> tagById = new HashMap<>();
        for (SemanticNode sn : sortedNodes) {
            TagNode tn = semanticToTag.get(sn.id);
            if (tn != null) {
                tagToSemantic.computeIfAbsent(tn.id, k -> new ArrayList<>()).add(sn);
                tagById.put(tn.id, tn);
            }
        }

        List<Assignment> assignments = new ArrayList<>();

        // Process each tag group
        for (SemanticNode sn : sortedNodes) {
            TagNode tn = semanticToTag.get(sn.id);
            if (tn == null) continue;

            // Only process once per tag node - skip if first semantic node for this tag isn't this one
            List<SemanticNode> tagSemNodes = tagToSemantic.get(tn.id);
            if (tagSemNodes == null || tagSemNodes.get(0) != sn) continue;

            // Compute combined bbox for all semantic nodes under this tag
            double minX = Double.MAX_VALUE, minY = Double.MAX_VALUE;
            double maxX = Double.MIN_VALUE, maxY = Double.MIN_VALUE;
            StringBuilder combinedText = new StringBuilder();
            for (SemanticNode tsn : tagSemNodes) {
                minX = Math.min(minX, tsn.bboxX);
                minY = Math.min(minY, tsn.bboxY);
                maxX = Math.max(maxX, tsn.bboxX + tsn.bboxW);
                maxY = Math.max(maxY, tsn.bboxY + tsn.bboxH);
                if (combinedText.length() > 0) combinedText.append(" ");
                combinedText.append(tsn.text);
            }

            String nodeText = combinedText.toString();
            Assignment asgn = new Assignment();
            asgn.tagNodeId = tn.id;
            asgn.tagType = tn.type;
            asgn.mcid = nextMcid++;

            // Match operators
            StringBuilder matchedText = new StringBuilder();
            double totalConfidence = 0;
            int matchCount = 0;

            for (int i = 0; i < operators.size(); i++) {
                if (assigned[i]) continue;
                OpInfo op = operators.get(i);
                if (op.text.trim().isEmpty()) continue;

                // Convert operator PDF y to top-origin y
                double convertedY = pageHeight - op.y;

                // Check position within bbox + tolerance
                double nodeMinX = minX - tolerance;
                double nodeMaxX = maxX + tolerance;
                double nodeMinY = minY - tolerance;
                double nodeMaxY = maxY + tolerance;

                if (op.x < nodeMinX || op.x > nodeMaxX) continue;
                if (convertedY < nodeMinY || convertedY > nodeMaxY) continue;

                // Position is within range - compute text similarity for this operator
                double textSim = textSimilarity(op.text.trim(), nodeText);

                // Also check if operator text appears as substring in the node text
                String normalizedOpText = normalizeText(op.text);
                String normalizedNodeText = normalizeText(nodeText);
                if (normalizedNodeText.contains(normalizedOpText) && normalizedOpText.length() > 0) {
                    textSim = Math.max(textSim, 0.8);
                }

                double dx = 0, dy = 0;
                // Distance to nearest bbox edge (0 if inside)
                if (op.x < minX) dx = minX - op.x;
                else if (op.x > maxX) dx = op.x - maxX;
                if (convertedY < minY) dy = minY - convertedY;
                else if (convertedY > maxY) dy = convertedY - maxY;

                double conf = operatorConfidence(dx, dy, textSim);
                if (conf <= 0.0) continue;

                OperatorAssignment oa = new OperatorAssignment();
                oa.seq = op.seq;
                oa.text = op.text;
                oa.x = op.x;
                oa.y = op.y;
                oa.confidence = conf;
                asgn.operators.add(oa);
                assigned[i] = true;
                totalConfidence += conf;
                matchCount++;
                matchedText.append(op.text);
            }

            if (asgn.operators.isEmpty()) {
                nextMcid--; // reclaim the MCID
                continue;
            }

            asgn.matchConfidence = matchCount > 0 ? totalConfidence / matchCount : 0;
            // Text coverage: how much of the node text is covered by matched operators
            String mText = normalizeText(matchedText.toString());
            String nText = normalizeText(nodeText);
            if (nText.isEmpty()) {
                asgn.textCoverage = mText.isEmpty() ? 1.0 : 0.0;
            } else {
                // Count characters from matched text that appear in node text
                asgn.textCoverage = Math.min(1.0, (double) mText.length() / nText.length());
            }
            assignments.add(asgn);
        }

        // Collect unmatched operators
        List<OpInfo> unmatched = new ArrayList<>();
        for (int i = 0; i < operators.size(); i++) {
            if (!assigned[i] && !operators.get(i).text.trim().isEmpty()) {
                unmatched.add(operators.get(i));
            }
        }

        MatchResult result = new MatchResult();
        result.assignments = assignments;
        result.unmatchedOperators = unmatched;
        result.totalOperators = (int) operators.stream().filter(o -> !o.text.trim().isEmpty()).count();
        return result;
    }

    static class MatchResult {
        List<Assignment> assignments;
        List<OpInfo> unmatchedOperators;
        int totalOperators;
    }

    // ---------------------------------------------------------------
    //  JSON output
    // ---------------------------------------------------------------

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

    private static String fmt(double v) {
        if (v == Math.floor(v) && !Double.isInfinite(v)) return String.valueOf((long) v);
        return String.format("%.2f", v);
    }

    // ---------------------------------------------------------------
    //  File reading
    // ---------------------------------------------------------------

    private static String readFile(String filePath) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new FileReader(filePath))) {
            char[] buf = new char[8192];
            int n;
            while ((n = reader.read(buf)) != -1) sb.append(buf, 0, n);
        }
        return sb.toString();
    }

    private static String readStdin() throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {
            char[] buf = new char[8192];
            int n;
            while ((n = reader.read(buf)) != -1) sb.append(buf, 0, n);
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------
    //  CLI main
    // ---------------------------------------------------------------

    public static void main(String[] args) throws Exception {
        String operatorsPath = null;
        String semanticPath = null;
        String tagsPath = null;
        double pageHeight = 792.0;
        double tolerance = 5.0;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--operators":
                    if (i + 1 < args.length) operatorsPath = args[++i];
                    break;
                case "--semantic":
                    if (i + 1 < args.length) semanticPath = args[++i];
                    break;
                case "--tags":
                    if (i + 1 < args.length) tagsPath = args[++i];
                    break;
                case "--page-height":
                    if (i + 1 < args.length) pageHeight = Double.parseDouble(args[++i]);
                    break;
                case "--tolerance":
                    if (i + 1 < args.length) tolerance = Double.parseDouble(args[++i]);
                    break;
            }
        }

        if (semanticPath == null || tagsPath == null) {
            System.err.println("Usage: java NativeTagMatcher --operators <operators.json> --semantic <semantic.json> --tags <tags.json> [--page-height <792>] [--tolerance <5>]");
            System.exit(1);
        }

        // Read operator data from file or stdin
        String operatorsJson;
        if (operatorsPath != null) {
            operatorsJson = readFile(operatorsPath);
        } else {
            operatorsJson = readStdin();
        }

        String semanticJson = readFile(semanticPath);
        String tagsJson = readFile(tagsPath);

        // Parse all inputs
        Object operatorData = parseJson(operatorsJson);
        Object semanticData = parseJson(semanticJson);
        Object tagsData = parseJson(tagsJson);

        List<List<OpInfo>> operatorPages = parseOperators(operatorData);
        List<SemanticNode> allSemanticNodes = parseSemanticNodes(semanticData);
        Map<String, Object> tagsRoot = asMap(tagsData);
        TagNode tagRoot = parseTagNode(tagsRoot.get("root"));

        // Flatten tag tree
        List<TagNode> flatTags = new ArrayList<>();
        flattenTagTree(tagRoot, flatTags);

        // Detect page height from operator data if available
        Map<String, Object> opRoot = asMap(operatorData);
        // Group semantic nodes by page
        Map<Integer, List<SemanticNode>> nodesByPage = new HashMap<>();
        for (SemanticNode sn : allSemanticNodes) {
            nodesByPage.computeIfAbsent(sn.pageNumber, k -> new ArrayList<>()).add(sn);
        }

        // Build output
        StringBuilder json = new StringBuilder();
        json.append("{\"pages\":[");

        int totalPages = operatorPages.size();
        int pagesAboveThreshold = 0;
        double totalMatchRate = 0;
        boolean firstPage = true;

        for (int p = 0; p < operatorPages.size(); p++) {
            List<OpInfo> pageOps = operatorPages.get(p);
            int pageNum = pageOps.isEmpty() ? (p + 1) : pageOps.get(0).page;
            List<SemanticNode> pageNodes = nodesByPage.getOrDefault(pageNum, new ArrayList<>());

            MatchResult result = matchPage(pageOps, pageNodes, flatTags, pageHeight, tolerance);

            int matched = result.totalOperators - result.unmatchedOperators.size();
            double matchRate = result.totalOperators > 0 ? (double) matched / result.totalOperators : 1.0;
            double meanConfidence = 0;
            int confCount = 0;
            for (Assignment a : result.assignments) {
                for (OperatorAssignment oa : a.operators) {
                    meanConfidence += oa.confidence;
                    confCount++;
                }
            }
            meanConfidence = confCount > 0 ? meanConfidence / confCount : 0;

            if (matchRate >= 0.8) pagesAboveThreshold++;
            totalMatchRate += matchRate;

            if (!firstPage) json.append(",");
            firstPage = false;

            json.append("{\"pageNumber\":").append(pageNum);
            json.append(",\"pageHeight\":").append(fmt(pageHeight));

            // Assignments
            json.append(",\"assignments\":[");
            for (int a = 0; a < result.assignments.size(); a++) {
                Assignment asgn = result.assignments.get(a);
                if (a > 0) json.append(",");
                json.append("{\"tagNodeId\":").append(escapeJson(asgn.tagNodeId));
                json.append(",\"tagType\":").append(escapeJson(asgn.tagType));
                json.append(",\"mcid\":").append(asgn.mcid);

                json.append(",\"operators\":[");
                for (int o = 0; o < asgn.operators.size(); o++) {
                    OperatorAssignment oa = asgn.operators.get(o);
                    if (o > 0) json.append(",");
                    json.append("{\"seq\":").append(oa.seq);
                    json.append(",\"text\":").append(escapeJson(oa.text));
                    json.append(",\"x\":").append(fmt(oa.x));
                    json.append(",\"y\":").append(fmt(oa.y));
                    json.append(",\"confidence\":").append(fmt(oa.confidence));
                    json.append("}");
                }
                json.append("]");

                json.append(",\"matchConfidence\":").append(fmt(asgn.matchConfidence));
                json.append(",\"textCoverage\":").append(fmt(asgn.textCoverage));
                json.append("}");
            }
            json.append("]");

            // Unmatched operators
            json.append(",\"unmatchedOperators\":[");
            for (int u = 0; u < result.unmatchedOperators.size(); u++) {
                OpInfo op = result.unmatchedOperators.get(u);
                if (u > 0) json.append(",");
                json.append("{\"seq\":").append(op.seq);
                json.append(",\"text\":").append(escapeJson(op.text));
                json.append(",\"x\":").append(fmt(op.x));
                json.append(",\"y\":").append(fmt(op.y));
                json.append("}");
            }
            json.append("]");

            // Summary
            json.append(",\"summary\":{");
            json.append("\"totalOperators\":").append(result.totalOperators);
            json.append(",\"matchedOperators\":").append(matched);
            json.append(",\"unmatchedOperators\":").append(result.unmatchedOperators.size());
            json.append(",\"matchRate\":").append(fmt(matchRate));
            json.append(",\"meanConfidence\":").append(fmt(meanConfidence));
            json.append("}}");
        }

        json.append("]");

        // Overall summary
        double meanMatchRate = totalPages > 0 ? totalMatchRate / totalPages : 0;
        json.append(",\"overall\":{");
        json.append("\"totalPages\":").append(totalPages);
        json.append(",\"meanMatchRate\":").append(fmt(meanMatchRate));
        json.append(",\"pagesAboveThreshold\":").append(pagesAboveThreshold);
        json.append(",\"nativeViable\":").append(meanMatchRate >= 0.7 && pagesAboveThreshold >= (totalPages * 0.5));
        json.append("}}");

        System.out.println(json.toString());
    }
}
