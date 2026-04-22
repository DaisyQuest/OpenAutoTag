package buildeverything.servlet;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Contract-backed schema guard for drag/drop operations. The valid tag
 * vocabulary is loaded from contracts/tagging.schema.json, while the structural
 * containment rules encode the PDF/UA table/list constraints the UI must
 * enforce before mutating reading order.
 */
public final class TagSchemaRules {
    private final Set<String> validTypes;
    private final Map<String, Set<String>> allowedChildren;

    private TagSchemaRules(Set<String> validTypes, Map<String, Set<String>> allowedChildren) {
        this.validTypes = Set.copyOf(validTypes);
        this.allowedChildren = Map.copyOf(allowedChildren);
    }

    public static TagSchemaRules fromContract(Path contractPath) throws IOException {
        String contract = Files.readString(contractPath, StandardCharsets.UTF_8);
        Object parsed = JsonSupport.parse(contract);
        Set<String> types = extractEnumValues(parsed);
        if (!types.contains("Document") || !types.contains("Table") || !types.contains("TR") || !types.contains("TD")) {
            throw new IOException("tagging.schema.json does not expose the required PDF tag vocabulary");
        }
        Map<String, Set<String>> rules = new LinkedHashMap<>(buildRules(types));
        Map<String, Set<String>> contractRules = extractContainmentRules(parsed, types);
        if (!contractRules.isEmpty()) {
            rules.putAll(contractRules);
        }
        return new TagSchemaRules(types, rules);
    }

    public boolean isValidType(String type) {
        return validTypes.contains(type);
    }

    public boolean isDropAllowed(String parentType, String childType) {
        if (!isValidType(parentType) || !isValidType(childType)) {
            return false;
        }
        Set<String> allowed = allowedChildren.get(parentType);
        return allowed != null && allowed.contains(childType);
    }

    public String explainDrop(String parentType, String childType) {
        if (!isValidType(parentType)) {
            return "Unknown parent tag <" + parentType + "> is not declared by contracts/tagging.schema.json.";
        }
        if (!isValidType(childType)) {
            return "Unknown child tag <" + childType + "> is not declared by contracts/tagging.schema.json.";
        }
        if (isDropAllowed(parentType, childType)) {
            return "<" + childType + "> can be placed inside <" + parentType + ">.";
        }
        if ("Table".equals(parentType)) {
            return "Table children must be table sections or rows; place content inside <TR>/<TH>/<TD>.";
        }
        if ("TR".equals(parentType)) {
            return "Table rows can contain only <TH> or <TD> cells.";
        }
        if ("TD".equals(childType) || "TH".equals(childType)) {
            return "Table cells must remain inside a <TR>.";
        }
        return "<" + childType + "> cannot be placed directly inside <" + parentType + "> under the tag schema.";
    }

    public Set<String> validTypes() {
        return validTypes;
    }

    private static Set<String> extractEnumValues(Object node) throws IOException {
        Set<String> values = findEnumValues(node);
        if (values != null) {
            return values;
        }
        Set<String> declaredTypes = collectDeclaredTypes(node);
        if (declaredTypes.contains("Document") && declaredTypes.contains("P")) {
            return declaredTypes;
        }
        throw new IOException("Unable to locate tagNode.type enum in tagging.schema.json");
    }

    private static Set<String> findEnumValues(Object node) {
        if (node instanceof Map<?, ?> map) {
            Object enumValue = map.get("enum");
            if (enumValue instanceof List<?> list) {
                Set<String> values = new HashSet<>();
                for (Object entry : list) {
                    if (entry instanceof String stringValue) {
                        values.add(stringValue);
                    }
                }
                if (values.contains("Document") && values.contains("P")) {
                    return values;
                }
            }
            for (Object value : map.values()) {
                Set<String> nested = findEnumValues(value);
                if (nested != null) {
                    return nested;
                }
            }
        } else if (node instanceof List<?> list) {
            for (Object entry : list) {
                Set<String> nested = findEnumValues(entry);
                if (nested != null) {
                    return nested;
                }
            }
        }
        return null;
    }

    private static Set<String> collectDeclaredTypes(Object node) {
        Set<String> values = new HashSet<>();
        collectDeclaredTypes(node, values);
        return values;
    }

