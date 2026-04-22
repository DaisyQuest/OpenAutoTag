import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceDir = path.join(repoRoot, "servlet", "src", "main", "java", "buildeverything", "servlet");

function javaTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  if (process.env.JAVA_HOME) {
    return path.join(process.env.JAVA_HOME, "bin", executable);
  }
  return executable;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
  assert.equal(
    result.status,
    0,
    [
      `${command} ${args.join(" ")} failed`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n")
  );
  return result;
}

test("perfect studio Java helpers compile and satisfy deterministic contracts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perfect-studio-java-"));
  const classesDir = path.join(tempDir, "classes");
  const harnessPath = path.join(tempDir, "PerfectStudioHarness.java");
  await writeFile(harnessPath, harnessSource(), "utf8");

  const javaFiles = [
    "StudioTag.java",
    "CoordinateMapper.java",
    "SoftPageImageCache.java",
    "TagSpatialIndex.java",
    "TagSchemaRules.java",
    "PerfectStudioHeadlessRunner.java"
  ].map((fileName) => path.join(sourceDir, fileName));

  run(javaTool("javac"), [
    "-encoding",
    "UTF-8",
    "-d",
    classesDir,
    ...javaFiles,
    harnessPath
  ]);

  const contractPath = path.join(repoRoot, "contracts", "tagging.schema.json");
  const result = run(javaTool("java"), [
    "-Djava.awt.headless=true",
    "-cp",
    classesDir,
    "PerfectStudioHarness",
    contractPath
  ]);
  assert.match(result.stdout, /perfect-studio-harness-ok/);
});

test("perfect studio implementation plan and test matrix are traceable to the spec", async () => {
  const planPath = path.join(repoRoot, "perfect-studio", "implementation-plan.md");
  const matrixPath = path.join(repoRoot, "perfect-studio", "test-matrix.md");
  await access(planPath);
  await access(matrixPath);

  const plan = await readFile(planPath, "utf8");
  const matrix = await readFile(matrixPath, "utf8");

  assert.match(plan, /Multi-Step Plan/);
  assert.match(plan, /CoordinateMapper/);
  assert.match(plan, /PerfectStudioHeadlessRunner/);
  assert.match(matrix, /Headless CLI/);
  assert.match(matrix, /Schema guard/);
  assert.match(matrix, /Spatial index/);
});

