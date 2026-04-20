import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";

const execFileP = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const buildDir = getRuntimeBuildDir("pdf-writer-hierarchy", { repoRoot });
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");
const fixturesExt = path.join(moduleDir, "fixtures", "external");
const externalPdfs = path.join(repoRoot, "test", "fixtures", "external");

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

// Inline Java probe that inspects the StructTreeRoot of an output
// PDF and prints JSON: max nesting depth, total element count, set
// of role names, whether the tree has any Table>TR>TD pattern, and
// TH /Scope attribute coverage. Kept inline so the test is
// self-contained.
const probeSource = `
import java.io.File;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.*;

public class InspectHierarchy {
  static int maxDepth = 0;
  static int elementCount = 0;
  static int thCount = 0;
  static int thColumnScope = 0;
  static int thRowScope = 0;
  static int thMissingScope = 0;
  static Set<String> roles = new LinkedHashSet<>();
  static boolean hasTableTrTd = false;
  static Set<String> parentChildPairs = new HashSet<>();

  static String extractScope(PDStructureElement el) {
    COSBase aBase = el.getCOSObject().getDictionaryObject(COSName.A);
    if (aBase instanceof COSArray) {
      for (COSBase e : ((COSArray) aBase)) if (e instanceof COSDictionary) {
        COSDictionary d = (COSDictionary) e;
        COSBase scope = d.getDictionaryObject(COSName.getPDFName("Scope"));
        if (scope instanceof COSName) return ((COSName) scope).getName();
      }
    } else if (aBase instanceof COSDictionary) {
      COSBase scope = ((COSDictionary) aBase).getDictionaryObject(COSName.getPDFName("Scope"));
      if (scope instanceof COSName) return ((COSName) scope).getName();
    }
    return null;
  }

  static void walk(Object node, int depth, String parentRole) {
    maxDepth = Math.max(maxDepth, depth);
    List<Object> kids = Collections.emptyList();
    String role = null;
    if (node instanceof PDStructureTreeRoot) {
      kids = ((PDStructureTreeRoot) node).getKids();
    } else if (node instanceof PDStructureElement) {
      PDStructureElement el = (PDStructureElement) node;
      role = el.getStructureType();
      kids = el.getKids();
      elementCount++;
      roles.add(role);
      if (parentRole != null) parentChildPairs.add(parentRole + ">" + role);
      if ("TH".equals(role)) {
        thCount++;
        String scope = extractScope(el);
        if ("Column".equals(scope)) thColumnScope++;
        else if ("Row".equals(scope)) thRowScope++;
        else thMissingScope++;
      }
    }
    for (Object k : kids) {
      if (k instanceof PDStructureElement || k instanceof PDStructureTreeRoot) walk(k, depth+1, role);
    }
  }

  public static void main(String[] args) throws Exception {
    try (PDDocument doc = Loader.loadPDF(new File(args[0]))) {
      PDStructureTreeRoot root = doc.getDocumentCatalog().getStructureTreeRoot();
      walk(root, 0, null);
    }
    hasTableTrTd = parentChildPairs.contains("Table>TR") && parentChildPairs.contains("TR>TD");
    StringBuilder sb = new StringBuilder("{");
    sb.append("\\"maxDepth\\":").append(maxDepth);
    sb.append(",\\"elementCount\\":").append(elementCount);
    sb.append(",\\"hasTableTrTd\\":").append(hasTableTrTd);
    sb.append(",\\"thCount\\":").append(thCount);
    sb.append(",\\"thColumnScope\\":").append(thColumnScope);
    sb.append(",\\"thRowScope\\":").append(thRowScope);
    sb.append(",\\"thMissingScope\\":").append(thMissingScope);
    sb.append(",\\"roles\\":[");
    boolean first = true;
    for (String r : roles) { if (!first) sb.append(","); sb.append("\\"").append(r).append("\\""); first=false; }
    sb.append("]}");
    System.out.println(sb.toString());
  }
}
`;

test("rewriter builds hierarchical StructTreeRoot (not flat) on irs-p1040-tax-tables", async (t) => {
  const fixture = "irs-p1040-tax-tables";
  const pdfPath = path.join(externalPdfs, `${fixture}.pdf`);
  const semanticPath = path.join(fixturesExt, fixture, "semantic-ordered.json");
  const tagsPath = path.join(fixturesExt, fixture, "tagging.json");
  if (!existsSync(pdfPath) || !existsSync(semanticPath) || !existsSync(tagsPath)) {
    t.skip(`missing fixture artifacts for ${fixture}`);
    return;
  }

  await compileNative();
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome });

  const opsPath = path.join(buildDir, `${fixture}-hier-operators.json`);
  const planPath = path.join(buildDir, `${fixture}-hier-plan.json`);
  const taggedPath = path.join(buildDir, `${fixture}-hier.pdf`);
  await execFileP(java, ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
    "--pdf", pdfPath, "--output", opsPath], { env, maxBuffer: 500 * 1024 * 1024 });
  await execFileP(java, ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeTagMatcher",
    "--operators", opsPath, "--semantic", semanticPath, "--tags", tagsPath, "--output", planPath],
    { env, maxBuffer: 500 * 1024 * 1024 });
  await execFileP(java, ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamRewriter",
    "--pdf", pdfPath, "--tag-plan", planPath, "--tags", tagsPath, "--output", taggedPath],
    { env, maxBuffer: 500 * 1024 * 1024 });

  const probePath = path.join(buildDir, "InspectHierarchy.java");
  await writeFile(probePath, probeSource);
  await execFileP(javac, ["-encoding", "UTF-8", "-cp", pdfboxJar, "-d", buildDir, probePath], { env });
  const { stdout } = await execFileP(java, ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "InspectHierarchy", taggedPath], { env });

  const report = JSON.parse(stdout.trim());
  // Pre-fix the tree was flat (Document > leaves, maxDepth=2).
  // Post-fix it carries Sect > H1/Table, Table > TR, TR > TD (depth ≥ 5).
  assert.ok(report.maxDepth >= 4,
    `maxDepth ${report.maxDepth} too shallow — hierarchy regression, output is flat again. Report: ${JSON.stringify(report)}`);
  assert.equal(report.hasTableTrTd, true,
    `Table>TR>TD parent-child chain missing — tag-builder hierarchy was flattened. Report: ${JSON.stringify(report)}`);
  assert.ok(report.elementCount > 1000,
    `elementCount ${report.elementCount} far below the expected ~3000 for this fixture`);
  // Matterhorn 15-003: every TH must carry a /Scope. JAWS/NVDA
  // silently drop header announcements when Scope is absent. We
  // pin both the total count and zero-tolerance on missing Scope.
  assert.ok(report.thCount > 0,
    `expected TH elements in irs-p1040-tax-tables, got ${report.thCount}`);
  assert.equal(report.thMissingScope, 0,
    `${report.thMissingScope} TH elements lack /Scope — Matterhorn 15-003 fail. Report: ${JSON.stringify(report)}`);
  assert.ok(report.thColumnScope > 0,
    `expected column-header TH elements (TH inside THead) in this fixture, got 0. Report: ${JSON.stringify(report)}`);
});