    private static void collectDeclaredTypes(Object node, Set<String> values) {
        if (node instanceof Map<?, ?> map) {
            Object typeProperty = map.get("type");
            if (typeProperty instanceof Map<?, ?> typeSchema) {
                collectTypeSchemaValues(typeSchema, values);
            }
            for (Object value : map.values()) {
                collectDeclaredTypes(value, values);
            }
        } else if (node instanceof List<?> list) {
            for (Object entry : list) {
                collectDeclaredTypes(entry, values);
            }
        }
    }

    private static void collectTypeSchemaValues(Map<?, ?> schema, Set<String> values) {
        Object constValue = schema.get("const");
        if (constValue instanceof String stringValue) {
            values.add(stringValue);
        }
        Object enumValue = schema.get("enum");
        if (enumValue instanceof List<?> list) {
            for (Object entry : list) {
                if (entry instanceof String stringValue) {
                    values.add(stringValue);
                }
            }
        }
    }

    private static Map<String, Set<String>> extractContainmentRules(Object node, Set<String> validTypes) {
        if (node instanceof Map<?, ?> map) {
            for (String key : List.of("tagContainment", "containment", "allowedChildren", "tagContainmentContract")) {
                Object candidate = map.get(key);
                Map<String, Set<String>> rules = parseContainmentCandidate(candidate, validTypes);
                if (!rules.isEmpty()) {
                    return rules;
                }
            }
            for (Object value : map.values()) {
                Map<String, Set<String>> nested = extractContainmentRules(value, validTypes);
                if (!nested.isEmpty()) {
                    return nested;
                }
            }
        } else if (node instanceof List<?> list) {
            for (Object entry : list) {
                Map<String, Set<String>> nested = extractContainmentRules(entry, validTypes);
                if (!nested.isEmpty()) {
                    return nested;
                }
            }
        }
        return Map.of();
    }

