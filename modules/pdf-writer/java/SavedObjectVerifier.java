import java.io.*;
import java.nio.file.Path;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.PDDocument;

/** Shared saved-object comparison for bounded incremental writer passes. */
public final class SavedObjectVerifier {
    private static final int MAX_NODES = 200000, MAX_DEPTH = 128, MAX_STREAM = 64 * 1024 * 1024;
    private static COSBase resolve(COSBase v) { return v instanceof COSObject ? ((COSObject)v).getObject() : v; }
    private static byte[] bytes(COSStream stream) throws IOException {
        try (InputStream in = stream.createInputStream()) {
            byte[] data = in.readNBytes(MAX_STREAM + 1);
            if (data.length > MAX_STREAM) throw new IOException("Comparison stream limit exceeded");
            return data;
        }
    }
    /** Compare the entire reachable object graph to a fresh replay, not just font counts.
     * Existing indirect identities, aliasing, strings and decoded streams must survive. */
    private static final class Comparison {
        final Map<COSBase, COSBase> pairs = new IdentityHashMap<>(), reverse = new IdentityHashMap<>();
        int nodes; long streamBytes;
        void same(COSBase a, COSBase b, String location, int depth) throws IOException {
            if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new IOException("Comparison traversal limit exceeded");
            a = resolve(a); b = resolve(b);
            if (a == null || a instanceof COSNull) { if (b != null && !(b instanceof COSNull)) fail(location); return; }
            if (b == null || a instanceof COSStream != b instanceof COSStream) { fail(location); return; }
            if (a.getKey() != null && !a.getKey().equals(b.getKey())) fail(location + " identity");
            if (a instanceof COSArray || a instanceof COSDictionary) {
                if (pairs.containsKey(a)) { if (pairs.get(a) != b) fail(location + " shared object"); return; }
                if (reverse.containsKey(b)) fail(location + " aliased object");
                pairs.put(a, b); reverse.put(b, a);
            }
            if (a instanceof COSArray && b instanceof COSArray) {
                COSArray x = (COSArray)a, y = (COSArray)b;
                if (x.size() != y.size()) fail(location + " size");
                for (int i = 0; i < x.size(); i++) same(x.get(i), y.get(i), location + "[" + i + "]", depth + 1);
            } else if (a instanceof COSDictionary && b instanceof COSDictionary) {
                COSDictionary x = (COSDictionary)a, y = (COSDictionary)b;
                Set<COSName> keys = new TreeSet<>(Comparator.comparing(COSName::getName)); keys.addAll(x.keySet()); keys.addAll(y.keySet());
                for (COSName key : keys) {
                    if (a instanceof COSStream && Set.of(COSName.LENGTH, COSName.FILTER, COSName.DECODE_PARMS).contains(key)) continue;
                    if (x.containsKey(key) != y.containsKey(key)) fail(location + "/" + key.getName());
                    same(x.getItem(key), y.getItem(key), location + "/" + key.getName(), depth + 1);
                }
                if (a instanceof COSStream) {
                    byte[] xBytes = bytes((COSStream)a), yBytes = bytes((COSStream)b); streamBytes += xBytes.length + yBytes.length;
                    if (streamBytes > 512L * 1024 * 1024) throw new IOException("Comparison stream budget exceeded");
                    if (!Arrays.equals(xBytes, yBytes)) fail(location + " decoded bytes");
                }
            } else if (a instanceof COSString && b instanceof COSString) {
                if (!Arrays.equals(((COSString)a).getBytes(), ((COSString)b).getBytes())) fail(location);
            } else if (!a.equals(b)) fail(location);
        }
        private void fail(String path) throws IOException { throw new IOException("Unexpected saved-object change at " + path); }
    }
    public static Map<String, Object> verify(PDDocument expected, Path candidate) throws IOException {
        try (PDDocument actual = Loader.loadPDF(candidate.toFile())) {
            Comparison comparison = new Comparison();
            comparison.same(expected.getDocumentCatalog().getCOSObject(), actual.getDocumentCatalog().getCOSObject(), "Catalog", 0);
            comparison.same(expected.getDocument().getTrailer().getItem(COSName.INFO), actual.getDocument().getTrailer().getItem(COSName.INFO), "Info", 0);
            return Map.of("status", "pass", "scope", "catalog-and-info", "reason", "Saved objects equal the source with only the requested qualified repairs applied");
        } catch (IOException e) { return Map.of("status", "fail", "scope", "catalog-and-info", "reason", e.getMessage()); }
    }
}
