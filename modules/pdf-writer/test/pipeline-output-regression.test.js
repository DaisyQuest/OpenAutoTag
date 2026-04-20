import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";
import { validateTaggedArtifacts } from "../../validator/index.js";

const execFileP = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const buildDir = getRuntimeBuildDir("pipeline-output-regression", { repoRoot });
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");
const lrbTestDir = path.join(repoRoot, "test", "LRBTest");
const externalPdfDir = path.join(repoRoot, "test", "fixtures", "external");
const lrbFixtures = path.join(moduleDir, "fixtures");
const externalFixtures = path.join(moduleDir, "fixtures", "external");

// Corpus-wide allowlist of VeraPDF + font-audit finding codes that the
// pipeline output is expected to carry today. Measured 2026-04-18 across
// all 27 corpus PDFs (15 LRBTest + 12 external, 6 external without source
// PDFs are skipped). The test asserts "at most these codes" — if the
// writer starts producing a NEW failure mode not in this list, the test
// fails; if a future fix removes a code, the test still passes.
//
// What this DOESN'T catch: Adobe Acrobat's "error in this PDF" dialog,
// which is based on proprietary content-stream validation rules not
// exposed by PDFBox load or VeraPDF. Treat that as an orthogonal failure
// mode requiring separate verification.
const ALLOWED_FINDING_CODES = new Set([
  // VeraPDF rule findings. Each of these is either a legitimate known
  // limitation (e.g., unembedded Standard 14 inside Form XObjects that
  // we deliberately don't touch per the "skip Form XObject font
  // replacement" trade-off) or a PDFBox-backend false positive that we
  // conditionally suppress when the independent metadata probe confirms
  // correctness, and which leaks through on docs that don't trip the
  // suppression gates (e.g., docs with no link annotations, or where
  // PDFBox's infoMatchesXmp helper returns false despite the metadata
  // being structurally intact).
  "VERAPDF_7_21_4_1_1",   // Font program not embedded (XObject-nested Standard 14)
  "VERAPDF_7_21_4_1_2",   // Font file references not resolvable (surfaces on Gutenberg / old pdfTeX outputs)
  "VERAPDF_7_21_3_2_1",   // Font widths array mismatch — source-PDF issue on academic PDFs
  "VERAPDF_7_21_5_1",     // Metrics inconsistency across Standard 14 substitutes
  "VERAPDF_7_21_6_2",     // Font-file metric conformance (Noto substitute vs source Times/Courier widths)
  "VERAPDF_7_21_8_1",     // .notdef glyph in OCR layer fonts (HiddenHorzOCR etc.) — source-PDF issue
  "VERAPDF_7_21_4_2_2",   // CIDToGIDMap not sync'd with CharProcs for some producers
  "VERAPDF_7_21_7_1",     // Font ToUnicode incomplete — arxiv/academic PDFs
  "VERAPDF_7_18_5_1",     // Link annot /StructParent — suppressed when metadata probe confirms; leaks when probe unavailable
  "VERAPDF_7_18_1_3",     // Annot missing Contents on non-link annotations
  "VERAPDF_7_18_4_1",     // Annot missing /Alt or /Contents entries
  "VERAPDF_7_11_1",       // Optional content not mapped to struct tree (irs-p1040 only)
  "VERAPDF_7_2_14",       // Language tag mismatch on specific struct elements
  "VERAPDF_5_1",          // XMP metadata mismatch false positive when suppression gate doesn't fire
  "VERAPDF_7_1_9",        // XMP metadata mismatch false positive when suppression gate doesn't fire
  // Our own font-audit findings. These are warnings/errors that document
  // known font-embedding limitations in the source, not writer failures.
  "FONT_STANDARD_14",
  "FONT_NOT_EMBEDDED",
  "TO_UNICODE_MISSING",
  "TO_UNICODE_INCOMPLETE",     // font emits ToUnicode but some codes still resolve to U+FFFD / empty
  "SYMBOLIC_WITHOUT_DIFFERENCES",
  "LICENSE_RESTRICTED"     // IRS PDFs declare /Perms that block modification flags
]);