    private static Map<String, Set<String>> parseContainmentCandidate(Object candidate, Set<String> validTypes) {
        Map<String, Set<String>> rules = new LinkedHashMap<>();
        if (candidate instanceof Map<?, ?> map) {
            String explicitParent = firstString(map, "parent", "parentType", "type", "tag");
            Set<String> explicitChildren = extractChildTypes(
                    firstNonNull(map, "children", "allowedChildren", "contains", "childTypes"),
                    validTypes);
            if (explicitParent != null && !explicitChildren.isEmpty() && validTypes.contains(explicitParent)) {
                rules.put(explicitParent, Set.copyOf(explicitChildren));
            }

            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String parentType) || !validTypes.contains(parentType)) {
                    continue;
                }
                Set<String> children = extractChildTypes(entry.getValue(), validTypes);
                rules.put(parentType, Set.copyOf(children));
            }
        } else if (candidate instanceof List<?> list) {
            for (Object entry : list) {
                if (entry instanceof Map<?, ?> map) {
                    String parent = firstString(map, "parent", "parentType", "type", "tag");
                    Set<String> children = extractChildTypes(
                            firstNonNull(map, "children", "allowedChildren", "contains", "childTypes"),
                            validTypes);
                    if (parent != null && validTypes.contains(parent) && !children.isEmpty()) {
                        rules.put(parent, Set.copyOf(children));
                    }
                }
            }
        }
        return rules;
    }

    private static Set<String> extractChildTypes(Object node, Set<String> validTypes) {
        Set<String> children = new HashSet<>();
        if (node instanceof List<?> list) {
            for (Object entry : list) {
                if (entry instanceof String stringValue && validTypes.contains(stringValue)) {
                    children.add(stringValue);
                }
            }
        } else if (node instanceof String stringValue) {
            if (validTypes.contains(stringValue)) {
                children.add(stringValue);
            }
        } else if (node instanceof Map<?, ?> map) {
            Object nested = firstNonNull(map, "children", "allowedChildren", "contains", "childTypes");
            if (nested != null) {
                children.addAll(extractChildTypes(nested, validTypes));
            }
        }
        return children;
    }

    private static Object firstNonNull(Map<?, ?> map, String... keys) {
        for (String key : keys) {
            Object value = map.get(key);
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private static String firstString(Map<?, ?> map, String... keys) {
        Object value = firstNonNull(map, keys);
        return value instanceof String stringValue ? stringValue : null;
    }

    private static Map<String, Set<String>> buildRules(Set<String> validTypes) {
        Map<String, Set<String>> rules = new HashMap<>();
        Set<String> flow = subset(validTypes, "Sect", "Title", "H1", "H2", "H3", "H4", "H5", "H6", "P", "L",
                "Figure", "Aside", "BlockQuote", "Span", "Form", "Table", "Caption");
        put(rules, validTypes, "Document", flow);
        put(rules, validTypes, "Sect", flow);
        put(rules, validTypes, "Aside", flow);
        put(rules, validTypes, "BlockQuote", flow);
        put(rules, validTypes, "Form", flow);
        put(rules, validTypes, "L", subset(validTypes, "LI"));
        put(rules, validTypes, "LI", flow);
        put(rules, validTypes, "Table", subset(validTypes, "Caption", "THead", "TBody", "TFoot", "TR"));
        put(rules, validTypes, "THead", subset(validTypes, "TR"));
        put(rules, validTypes, "TBody", subset(validTypes, "TR"));
        put(rules, validTypes, "TFoot", subset(validTypes, "TR"));
        put(rules, validTypes, "TR", subset(validTypes, "TH", "TD"));
        put(rules, validTypes, "TH", flow);
        put(rules, validTypes, "TD", flow);
        put(rules, validTypes, "Figure", subset(validTypes, "Caption"));
        put(rules, validTypes, "P", subset(validTypes, "Span"));
        put(rules, validTypes, "Span", subset(validTypes, "Span"));
        for (String heading : List.of("Title", "H1", "H2", "H3", "H4", "H5", "H6", "Caption")) {
            put(rules, validTypes, heading, subset(validTypes, "Span"));
        }
        return rules;
    }

    private static Set<String> subset(Set<String> validTypes, String... candidates) {
        Set<String> subset = new HashSet<>();
        for (String candidate : candidates) {
            if (validTypes.contains(candidate)) {
                subset.add(candidate);
            }
        }
        return subset;
    }

    private static void put(Map<String, Set<String>> rules, Set<String> validTypes, String parent, Set<String> children) {
        if (!validTypes.contains(parent)) {
            return;
        }
        rules.put(parent, Set.copyOf(children));
    }

    public static Path defaultContractPath(Path repoRoot) {
        return repoRoot.resolve("contracts").resolve("tagging.schema.json");
    }

    public static Path resolveRepoRoot(Path start) {
        Path current = start.toAbsolutePath().normalize();
        List<Path> candidates = new ArrayList<>();
        candidates.add(current);
        Path parent = current.getParent();
        while (parent != null) {
            candidates.add(parent);
            parent = parent.getParent();
        }
        for (Path candidate : candidates) {
            if (Files.exists(defaultContractPath(candidate))) {
                return candidate;
            }
        }
        throw new IllegalArgumentException("Unable to locate OpenAutoTag repo root from " + start);
    }

    public static String normalizeType(String value) {
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        if (trimmed.length() < 2) {
            return trimmed.toUpperCase(Locale.ROOT);
        }
        return trimmed.substring(0, 1).toUpperCase(Locale.ROOT) + trimmed.substring(1);
    }
}

final class JsonSupport {
    private final String text;
    private int index;

    private JsonSupport(String text) {
        this.text = text;
    }

    static Object parse(String text) throws IOException {
        JsonSupport parser = new JsonSupport(text);
        Object value = parser.parseValue();
        parser.skipWhitespace();
        if (!parser.isEof()) {
            throw parser.error("Unexpected trailing content");
        }
        return value;
    }

    private Object parseValue() throws IOException {
        skipWhitespace();
        if (isEof()) {
            throw error("Unexpected end of JSON");
        }
        char ch = text.charAt(index);
        return switch (ch) {
            case '{' -> parseObject();
            case '[' -> parseArray();
            case '"' -> parseString();
            case 't' -> parseLiteral("true", Boolean.TRUE);
            case 'f' -> parseLiteral("false", Boolean.FALSE);
            case 'n' -> parseLiteral("null", null);
            default -> {
                if (ch == '-' || Character.isDigit(ch)) {
                    yield parseNumber();
                }
                throw error("Unexpected character '" + ch + "'");
            }
        };
    }

    private Map<String, Object> parseObject() throws IOException {
        expect('{');
        Map<String, Object> object = new LinkedHashMap<>();
        skipWhitespace();
        if (consume('}')) {
            return object;
        }
        while (true) {
            skipWhitespace();
            if (peek() != '"') {
                throw error("Expected string property name");
            }
            String key = parseString();
            skipWhitespace();
            expect(':');
            Object value = parseValue();
            object.put(key, value);
            skipWhitespace();
            if (consume('}')) {
                return object;
            }
            expect(',');
        }
    }

    private List<Object> parseArray() throws IOException {
        expect('[');
        List<Object> values = new ArrayList<>();
        skipWhitespace();
        if (consume(']')) {
            return values;
        }
        while (true) {
            values.add(parseValue());
            skipWhitespace();
            if (consume(']')) {
                return values;
            }
            expect(',');
        }
    }

    private String parseString() throws IOException {
        expect('"');
        StringBuilder builder = new StringBuilder();
        while (!isEof()) {
            char ch = text.charAt(index++);
            if (ch == '"') {
                return builder.toString();
            }
            if (ch == '\\') {
                if (isEof()) {
                    throw error("Incomplete escape sequence");
                }
                char escaped = text.charAt(index++);
                switch (escaped) {
                    case '"', '\\', '/' -> builder.append(escaped);
                    case 'b' -> builder.append('\b');
                    case 'f' -> builder.append('\f');
                    case 'n' -> builder.append('\n');
                    case 'r' -> builder.append('\r');
                    case 't' -> builder.append('\t');
                    case 'u' -> builder.append(parseUnicodeEscape());
                    default -> throw error("Invalid escape sequence \\" + escaped);
                }
                continue;
            }
            builder.append(ch);
        }
        throw error("Unterminated string");
    }

    private char parseUnicodeEscape() throws IOException {
        if (index + 4 > text.length()) {
            throw error("Incomplete unicode escape");
        }
        int value = 0;
        for (int offset = 0; offset < 4; offset += 1) {
            char digit = text.charAt(index++);
            int numeric = Character.digit(digit, 16);
            if (numeric < 0) {
                throw error("Invalid unicode escape");
            }
            value = (value << 4) | numeric;
        }
        return (char) value;
    }

    private Object parseLiteral(String literal, Object value) throws IOException {
        if (!text.startsWith(literal, index)) {
            throw error("Expected '" + literal + "'");
        }
        index += literal.length();
        return value;
    }

    private Number parseNumber() throws IOException {
        int start = index;
        consume('-');
        consumeDigits();
        if (consume('.')) {
            consumeDigits();
        }
        if (consume('e') || consume('E')) {
            consume('+');
            consume('-');
            consumeDigits();
        }
        String token = text.substring(start, index);
        try {
            if (token.contains(".") || token.contains("e") || token.contains("E")) {
                return Double.parseDouble(token);
            }
            return Long.parseLong(token);
        } catch (NumberFormatException error) {
            throw error("Invalid number '" + token + "'");
        }
    }

    private void consumeDigits() throws IOException {
        int start = index;
        while (!isEof() && Character.isDigit(text.charAt(index))) {
            index += 1;
        }
        if (start == index) {
            throw error("Expected digit");
        }
    }

    private void skipWhitespace() {
        while (!isEof()) {
            char ch = text.charAt(index);
            if (ch != ' ' && ch != '\n' && ch != '\r' && ch != '\t') {
                return;
            }
            index += 1;
        }
    }

    private boolean consume(char expected) {
        if (!isEof() && text.charAt(index) == expected) {
            index += 1;
            return true;
        }
        return false;
    }

    private void expect(char expected) throws IOException {
        if (!consume(expected)) {
            throw error("Expected '" + expected + "'");
        }
    }

    private char peek() throws IOException {
        if (isEof()) {
            throw error("Unexpected end of JSON");
        }
        return text.charAt(index);
    }

    private boolean isEof() {
        return index >= text.length();
    }

    private IOException error(String message) {
        return new IOException(message + " at position " + index);
    }
}