function harnessSource() {
  return String.raw`
import buildeverything.servlet.CoordinateMapper;
import buildeverything.servlet.PerfectStudioHeadlessRunner;
import buildeverything.servlet.SoftPageImageCache;
import buildeverything.servlet.StudioTag;
import buildeverything.servlet.TagSchemaRules;
import buildeverything.servlet.TagSpatialIndex;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class PerfectStudioHarness {
  public static void main(String[] args) throws Exception {
    Path contractPath = Path.of(args[0]);
    Path repoRoot = contractPath.getParent().getParent();
    TagSchemaRules rules = TagSchemaRules.fromContract(contractPath);
    check(rules.isValidType("Document"), "Document must be a valid contract type");
    check(rules.isValidType("TD"), "TD must be a valid contract type");
    check(!rules.isValidType("Part"), "Part is not present in the current tagging contract");
    check(rules.isDropAllowed("TR", "TD"), "TD belongs under TR");
    check(!rules.isDropAllowed("Table", "P"), "P must not drop directly into Table");
    check(!rules.isDropAllowed("Sect", "TD"), "TD must not drop directly into Sect");
    check(rules.explainDrop("Table", "P").contains("Table children"), "Table rejection should be explainable");

    Path containmentContract = Files.createTempFile("tag-containment-", ".json");
    Files.writeString(containmentContract, """
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "tagNode": {
      "properties": {
        "type": {
          "enum": ["Document", "Sect", "P", "Table", "TR", "TD"]
        }
      }
    }
  },
  "tagContainment": {
    "Document": ["Sect", "Table"],
    "Sect": ["P"],
    "Table": ["TR"],
    "TR": ["TD"]
  }
}
""");
    TagSchemaRules containmentRules = TagSchemaRules.fromContract(containmentContract);
    check(containmentRules.isDropAllowed("Document", "Sect"), "Explicit containment should allow Sect under Document");
    check(containmentRules.isDropAllowed("Table", "TR"), "Explicit containment should allow TR under Table");
    check(!containmentRules.isDropAllowed("Document", "P"), "Explicit containment should override the fallback flow rules");
    check(containmentRules.isDropAllowed("TR", "TD"), "Explicit containment should allow TD under TR");

    CoordinateMapper mapper = new CoordinateMapper(600, 800, 2.0, 16, 20, 10, 30, 1.25);
    Rectangle2D.Double pdfBox = new Rectangle2D.Double(100, 100, 50, 60);
    Rectangle2D.Double screenBox = mapper.toScreen(pdfBox);
    close(screenBox.width, 125.0, "screen width should include zoom and HiDPI scale");
    close(screenBox.height, 150.0, "screen height should include zoom and HiDPI scale");
    Rectangle2D.Double roundTrip = mapper.toPdf(screenBox);
    close(roundTrip.x, pdfBox.x, "round-trip x");
    close(roundTrip.y, pdfBox.y, "round-trip y");
    close(roundTrip.width, pdfBox.width, "round-trip width");
    close(roundTrip.height, pdfBox.height, "round-trip height");

    SoftPageImageCache cache = new SoftPageImageCache(3);
    cache.put(1, image());
    cache.put(2, image());
    cache.put(3, image());
    check(cache.get(2) != null, "page 2 should be readable");
    cache.put(4, image());
    check(!cache.cachedPages().contains(1), "least-recently-used page should be evicted");
    check(cache.cachedPages().contains(2), "recently accessed page should remain cached");
    cache.retainAround(4);
    check(cache.cachedPages().equals(java.util.Set.of(3, 4)), "retainAround keeps current page plus previous adjacent page");

    List<StudioTag> tags = new ArrayList<>();
    tags.add(new StudioTag("page", "Document", "page", 1, new Rectangle2D.Double(0, 0, 600, 800)));
    for (int index = 0; index < 12; index += 1) {
      tags.add(new StudioTag("p-" + index, "P", "paragraph", 1, new Rectangle2D.Double(20 + index * 20, 20 + index * 10, 12, 12)));
    }
    tags.add(new StudioTag("outer", "Figure", "outer", 1, new Rectangle2D.Double(100, 100, 80, 80)));
    tags.add(new StudioTag("nested", "Figure", "nested", 1, new Rectangle2D.Double(110, 110, 10, 10)));
    TagSpatialIndex index = new TagSpatialIndex();
    index.rebuild(tags);
    StudioTag hit = index.hitTest(1, new Point2D.Double(115, 115)).orElseThrow();
    check("nested".equals(hit.id()), "spatial index should prefer smallest containing tag");
    check(index.hitHandle(1, new Point2D.Double(110, 119.5), 1.0).isPresent(), "resize handle should be detectable");

    Path temp = Files.createTempDirectory("perfect-studio-headless-");
    Path input = temp.resolve("input.pdf");
    Path output = temp.resolve("out.pdf");
    Path outputDir = temp.resolve("run");
    Files.writeString(input, "%PDF-1.7\n");
    PerfectStudioHeadlessRunner.HeadlessOptions options = PerfectStudioHeadlessRunner.parseArgs(
      new String[]{"--headless", "-i", input.toString(), "-o", output.toString(), "--output-dir", outputDir.toString()}
    );

    Path parsedOutputDir = temp.resolve("parsed-run");
    Path parsedTaggedPdf = parsedOutputDir.resolve("custom-tagged.pdf");
    Path parsedValidationReport = parsedOutputDir.resolve("nested").resolve("validation.json");
    PerfectStudioHeadlessRunner parsedRunner = new PerfectStudioHeadlessRunner(repoRoot, (command, workingDirectory, stdout, stderr) -> {
      check(command.get(0).equals("node"), "headless runner should invoke node");
      check(command.get(1).endsWith("pipeline-runner.js"), "headless runner should invoke pipeline-runner");
      check(workingDirectory.equals(repoRoot.toAbsolutePath().normalize()), "runner working directory should be repo root");
      Files.createDirectories(parsedValidationReport.getParent());
      Files.writeString(parsedTaggedPdf, "%PDF-1.7\n% tagged\n");
      Files.writeString(parsedValidationReport, compliantValidationReport());
      stdout.append(orchestratorSnapshot(parsedOutputDir, parsedTaggedPdf, parsedValidationReport));
      return 0;
    });
    PerfectStudioHeadlessRunner.HeadlessResult parsedResult = parsedRunner.run(
      new PerfectStudioHeadlessRunner.HeadlessOptions(input, output, parsedOutputDir),
      new StringBuilder(),
      new StringBuilder()
    );
    check(parsedResult.generatedPdf().equals(parsedTaggedPdf), "stdout JSON should drive tagged PDF resolution");
    check(parsedResult.validationReport().equals(parsedValidationReport), "stdout JSON should drive validation report resolution");
    check(Files.isRegularFile(output), "requested output PDF should be copied");
    check(PerfectStudioHeadlessRunner.toJson(parsedResult).contains(escapeJson(parsedTaggedPdf.toString())), "headless JSON should report the resolved PDF path");

    Path fallbackOutputDir = temp.resolve("fallback-run");
    PerfectStudioHeadlessRunner fallbackRunner = new PerfectStudioHeadlessRunner(repoRoot, (command, workingDirectory, stdout, stderr) -> {
      Files.createDirectories(fallbackOutputDir);
      Files.writeString(fallbackOutputDir.resolve("06-tagged.pdf"), "%PDF-1.7\n% tagged\n");
      Files.writeString(fallbackOutputDir.resolve("07-validation-report.json"), compliantValidationReport());
      stdout.append("{\"status\":\"completed\",\"input\":{\"outputDir\":\"")
        .append(escapeJson(fallbackOutputDir.toString()))
        .append("\"},\"artifacts\":{}}\n");
      return 0;
    });
    PerfectStudioHeadlessRunner.HeadlessResult fallbackResult = fallbackRunner.run(
      new PerfectStudioHeadlessRunner.HeadlessOptions(input, output, fallbackOutputDir),
      new StringBuilder(),
      new StringBuilder()
    );
    check(fallbackResult.generatedPdf().equals(fallbackOutputDir.resolve("06-tagged.pdf")), "legacy tagged PDF path should remain a fallback");
    check(fallbackResult.validationReport().equals(fallbackOutputDir.resolve("07-validation-report.json")), "legacy validation report path should remain a fallback");

    Path malformedOutputDir = temp.resolve("malformed-run");
    PerfectStudioHeadlessRunner malformedRunner = new PerfectStudioHeadlessRunner(repoRoot, (command, workingDirectory, stdout, stderr) -> {
      Files.createDirectories(malformedOutputDir);
      Files.writeString(malformedOutputDir.resolve("06-tagged.pdf"), "%PDF-1.7\n% tagged\n");
      Files.writeString(malformedOutputDir.resolve("07-validation-report.json"), "{\"status\":\"completed\",\"isCompliant\":true");
      stdout.append(orchestratorSnapshot(malformedOutputDir, malformedOutputDir.resolve("06-tagged.pdf"), malformedOutputDir.resolve("07-validation-report.json")));
      return 0;
    });
    expectFailure(
      () -> malformedRunner.run(new PerfectStudioHeadlessRunner.HeadlessOptions(input, output, malformedOutputDir), new StringBuilder(), new StringBuilder()),
      "Malformed validation report"
    );

    Path failingOutputDir = temp.resolve("failing-run");
    PerfectStudioHeadlessRunner failingRunner = new PerfectStudioHeadlessRunner(repoRoot, (command, workingDirectory, stdout, stderr) -> {
      Files.createDirectories(failingOutputDir);
      Files.writeString(failingOutputDir.resolve("06-tagged.pdf"), "%PDF-1.7\n% tagged\n");
      Files.writeString(failingOutputDir.resolve("07-validation-report.json"), failingValidationReport());
      stdout.append(orchestratorSnapshot(failingOutputDir, failingOutputDir.resolve("06-tagged.pdf"), failingOutputDir.resolve("07-validation-report.json")));
      return 0;
    });
    expectFailure(
      () -> failingRunner.run(new PerfectStudioHeadlessRunner.HeadlessOptions(input, output, failingOutputDir), new StringBuilder(), new StringBuilder()),
      "noncompliant"
    );

    System.out.println("perfect-studio-harness-ok");
  }

  private static BufferedImage image() {
    return new BufferedImage(8, 8, BufferedImage.TYPE_INT_ARGB);
  }

  private static void check(boolean condition, String message) {
    if (!condition) {
      throw new AssertionError(message);
    }
  }

  private static void close(double actual, double expected, String message) {
    if (Math.abs(actual - expected) > 0.0001) {
      throw new AssertionError(message + ": expected " + expected + " but got " + actual);
    }
  }

  private static String compliantValidationReport() {
    return "{\"status\":\"completed\",\"isCompliant\":true,\"overall\":{\"status\":\"pass\"},\"findings\":[],\"summary\":{}}";
  }

  private static String failingValidationReport() {
    return "{\"status\":\"completed\",\"isCompliant\":false,\"overall\":{\"status\":\"fail\"},\"findings\":[{\"severity\":\"error\",\"code\":\"BROKEN\",\"message\":\"bad report\"}],\"summary\":{}}";
  }

  private static String orchestratorSnapshot(Path outputDir, Path taggedPdf, Path validationReport) {
    return "{\"status\":\"completed\",\"input\":{\"outputDir\":\""
      + escapeJson(outputDir.toString())
      + "\"},\"artifacts\":{\"outputDir\":\""
      + escapeJson(outputDir.toString())
      + "\",\"taggedPdf\":\""
      + escapeJson(taggedPdf.toString())
      + "\",\"validationReport\":\""
      + escapeJson(validationReport.toString())
      + "\"}}\n";
  }

  private static String escapeJson(String value) {
    return value
      .replace("\\", "\\\\")
      .replace("\"", "\\\"");
  }

  private static void expectFailure(CheckedRunnable runnable, String expectedMessage) throws Exception {
    try {
      runnable.run();
      throw new AssertionError("Expected failure containing: " + expectedMessage);
    } catch (Exception error) {
      check(
        error.getMessage() != null && error.getMessage().contains(expectedMessage),
        "Expected failure containing '" + expectedMessage + "' but got: " + error.getMessage()
      );
    }
  }

  @FunctionalInterface
  private interface CheckedRunnable {
    void run() throws Exception;
  }
}
`;
}