async function compileNative() {
  const sources = [
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamParser.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeTagMatcher.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamRewriter.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "PassthroughMetadataCli.java")
  ];
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => false,
    compile: async () => {
      const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      await execFileP(javac, ["-encoding", "UTF-8", "-cp", pdfboxJar, "-d", buildDir, ...sources], {
        env: await buildJavaExecEnv({ bundledJavaHome })
      });
    }
  });
  await mkdir(buildDir, { recursive: true });
}

// Inline PDFBox probe: try-loads the tagged output, walks the structure
// tree, extracts text from the first 3 pages, and reports everything as
// a single JSON line so the test can assert on the measured state.
const probeSource = `
import java.io.File;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.*;
import org.apache.pdfbox.text.PDFTextStripper;

public class ProbeTaggedOutput {
  static int maxDepth = 0;
  static int elementCount = 0;
  static int thCount = 0;
  static int thMissingScope = 0;
  static int imbalancedPages = 0;
  static int pagesWithDuplicateMcid = 0;
  static int missingStructParents = 0;
  static int missingTabsS = 0;

  static String extractScope(PDStructureElement el) {
    COSBase aBase = el.getCOSObject().getDictionaryObject(COSName.A);
    if (aBase instanceof COSArray) {
      for (COSBase e : ((COSArray) aBase)) if (e instanceof COSDictionary) {
        COSBase scope = ((COSDictionary) e).getDictionaryObject(COSName.getPDFName("Scope"));
        if (scope instanceof COSName) return ((COSName) scope).getName();
      }
    } else if (aBase instanceof COSDictionary) {
      COSBase scope = ((COSDictionary) aBase).getDictionaryObject(COSName.getPDFName("Scope"));
      if (scope instanceof COSName) return ((COSName) scope).getName();
    }
    return null;
  }

  static void walk(Object node, int depth) {
    maxDepth = Math.max(maxDepth, depth);
    List<Object> kids = Collections.emptyList();
    if (node instanceof PDStructureTreeRoot) {
      kids = ((PDStructureTreeRoot) node).getKids();
    } else if (node instanceof PDStructureElement) {
      PDStructureElement el = (PDStructureElement) node;
      String role = el.getStructureType();
      kids = el.getKids();
      elementCount++;
      if ("TH".equals(role)) {
        thCount++;
        if (extractScope(el) == null) thMissingScope++;
      }
    }
    for (Object k : kids) {
      if (k instanceof PDStructureElement || k instanceof PDStructureTreeRoot) walk(k, depth + 1);
    }
  }

  public static void main(String[] args) throws Exception {
    boolean loaded = false;
    String loadError = null;
    int pageCount = 0;
    int textLength = 0;
    boolean hasStructTree = false;
    try (PDDocument doc = Loader.loadPDF(new File(args[0]))) {
      loaded = true;
      pageCount = doc.getNumberOfPages();
      PDStructureTreeRoot root = doc.getDocumentCatalog().getStructureTreeRoot();
      if (root != null) {
        hasStructTree = true;
        walk(root, 0);
      }
      // Count pages whose marked-content (BDC/BMC vs EMC) is unbalanced.
      // An imbalance is a silent reading-order regression: NVDA and JAWS
      // fall back to content-stream order on affected pages even though
      // PAC/VeraPDF pass. See PDF 32000-1 §14.6 for the LIFO invariant.
      //
      // Also tracked per-page for additional sanity checks:
      //   - mcidsByPage : the set of MCIDs that appear in BDC markers
      //     on each page. If any MCID repeats on the same page, the
      //     struct tree can't unambiguously resolve leaves to content.
      //   - pagesWithDuplicateMcid : count of pages that violate MCID
      //     uniqueness. Zero is the only acceptable value.
      java.util.Map<COSDictionary, java.util.List<Integer>> mcidsByPage = new java.util.HashMap<>();
      for (PDPage page : doc.getPages()) {
        PDFStreamParser parser = new PDFStreamParser(page);
        int depth = 0;
        java.util.List<Integer> pageMcids = new java.util.ArrayList<>();
        java.util.List<COSBase> operands = new java.util.ArrayList<>();
        Object token;
        while ((token = parser.parseNextToken()) != null) {
          if (token instanceof Operator) {
            String n = ((Operator) token).getName();
            if ("BDC".equals(n) || "BMC".equals(n)) {
              depth++;
              for (COSBase b : operands) {
                if (b instanceof COSDictionary) {
                  COSBase v = ((COSDictionary) b).getDictionaryObject(COSName.MCID);
                  if (v instanceof COSInteger) pageMcids.add(((COSInteger) v).intValue());
                }
              }
            }
            else if ("EMC".equals(n)) depth--;
            operands.clear();
          } else if (token instanceof COSBase) operands.add((COSBase) token);
        }
        if (depth != 0) imbalancedPages++;
        mcidsByPage.put(page.getCOSObject(), pageMcids);
      }
      // Per-page MCID uniqueness check.
      for (var e : mcidsByPage.entrySet()) {
        java.util.Set<Integer> s = new java.util.HashSet<>();
        for (int m : e.getValue()) if (!s.add(m)) { pagesWithDuplicateMcid++; break; }
      }
      // Check every page with MCIDs has /StructParents + /Tabs=S.
      for (PDPage page : doc.getPages()) {
        java.util.List<Integer> mcids = mcidsByPage.get(page.getCOSObject());
        if (mcids == null || mcids.isEmpty()) continue;
        COSBase sp = page.getCOSObject().getDictionaryObject(COSName.getPDFName("StructParents"));
        if (!(sp instanceof COSInteger)) missingStructParents++;
        COSBase tabs = page.getCOSObject().getDictionaryObject(COSName.getPDFName("Tabs"));
        if (!(tabs instanceof COSName) || !"S".equals(((COSName) tabs).getName())) missingTabsS++;
      }
      try {
        PDFTextStripper stripper = new PDFTextStripper();
        stripper.setStartPage(1);
        stripper.setEndPage(Math.min(3, pageCount));
        textLength = stripper.getText(doc).length();
      } catch (Throwable t) { /* leave textLength=0 */ }
    } catch (Throwable t) {
      loadError = t.getClass().getSimpleName() + ": " + t.getMessage();
    }
    StringBuilder sb = new StringBuilder("{");
    sb.append("\\"loaded\\":").append(loaded);
    if (loadError != null) sb.append(",\\"loadError\\":").append(jsonStr(loadError));
    sb.append(",\\"pageCount\\":").append(pageCount);
    sb.append(",\\"hasStructTree\\":").append(hasStructTree);
    sb.append(",\\"maxDepth\\":").append(maxDepth);
    sb.append(",\\"elementCount\\":").append(elementCount);
    sb.append(",\\"thCount\\":").append(thCount);
    sb.append(",\\"thMissingScope\\":").append(thMissingScope);
    sb.append(",\\"imbalancedPages\\":").append(imbalancedPages);
    sb.append(",\\"pagesWithDuplicateMcid\\":").append(pagesWithDuplicateMcid);
    sb.append(",\\"missingStructParents\\":").append(missingStructParents);
    sb.append(",\\"missingTabsS\\":").append(missingTabsS);
    sb.append(",\\"textLength\\":").append(textLength);
    sb.append("}");
    System.out.println(sb.toString());
  }

  static String jsonStr(String s) {
    if (s == null) return "null";
    StringBuilder sb = new StringBuilder("\\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '\\\\' || c == '"') sb.append('\\\\').append(c);
      else if (c < 0x20) sb.append(String.format("\\\\u%04x", (int) c));
      else sb.append(c);
    }
    sb.append("\\"");
    return sb.toString();
  }
}
`;

