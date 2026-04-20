import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";

const execFileP = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot });
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");
const fixturesRoot = path.join(moduleDir, "fixtures");
const lrbTestDir = path.join(repoRoot, "test", "LRBTest");

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

const POSITION_TOLERANCE = 5;
const MIN_UNIQUE_ON_EVIDENCE = 0.97; // corpus-wide floor for uniquely-correct assignments

function normalizeMatcherText(s) {
  return String(s || "")
    .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    // Strip C0 control chars except whitespace to match the Java matcher's
    // normalizeText. See NativeTagMatcher.java for context (some producers
    // encode ligatures as U+001F).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function collectTagInfo(tagNode, semById, out) {
  const semNodes = [];
  for (const srcId of tagNode.sourceNodeIds || []) {
    const sn = semById.get(srcId);
    if (sn) semNodes.push(sn);
  }
  if (semNodes.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pages = new Set();
    let text = "";
    for (const sn of semNodes) {
      const [x, y, w, h] = sn.bbox || [0, 0, 0, 0];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
      pages.add(sn.pageNumber);
      text += (text ? " " : "") + sn.text;
    }
    out.set(tagNode.id, { minX, minY, maxX, maxY, pages, text: normalizeMatcherText(text) });
  }
  for (const child of tagNode.children || []) collectTagInfo(child, semById, out);
  return out;
}

function positionInside(op, tag) {
  return op.x >= tag.minX - POSITION_TOLERANCE && op.x <= tag.maxX + POSITION_TOLERANCE &&
         op.y >= tag.minY - POSITION_TOLERANCE && op.y <= tag.maxY + POSITION_TOLERANCE;
}

/**
 * Full-corpus regression lock. Every LRBTest PDF's matcher output is
 * verified on three axes:
 *
 *   1. MATCH RATE — each doc must match ≥99% of its text ops (corpus
 *      ≥99.9%). Page-header duplicates the semantic engine intentionally
 *      dedupes flow to /Artifact wrap and count as legit unmatched.
 *   2. NOT-BOGUS — every assigned op must satisfy BOTH the text-
 *      containment AND the bbox-containment gate on its assigned tag.
 *      No op is assigned to a tag that fails either check.
 *   3. UNIQUELY-CORRECT — for ≥97% of assigned ops (corpus-wide), the
 *      assigned tag must be the UNIQUE candidate on its page that
 *      satisfies both gates. The remaining ≤3% are genuinely ambiguous
 *      (e.g., single-char operators in tightly-packed table cells, short
 *      words appearing in multiple adjacent tags) — the matcher picks
 *      first-in-reading-order, which is a reasonable heuristic but not
 *      provable from the available evidence.
 *
 * Baseline measured 2026-04-18 after the TextPosition-based coordinate
 * frame, whitespace-aware position capture, substring-only confidence
 * gating, and soft-hyphen normalization:
 *   - 28,017 assignments across 15 PDFs
 *   - 0 bogus (tag contains op text AND op position for every assignment)
 *   - 27,535 uniquely correct (98.28%)
 *   - 482 ambiguous on evidence (1.72%) — all still geographically AND
 *     textually consistent with their assigned tag
 *
 * If this test fails: run `node tmp/corpus-probe.mjs` to find which doc
 * regressed, then `node tmp/position-audit.mjs tmp/corpus-probe-fixtures/<DOC>/`
 * to inspect the ambiguous samples. The common failure mode is a matcher
 * change that accepts weaker text signals (bigram-Jaccard tier), which
 * quietly pushes formerly-unique assignments into the ambiguous bucket.
 */
