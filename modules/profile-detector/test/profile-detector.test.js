import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { detectProfileFromOperators, detectProfileFromOperatorsFile } from "../index.js";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";

const execFileP = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const buildDir = getRuntimeBuildDir("profile-detector", { repoRoot });
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");
const externalPdfDir = path.join(repoRoot, "test", "fixtures", "external");

// Ground-truth mapping from PDF fixture → expected profile. These
// claims encode the calibration team's judgment of the "right"
// profile for each known doc. Regression tests pin them so a change
// to detector heuristics surfaces any reclassification immediately.
//
// Rationale for each:
//   irs-w9, irs-p1040-tax-tables: IRS forms, AcroForm populated →
//     forms-heavy
//   un-ga-chinese: dominantly Chinese → cjk
//   scotus-24-656: US Supreme Court slip opinion → legal
//   arxiv-2501.18462: LaTeX pdfTeX → scientific
//   gpo-fr-notice, nist-sp-1271, thai-constitution-en,
//   un-ecosoc-multilingual, un-ga-hebrew, un-sc-arabic,
//   usgs-of2024-1001: no specialized signal strong enough → default
const EXPECTED_PROFILE = {
  "irs-w9": "forms-heavy",
  "irs-p1040-tax-tables": "default", // IRS publication, not a form
  "un-ga-chinese": "cjk",
  "scotus-24-656": "legal",
  "arxiv-2501.18462": "scientific",
  "gpo-fr-notice": "default",
  "nist-sp-1271": "default",
  "thai-constitution-en": "default", // Thai script but not CJK; no specialized profile
  "un-ecosoc-multilingual": "default",
  "un-ga-hebrew": "default",   // RTL but no rtl-specific profile yet; default is fine
  "un-sc-arabic": "default",   // same reasoning
  "usgs-of2024-1001": "default"
};

async function compileParser() {
  const sources = [
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamParser.java")
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

test("profile-detector correctly classifies the pinned external corpus", async (t) => {
  if (!existsSync(externalPdfDir)) {
    t.skip(`external PDF dir missing at ${externalPdfDir}`);
    return;
  }
  await compileParser();
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome });

  for (const [base, expectedProfile] of Object.entries(EXPECTED_PROFILE)) {
    await t.test(`${base} → ${expectedProfile}`, async (subt) => {
      const pdfPath = path.join(externalPdfDir, `${base}.pdf`);
      if (!existsSync(pdfPath)) {
        subt.skip(`missing pdf at ${pdfPath}`);
        return;
      }
      const opsPath = path.join(buildDir, `${base}-detect.json`);
      await execFileP(
        java,
        ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
         "--pdf", pdfPath, "--output", opsPath],
        { env, maxBuffer: 200 * 1024 * 1024 }
      );

      const result = await detectProfileFromOperatorsFile(opsPath);
      assert.equal(result.profileId, expectedProfile,
        `Expected ${expectedProfile}, got ${result.profileId}. Reasoning: ${result.reasoning}. Signals: ${JSON.stringify(result.signals)}`);
      assert.ok(result.reasoning.length > 20, "every detection should explain itself");
      assert.ok(result.confidence >= 0 && result.confidence <= 1, "confidence must be in [0,1]");
    });
  }
});

test("profile-detector decision inputs: synthetic signal coverage", () => {
  // Minimal synthetic operators.json shapes exercising each branch.
  // These tests pin the detector's decision boundaries independently
  // of the corpus — if somebody adjusts a threshold they should have
  // to consciously change a test.

  const baseDoc = (source, opsPerPage = 100, text = "Plain English text paragraph here.") => ({
    source: { hasStructTree: false, markInfoMarked: false, hasAcroForm: false, pdfVersion: "1.7", producer: "", creator: "", ...source },
    coordinateOrigin: "top",
    pages: [{
      pageNumber: 1, pageWidth: 612, pageHeight: 792, rotation: 0,
      operatorCount: opsPerPage, markedContentOperators: 0,
      operators: Array.from({ length: opsPerPage }, (_, i) => ({
        seq: i, op: "Tj", text, x: 50, y: 50 + i * 10, font: "Helvetica", fontSize: 10,
        glyphs: text.length, streamOrigin: "page", insideMarkedContent: false
      }))
    }]
  });

  // Scanned: zero text operators
  const scanned = detectProfileFromOperators({
    source: {}, coordinateOrigin: "top",
    pages: [{ pageNumber: 1, pageWidth: 612, pageHeight: 792, rotation: 0, operatorCount: 0, markedContentOperators: 0, operators: [] }]
  });
  assert.equal(scanned.profileId, "scanned-low-quality");

  // Forms-heavy: hasAcroForm wins over other signals
  const forms = detectProfileFromOperators(baseDoc({ hasAcroForm: true, producer: "pdfTeX-1.40" }));
  assert.equal(forms.profileId, "forms-heavy");

  // CJK: dominant Chinese text
  const cjk = detectProfileFromOperators(baseDoc({ producer: "Word" }, 50, "这是中文文本段落内容"));
  assert.equal(cjk.profileId, "cjk");

  // Legal: citation density
  const legal = detectProfileFromOperators(baseDoc(
    { producer: "Microsoft Word" }, 20,
    "Smith v. Jones, 410 U.S. 113 (1973). See, e.g., Doe v. Roe, 456 F.3d 789 (9th Cir. 2005) ¶ 14."
  ));
  assert.equal(legal.profileId, "legal");

  // Scientific: pdfTeX producer
  const scientific = detectProfileFromOperators(baseDoc({ producer: "pdfTeX-1.40.25" }, 50, "We prove the main theorem as a corollary of Lemma 2.1 and the Banach-Steinhaus theorem."));
  assert.equal(scientific.profileId, "scientific");

  // Default: no specialized signal
  const def = detectProfileFromOperators(baseDoc({ producer: "Microsoft Word" }, 50, "This is a general paragraph with nothing specific."));
  assert.equal(def.profileId, "default");
});

test("profile-detector every output includes explanation and signals", () => {
  const result = detectProfileFromOperators({
    source: {}, coordinateOrigin: "top",
    pages: [{ pageNumber: 1, pageWidth: 612, pageHeight: 792, rotation: 0, operatorCount: 1, markedContentOperators: 0, operators: [{ seq: 0, op: "Tj", text: "x", x: 0, y: 0, font: "", fontSize: 10, glyphs: 1, streamOrigin: "page", insideMarkedContent: false }] }]
  });
  assert.ok(result.profileId);
  assert.ok(result.reasoning);
  assert.ok(typeof result.confidence === "number");
  assert.ok(Array.isArray(result.alternates));
  assert.ok(result.signals);
  assert.ok(result.signals.scriptCounts);
});