async function compileProbe(javac, env) {
  const probePath = path.join(buildDir, "ProbeTaggedOutput.java");
  await writeFile(probePath, probeSource);
  await execFileP(javac, ["-encoding", "UTF-8", "-cp", pdfboxJar, "-d", buildDir, probePath], { env });
}

async function runOneDoc(javac, java, env, label, pdfPath, fixtureDir) {
  const semanticPath = path.join(fixtureDir, "semantic-ordered.json");
  const tagsPath = path.join(fixtureDir, "tagging.json");
  if (!existsSync(pdfPath) || !existsSync(semanticPath) || !existsSync(tagsPath)) {
    return { label, skip: "missing-artifact" };
  }

  const opsPath = path.join(buildDir, `${label}-ops.json`);
  const planPath = path.join(buildDir, `${label}-plan.json`);
  const taggedPath = path.join(buildDir, `${label}-tagged.pdf`);
  const manifestPath = taggedPath + ".manifest.json";

  const cp = `${buildDir}${path.delimiter}${pdfboxJar}`;
  const opts = { env, maxBuffer: 500 * 1024 * 1024 };

  await execFileP(java, ["-cp", cp, "NativeContentStreamParser", "--pdf", pdfPath, "--output", opsPath], opts);
  await execFileP(java, ["-cp", cp, "NativeTagMatcher", "--operators", opsPath, "--semantic", semanticPath, "--tags", tagsPath, "--output", planPath], opts);
  await execFileP(java, ["-cp", cp, "NativeContentStreamRewriter", "--pdf", pdfPath, "--tag-plan", planPath, "--tags", tagsPath, "--output", taggedPath], opts);

  // Build a real tagging-manifest wrapper around the source tagging.json
  // so the validator's buildManifestFindings path doesn't emit stub-
  // manifest findings (which would otherwise pollute the allowlist).
  const taggingDoc = JSON.parse(await readFile(tagsPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({
    tagging: taggingDoc,
    nativeTaggingApplied: true
  }));

  const { stdout } = await execFileP(java, ["-cp", cp, "ProbeTaggedOutput", taggedPath], opts);
  const probe = JSON.parse(stdout.trim());

  const validation = await validateTaggedArtifacts({ pdfPath: taggedPath, manifestPath, skipFontAudit: false });
  const findingCodes = (validation.findings || []).map(f => f.code);

  return { label, probe, findingCodes };
}

/**
 * End-to-end rewriter regression: runs parser → matcher → rewriter on
 * every corpus PDF and asserts invariants on the TAGGED OUTPUT PDF —
 * filling the gap between the matcher-output tests (which stop at the
 * tag plan) and the user-observable question of whether the writer
 * produces a PDF that actually loads and validates. The Adobe "error in
 * this PDF" class of failure slipped through precisely because no test
 * loaded the writer output and asserted non-brokenness on it.
 *
 * Baseline measured 2026-04-18 across 27 corpus PDFs:
 *   - 27/27 load cleanly in PDFBox (no content-stream corruption)
 *   - 27/27 have a struct tree with ≥1 element
 *   - 27/27 extract non-empty text from the first 3 pages
 *   - 0 TH elements missing /Scope (Matterhorn 15-003)
 *   - 16 distinct finding codes across the corpus — all in the pinned
 *     allowlist below
 */
test("pipeline-output regression: tagged PDFs across corpus are loadable and findings are within allowlist", async (t) => {
  await compileNative();
  const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome });
  await compileProbe(javac, env);

  const lrbSubdirs = existsSync(lrbFixtures)
    ? (await readdir(lrbFixtures, { withFileTypes: true }))
        .filter(d => d.isDirectory() && /^(06-tagged|2025_|2026_)/.test(d.name))
        .map(d => d.name).sort()
    : [];
  const extSubdirs = existsSync(externalFixtures)
    ? (await readdir(externalFixtures, { withFileTypes: true }))
        .filter(d => d.isDirectory()).map(d => d.name).sort()
    : [];

  const corpus = [];
  for (const name of lrbSubdirs) {
    const pdfPath = name === "06-tagged"
      ? path.join(lrbTestDir, "06-tagged.pdf")
      : path.join(lrbTestDir, `${name}.pdf`);
    corpus.push({ label: `lrb-${name}`, pdfPath, fixtureDir: path.join(lrbFixtures, name) });
  }
  for (const name of extSubdirs) {
    corpus.push({
      label: `ext-${name}`,
      pdfPath: path.join(externalPdfDir, `${name}.pdf`),
      fixtureDir: path.join(externalFixtures, name)
    });
  }

  if (corpus.length === 0) {
    t.skip("no corpus fixtures present");
    return;
  }

  const unexpectedCodesByDoc = new Map();
  let totalEvaluated = 0;
  let totalThMissingScope = 0;
  let totalImbalancedPages = 0;

  for (const { label, pdfPath, fixtureDir } of corpus) {
    await t.test(label, async (subt) => {
      const r = await runOneDoc(javac, java, env, label, pdfPath, fixtureDir);
      if (r.skip) {
        subt.skip(`${label}: ${r.skip}`);
        return;
      }
      totalEvaluated++;
      totalThMissingScope += r.probe.thMissingScope;
      totalImbalancedPages += r.probe.imbalancedPages;

      assert.equal(r.probe.loaded, true,
        `${label}: tagged output failed to load in PDFBox: ${r.probe.loadError}`);
      assert.equal(r.probe.hasStructTree, true,
        `${label}: tagged output has no StructTreeRoot`);
      assert.ok(r.probe.elementCount > 0,
        `${label}: struct tree has zero elements`);
      assert.ok(r.probe.textLength > 0,
        `${label}: PDFTextStripper extracted zero characters from first 3 pages`);
      assert.ok(r.probe.maxDepth >= 2,
        `${label}: struct tree depth ${r.probe.maxDepth} below floor of 2`);
      assert.equal(r.probe.thMissingScope, 0,
        `${label}: ${r.probe.thMissingScope} TH elements lack /Scope (Matterhorn 15-003)`);
      assert.equal(r.probe.imbalancedPages, 0,
        `${label}: ${r.probe.imbalancedPages} page(s) have imbalanced BDC/EMC — silent reading-order regression for NVDA/JAWS`);
      assert.equal(r.probe.pagesWithDuplicateMcid, 0,
        `${label}: ${r.probe.pagesWithDuplicateMcid} page(s) have duplicate MCIDs — struct tree can't unambiguously resolve tagged content`);
      assert.equal(r.probe.missingStructParents, 0,
        `${label}: ${r.probe.missingStructParents} page(s) with MCIDs lack /StructParents — parent-tree reverse lookup broken`);
      assert.equal(r.probe.missingTabsS, 0,
        `${label}: ${r.probe.missingTabsS} page(s) with annotations lack /Tabs=S — Matterhorn 28-008/009`);

      const unexpected = r.findingCodes.filter(c => !ALLOWED_FINDING_CODES.has(c));
      if (unexpected.length > 0) unexpectedCodesByDoc.set(label, unexpected);
    });
  }

  await t.test("corpus aggregate: findings within allowlist, minimum coverage", () => {
    assert.ok(totalEvaluated >= 12,
      `expected ≥12 corpus docs evaluated, got ${totalEvaluated}`);
    assert.equal(totalThMissingScope, 0,
      `${totalThMissingScope} TH elements missing /Scope across corpus`);
    assert.equal(totalImbalancedPages, 0,
      `${totalImbalancedPages} pages across corpus have imbalanced BDC/EMC marked-content`);
    if (unexpectedCodesByDoc.size > 0) {
      const summary = [...unexpectedCodesByDoc.entries()]
        .map(([doc, codes]) => `${doc}: ${codes.join(",")}`).join("; ");
      assert.fail(`Unexpected finding codes (not in ALLOWED_FINDING_CODES): ${summary}`);
    }
  });
});