test("corpus regression: matcher preserves match rate, no bogus assignments, high uniqueness", async (t) => {
  if (!existsSync(lrbTestDir)) {
    t.skip(`LRBTest source dir missing at ${lrbTestDir}`);
    return;
  }
  await compileNative();
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome });

  const fixtureDirs = (await readdir(fixturesRoot))
    .filter(name => /^(06-tagged|2025_|2026_)/.test(name))
    .sort();

  assert.ok(fixtureDirs.length >= 15, `expected 15 corpus fixtures, found ${fixtureDirs.length}`);

  let totalOps = 0;
  let totalMatched = 0;
  let totalAssigned = 0;
  let totalUniqueOnEvidence = 0;
  let totalBogus = 0;
  const failures = [];

  for (const fixName of fixtureDirs) {
    await t.test(fixName, async (subt) => {
      const semanticPath = path.join(fixturesRoot, fixName, "semantic-ordered.json");
      const tagsPath = path.join(fixturesRoot, fixName, "tagging.json");
      const pdfPath = path.join(lrbTestDir, `${fixName}.pdf`);
      if (!existsSync(pdfPath) || !existsSync(semanticPath) || !existsSync(tagsPath)) {
        subt.skip(`missing artifacts for ${fixName}`);
        return;
      }

      const opsPath = path.join(buildDir, `corpus-${fixName}-operators.json`);
      const planPath = path.join(buildDir, `corpus-${fixName}-plan.json`);

      await execFileP(
        java,
        ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
         "--pdf", pdfPath, "--output", opsPath],
        { env, maxBuffer: 100 * 1024 * 1024 }
      );
      await execFileP(
        java,
        ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeTagMatcher",
         "--operators", opsPath, "--semantic", semanticPath, "--tags", tagsPath,
         "--output", planPath],
        { env, maxBuffer: 100 * 1024 * 1024 }
      );

      const plan = JSON.parse(await readFile(planPath, "utf8"));
      const semantic = JSON.parse(await readFile(semanticPath, "utf8"));
      const tagging = JSON.parse(await readFile(tagsPath, "utf8"));

      const overall = plan.overall || {};
      const ops = Number(overall.operatorCount || 0);
      const matched = Number(overall.matchedOperators || 0);
      const rate = Number(overall.matchRate ?? (ops ? matched / ops : 1));

      totalOps += ops;
      totalMatched += matched;

      // Assignment-quality checks: for every assigned op, verify the
      // assigned tag satisfies BOTH gates (text containment + bbox
      // containment), and count how many OTHER tags on the page would
      // also satisfy both gates. Unique = confidently correct. Ambiguous
      // = still valid but picked first among peers. Bogus = the assigned
      // tag fails at least one gate, which should never happen.
      const semById = new Map();
      for (const n of semantic.nodes || []) semById.set(n.id, n);
      const tagInfoById = collectTagInfo(tagging.root, semById, new Map());

      let assigned = 0;
      let uniqueOnEvidence = 0;
      let ambiguousOnEvidence = 0;
      let bogus = 0;
      const bogusSamples = [];
      for (const page of plan.pages || []) {
        const pageTags = [];
        for (const [id, info] of tagInfoById.entries()) {
          if (info.pages.has(page.pageNumber)) pageTags.push({ id, ...info });
        }
        for (const asgn of page.assignments || []) {
          for (const op of asgn.operators || []) {
            assigned++;
            const opNorm = normalizeMatcherText(op.text);
            const opNoSpace = opNorm.replace(/\s+/g, "");
            // Mirror the matcher's acceptance logic: bidirectional
            // substring containment, plus spaceless fallback for pdfTeX-
            // style producers that omit literal spaces between glyphs.
            const finalists = pageTags.filter(t => {
              if (!positionInside(op, t)) return false;
              if (opNorm.length === 0) return true;
              if (t.text.includes(opNorm) || opNorm.includes(t.text)) return true;
              if (opNoSpace.length >= 5) {
                const tNoSpace = t.text.replace(/\s+/g, "");
                if (tNoSpace.includes(opNoSpace) || opNoSpace.includes(tNoSpace)) return true;
              }
              return false;
            });
            const hit = finalists.some(f => f.id === asgn.tagNodeId);
            if (!hit) {
              bogus++;
              if (bogusSamples.length < 3) {
                bogusSamples.push({
                  page: page.pageNumber,
                  tag: asgn.tagNodeId,
                  opSeq: op.seq,
                  opText: op.text.slice(0, 60)
                });
              }
              continue;
            }
            if (finalists.length === 1) uniqueOnEvidence++;
            else ambiguousOnEvidence++;
          }
        }
      }

      totalAssigned += assigned;
      totalUniqueOnEvidence += uniqueOnEvidence;
      totalBogus += bogus;

      const uniqueRate = assigned > 0 ? uniqueOnEvidence / assigned : 1;
      if (rate < 0.99 || bogus > 0) {
        failures.push({ fixture: fixName, ops, matched, rate, uniqueRate, bogus });
      }

      assert.ok(rate >= 0.99,
        `${fixName}: match rate ${rate.toFixed(3)} dropped below the 0.99 floor (${matched}/${ops})`);
      assert.equal(bogus, 0,
        `${fixName}: ${bogus} bogus assignments (text or position gate fails). ` +
        `First: ${JSON.stringify(bogusSamples[0])}`);
      // Per-doc uniqueness floor: 90% is lenient enough that a table-heavy
      // doc with cramped bboxes doesn't fail, while still catching a
      // matcher change that pushes uniqueness below what tablet text can
      // tolerate.
      assert.ok(uniqueRate >= 0.9,
        `${fixName}: unique-on-evidence rate ${uniqueRate.toFixed(3)} below 0.9 (${uniqueOnEvidence}/${assigned})`);
      assert.ok(overall.nativeViable, `${fixName}: nativeViable must be true`);
    });
  }

  // End-of-run corpus-level rollup. Catches drift that stays under each
  // individual fixture's per-doc floor.
  await t.test("corpus aggregate: rate, uniqueness, no bogus", () => {
    assert.equal(failures.length, 0,
      `${failures.length} fixture(s) failed: ${JSON.stringify(failures)}`);
    assert.ok(totalOps > 25000, `expected >25k total text operators across corpus, got ${totalOps}`);

    // Corpus-wide match rate floor. ~18 unmatched ops today are genuine
    // upstream-deduped page-header duplicates — the matcher correctly
    // declines to claim them. This floor catches regressions that push
    // unmatched over ~0.1% of the corpus.
    const corpusRate = totalMatched / totalOps;
    assert.ok(corpusRate >= 0.999,
      `corpus match rate ${corpusRate.toFixed(4)} below 0.999 floor (${totalMatched}/${totalOps})`);

    // Uniqueness floor. Genuinely ambiguous cases (single-char ops in
    // packed table cells, short words in overlapping bboxes) account for
    // ~1.7% of assignments today; keep a 3% ceiling so this stays a
    // useful regression signal.
    assert.equal(totalBogus, 0,
      `${totalBogus} bogus assignments across the corpus — should be zero`);
    const uniqueRate = totalAssigned > 0 ? totalUniqueOnEvidence / totalAssigned : 1;
    assert.ok(uniqueRate >= MIN_UNIQUE_ON_EVIDENCE,
      `corpus uniqueness ${uniqueRate.toFixed(4)} below ${MIN_UNIQUE_ON_EVIDENCE} floor ` +
      `(${totalUniqueOnEvidence}/${totalAssigned} uniquely correct on evidence)`);
  });
});
